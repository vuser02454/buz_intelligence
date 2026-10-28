"""
Location analysis shared by the HTTP views and the PDF report generator.

Moved out of views.py unchanged (ML helpers, Overpass helpers) plus the
sector classification and feasibility rules that used to live inline in the
analyze_crowd_intensity and check_feasibility views. Keeping one copy means
the report re-derives exactly what the website shows.
"""
import math

import requests

from pathlib import Path

# Load ML model, feature columns, and per-intensity business options at module load
_MODEL_DIR = Path(__file__).resolve().parent.parent / 'crowd_heatmap_project'
_MODEL_PATH = _MODEL_DIR / 'business_model.pkl'
_DATASET_PATH = _MODEL_DIR / 'business_dataset.csv'

_model = None
_feature_columns = None
_business_choices_by_intensity = {}
# Reset on module reload to pick up retrained model
_model = None


def _load_model():
    """
    Lazy-load model, expected feature columns, and business choices per
    crowd intensity (derived from the CSV used to train the model).
    """
    global _model, _feature_columns, _business_choices_by_intensity

    if _model is None:
        import pickle
        import pandas as pd
        with open(_MODEL_PATH, 'rb') as f:
            _model = pickle.load(f)

        # Get expected columns from training data (for get_dummies alignment)
        df = pd.read_csv(_DATASET_PATH)
        X = df[['crowd', 'shops', 'area']]
        X_dummies = pd.get_dummies(X)
        _feature_columns = X_dummies.columns.tolist()

        # Build a lookup of available businesses per intensity level,
        # e.g. {"high": ["cafe", "restaurant", ...], ...}
        _business_choices_by_intensity = (
            df.groupby('crowd')['business']
            .apply(lambda s: sorted(set(s.dropna())))
            .to_dict()
        )

    return _model, _feature_columns


def get_business_choices_for_intensity(intensity: str):
    """
    Return a list of business names from the CSV for the given intensity.
    Falls back to all known businesses if the intensity key is missing.
    """
    # Ensure model/dataset are initialized so the mapping is built
    _load_model()

    normalized = (intensity or '').strip().lower()
    if not normalized:
        normalized = 'low'

    choices = _business_choices_by_intensity.get(normalized)
    if choices:
        return choices

    # Fallback: flatten all unique businesses if specific intensity not found
    all_unique = set()
    for items in _business_choices_by_intensity.values():
        all_unique.update(items)
    return sorted(all_unique)


def get_all_business_choices():
    """
    Return the entire mapping {intensity: [business, ...]} derived from
    the training CSV so the frontend can stay in sync dynamically.
    """
    _load_model()
    # Shallow copy to avoid accidental mutation from callers
    return {k: list(v) for k, v in _business_choices_by_intensity.items()}


# Intensity mapping: intensity -> list of (shops, area) variants from dataset for variety
_INTENSITY_VARIANTS = {
    'high': [('high', 'commercial'), ('high', 'market'), ('medium', 'college'), ('high', 'mall'), ('medium', 'office')],
    'medium': [('medium', 'residential'), ('medium', 'commercial'), ('low', 'residential'), ('medium', 'city_center')],
    'low': [('low', 'outskirts'), ('low', 'industrial'), ('low', 'village'), ('low', 'storage')],
}


def _infer_area_from_pois(elements):
    """Infer area type from POI tags to vary ML prediction by location."""
    type_counts = {}
    for el in (elements or []):
        tags = el.get('tags') or {}
        t = tags.get('amenity') or tags.get('shop') or tags.get('tourism') or ''
        if t:
            type_counts[t] = type_counts.get(t, 0) + 1
    if not type_counts:
        return None
    # Map POI types to dataset area values
    if type_counts.get('restaurant', 0) + type_counts.get('cafe', 0) + type_counts.get('fast_food', 0) > 3:
        return 'commercial'
    if type_counts.get('school', 0) + type_counts.get('college', 0) + type_counts.get('university', 0) > 1:
        return 'college'
    if type_counts.get('hospital', 0) + type_counts.get('pharmacy', 0) > 1:
        return 'residential'
    if type_counts.get('mall', 0) or type_counts.get('market', 0):
        return 'market' if type_counts.get('market', 0) else 'mall'
    if type_counts.get('place_of_worship', 0) + type_counts.get('community_centre', 0) > 2:
        return 'residential'
    return None


def predict_business(intensity, area_hint=None):
    """
    Predict best business type based on crowd intensity and optional area hint.
    Uses area_hint to pick a (shops, area) variant so predictions vary by location.
    """
    intensity = (intensity or 'low').strip().lower()
    variants = _INTENSITY_VARIANTS.get(intensity, _INTENSITY_VARIANTS['low'])
    # If we have an area hint, try to use a variant that matches or fall back to first
    shops, area = variants[0]
    if area_hint:
        area_lower = area_hint.strip().lower()
        for s, a in variants:
            if a == area_lower:
                shops, area = s, a
                break
    crowd = intensity
    import pandas as pd
    data = pd.DataFrame([[crowd, shops, area]], columns=['crowd', 'shops', 'area'])
    data = pd.get_dummies(data)
    model, feature_columns = _load_model()
    data = data.reindex(columns=feature_columns, fill_value=0)
    prediction = model.predict(data)
    return str(prediction[0])


# ---------------------------------------------------------------------------
# Overpass (OpenStreetMap) access
#
# Public Overpass instances are often overloaded: the main instance answers
# "at capacity" (502) instantly and others queue requests for 20-40 s. So:
#   * one combined bbox query per area, with small [timeout]/[maxsize] so the
#     dispatcher admits it sooner, and `qt` output (no id-sorted 350 cap, which
#     returned a spatially biased subset);
#   * hedged requests: the next mirror starts if the current one has not
#     answered after a few seconds; retryable errors move on immediately and
#     whole rounds are retried with backoff;
#   * area results are cached persistently (CACHES['overpass']) by rounded
#     lat/lng + radius: fresh for 6 h, kept 7 days and served, labelled as
#     cached, when Overpass is unavailable;
#   * fetch_area_pois() waits a bounded time; if the data is not there yet the
#     fetch keeps running in the background and the caller gets status
#     'pending' so the UI can show progress and retry. Nothing is invented: the
#     old synthetic "fallback POIs" (always 100 of them) are gone.
# ---------------------------------------------------------------------------
import hashlib
import logging
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from concurrent.futures import wait as wait_futures
from datetime import datetime, timezone

from django.conf import settings
from django.core.cache import cache, caches
from django.core.cache.backends.base import InvalidCacheBackendError

logger = logging.getLogger(__name__)

_DEFAULT_OVERPASS_URLS = [
    "https://lz4.overpass-api.de/api/interpreter",
    "https://z.overpass-api.de/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
_OVERPASS_URLS = list(getattr(settings, 'OVERPASS_URLS', None) or _DEFAULT_OVERPASS_URLS)
_USER_AGENT = 'CrowdHeatmapApp/2.0 (Django Business Intelligence)'
_RETRYABLE_STATUS = {429, 500, 502, 503, 504}
HEDGE_AFTER_S = 4.0          # start the next mirror when the current one is this slow
MAX_PARALLEL_MIRRORS = 3
AREA_WAIT_S = float(getattr(settings, 'OVERPASS_WAIT_SECONDS', 18))   # per HTTP request
AREA_FETCH_BUDGET_S = 75     # background fetch keeps trying this long
AREA_FRESH_S = int(getattr(settings, 'OVERPASS_FRESH_SECONDS', 600))  # then served stale while refreshing
AREA_KEEP_S = 7 * 24 * 3600
_QUERY_CACHE_S = 900

_http_pool = ThreadPoolExecutor(max_workers=12, thread_name_prefix='overpass-http')
_area_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix='overpass-area')
_inflight = {}
_inflight_lock = threading.Lock()

# Amenity values that are street furniture, not businesses or footfall generators.
_NOISE_AMENITIES = ('bench|waste_basket|waste_disposal|recycling|parking_space|parking_entrance|'
                    'bicycle_parking|motorcycle_parking|toilets|drinking_water|shelter|telephone|'
                    'post_box|vending_machine|clock|grave_yard|hunting_stand|fountain|water_point|'
                    'letter_box|bbq|loading_dock|watering_place')
_LEISURE = 'fitness_centre|sports_centre|stadium|swimming_pool|park|playground|water_park|dance|bowling_alley'


def _area_cache():
    try:
        return caches['overpass']
    except InvalidCacheBackendError:
        return cache


def _haversine_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate the great circle distance between two points in meters."""
    r = 6371000.0  # Earth's radius in meters
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


def _bbox(lat, lon, radius_m):
    dlat = radius_m / 111320.0
    dlon = radius_m / (111320.0 * max(0.2, math.cos(math.radians(lat))))
    return lat - dlat, lon - dlon, lat + dlat, lon + dlon


def _build_overpass_query(lat: float, lon: float, radius: int = 5000) -> str:
    """
    One Overpass QL request for the commercial features in the square around
    the analysis circle (callers then keep only points within `radius`).
    A bbox is much cheaper for Overpass than 14 `around:` filters, and the
    small timeout/maxsize let busy servers admit the query sooner.
    """
    s, w, n, e = _bbox(float(lat), float(lon), int(radius))
    return f"""[out:json][timeout:25][maxsize:134217728][bbox:{s:.6f},{w:.6f},{n:.6f},{e:.6f}];
(
  nwr["amenity"]["amenity"!~"^({_NOISE_AMENITIES})$"];
  nwr["shop"];
  nwr["tourism"];
  nwr["office"];
  nwr["leisure"~"^({_LEISURE})$"];
  node["railway"="station"];
  node["public_transport"="station"];
  node["highway"="bus_stop"];
);
out center tags qt;
"""


def _post_overpass(url, query, timeout):
    """One HTTP request. Returns (data, error, retryable)."""
    started = time.monotonic()
    try:
        resp = requests.post(url, data={'data': query}, headers={'User-Agent': _USER_AGENT}, timeout=timeout)
    except requests.exceptions.Timeout:
        return None, f'Overpass timeout from {url}', True
    except requests.exceptions.RequestException as exc:
        return None, f'Overpass request error from {url}: {exc}', True
    elapsed = time.monotonic() - started
    if resp.status_code != 200:
        logger.warning('Overpass %s answered %s in %.1fs', url, resp.status_code, elapsed)
        return None, f'Overpass {url} answered HTTP {resp.status_code}', resp.status_code in _RETRYABLE_STATUS
    try:
        data = resp.json()
    except ValueError:
        return None, f'Invalid Overpass response from {url}', True
    if not isinstance(data, dict) or not isinstance(data.get('elements'), list):
        return None, f'Invalid Overpass response from {url}', True
    remark = str(data.get('remark') or '')
    if 'error' in remark.lower() or 'timed out' in remark.lower():
        # Partial result (the server gave up half way): not usable for counts.
        return None, f'Overpass {url}: {remark[:160]}', True
    logger.info('Overpass %s: %d elements in %.1fs', url, len(data['elements']), elapsed)
    return data, None, False


def _run_overpass_query(query: str, timeout: int = 25, lat: float = None, lon: float = None, radius: int = None):
    """
    Run `query` against the Overpass mirrors and return (data, error_message).

    Mirrors are hedged: a request starts on the first mirror, the next one is
    added if no answer arrived within HEDGE_AFTER_S (at most
    MAX_PARALLEL_MIRRORS at once), and a mirror that fails fast hands over
    immediately. After a full round of failures the round is retried with
    backoff while `timeout` seconds remain. Successful results are cached for
    15 minutes by query text. `lat`/`lon`/`radius` are accepted for backwards
    compatibility; area caching lives in fetch_area_pois().
    """
    cache_key = 'overpass_q_' + hashlib.md5(query.encode('utf-8')).hexdigest()
    cached = cache.get(cache_key)
    if cached:
        return cached, None

    deadline = time.monotonic() + max(1.0, float(timeout))
    last_error = 'Overpass API is unavailable'
    backoff = 1.0
    while time.monotonic() < deadline:
        queue = list(_OVERPASS_URLS)
        running = {}
        round_retryable = False
        while (queue or running) and time.monotonic() < deadline:
            while queue and len(running) < MAX_PARALLEL_MIRRORS and (not running or _all_slow(running)):
                url = queue.pop(0)
                per_request = max(1.0, min(40.0, deadline - time.monotonic()))
                running[_http_pool.submit(_post_overpass, url, query, per_request)] = time.monotonic()
            remaining = deadline - time.monotonic()
            done, _ = wait_futures(list(running), timeout=max(0.05, min(HEDGE_AFTER_S, remaining)),
                                   return_when=FIRST_COMPLETED)
            for fut in done:
                running.pop(fut, None)
                data, error, retryable = fut.result()
                if data is not None:
                    data['is_live'] = True
                    data['data_source'] = 'Verified live OpenStreetMap'
                    data['data_quality'] = 'Verified live'
                    cache.set(cache_key, data, timeout=_QUERY_CACHE_S)
                    return data, None
                last_error = error
                round_retryable = round_retryable or retryable
        if not round_retryable:
            break
        sleep_for = min(backoff, deadline - time.monotonic())
        if sleep_for <= 0:
            break
        time.sleep(sleep_for)
        backoff = min(backoff * 2, 8.0)
    return None, last_error


def _all_slow(running):
    now = time.monotonic()
    return all(now - started >= HEDGE_AFTER_S for started in running.values())


def _area_key(lat, lon, radius):
    return f'area_pois:v2:{round(float(lat), 3)}:{round(float(lon), 3)}:{int(radius)}'


def _fetch_area(key, lat, lon, radius):
    try:
        data, error = _run_overpass_query(_build_overpass_query(lat, lon, radius), timeout=AREA_FETCH_BUDGET_S)
        if data is not None:
            entry = {'elements': data.get('elements', []), 'fetched_at': time.time()}
            _area_cache().set(key, entry, timeout=AREA_KEEP_S)
            return entry, None
        return None, error
    finally:
        with _inflight_lock:
            _inflight.pop(key, None)


def fetch_area_pois(lat, lon, radius_m=None, wait_s=None):
    """
    POIs around (lat, lon) for the analysis radius, from cache or Overpass.

    Returns a dict:
      status       'ok' | 'pending' | 'error'
      elements     list of Overpass elements (status 'ok' only)
      is_live      True for data fetched from Overpass (now or from cache)
      stale        True when Overpass failed and an older cached copy is served
      fetched_at   ISO time the data was retrieved from OpenStreetMap
      cache        'hit' | 'miss' | 'stale'
      error, retry_after (seconds) for 'pending' / 'error'
    """
    radius_m = int(radius_m or HEATMAP_RADIUS_M)
    wait_s = AREA_WAIT_S if wait_s is None else wait_s
    key = _area_key(lat, lon, radius_m)
    store = _area_cache()
    cached = store.get(key)
    age = time.time() - cached['fetched_at'] if cached else None
    if cached and age < AREA_FRESH_S:
        return _area_ok(cached, 'hit')

    with _inflight_lock:
        fut = _inflight.get(key)
        if fut is None:
            fut = _area_pool.submit(_fetch_area, key, float(lat), float(lon), radius_m)
            _inflight[key] = fut
    if cached:
        # Stale-while-revalidate: answer instantly from the older copy (OpenStreetMap
        # changes slowly); the refresh started above replaces it for the next request.
        return _area_ok(cached, 'refreshing')
    try:
        entry, error = fut.result(timeout=wait_s)
    except FutureTimeout:
        if cached:
            return _area_ok(cached, 'stale')
        return {'status': 'pending', 'retry_after': 4,
                'error': 'OpenStreetMap (Overpass) is responding slowly. Still fetching the area data…'}
    if entry is not None:
        return _area_ok(entry, 'miss')
    if cached:
        return _area_ok(cached, 'stale')
    return {'status': 'error', 'retry_after': 15,
            'error': 'OpenStreetMap data could not be retrieved right now (all Overpass servers are busy). '
                     'Please retry in a minute.', 'detail': error}


def area_cache_status(lat, lon, radius_m=None):
    """
    Whether the area analysis for (lat, lon) is already cached – read only, never fetches.
    'fresh' (served instantly), 'stale' (served instantly and refreshed in the background
    on the next analysis) or 'none' (the next analysis fetches it from Overpass).
    """
    entry = _area_cache().get(_area_key(lat, lon, radius_m or HEATMAP_RADIUS_M))
    if not entry:
        return {'status': 'none'}
    age = time.time() - entry['fetched_at']
    return {'status': 'fresh' if age < AREA_FRESH_S else 'stale',
            'fetched_at': datetime.fromtimestamp(entry['fetched_at'], tz=timezone.utc).isoformat(timespec='seconds'),
            'places': len(entry['elements'])}


def _area_ok(entry, how):
    fetched = datetime.fromtimestamp(entry['fetched_at'], tz=timezone.utc)
    return {
        'status': 'ok',
        'elements': entry['elements'],
        'is_live': True,
        'stale': how == 'stale',
        'refreshing': how == 'refreshing',
        'cache': how,
        'fetched_at': fetched.isoformat(timespec='seconds'),
        'data_source': 'OpenStreetMap (Overpass API)' + {'stale': ' – cached copy, live refresh failed',
                                                         'refreshing': ' – cached copy, refreshing in the background'}.get(how, ''),
    }


def sample_places_across_sectors(elements, lat, lon, radius_m, limit=30):
    """
    Up to `limit` named businesses spread over the whole analysis circle:
    round-robin over the 9 sectors, nearest first inside each sector. (Taking
    the first N in Overpass order put every marker in one corner of the map.)
    """
    buckets = {}
    for el in elements:
        tags = el.get('tags') or {}
        if not tags.get('name') or not (tags.get('amenity') or tags.get('shop') or tags.get('tourism')):
            continue
        e_lat = el.get('lat') or (el.get('center') or {}).get('lat')
        e_lon = el.get('lon') or (el.get('center') or {}).get('lon')
        if e_lat is None or e_lon is None:
            continue
        dist = el.get('distance_m')
        if dist is None:
            dist = _haversine_distance_m(lat, lon, float(e_lat), float(e_lon))
        if dist > radius_m:
            continue
        ring = min(int(dist / (radius_m / 3.0)), 2)
        wedge = int((math.degrees(math.atan2(float(e_lat) - lat, float(e_lon) - lon)) + 180) / 120) % 3
        buckets.setdefault(f'{ring}_{wedge}', []).append((dist, el))
    for items in buckets.values():
        items.sort(key=lambda pair: pair[0])
    picked = []
    queues = [buckets[k] for k in sorted(buckets)]
    while len(picked) < limit and any(queues):
        for q in queues:
            if q and len(picked) < limit:
                picked.append(q.pop(0)[1])
    return picked


def elements_within(elements, lat, lon, radius_m):
    """Elements with coordinates inside the circle, each with `distance_m` added."""
    out = []
    for el in elements or []:
        e_lat = el.get('lat') or (el.get('center') or {}).get('lat')
        e_lon = el.get('lon') or (el.get('center') or {}).get('lon')
        if e_lat is None or e_lon is None:
            continue
        dist = _haversine_distance_m(lat, lon, float(e_lat), float(e_lon))
        if dist <= radius_m:
            item = dict(el)
            item['distance_m'] = round(dist, 1)
            out.append(item)
    return out


# ---------------------------------------------------------------------------
# Sector grid (heatmap) and feasibility rules (5 km analysis radius)
# ---------------------------------------------------------------------------

HEATMAP_RADIUS_M = 5000
# Sector levels are thresholds on mapped-feature *density*. Raw counts made
# every sector of a real city "High" (thousands of features in 5 km) and
# favoured the outer ring, whose sectors are 5x larger than the inner ones.
HIGH_DENSITY_PER_KM2 = 60
MEDIUM_DENSITY_PER_KM2 = 25

_REASONING = {
    'high': 'High foot traffic in commercial area — ideal for food, retail, and services.',
    'medium': 'Moderate crowd in residential area — good for essentials like grocery, pharmacy.',
    'low': 'Low traffic in outskirts — suited for storage, warehouse, or niche ventures.',
}

_BEST_TIMES = {
    'high': 'Peak hours 10am–8pm. Morning (6–10am) has lower competition.',
    'medium': 'Steady flow 9am–7pm. Evening slightly busier.',
    'low': 'Flexible timing. Consider proximity to transport for visibility.',
}


def _group_into_sectors(elements, lat, lon, radius_m, with_details=False):
    """
    Bucket POIs into 9 sectors: 3 distance rings of radius/3 metres times
    3 compass wedges of 120°. Key is "<ring>_<wedge>". POIs outside the
    radius (or without coordinates) are dropped.
    """
    sector_size = radius_m / 3
    sectors = {}
    for element in elements:
        elem_lat = element.get('lat') or (element.get('center', {}).get('lat'))
        elem_lon = element.get('lon') or (element.get('center', {}).get('lon'))
        if not elem_lat or not elem_lon:
            continue

        # Calculate distance from center
        R = 6371000  # Earth radius in meters
        lat1_rad = math.radians(lat)
        lat2_rad = math.radians(elem_lat)
        delta_lat = math.radians(elem_lat - lat)
        delta_lon = math.radians(elem_lon - lon)

        a = math.sin(delta_lat/2)**2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(delta_lon/2)**2
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
        distance = R * c

        if distance > radius_m:
            continue

        # Sector based on angle and distance
        angle = math.atan2(elem_lat - lat, elem_lon - lon)
        angle_deg = math.degrees(angle) + 180  # 0-360
        angle_sector = int(angle_deg / 120)  # 0-2
        dist_sector = int(distance / sector_size)  # 0-2
        sector_key = f"{dist_sector}_{angle_sector}"

        if sector_key not in sectors:
            sectors[sector_key] = []
        poi = {'lat': elem_lat, 'lon': elem_lon}
        if with_details:
            tags = element.get('tags', {})
            poi['name'] = tags.get('name', 'Unknown')
            poi['type'] = tags.get('amenity') or tags.get('shop') or tags.get('tourism', 'Unknown')
        sectors[sector_key].append(poi)
    return sectors


def sector_area_km2(sector_key, radius_m):
    """Area of one of the 9 sectors (a third of a ring) in km²."""
    ring = min(int(str(sector_key).split('_')[0]), 2)
    step = radius_m / 3.0
    return math.pi * (((ring + 1) * step) ** 2 - (ring * step) ** 2) / 3.0 / 1e6


def intensity_for_density(per_km2):
    if per_km2 >= HIGH_DENSITY_PER_KM2:
        return 'high'
    if per_km2 >= MEDIUM_DENSITY_PER_KM2:
        return 'medium'
    return 'low'


def classify_sectors(elements, lat, lon, radius_m=HEATMAP_RADIUS_M):
    """
    Heatmap classification used by /analyze-crowd-intensity/ and the reports.

    Each of the 9 sectors is classified by its density of mapped features.
    Returns the three area lists in the endpoint's response shape, the dominant
    intensity (from the density of the whole circle) and `placeholder_used`,
    which is True when no feature with coordinates was found: then nothing is
    drawn (no synthetic area is invented any more).
    """
    sectors = _group_into_sectors(elements, lat, lon, radius_m, with_details=True)

    areas = {'high': [], 'medium': [], 'low': []}
    total = 0
    for sector_key, pois in sorted(sectors.items()):
        count = len(pois)
        total += count
        area_km2 = sector_area_km2(sector_key, radius_m)
        density = count / area_km2 if area_km2 else 0
        areas[intensity_for_density(density)].append({
            'latitude': sum(p['lat'] for p in pois) / count,
            'longitude': sum(p['lon'] for p in pois) / count,
            'count': count,
            'sector': sector_key,
            'area_km2': round(area_km2, 2),
            'density_per_km2': round(density, 1),
        })

    circle_km2 = math.pi * (radius_m / 1000.0) ** 2
    overall = total / circle_km2 if circle_km2 else 0
    return {
        'high': areas['high'],
        'medium': areas['medium'],
        'low': areas['low'],
        'dominant': intensity_for_density(overall) if total else 'low',
        'density_per_km2': round(overall, 1),
        'total_in_radius': total,
        'placeholder_used': total == 0,
    }


def build_business_prediction(dominant, elements):
    """ML business prediction block returned by /analyze-crowd-intensity/."""
    area_hint = _infer_area_from_pois(elements)
    primary = predict_business(dominant, area_hint=area_hint)
    # Business options sourced directly from the CSV
    csv_choices = get_business_choices_for_intensity(dominant)
    alternatives = []
    for alt_level in ['high', 'medium', 'low']:
        if alt_level != dominant:
            alt_biz = predict_business(alt_level)
            if alt_biz and alt_biz != primary and alt_biz not in [a['business'] for a in alternatives]:
                alternatives.append({'business': alt_biz, 'intensity': alt_level})

    return {
        'primary': primary,
        'reasoning': _REASONING.get(dominant, ''),
        'alternatives': alternatives[:2],
        'best_times': _BEST_TIMES.get(dominant, ''),
        'choices': csv_choices,
        'intensity': dominant,
        'area_hint': area_hint,
    }


def build_feasibility_query(lat, lon):
    """The feasibility check only looks at amenity/shop/tourism POIs."""
    return f"""
        [out:json][timeout:15];
        (
          node["amenity"](around:2000,{lat},{lon});
          way["amenity"](around:2000,{lat},{lon});
          node["shop"](around:2000,{lat},{lon});
          way["shop"](around:2000,{lat},{lon});
          node["tourism"](around:2000,{lat},{lon});
          way["tourism"](around:2000,{lat},{lon});
        );
        out center;
        """


_FEASIBILITY_SYNONYMS = {
    'grocery_shop': 'supermarket',
    'grocery': 'supermarket',
    'medical_store': 'pharmacy',
    'chemist': 'pharmacy',
    'pub': 'restaurant',
    'bar': 'restaurant',
    'coffee_shop': 'cafe',
    'book_shop': 'book_store',
    'cloth_store': 'clothing_store',
    'garments': 'clothing_store',
}


def evaluate_feasibility(elements, lat, lon, business_type):
    """
    Go/No-Go rules used by /check-feasibility/. Returns the endpoint's fields
    plus the evidence behind the decision (which rules fired, sector counts).
    """
    sectors = _group_into_sectors(elements, lat, lon, 2000)
    # --- DYNAMIC FEASIBILITY CORRECTION ---
    # 1. Prepare candidate types (synonyms + normalization)
    biz_normalized = business_type.lower().replace(' ', '_').strip()
    if biz_normalized.endswith('_business'):
        biz_normalized = biz_normalized[:-9]
    search_target = _FEASIBILITY_SYNONYMS.get(biz_normalized, biz_normalized)

    # 2. Check actual POI frequency in the area to provide "Dynamic Evidence"
    # If the area already has many of these businesses, it's proven to be a feasible location.
    found_count = 0
    for element in elements:
        tags = element.get('tags', {})
        # Check amenity, shop, or name for the business type
        poi_type = (tags.get('amenity') or tags.get('shop') or tags.get('tourism') or '').lower()
        poi_name = tags.get('name', '').lower()
        if biz_normalized in poi_type or search_target in poi_type or biz_normalized in poi_name:
            found_count += 1

    high_c, medium_c, low_c = 0, 0, 0
    for key, pois in sectors.items():
        level = intensity_for_density(len(pois) / sector_area_km2(key, 2000))
        if level == 'high':
            high_c += 1
        elif level == 'medium':
            medium_c += 1
        else:
            low_c += 1

    dominant = 'low'
    if high_c > 0:
        dominant = 'high'
    elif medium_c > 0:
        dominant = 'medium'

    allowed_businesses = [b.lower().replace(' ', '_') for b in get_business_choices_for_intensity(dominant)]
    recommended_primary = predict_business(dominant, _infer_area_from_pois(elements)).lower().replace(' ', '_')

    evidence = {
        'similar_businesses_found': found_count,
        'in_dataset_for_intensity': False,
        'matches_ml_recommendation': False,
        'local_proof': False,
        'high_intensity_retail_rule': False,
        'sector_counts': {'high': high_c, 'medium': medium_c, 'low': low_c},
        'allowed_businesses': allowed_businesses,
    }

    if business_type:
        # 3. Final Feasibility Decision (Permissive)
        # Feasible if:
        # - Matches CSV intensity list
        # - Matches ML primary recommendation
        # - Many similar businesses already exist in the area (dynamic proof)
        # - High intensity areas are generally feasible for most services
        is_in_dataset = (biz_normalized in allowed_businesses or search_target in allowed_businesses)
        is_recommended = (biz_normalized == recommended_primary or search_target == recommended_primary)
        has_local_proof = (found_count >= 2)  # If at least 2 exist, it's definitely feasible

        feasible = is_in_dataset or is_recommended or has_local_proof
        evidence.update({
            'in_dataset_for_intensity': is_in_dataset,
            'matches_ml_recommendation': is_recommended,
            'local_proof': has_local_proof,
        })

        # Bonus: High intensity is feasible for almost anything retail/food
        if not feasible and dominant == 'high' and ('shop' in biz_normalized or 'store' in biz_normalized or 'food' in biz_normalized):
            feasible = True
            evidence['high_intensity_retail_rule'] = True

        if feasible:
            if has_local_proof:
                message = f'✅ Feasible: We found {found_count} similar businesses in the area, confirming this is a strong location for a "{business_type}".'
            else:
                message = f'✅ Feasible: A "{business_type}" matches the {dominant} crowd profile and development level of this area.'
        else:
            message = f'❌ Not feasible: The area currently has {dominant} intensity and low indicators for "{business_type}". Consider a {recommended_primary.replace("_", " ")} instead.'
    else:
        feasible = True
        message = f'Location analyzed. Dominant crowd intensity is {dominant}. We recommend starting a {recommended_primary.replace("_", " ")} here.'

    return {
        'feasible': feasible,
        'dominant_intensity': dominant,
        'message': message,
        'recommended_business': recommended_primary,
        'evidence': evidence,
    }


def feasibility_elements(elements):
    """Features the feasibility rules look at: those with an amenity, shop or tourism tag."""
    return [el for el in elements if any(k in (el.get('tags') or {}) for k in ('amenity', 'shop', 'tourism'))]


def feasibility_reasons(verdict):
    """Plain-language reasons behind evaluate_feasibility()'s Go/No-Go decision."""
    ev = verdict.get('evidence') or {}
    counts = ev.get('sector_counts') or {}
    reasons = [f"Dominant crowd level within 2 km: {verdict.get('dominant_intensity', 'unknown')} "
               f"({counts.get('high', 0)} high, {counts.get('medium', 0)} medium, {counts.get('low', 0)} low-density sectors)."]
    found = ev.get('similar_businesses_found', 0)
    reasons.append(f"{found} similar business{'es' if found != 1 else ''} already mapped within 2 km"
                   + (' – proven local demand.' if ev.get('local_proof') else '.'))
    if ev.get('in_dataset_for_intensity'):
        reasons.append('The category is typical for this crowd level in the training data.')
    if ev.get('matches_ml_recommendation'):
        reasons.append('It matches the ML model\'s top recommendation for this area.')
    if ev.get('high_intensity_retail_rule'):
        reasons.append('High-footfall area: retail and food formats are generally viable.')
    if not verdict.get('feasible'):
        reasons.append(f"Suggested alternative: {str(verdict.get('recommended_business', '')).replace('_', ' ')}.")
    return reasons


# Rough set-up cost (INR), operating-cost share of revenue, icon and the OSM
# tag values that count as competitors. Used to turn the revenue engine's
# gross-sales estimate into profit and break-even; unknown categories get the
# generic row. These are planning assumptions and are labelled as such.
_REC_DEFAULT = (1_500_000, 0.65, 'fas fa-store', None)
_REC_CATALOG = {
    'cafe': (1_500_000, 0.60, 'fas fa-coffee', ('cafe',)),
    'coffee_shop': (1_500_000, 0.60, 'fas fa-coffee', ('cafe',)),
    'restaurant': (3_000_000, 0.65, 'fas fa-utensils', ('restaurant',)),
    'fast_food': (1_200_000, 0.62, 'fas fa-hamburger', ('fast_food',)),
    'food_court': (2_000_000, 0.62, 'fas fa-utensils', ('food_court', 'fast_food')),
    'street_food_stall': (300_000, 0.55, 'fas fa-hotdog', ('fast_food',)),
    'tiffin_service': (400_000, 0.60, 'fas fa-utensils', ('fast_food', 'restaurant')),
    'juice_bar': (500_000, 0.55, 'fas fa-glass-whiskey', ('juice', 'cafe')),
    'ice_cream_parlour': (700_000, 0.58, 'fas fa-ice-cream', ('ice_cream',)),
    'bakery': (1_000_000, 0.60, 'fas fa-bread-slice', ('bakery',)),
    'sweet_shop': (1_000_000, 0.62, 'fas fa-cookie', ('confectionery', 'pastry', 'bakery')),
    'supermarket': (4_000_000, 0.80, 'fas fa-shopping-basket', ('supermarket', 'convenience')),
    'grocery_store': (1_000_000, 0.82, 'fas fa-shopping-basket', ('convenience', 'supermarket', 'greengrocer')),
    'vegetable_shop': (300_000, 0.80, 'fas fa-carrot', ('greengrocer',)),
    'fruit_shop': (300_000, 0.80, 'fas fa-apple-alt', ('greengrocer',)),
    'milk_booth': (200_000, 0.85, 'fas fa-glass-whiskey', ('dairy',)),
    'pharmacy': (1_200_000, 0.75, 'fas fa-prescription-bottle-alt', ('pharmacy', 'chemist')),
    'medical_store': (1_200_000, 0.75, 'fas fa-prescription-bottle-alt', ('pharmacy', 'chemist')),
    'optical_store': (1_000_000, 0.65, 'fas fa-glasses', ('optician',)),
    'gym': (2_500_000, 0.55, 'fas fa-dumbbell', ('fitness_centre', 'gym', 'sports_centre')),
    'salon': (800_000, 0.55, 'fas fa-cut', ('hairdresser', 'beauty')),
    'laundry_service': (600_000, 0.60, 'fas fa-tshirt', ('laundry', 'dry_cleaning')),
    'tailoring_shop': (300_000, 0.55, 'fas fa-cut', ('tailor',)),
    'clothing_store': (1_500_000, 0.70, 'fas fa-tshirt', ('clothes', 'boutique')),
    'clothing_boutique': (1_500_000, 0.70, 'fas fa-tshirt', ('clothes', 'boutique')),
    'footwear_store': (1_200_000, 0.72, 'fas fa-shoe-prints', ('shoes',)),
    'mobile_shop': (800_000, 0.82, 'fas fa-mobile-alt', ('mobile_phone', 'electronics')),
    'electronics_store': (2_500_000, 0.82, 'fas fa-tv', ('electronics', 'computer')),
    'hardware_store': (1_500_000, 0.78, 'fas fa-tools', ('hardware', 'doityourself')),
    'stationery_shop': (400_000, 0.75, 'fas fa-pen', ('stationery',)),
    'book_store': (800_000, 0.75, 'fas fa-book', ('books',)),
    'jewellery_store': (5_000_000, 0.85, 'fas fa-gem', ('jewelry',)),
    'cosmetics_store': (1_000_000, 0.72, 'fas fa-spa', ('cosmetics', 'beauty')),
    'pet_shop': (800_000, 0.70, 'fas fa-paw', ('pet',)),
    'coaching_centre': (1_000_000, 0.55, 'fas fa-chalkboard-teacher', ('school', 'college', 'training')),
    'tuition_centre': (500_000, 0.50, 'fas fa-chalkboard-teacher', ('school', 'training')),
    'auto_repair_shop': (1_000_000, 0.60, 'fas fa-car', ('car_repair',)),
    'cycle_repair': (150_000, 0.50, 'fas fa-bicycle', ('bicycle',)),
    'spare_parts_shop': (1_000_000, 0.80, 'fas fa-cogs', ('car_parts',)),
}
_ENGINE_ALIASES = {'coffee_shop': 'cafe', 'medical_store': 'pharmacy', 'grocery_store': 'supermarket',
                   'street_food_stall': 'fast_food', 'tiffin_service': 'fast_food', 'food_court': 'restaurant'}


def _poi_type(tags):
    return (tags.get('amenity') or tags.get('shop') or tags.get('leisure') or tags.get('office') or '').lower()


def _rec_key(name):
    return str(name or '').strip().lower().replace('-', ' ').replace(' ', '_')


def recommendation_candidates(dominant, elements):
    """
    Candidate businesses: the ML model's primary + alternatives (weighted),
    the CSV categories for this crowd level, and every category the revenue
    engine models. Returns [(display_name, ml_role, preferred_level)].
    """
    out, seen = [], set()

    def add(name, role, level):
        key = _rec_key(name)
        if key and key not in seen and key not in ('default', 'shop'):
            seen.add(key)
            out.append((str(name).replace('_', ' ').title() if name.islower() else str(name), role, level))

    try:
        pred = build_business_prediction(dominant, elements)
    except Exception:
        logger.exception('ML prediction failed for recommendations')
        pred = None
    if pred:
        add(pred['primary'], 'primary', dominant)
        for alt in pred.get('alternatives') or []:
            add(alt['business'], 'alternative', alt.get('intensity', dominant))
        for choice in pred.get('choices') or []:
            add(choice, 'choice', dominant)
    from .prediction_engine.config import BUSINESS_METRICS
    for key in BUSINESS_METRICS:
        add(key, 'engine', dominant)
    return out


def generate_location_business_recommendations(lat: float, lon: float, radius_m: int = 5000,
                                               location_name: str = 'Selected Location', elements: list = None,
                                               category: str = None, limit: int = 5) -> list:
    """Top recommendations only (see recommend_businesses)."""
    return recommend_businesses(lat, lon, radius_m, location_name, elements, category, limit)['recommendations']


def recommend_businesses(lat: float, lon: float, radius_m: int = 5000, location_name: str = 'Selected Location',
                         elements: list = None, category: str = None, limit: int = 5) -> dict:
    """
    Top business opportunities for the 5 km circle around (lat, lon), from the
    area's real data: the ML model proposes candidates, each is placed in the
    sector that best suits it (its crowd level, fewest same-category places
    within 1 km), and the revenue engine estimates gross sales there. Profit
    and break-even use the planning assumptions in _REC_CATALOG.
    `category` limits the result to one business category.

    Every candidate also gets a Business Synergy analysis at its spot (how nearby
    businesses and surroundings could help it). The ranking itself is unchanged;
    `comparison` names the best pick by the existing model, by synergy, and overall.
    """
    from . import synergy, utils
    from .prediction_engine.config import BUSINESS_METRICS

    empty = {'recommendations': [], 'comparison': None}
    if elements is None:
        fetched = fetch_area_pois(lat, lon, radius_m)
        if fetched['status'] != 'ok':
            return empty
        elements = elements_within(fetched['elements'], lat, lon, radius_m)
    if not elements:
        return empty

    grid = classify_sectors(elements, lat, lon, radius_m)
    sectors = [dict(area, level=level) for level in ('high', 'medium', 'low') for area in grid[level]]
    if not sectors:
        return empty
    synergy_area = synergy.AreaSynergy(elements)
    # Place types within 1 km of each sector centre (for competition), computed once.
    typed = [(float(el.get('lat') or el['center']['lat']), float(el.get('lon') or el['center']['lon']), _poi_type(el.get('tags') or {}))
             for el in elements if (el.get('lat') or el.get('center')) and _poi_type(el.get('tags') or {})]
    for sec in sectors:
        sec['nearby_types'] = [t for (a, b, t) in typed if _haversine_distance_m(sec['latitude'], sec['longitude'], a, b) <= 1000]

    clean_loc = (location_name or 'Selected Area').split(',')[0].strip()
    wanted = _rec_key(category) if category else None
    scored = []
    for name, role, level in recommendation_candidates(grid['dominant'], elements):
        key = _rec_key(name)
        if wanted and wanted != key and wanted not in key:
            continue
        setup_cost, opex_ratio, icon, osm_keys = _REC_CATALOG.get(key, _REC_DEFAULT)
        osm_keys = osm_keys or (key,)
        comp_count = lambda sec: sum(1 for t in sec['nearby_types'] if t in osm_keys)
        pool = [s for s in sectors if s['level'] == level] or sectors
        best = min(pool, key=lambda s: (comp_count(s), -s.get('density_per_km2', 0)))
        competitors = comp_count(best)
        competitors_area = sum(1 for (_a, _b, t) in typed if t in osm_keys)

        engine_key = _ENGINE_ALIASES.get(key, key)
        rev = utils.calculate_smart_revenue(elements, business_type=engine_key, lat=best['latitude'], lon=best['longitude'])
        monthly = float(rev.get('monthly_revenue') or 0)
        if monthly <= 0:
            continue
        costs = monthly * opex_ratio
        profit = monthly - costs
        break_even = round(setup_cost / profit, 1) if profit > 0 else None
        uses_default = engine_key not in BUSINESS_METRICS
        ml_bonus = {'primary': 15, 'alternative': 6, 'choice': 8}.get(role, 0)
        # Categories the engine has no parameters for all get the same generic
        # figure, so they rank below categories it actually models.
        score = (rev.get('potential_score', 0) + ml_bonus - min(15, competitors * 1.5)
                 - (15 if uses_default else 0))
        comp_level = 'Low' if competitors <= 1 else ('Moderate' if competitors <= 5 else 'High')
        reasons = [
            f"{best['level'].capitalize()}-activity sector ({best.get('density_per_km2', 0)} mapped places/km²) "
            f"{round(_haversine_distance_m(lat, lon, best['latitude'], best['longitude']) / 1000, 1)} km from {clean_loc}.",
            f"{competitors} same-category place{'s' if competitors != 1 else ''} within 1 km of that spot "
            f"({competitors_area} in the whole 5 km area).",
            f"Revenue engine: ≈₹{int(monthly):,}/month gross sales, potential {rev.get('potential_score', 0)}/100"
            + (' (generic assumptions for this category).' if uses_default else '.'),
        ]
        if role == 'primary':
            reasons.insert(0, "The ML model's top recommendation for this area.")
        elif role in ('alternative', 'choice'):
            reasons.append(f'Suggested by the ML model for {level}-crowd areas.')
        scored.append((score, {
            'id': f"rec_{key}_{abs(hash((key, round(lat, 4), round(lon, 4)))) % 100000}",
            'name': name,
            'category': key,
            'engine_category': engine_key,
            'locality': clean_loc,
            'badge': {'primary': 'ML top pick', 'alternative': 'ML alternative', 'choice': 'Fits crowd profile'}.get(role, 'Revenue engine'),
            'icon': icon,
            'target_lat': round(best['latitude'], 6),
            'target_lon': round(best['longitude'], 6),
            'crowd_level': best['level'],
            'starting_monthly_revenue': int(round(monthly, -2)),
            'estimated_monthly_costs': int(round(costs, -2)),
            'estimated_monthly_profit': int(round(profit, -2)),
            'setup_cost_estimate': setup_cost,
            'break_even_months': break_even,
            'potential_score': rev.get('potential_score', 0),
            'confidence_score': rev.get('confidence_score'),
            'competitors_1km': competitors,
            'competitors_area': competitors_area,
            'competition_level': comp_level,
            'expected_demand': {'high': 'High', 'medium': 'Moderate', 'low': 'Low'}[best['level']],
            'ml_match': role in ('primary', 'alternative', 'choice'),
            'reasons': reasons,
            'assumptions': f'Profit uses an operating-cost share of {int(opex_ratio * 100)}% and set-up cost ≈₹{setup_cost:,} (planning assumptions).',
            'data_source': 'OpenStreetMap + ML model + revenue engine',
            'confidence': f"{rev.get('confidence_score', '—')}/100 engine confidence",
            'uses_default_assumptions': uses_default,
            'is_estimate': True,
        }))
    for model_score, rec in scored:
        full = synergy_area.analyze(rec['target_lat'], rec['target_lon'], rec['category'], rec['starting_monthly_revenue'],
                                    competitor_types=_REC_CATALOG.get(rec['category'], _REC_DEFAULT)[3] or (rec['category'],),
                                    location_name=clean_loc)
        rec['synergy'] = synergy.summary(full)
        rec['model_score'] = round(max(0.0, min(100.0, model_score)), 1)
        # Overall = existing model ranking (60%) + synergy potential (40%).
        rec['overall_score'] = round(0.6 * rec['model_score'] + 0.4 * full['score'], 1)

    scored.sort(key=lambda pair: pair[0], reverse=True)
    recs = [rec for _score, rec in scored[:limit]]
    for i, rec in enumerate(recs, 1):
        rec['rank'] = i
    return {'recommendations': recs, 'comparison': _compare_picks([r for _s, r in scored])}


def _compare_picks(candidates):
    """Best by the existing model, best by synergy potential, best overall (from all candidates, not just the top 5)."""
    if not candidates:
        return None
    pick = lambda key: max(candidates, key=lambda r: (r[key], r['starting_monthly_revenue']))
    brief = lambda r, why: {'name': r['name'], 'category': r['category'], 'rank': r.get('rank'),
                            'model_score': r['model_score'], 'synergy_score': r['synergy']['score'],
                            'synergy_level': r['synergy']['level'], 'overall_score': r['overall_score'],
                            'monthly_revenue': r['starting_monthly_revenue'],
                            'moderate_monthly': r['synergy']['scenarios']['moderate']['monthly'],
                            'target_lat': r['target_lat'], 'target_lon': r['target_lon'], 'why': why}
    model = candidates[0]  # candidates arrive in the model's ranking order
    syn = max(candidates, key=lambda r: (r['synergy']['score'], r['starting_monthly_revenue']))
    overall = pick('overall_score')
    return {
        'model': brief(model, 'Highest ranking from the existing ML + revenue-engine recommendation.'),
        'synergy': brief(syn, 'Strongest help from nearby businesses and surroundings.'),
        'overall': brief(overall, 'Best combined: 60% existing model ranking + 40% synergy potential.'),
        'method': 'Overall score = 0.6 × model score (0–100) + 0.4 × synergy potential score (0–100).',
    }
