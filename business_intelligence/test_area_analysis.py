"""
Popular Places / crowd analysis (bugs 4 and 5): Overpass fetching, caching,
pending/stale behaviour, real counts instead of synthetic data, sector spread.
No network access: Overpass is mocked.
"""
import json
import time
from unittest.mock import patch

from django.core.cache import caches
from django.test import TestCase

from business_intelligence import analysis, utils
from report_generator.tests.fixtures import LAT, LON, clear_overpass_caches, fake_overpass, overpass_elements


def _resp(status, body):
    class R:
        status_code = status
        content = json.dumps(body).encode()

        def json(self):
            return body
    return R()


class OverpassFetchTests(TestCase):
    def setUp(self):
        clear_overpass_caches()
        self.addCleanup(clear_overpass_caches)

    def test_query_is_one_bbox_request_without_the_biased_350_cap(self):
        q = analysis._build_overpass_query(LAT, LON, 5000)
        self.assertIn('[bbox:', q)
        self.assertIn('out center tags qt;', q)
        self.assertNotIn('350', q)
        self.assertNotIn('around:', q)

    def test_failover_to_next_mirror_on_capacity_error(self):
        good = {'elements': [{'type': 'node', 'id': 1, 'lat': LAT, 'lon': LON, 'tags': {'amenity': 'cafe'}}]}
        replies = {analysis._OVERPASS_URLS[0]: _resp(502, {}), analysis._OVERPASS_URLS[1]: _resp(200, good)}
        with patch('business_intelligence.analysis.requests.post',
                   side_effect=lambda url, **kw: replies.get(url, _resp(504, {}))) as post, \
                self.assertLogs('business_intelligence.analysis', level='WARNING'):
            data, err = analysis._run_overpass_query('q-failover', timeout=10)
        self.assertIsNone(err)
        self.assertEqual(len(data['elements']), 1)
        self.assertTrue(data['is_live'])
        self.assertGreaterEqual(post.call_count, 2)

    def test_all_mirrors_down_returns_error_not_synthetic_data(self):
        with patch('business_intelligence.analysis.requests.post', return_value=_resp(502, {})), \
                patch('business_intelligence.analysis.time.sleep'), \
                self.assertLogs('business_intelligence.analysis', level='WARNING'):
            data, err = analysis._run_overpass_query('q-down', timeout=1)
        self.assertIsNone(data)
        self.assertIn('502', err)

    def test_partial_result_with_runtime_error_remark_is_rejected(self):
        partial = {'elements': [], 'remark': 'runtime error: Query timed out in "query" at line 3'}
        with patch('business_intelligence.analysis.requests.post', return_value=_resp(200, partial)), \
                patch('business_intelligence.analysis.time.sleep'):
            data, err = analysis._run_overpass_query('q-partial', timeout=1)
        self.assertIsNone(data)
        self.assertIn('timed out', err)

    def test_area_cache_hit_needs_no_network(self):
        with fake_overpass() as m:
            first = analysis.fetch_area_pois(LAT, LON, 5000)
            second = analysis.fetch_area_pois(LAT + 0.0001, LON, 5000)  # same ~110 m grid cell
        self.assertEqual(first['status'], 'ok')
        self.assertEqual(first['cache'], 'miss')
        self.assertEqual(second['cache'], 'hit')
        self.assertEqual(m.call_count, 1)

    def test_older_copy_is_served_instantly_while_refreshing(self):
        key = analysis._area_key(LAT, LON, 5000)
        caches['overpass'].set(key, {'elements': overpass_elements(), 'fetched_at': time.time() - 2 * analysis.AREA_FRESH_S})
        fresh = [{'type': 'node', 'id': 5, 'lat': LAT, 'lon': LON, 'tags': {'amenity': 'cafe'}}]

        def slow(*a, **kw):
            time.sleep(0.3)
            return {'elements': fresh}, None
        with patch('business_intelligence.analysis._run_overpass_query', side_effect=slow):
            started = time.monotonic()
            res = analysis.fetch_area_pois(LAT, LON, 5000)
            self.assertLess(time.monotonic() - started, 0.2)   # did not wait for Overpass
            self.assertEqual(res['cache'], 'refreshing')
            self.assertEqual(len(res['elements']), len(overpass_elements()))
            time.sleep(0.5)
            again = analysis.fetch_area_pois(LAT, LON, 5000)
        self.assertEqual(again['cache'], 'hit')
        self.assertEqual(again['elements'], fresh)

    def test_fresh_ttl_is_about_ten_minutes(self):
        self.assertEqual(analysis.AREA_FRESH_S, 600)

    def test_slow_overpass_returns_pending_and_keeps_fetching(self):
        def slow(*a, **kw):
            time.sleep(0.4)
            return {'elements': overpass_elements()}, None
        with patch('business_intelligence.analysis._run_overpass_query', side_effect=slow):
            first = analysis.fetch_area_pois(LAT, LON, 5000, wait_s=0.05)
            self.assertEqual(first['status'], 'pending')
            self.assertGreater(first['retry_after'], 0)
            time.sleep(0.6)
            second = analysis.fetch_area_pois(LAT, LON, 5000, wait_s=0.05)
        self.assertEqual(second['status'], 'ok')
        self.assertEqual(second['cache'], 'hit')


class PopularPlacesEndpointTests(TestCase):
    def post(self, url, body):
        return self.client.post(url, json.dumps(body), content_type='application/json')

    def test_real_counts_and_engine_revenue(self):
        with fake_overpass():
            resp = self.post('/find-popular-places/', {'latitude': LAT, 'longitude': LON, 'name': 'MG Road'})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        expected = len(analysis.elements_within(overpass_elements(), LAT, LON, 5000))
        self.assertEqual(data['active_sensors_count'], expected)
        self.assertNotEqual(data['active_sensors_count'], 100)
        self.assertEqual(data['analysis_radius'], 5000)
        self.assertEqual(data['center'], {'latitude': LAT, 'longitude': LON, 'name': 'MG Road'})
        revenue_sum = round(sum(p['revenue_data']['estimated_monthly_revenue'] for p in data['places']))
        self.assertAlmostEqual(data['total_area_revenue'], revenue_sum, delta=2)
        self.assertNotEqual(data['crowd_intensity']['estimated_revenue'], utils.predict_revenue(100))
        self.assertIn('Sum of revenue-engine estimates', data['estimated_revenue_basis'])
        for p in data['places']:
            self.assertNotIn('Estimated spatial signal model', json.dumps(p))
        self.assertEqual(len(data['recommendations']), 5)

    def test_overpass_failure_is_a_clear_error_not_fake_data(self):
        with fake_overpass(error='Overpass answered HTTP 502'):
            resp = self.post('/find-popular-places/', {'latitude': LAT, 'longitude': LON})
        self.assertEqual(resp.status_code, 503)
        body = resp.json()
        self.assertFalse(body['success'])
        self.assertIn('retry', body['error'].lower())
        self.assertNotIn('results', body)

    def test_crowd_endpoint_uses_the_same_single_fetch(self):
        with fake_overpass() as m:
            a = self.post('/find-popular-places/', {'latitude': LAT, 'longitude': LON}).json()
            b = self.post('/analyze-crowd-intensity/', {'latitude': LAT, 'longitude': LON}).json()
        self.assertEqual(m.call_count, 1)
        for level in ('high_intensity', 'medium_intensity', 'low_intensity'):
            self.assertEqual(a['crowd_intensity'][level], b[level])

    def test_invalid_coordinates(self):
        self.assertEqual(self.post('/find-popular-places/', {'latitude': 'x', 'longitude': 1}).status_code, 400)
        self.assertEqual(self.post('/analyze-crowd-intensity/', {'latitude': 95, 'longitude': 1}).status_code, 400)


class SectorAnalysisTests(TestCase):
    def test_places_are_spread_over_sectors(self):
        els = analysis.elements_within(overpass_elements(), LAT, LON, 5000)
        picked = analysis.sample_places_across_sectors(els, LAT, LON, 5000, limit=6)
        sectors = set()
        for el in picked:
            ring = min(int(el['distance_m'] / (5000 / 3)), 2)
            sectors.add(ring)
        named = [e for e in els if (e.get('tags') or {}).get('name')]
        first_six = sorted(named, key=lambda e: e['id'])[:6]
        # The old "first N in Overpass order" pick came from a single wedge.
        self.assertGreater(len({(e['tags'].get('amenity'), e['tags'].get('shop')) for e in picked}), 1)
        self.assertLessEqual(len(picked), 6)
        self.assertNotEqual([e['id'] for e in picked], [e['id'] for e in first_six])

    def test_levels_follow_density_not_raw_counts(self):
        # 60 features in an inner sector (2.9 km²) = 20/km² -> low, not "high".
        els = [{'type': 'node', 'id': i, 'lat': LAT + 0.004, 'lon': LON + 0.004, 'tags': {'shop': 'x'}} for i in range(60)]
        grid = analysis.classify_sectors(els, LAT, LON, 5000)
        self.assertEqual(len(grid['low']), 1)
        self.assertEqual(grid['low'][0]['count'], 60)
        self.assertEqual(grid['dominant'], 'low')

    def test_no_features_means_no_invented_area(self):
        grid = analysis.classify_sectors([], LAT, LON, 5000)
        self.assertTrue(grid['placeholder_used'])
        self.assertEqual(grid['high'] + grid['medium'] + grid['low'], [])
