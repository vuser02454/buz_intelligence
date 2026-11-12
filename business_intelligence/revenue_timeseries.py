"""
Projected revenue over time for the 5 km area around a point (Business Analytics 3D graph,
/api/revenue-timeseries/, ws/analytics/ and the PDF report).

Nothing here is measured sales data. Everything is derived from the platform's
existing engines:

* per-category daily revenue = sum of the Extended Huff engine's daily estimate
  (enrich_places_with_revenue -> predict_site_revenue) for the places the map's
  Popular Places analysis estimated – the same places and figures as the map;
* hour of day = the engine's own diurnal pattern (prediction_engine.config.
  TEMPORAL_PATTERNS), applied exactly as predictor.py derives hourly revenue;
* day of week = WEEKDAY_PROFILES below (a documented assumption; each profile
  averages exactly 1.0, so a week is 7 x the engine's daily figure).

build_views() is a pure function of (base, timestamp): no randomness, so the
"live" values move only with the clock and are reproducible in tests.
"""
import calendar
import hashlib
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from django.core.cache import cache

from .prediction_engine.config import TEMPORAL_PATTERNS

IST = ZoneInfo('Asia/Kolkata')
MAX_RADIUS_M = 5000
MIN_RADIUS_M = 500
BASE_CACHE_SECONDS = 600
HOUR_WEIGHTS = [TEMPORAL_PATTERNS[h][0] for h in range(24)]
_WEIGHT_SUM = sum(HOUR_WEIGHTS)
HOUR_SHARE = [w / _WEIGHT_SUM for w in HOUR_WEIGHTS]
DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

# Mon..Sun multipliers; each averages exactly 1.0.
WEEKDAY_PROFILES = {
    'footfall': [0.875, 0.875, 0.875, 0.875, 1.05, 1.25, 1.20],   # food, retail, leisure: busier weekends
    'weekday': [1.15, 1.15, 1.15, 1.15, 1.15, 0.75, 0.50],        # schools, offices, banks: quiet weekends
    'flat': [1.0] * 7,                                           # health and other services
}

# (category key, label, weekday profile) by OSM tag value.
_CATEGORY_RULES = [
    (('cafe', 'coffee', 'tea'), 'cafe', 'Cafe', 'footfall'),
    (('restaurant', 'food_court', 'bar', 'pub', 'biergarten'), 'restaurant', 'Restaurant', 'footfall'),
    (('fast_food', 'ice_cream', 'bakery', 'confectionery'), 'fast_food', 'Fast food & bakery', 'footfall'),
    (('pharmacy', 'chemist'), 'pharmacy', 'Pharmacy', 'flat'),
    (('supermarket', 'department_store', 'mall'), 'supermarket', 'Supermarket', 'footfall'),
    (('convenience', 'greengrocer', 'grocery', 'dairy', 'butcher'), 'grocery', 'Grocery', 'footfall'),
    (('school', 'college', 'university', 'kindergarten', 'training'), 'school', 'School & education', 'weekday'),
    (('fitness_centre', 'gym', 'sports_centre', 'swimming_pool'), 'gym', 'Gym & fitness', 'footfall'),
    (('bank', 'atm', 'bureau_de_change'), 'bank', 'Bank & ATM', 'weekday'),
    (('hospital', 'clinic', 'doctors', 'dentist', 'veterinary'), 'health', 'Healthcare', 'flat'),
]


def clamp_radius(value):
    """Radius in metres limited to 500–5000 (the analysis circle is never larger than 5 km)."""
    try:
        radius = int(float(value))
    except (TypeError, ValueError):
        radius = MAX_RADIUS_M
    return max(MIN_RADIUS_M, min(MAX_RADIUS_M, radius))


def category_of(tags):
    """(key, label, profile) for an OSM element's tags."""
    values = {str(tags.get(k) or '').lower() for k in ('amenity', 'shop', 'leisure')}
    for names, key, label, profile in _CATEGORY_RULES:
        if values & set(names):
            return key, label, profile
    if tags.get('shop'):
        return 'retail', 'Other shops', 'footfall'
    return 'other', 'Other businesses', 'flat'


def base_from_places(places, mapped_places, crowd_level='', density=None, fetched_at=None):
    """
    Per-category daily revenue from places enriched by the revenue engine.
    `places` = enrich_places_with_revenue output (each with revenue_data).
    """
    cats = {}
    confidences = []
    estimated = 0
    for p in places:
        rd = p.get('revenue_data') or {}
        daily = float(rd.get('estimated_daily_revenue') or rd.get('daily_revenue') or 0)
        if daily <= 0:
            continue
        estimated += 1
        if rd.get('confidence_score') is not None:
            confidences.append(float(rd['confidence_score']))
        key, label, profile = category_of(p.get('tags') or {})
        c = cats.setdefault(key, {'key': key, 'label': label, 'profile': profile, 'daily': 0.0, 'places': 0})
        c['daily'] += daily
        c['places'] += 1
    categories = sorted(cats.values(), key=lambda c: c['daily'], reverse=True)

    score = round(sum(confidences) / len(confidences)) if confidences else 0
    level = 'high' if score >= 75 else ('medium' if score >= 55 else 'low')
    notes = []
    if estimated < 10 or mapped_places < 100:
        level = 'low'
        notes.append(f'Only {estimated} businesses could be estimated from {mapped_places} mapped places, '
                     'so this projection has low confidence.')
    return {
        'categories': categories,
        'places_estimated': estimated,
        'mapped_places': mapped_places,
        'crowd_level': crowd_level,
        'density_per_km2': density,
        'fetched_at': fetched_at,
        'confidence': {'level': level, 'score': score,
                       'note': ' '.join(notes) or 'Average confidence reported by the revenue engine for these places.'},
    }


def base_for_area(lat, lon, radius_m, name='Selected Location'):
    """
    (base, None) from the cached area analysis (no Overpass call when the area is cached),
    or (None, fetched) when the area's data is not available yet (fetched['status'] pending/error).
    The base is cached for 10 minutes by rounded lat/lng + radius.
    """
    from .views import compute_area_analysis  # views imports this module

    radius_m = clamp_radius(radius_m)
    key = f'ts_base:v1:{round(float(lat), 3)}:{round(float(lon), 3)}:{radius_m}'
    base = cache.get(key)
    if base is not None:
        return base, None
    result, fetched = compute_area_analysis(float(lat), float(lon), name, radius_m)
    if result is None:
        return None, fetched
    grid = result['grid']
    base = base_from_places(result['places'], len(result['elements']), grid['dominant'],
                            grid['density_per_km2'], result['fetched']['fetched_at'])
    base.update({'analysis_id': result['analysis_id'], 'radius_m': radius_m,
                 'lat': float(lat), 'lng': float(lon)})
    cache.set(key, base, BASE_CACHE_SECONDS)
    return base, None


def _day_factor(cat, day):
    return WEEKDAY_PROFILES[cat['profile']][day.weekday()]


def _day_total(base, day):
    return sum(c['daily'] * _day_factor(c, day) for c in base['categories'])


def _view(base, buckets, value):
    """Assemble one view: value(cat, i) -> rupees for bucket i."""
    series = {c['key']: [round(value(c, i), 2) for i in range(len(buckets))] for c in base['categories']}
    totals = [round(sum(series[k][i] for k in series), 2) for i in range(len(buckets))]
    cat_totals = {k: sum(v) for k, v in series.items()}
    peak_i = max(range(len(totals)), key=lambda i: totals[i]) if totals else 0
    return {
        'buckets': buckets,
        'series': series,
        'totals': totals,
        'total': round(sum(totals), 2),
        'peak': {'index': peak_i, 'label': buckets[peak_i] if buckets else '', 'value': totals[peak_i] if totals else 0},
        'top_category': max(cat_totals, key=cat_totals.get) if cat_totals else None,
    }


def _growth(now_value, prev_value):
    return round((now_value - prev_value) / prev_value * 100, 1) if prev_value else None


def build_views(base, now=None):
    """The four views for `now` (aware datetime; default: current time). Pure and deterministic."""
    now = (now or datetime.now(tz=IST)).astimezone(IST)
    today = now.date()
    hour = now.hour
    frac = (now.minute * 60 + now.second) / 3600.0

    # DAILY – 24 hours of today
    daily = _view(base, [f'{h:02d}:00' for h in range(24)],
                  lambda c, h: c['daily'] * _day_factor(c, today) * HOUR_SHARE[h])
    yesterday = _day_total(base, today - timedelta(days=1))
    daily.update({'growth_pct': _growth(_day_total(base, today), yesterday), 'growth_label': 'vs yesterday'})

    # LIVE – today up to now; the current hour pro-rated to the second
    live = _view(base, [f'{h:02d}:00' for h in range(hour + 1)],
                 lambda c, h: c['daily'] * _day_factor(c, today) * HOUR_SHARE[h] * (frac if h == hour else 1.0))
    day_total = _day_total(base, today)

    def rate_at(h, f):
        w = HOUR_WEIGHTS[h] + (HOUR_WEIGHTS[(h + 1) % 24] - HOUR_WEIGHTS[h]) * f
        return day_total * w / _WEIGHT_SUM            # rupees per hour at that instant

    now_rate = rate_at(hour, frac)
    live.update({
        'now_index': hour,
        'now_label': now.strftime('%H:%M:%S'),
        'now_rate_per_hour': round(now_rate, 2),
        'today_so_far': live['total'],
        'growth_pct': _growth(now_rate, rate_at((hour - 1) % 24, frac)),
        'growth_label': 'rate vs one hour ago',
    })

    # WEEKLY – Mon..Sun of the current week
    monday = today - timedelta(days=today.weekday())
    week_days = [monday + timedelta(days=i) for i in range(7)]
    weekly = _view(base, [f'{DAY_LABELS[i]} {d.day}' for i, d in enumerate(week_days)],
                   lambda c, i: c['daily'] * _day_factor(c, week_days[i]))
    weekly.update({'today_index': today.weekday(), 'growth_pct': None,
                   'growth_label': 'no trend: the model has no history, so every week is projected alike'})

    # MONTHLY – Monday-based weeks of the current month, clipped to the month
    days_in_month = calendar.monthrange(today.year, today.month)[1]
    month_days = [date(today.year, today.month, d) for d in range(1, days_in_month + 1)]
    groups = []
    for d in month_days:
        if not groups or d.weekday() == 0:
            groups.append([])
        groups[-1].append(d)
    month_abbr = today.strftime('%b')
    labels = [f'{g[0].day}–{g[-1].day} {month_abbr}' if len(g) > 1 else f'{g[0].day} {month_abbr}' for g in groups]
    monthly = _view(base, labels, lambda c, i: sum(c['daily'] * _day_factor(c, d) for d in groups[i]))
    prev_last = today.replace(day=1) - timedelta(days=1)
    prev_total = sum(_day_total(base, prev_last.replace(day=d)) for d in range(1, prev_last.day + 1))
    monthly.update({'current_index': next(i for i, g in enumerate(groups) if today in g),
                    'growth_pct': _growth(monthly['total'], prev_total),
                    'growth_label': f'vs {prev_last.strftime("%B")} (days in month and weekday mix)'})

    return {
        'generated_at': now.isoformat(timespec='seconds'),
        'views': {'live': live, 'daily': daily, 'weekly': weekly, 'monthly': monthly},
    }


def payload(base, name, now=None, views=None):
    """API/WebSocket response for a base."""
    built = build_views(base, now)
    wanted = views or ['live', 'daily', 'weekly', 'monthly']
    return {
        'success': True,
        'is_estimate': True,
        'analysis_id': base.get('analysis_id'),
        'area': {'name': name, 'lat': base.get('lat'), 'lng': base.get('lng'), 'radius_m': base.get('radius_m')},
        'generated_at': built['generated_at'],
        'timezone': 'Asia/Kolkata',
        'confidence': base['confidence'],
        'assumptions': {
            'radius_m': base.get('radius_m'),
            'mapped_places': base['mapped_places'],
            'places_estimated': base['places_estimated'],
            'crowd_level': base['crowd_level'],
            'density_per_km2': base['density_per_km2'],
            'data_fetched_at': base['fetched_at'],
            'method': ('Sum of the revenue engine\'s daily estimates for the businesses found in OpenStreetMap '
                       'within the radius, spread over the day with the engine\'s hourly pattern and over the '
                       'week with fixed weekday/weekend multipliers. A model projection, not sales data.'),
            'weekday_multipliers': WEEKDAY_PROFILES,
        },
        'categories': [{'key': c['key'], 'label': c['label'], 'places': c['places']} for c in base['categories']],
        'views': {k: v for k, v in built['views'].items() if k in wanted},
    }


def fingerprint(base):
    """Short hash of a base (used in tests and logs)."""
    raw = '|'.join(f"{c['key']}:{c['daily']:.2f}" for c in base['categories'])
    return hashlib.sha1(raw.encode()).hexdigest()[:10]
