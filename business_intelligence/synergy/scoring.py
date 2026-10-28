"""
Deterministic, explainable synergy factor scores (each 0–100).

Distance weight: a place within FULL_WEIGHT_WITHIN_M counts 1.0, falling linearly to
MIN_DISTANCE_WEIGHT at SEARCH_RADIUS_M; places further away do not count.
"""
import math

from . import configuration as cfg
from .relationships import ANCHORS, CUSTOMER_GROUPS, DESTINATION_WEIGHT, INFERRED_ANCHORS, anchor_of


def _haversine(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def distance_weight(d):
    if d <= cfg.FULL_WEIGHT_WITHIN_M:
        return 1.0
    if d > cfg.SEARCH_RADIUS_M:
        return 0.0
    span = cfg.SEARCH_RADIUS_M - cfg.FULL_WEIGHT_WITHIN_M
    return 1.0 - (1.0 - cfg.MIN_DISTANCE_WEIGHT) * (d - cfg.FULL_WEIGHT_WITHIN_M) / span


def poi_type(tags):
    return str(tags.get('amenity') or tags.get('shop') or tags.get('leisure') or tags.get('office') or '').lower()


class PointIndex:
    """Mapped places within SEARCH_RADIUS_M of one point, with distance, anchors and type."""

    def __init__(self, elements, lat, lon):
        self.lat, self.lon = float(lat), float(lon)
        self.items = []
        self.catchment = []
        for el in elements or []:
            e_lat = el.get('lat') or (el.get('center') or {}).get('lat')
            e_lon = el.get('lon') or (el.get('center') or {}).get('lon')
            if e_lat is None or e_lon is None:
                continue
            d = _haversine(self.lat, self.lon, float(e_lat), float(e_lon))
            if d > cfg.SEARCH_RADIUS_M:
                continue
            tags = el.get('tags') or {}
            self.catchment.append(el)
            self.items.append({'d': d, 'w': distance_weight(d), 'tags': tags, 'anchors': anchor_of(tags),
                               'type': poi_type(tags), 'name': tags.get('name')})
        self.mapped = len(self.items)

    def anchored(self, anchor):
        return sorted((i for i in self.items if anchor in i['anchors']), key=lambda i: i['d'])


def _examples(items, singular, limit=3):
    out = []
    for i in items[:limit]:
        out.append({'name': i['name'] or f'Unnamed {singular} (mapped without a name)',
                    'named': bool(i['name']), 'distance_m': int(round(i['d']))})
    return out


def relationship_scores(index, relationships, weights):
    """Business and environment factor scores with one explainable line per relationship."""
    lines = []
    for rel in relationships:
        singular, plural, group, _rules = ANCHORS[rel['anchor']]
        items = index.anchored(rel['anchor'])
        effective = sum(i['w'] for i in items)
        strength = min(1.0, effective / rel['saturation']) if rel['saturation'] else 0.0
        lines.append({
            'anchor': rel['anchor'], 'kind': rel['kind'], 'label': plural, 'singular': singular,
            'customer_group': group, 'relevance': rel['relevance'], 'saturation': rel['saturation'],
            'count': len(items), 'effective_count': round(effective, 2), 'strength': round(strength, 3),
            'nearest_m': int(round(items[0]['d'])) if items else None,
            'examples': _examples(items, singular), 'how': rel['how'], 'action': rel['action'],
            'inferred_note': INFERRED_ANCHORS.get(rel['anchor']),
        })
    scores = {}
    for kind in ('business', 'environment'):
        rels = [l for l in lines if l['kind'] == kind]
        total_rel = sum(l['relevance'] for l in rels)
        score = 100.0 * sum(l['relevance'] * l['strength'] for l in rels) / total_rel if total_rel else 0.0
        scores[kind] = round(score, 1)
        for l in rels:
            # Points this relationship adds to the final 0–100 synergy score.
            l['points'] = round(weights[kind] * 100.0 * l['relevance'] * l['strength'] / total_rel, 2) if total_rel else 0.0
    return scores, lines


def customer_score(index, lines):
    """How many of the customer groups this business suits are present (distance-weighted)."""
    fit = {}
    for l in lines:
        fit[l['customer_group']] = max(fit.get(l['customer_group'], 0.0), l['relevance'])
    groups = []
    for group, f in sorted(fit.items(), key=lambda kv: -kv[1]):
        anchors = [a for a, spec in ANCHORS.items() if spec[2] == group]
        effective = sum(i['w'] for i in index.items if set(i['anchors']) & set(anchors))
        presence = min(1.0, effective / cfg.CUSTOMER_GROUP_SATURATION)
        groups.append({'group': group, 'label': CUSTOMER_GROUPS[group], 'fit': f,
                       'presence': round(presence, 3), 'present': presence >= 0.4})
    total = sum(g['fit'] for g in groups)
    score = 100.0 * sum(g['fit'] * g['presence'] for g in groups) / total if total else 0.0
    return round(score, 1), groups


def competition_score(index, competitor_types, group, business_score, environment_score):
    """
    Higher = better. Same-category places within 1 km reduce the opportunity relative to
    how much surrounding demand there is; a tight cluster (400 m) can add destination
    pull for comparison-shopping categories but also saturates.
    """
    types = {t.lower() for t in (competitor_types or [])}
    comps = sorted((i for i in index.items if i['type'] in types and i['d'] > 10 and i['d'] <= cfg.COMPETITION_RADIUS_M),
                   key=lambda i: i['d'])
    pressure = sum(i['w'] for i in comps)
    demand = (business_score + environment_score) / 200.0
    capacity = 3.0 + 9.0 * demand                    # strong demand supports more similar places
    base = 100.0 * max(0.0, 1.0 - pressure / capacity)
    in_cluster = sum(1 for i in comps if i['d'] <= cfg.CLUSTER_RADIUS_M)
    attraction = DESTINATION_WEIGHT.get(group, 0.2) * min(1.0, in_cluster / 6.0)
    saturation = min(1.0, max(0, in_cluster - 4) / 8.0)
    score = max(0.0, min(100.0, base + 25.0 * attraction - 25.0 * saturation))
    return round(score, 1), {
        'competitors_1km': len(comps), 'competitors_400m': in_cluster,
        'pressure': round(pressure, 2), 'capacity': round(capacity, 2),
        'base_score': round(base, 1), 'cluster_attraction': round(attraction, 3), 'cluster_saturation': round(saturation, 3),
        'nearest': [{'name': i['name'] or 'Unnamed (mapped without a name)', 'distance_m': int(round(i['d']))} for i in comps[:3]],
    }


def accessibility_score(index):
    """The revenue engine's accessibility score for the site, with transit counts for the explanation."""
    from business_intelligence.prediction_engine import FeatureExtractor
    features = FeatureExtractor(index.lat, index.lon, 'default').extract_features(index.catchment)
    bus = sum(1 for i in index.items if 'bus' in i['anchors'] and i['d'] <= 500)
    rail = sum(1 for i in index.items if 'rail' in i['anchors'] and i['d'] <= 1000)
    parking = sum(1 for i in index.items if 'parking_fuel' in i['anchors'] and i['d'] <= 500)
    return round(float(features.accessibility_score), 1), {'bus_stops_500m': bus, 'stations_1km': rail, 'parking_500m': parking}


def coverage(index):
    """Share of 'well mapped' (0–1) and a confidence label."""
    c = min(1.0, index.mapped / cfg.COVERAGE_FULL_AT)
    level = 'high' if c >= 0.8 else ('medium' if c >= 0.4 else 'low')
    return round(c, 3), level
