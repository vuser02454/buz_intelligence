"""
Business Synergy Intelligence: how the surroundings of a site could help a proposed business.

  analyze(elements, lat, lon, business, base_monthly, competitor_types)  -> full result (one site)
  AreaSynergy(elements).analyze(...)                                     -> same, with per-point caching
  for_location(elements, lat, lon, business_type)                        -> base revenue from the engine
                                                                            (as the PDF report does) + analyze
The numbers are computed here, deterministically, from OpenStreetMap places; the text
is built by fixed rules from those numbers (no AI-generated figures).
"""
import re

from . import configuration as cfg
from . import revenue_uplift, scoring
from .relationships import RELATIONSHIPS, business_key, group_for

SYNERGY_VERSION = 1


def _inr(amount):
    value = int(round(float(amount or 0)))
    digits = str(abs(value))
    if len(digits) > 3:
        head, tail = digits[:-3], digits[-3:]
        digits = re.sub(r'(\d)(?=(\d{2})+$)', r'\1,', head) + ',' + tail
    return ('-' if value < 0 else '') + '₹' + digits


def _nice(name):
    return ' '.join(w if w.isupper() else w.capitalize() for w in str(name or '').replace('_', ' ').split()) or 'Business'


def _km(m):
    return f'{m / 1000:.1f} km' if m >= 1000 else f'{int(m)} m'


class AreaSynergy:
    """Analyse many (business, site) pairs over one area's places, indexing each site once."""

    def __init__(self, elements):
        self.elements = elements or []
        self._points = {}
        self._access = {}

    def _index(self, lat, lon):
        key = (round(float(lat), 6), round(float(lon), 6))
        if key not in self._points:
            self._points[key] = scoring.PointIndex(self.elements, lat, lon)
        return self._points[key]

    def _accessibility(self, index):
        key = (round(index.lat, 6), round(index.lon, 6))
        if key not in self._access:
            self._access[key] = scoring.accessibility_score(index)
        return self._access[key]

    def analyze(self, lat, lon, business, base_monthly, competitor_types=None, location_name=''):
        index = self._index(lat, lon)
        key = business_key(business)
        group = group_for(key)
        weights = cfg.weights()
        factor, lines = scoring.relationship_scores(index, RELATIONSHIPS[group], weights)
        cust, groups = scoring.customer_score(index, lines)
        comp, comp_detail = scoring.competition_score(index, competitor_types or (key,), group,
                                                      factor['business'], factor['environment'])
        acc, acc_detail = self._accessibility(index)
        cover, confidence = scoring.coverage(index)
        factors = {'business': factor['business'], 'environment': factor['environment'], 'customer': cust,
                   'competition': comp, 'accessibility': acc}
        score = round(sum(weights[k] * factors[k] for k in factors), 1)
        revenue = revenue_uplift.scenarios(base_monthly, score, cover)

        result = {
            'version': SYNERGY_VERSION,
            'business': _nice(business), 'business_key': key, 'group': group,
            'location': {'lat': round(float(lat), 6), 'lng': round(float(lon), 6), 'name': location_name or ''},
            'score': score, 'level': cfg.level_for(score),
            'factors': [{'key': k, 'label': cfg.LABELS[k], 'score': factors[k], 'weight': weights[k],
                         'points': round(weights[k] * factors[k], 1)} for k in factors],
            'relationships': sorted(lines, key=lambda l: -l['points']),
            'customer_groups': groups,
            'customer_groups_present': [g['label'] for g in groups if g['present']],
            'competition': comp_detail,
            'accessibility': acc_detail,
            'data': {'mapped_places_1500m': index.mapped, 'coverage': cover, 'confidence': confidence,
                     'search_radius_m': cfg.SEARCH_RADIUS_M},
            'revenue': revenue,
            'is_estimate': True,
        }
        result['explanation'] = explain(result)
        return result


def analyze(elements, lat, lon, business, base_monthly, competitor_types=None, location_name=''):
    return AreaSynergy(elements).analyze(lat, lon, business, base_monthly, competitor_types, location_name)


def competitor_types_for(business):
    """OSM values that count as the same category (shared with the recommendation engine)."""
    from business_intelligence.analysis import _REC_CATALOG, _REC_DEFAULT
    key = business_key(business)
    return _REC_CATALOG.get(key, _REC_DEFAULT)[3] or (key,)


def for_location(elements, lat, lon, business_type, base_monthly=None, location_name=''):
    """
    Synergy for `business_type` at (lat, lon). Base revenue = calculate_smart_revenue on the
    same elements – exactly how the PDF report computes its revenue forecast, so the web
    page and the report show the same numbers.
    """
    if base_monthly is None:
        from business_intelligence import utils
        base_monthly = utils.calculate_smart_revenue(elements, business_type=business_type, lat=lat, lon=lon)['monthly_revenue']
    return analyze(elements, lat, lon, business_type, base_monthly, competitor_types_for(business_type), location_name)


def summary(result, contributors=3):
    """Compact form for recommendation cards (same numbers as the full result)."""
    rows = {r['scenario']: r for r in result['revenue']['rows']}
    return {
        'score': result['score'], 'level': result['level'],
        'confidence': result['data']['confidence'],
        'sources': [{'label': l['label'], 'count': l['count'], 'nearest_m': l['nearest_m'], 'kind': l['kind'],
                     'points': l['points']} for l in result['relationships'] if l['count'] and l['points'] > 0][:contributors],
        'scenarios': {k: {'monthly': rows[k]['monthly'], 'additional': rows[k]['additional'], 'uplift_pct': rows[k]['uplift_pct']}
                      for k in ('base', 'conservative', 'moderate', 'optimistic')},
        'competitors_1km': result['competition']['competitors_1km'],
        'why': result['explanation']['why'],
        'main_risk': result['explanation']['risks'][0] if result['explanation']['risks'] else '',
        'actions': result['explanation']['actions'][:2],
    }


# ------------------------------------------------------------------ explanation ----

def _phrase(line):
    n = line['count']
    noun = line['singular'] if n == 1 else line['label']
    ex = line['examples'][0] if line['examples'] else None
    near = f" (nearest: {ex['name']}, {_km(ex['distance_m'])} away)" if ex else ''
    return f"{n} {noun} within {_km(cfg.SEARCH_RADIUS_M)}{near}"


def explain(r):
    label = r['business'].lower()
    rows = {row['scenario']: row for row in r['revenue']['rows']}
    helpful = [l for l in r['relationships'] if l['count'] and l['points'] >= 0.5]
    top = helpful[:3]
    comp = r['competition']
    groups_present = [g['label'] for g in r['customer_groups'] if g['present']]

    if top:
        why = f"Your proposed {label} would be close to {_phrase(top[0])}"
        why += f", and {_phrase(top[1])}." if len(top) > 1 else '.'
        why += ' ' + top[0]['how']
    else:
        why = (f"We found few places nearby that would naturally send customers to a {label}. "
               "Success here would depend mainly on your own visibility and marketing.")

    supports = [{
        'title': _nice(l['label']), 'kind': 'Nearby business' if l['kind'] == 'business' else 'Surrounding demand',
        'count': l['count'], 'nearest_m': l['nearest_m'], 'examples': l['examples'], 'points': l['points'],
        'relationship': l['how'], 'note': l['inferred_note'],
    } for l in helpful[:6]]

    how = [l['how'] for l in top]
    if groups_present:
        how.append('Possible customer groups nearby: ' + ', '.join(groups_present[:5]) + '. These are potential customers '
                   'suggested by what is mapped around the site, not measured visitor movement.')

    opportunity = (f"The platform's revenue engine projects about {_inr(rows['base']['monthly'])} per month for a {label} here. "
                   f"If the surroundings help as described, illustrative scenarios give {_inr(rows['conservative']['monthly'])} "
                   f"(conservative) to {_inr(rows['optimistic']['monthly'])} (optimistic) per month – about "
                   f"{_inr(rows['moderate']['additional'])} more in the moderate case. These are model projections, "
                   "not expected or guaranteed sales.")

    risks = []
    if comp['competitors_1km']:
        sat = ' The closest ones are packed together, so the street may already be saturated.' if comp['cluster_saturation'] > 0 else ''
        risks.append(f"Competition: {comp['competitors_1km']} similar place{'s' if comp['competitors_1km'] != 1 else ''} within 1 km "
                     f"({comp['competitors_400m']} within 400 m) may take part of the same customers.{sat}")
    else:
        risks.append('No similar places are mapped within 1 km. That can mean an unserved gap – or that demand for this '
                     'business here is weak, or that nearby places are simply not mapped. Check on the ground.')
    if r['data']['confidence'] != 'high':
        risks.append(f"Limited map data: only {r['data']['mapped_places_1500m']} places are mapped within 1.5 km, so some "
                     "helpful (or competing) places may be missing. The scenarios are scaled down to reflect this.")
    if any(l['inferred_note'] for l in top):
        risks.append(next(l['inferred_note'] for l in top if l['inferred_note']))
    risks.append('Customer links are inferred from what is mapped nearby; the platform has no data on how people actually '
                 'move between these places.')
    risks.append('Actual revenue depends on execution, pricing, rent, customer conversion, operating costs and how '
                 'competitors respond – none of which the model can see.')
    if r['score'] < 30:
        risks.insert(0, 'Weak synergy: the surroundings give this business little built-in help.')

    actions = []
    for l in top:
        if l['action'] not in actions:
            actions.append(l['action'])
    if comp['competitors_1km'] >= 5:
        actions.append('Differentiate clearly (product, price, hours or service) – several similar places are already close by.')
    actions.append('Before signing a lease, observe the area at the busy times mentioned above and talk to nearby '
                   'businesses about partnerships or referrals.')

    return {'why': why, 'supports': supports, 'how': how, 'opportunity': opportunity, 'risks': risks, 'actions': actions[:5],
            'disclaimer': 'Synergy scores and revenue scenarios are calculated from OpenStreetMap data and the platform\'s '
                          'revenue engine. They are projections to guide your own checks, not measured results.'}
