"""Part 2: projected revenue time series (/api/revenue-timeseries/) – service and API."""
import json
from datetime import datetime
from unittest.mock import patch

from django.core.cache import cache
from django.test import TestCase, override_settings

from business_intelligence import revenue_timeseries as ts
from report_generator.tests.fixtures import LAT, LON, auth_header, fake_overpass, signed_in

URL = '/api/revenue-timeseries/'
# Wednesday 28 Oct 2026, 18:42:10 IST
NOW = datetime(2026, 10, 28, 18, 42, 10, tzinfo=ts.IST)


def place(tag, value, daily, conf=70):
    return {'tags': {tag: value, 'name': value}, 'revenue_data': {'estimated_daily_revenue': daily, 'confidence_score': conf}}


def sample_base():
    places = [place('amenity', 'cafe', 10000), place('amenity', 'cafe', 5000), place('amenity', 'restaurant', 20000),
              place('amenity', 'school', 8000), place('amenity', 'pharmacy', 6000), place('shop', 'supermarket', 30000)]
    places += [place('shop', 'clothes', 1000 + i) for i in range(10)]
    base = ts.base_from_places(places, 4000, 'medium', 50.0, '2026-10-28T12:00:00+00:00')
    base.update({'analysis_id': 'abc', 'radius_m': 5000, 'lat': LAT, 'lng': LON})
    return base


class TimeSeriesModelTests(TestCase):
    def test_categories_are_grouped_and_sorted(self):
        base = sample_base()
        keys = [c['key'] for c in base['categories']]
        self.assertEqual(keys[0], 'supermarket')
        cafe = next(c for c in base['categories'] if c['key'] == 'cafe')
        self.assertEqual((cafe['daily'], cafe['places']), (15000, 2))
        self.assertIn('retail', keys)

    def test_deterministic_for_same_inputs_and_timestamp(self):
        self.assertEqual(ts.build_views(sample_base(), NOW), ts.build_views(sample_base(), NOW))
        later = ts.build_views(sample_base(), NOW.replace(second=40))['views']['live']
        self.assertGreater(later['today_so_far'], ts.build_views(sample_base(), NOW)['views']['live']['today_so_far'])

    def test_no_random_numbers(self):
        with patch('random.random', side_effect=AssertionError('random used')):
            ts.build_views(sample_base(), NOW)

    def test_radius_is_clamped_to_5_km(self):
        self.assertEqual(ts.clamp_radius(20000), 5000)
        self.assertEqual(ts.clamp_radius('3000'), 3000)
        self.assertEqual(ts.clamp_radius(10), 500)
        self.assertEqual(ts.clamp_radius('abc'), 5000)

    def test_totals_are_consistent_across_views(self):
        v = ts.build_views(sample_base(), NOW)['views']
        daily, weekly, monthly, live = v['daily'], v['weekly'], v['monthly'], v['live']
        # today's 24 hours == today's bar in the week
        self.assertAlmostEqual(daily['total'], weekly['totals'][weekly['today_index']], delta=1)
        # a full week of a flat base equals 7 x the engine's daily estimate
        engine_daily = sum(c['daily'] for c in sample_base()['categories'])
        self.assertAlmostEqual(weekly['total'], 7 * engine_daily, delta=2)
        # the month's buckets cover every day of October once
        self.assertEqual(len(monthly['buckets']), 5)   # 1–4, 5–11, 12–18, 19–25, 26–31 Oct
        oct_total = sum(ts._day_total(sample_base(), datetime(2026, 10, d).date()) for d in range(1, 32))
        self.assertAlmostEqual(monthly['total'], oct_total, delta=2)
        # the week of the 26th is inside the month bucket "26–31 Oct"
        self.assertEqual(monthly['buckets'][monthly['current_index']], '26–31 Oct')
        # live so far <= daily total and equals the sum of today's elapsed hours (+ pro-rated current hour)
        self.assertEqual(live['now_index'], 18)
        expected = sum(daily['totals'][:18]) + daily['totals'][18] * (42 * 60 + 10) / 3600
        self.assertAlmostEqual(live['today_so_far'], expected, delta=1)

    def test_weekday_profiles_average_one(self):
        for name, profile in ts.WEEKDAY_PROFILES.items():
            self.assertAlmostEqual(sum(profile), 7.0, places=9, msg=name)

    def test_hourly_shape_matches_the_engine(self):
        from business_intelligence.prediction_engine.config import TEMPORAL_PATTERNS
        v = ts.build_views(sample_base(), NOW)['views']['daily']
        self.assertEqual(v['peak']['label'], '19:00')          # engine's busiest hour (1.7)
        self.assertGreater(v['totals'][19], v['totals'][3])
        self.assertAlmostEqual(v['totals'][19] / v['totals'][10], TEMPORAL_PATTERNS[19][0] / TEMPORAL_PATTERNS[10][0], places=3)

    def test_low_confidence_for_few_places(self):
        base = ts.base_from_places([place('amenity', 'cafe', 1000)], 40)
        self.assertEqual(base['confidence']['level'], 'low')
        self.assertIn('low confidence', base['confidence']['note'])

    def test_payload_is_labelled_as_estimate(self):
        body = ts.payload(sample_base(), 'Uttarahalli', now=NOW)
        self.assertTrue(body['is_estimate'])
        self.assertEqual(set(body['views']), {'live', 'daily', 'weekly', 'monthly'})
        self.assertIn('not sales data', body['assumptions']['method'])
        self.assertEqual(body['assumptions']['radius_m'], 5000)


class TimeSeriesAPITests(TestCase):
    def setUp(self):
        cache.clear()

    def post(self, body, user='user-aaaaaaaa-1111'):
        with signed_in(user):
            return self.client.post(URL, json.dumps(body), content_type='application/json', **auth_header())

    def test_requires_sign_in(self):
        resp = self.client.post(URL, json.dumps({'lat': LAT, 'lng': LON}), content_type='application/json')
        self.assertEqual(resp.status_code, 401)

    def test_returns_four_views_from_the_cached_analysis(self):
        with fake_overpass() as overpass:
            first = self.post({'lat': LAT, 'lng': LON, 'radius': 99999, 'name': 'MG Road'})
            again = self.post({'lat': LAT, 'lng': LON, 'name': 'MG Road', 'views': ['live']})
            popular = self.client.post('/find-popular-places/', json.dumps({'latitude': LAT, 'longitude': LON}),
                                       content_type='application/json').json()
        self.assertEqual(first.status_code, 200, first.content)
        body = first.json()
        self.assertTrue(body['is_estimate'])
        self.assertEqual(body['area']['radius_m'], 5000)
        self.assertEqual(set(body['views']), {'live', 'daily', 'weekly', 'monthly'})
        self.assertGreater(body['views']['daily']['total'], 0)
        self.assertEqual(list(again.json()['views']), ['live'])
        self.assertEqual(overpass.call_count, 1, 'Overpass must not run again on refresh')
        # Same analysis as the map's Popular Places
        self.assertEqual(body['analysis_id'], popular['analysis_id'])
        engine_daily = sum(p['revenue_data']['estimated_daily_revenue'] for p in popular['places'])
        self.assertAlmostEqual(body['views']['weekly']['total'], engine_daily * 7, delta=engine_daily * 0.001 + 5)

    def test_validation(self):
        self.assertEqual(self.post({'lat': 'abc', 'lng': LON}).status_code, 400)
        self.assertEqual(self.post({'lat': 95, 'lng': LON}).status_code, 400)
        self.assertEqual(self.post({'lng': LON}).status_code, 400)

    def test_pending_while_area_data_is_fetched(self):
        with patch('business_intelligence.views.fetch_area_pois',
                   return_value={'status': 'pending', 'retry_after': 4, 'error': 'still fetching'}):
            resp = self.post({'lat': LAT, 'lng': LON})
        self.assertEqual(resp.status_code, 202)
        self.assertTrue(resp.json()['pending'])

    @patch('business_intelligence.views.ANALYTICS_RATE_LIMIT', 3)
    def test_rate_limit(self):
        with fake_overpass():
            codes = [self.post({'lat': LAT, 'lng': LON}).status_code for _ in range(5)]
        self.assertEqual(codes[:3], [200, 200, 200])
        self.assertEqual(codes[-1], 429)

    def test_changed_analysis_is_flagged(self):
        with fake_overpass():
            body = self.post({'lat': LAT, 'lng': LON, 'analysis_id': 'old-id'}).json()
        self.assertTrue(body['analysis_changed'])
