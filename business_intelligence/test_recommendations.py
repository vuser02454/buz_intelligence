"""Bug 9: dynamic Top 5 Business Recommendations (ML candidates + revenue engine + local competition)."""
import json
import math
from unittest.mock import patch

from django.test import TestCase

from business_intelligence import analysis, utils
from report_generator.tests.fixtures import LAT, LON, fake_overpass, overpass_elements

URL = '/api/location-recommendations/'


def _ring(n, tags, ring_m, lat=LAT, lon=LON, start_id=1):
    els = []
    for i in range(n):
        b = math.radians(i * 360 / max(n, 1))
        els.append({'type': 'node', 'id': start_id + i, 'tags': tags,
                    'lat': lat + ring_m * math.cos(b) / 110540, 'lon': lon + ring_m * math.sin(b) / (111320 * math.cos(math.radians(lat)))})
    return els


def cafe_saturated_area():
    """Dense commercial core full of cafes."""
    return (_ring(40, {'amenity': 'cafe', 'name': 'Cafe'}, 400) + _ring(30, {'shop': 'clothes', 'name': 'Store'}, 700, start_id=100)
            + _ring(25, {'amenity': 'restaurant', 'name': 'R'}, 600, start_id=200) + _ring(15, {'office': 'company'}, 900, start_id=300))


def residential_area():
    """Quiet area: a few schools and houses, no cafes or pharmacies."""
    return (_ring(6, {'amenity': 'school', 'name': 'School'}, 1500) + _ring(4, {'amenity': 'place_of_worship'}, 2500, start_id=50)
            + _ring(3, {'shop': 'convenience', 'name': 'Kirana'}, 3000, start_id=80))


class RecommendationAPITests(TestCase):
    def get(self, **params):
        params.setdefault('latitude', LAT)
        params.setdefault('longitude', LON)
        return self.client.get(URL, params)

    def test_five_recommendations_with_revenue_details(self):
        with fake_overpass():
            data = self.get(location_name='MG Road, Bengaluru').json()
        self.assertTrue(data['success'])
        self.assertEqual(data['count'], 5)
        for i, rec in enumerate(data['recommendations'], 1):
            self.assertEqual(rec['rank'], i)
            for key in ('starting_monthly_revenue', 'estimated_monthly_profit', 'break_even_months', 'competition_level',
                        'crowd_level', 'competitors_1km', 'target_lat', 'target_lon', 'reasons', 'potential_score'):
                self.assertIn(key, rec)
            self.assertGreater(rec['starting_monthly_revenue'], 0)
            self.assertIn(rec['crowd_level'], ('high', 'medium', 'low'))
            self.assertLessEqual(analysis._haversine_distance_m(LAT, LON, rec['target_lat'], rec['target_lon']), 5000)

    def test_revenue_is_the_engine_estimate_at_the_target(self):
        els = analysis.elements_within(overpass_elements(), LAT, LON, 5000)
        rec = analysis.generate_location_business_recommendations(LAT, LON, 5000, 'X', els)[0]
        engine = utils.calculate_smart_revenue(els, business_type=rec['engine_category'], lat=rec['target_lat'], lon=rec['target_lon'])
        self.assertAlmostEqual(rec['starting_monthly_revenue'], engine['monthly_revenue'], delta=100)

    def test_recommendations_depend_on_the_location(self):
        with fake_overpass(elements=cafe_saturated_area()):
            busy = [r['category'] for r in self.get().json()['recommendations']]
        with fake_overpass(elements=residential_area()):
            quiet = [r['category'] for r in self.get().json()['recommendations']]
        self.assertNotEqual(busy, quiet)
        self.assertNotEqual(busy, ['cafe', 'fitness_center', 'coworking_space', 'supermarket', 'restaurant'])

    def test_competition_is_counted_from_real_places(self):
        with fake_overpass(elements=cafe_saturated_area()):
            recs = self.get(category='cafe').json()['recommendations']
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]['category'], 'cafe')
        self.assertGreater(recs[0]['competitors_area'], 30)
        self.assertEqual(recs[0]['competition_level'], 'High')

    def test_category_filter_and_limit(self):
        with fake_overpass():
            data = self.get(category='Pharmacy').json()
            self.assertEqual([r['category'] for r in data['recommendations']], ['pharmacy'])
            self.assertEqual(self.get(limit=3).json()['count'], 3)

    def test_pending_and_errors(self):
        with patch('business_intelligence.views.fetch_area_pois',
                   return_value={'status': 'pending', 'retry_after': 4, 'error': 'still fetching'}):
            resp = self.get()
        self.assertEqual(resp.status_code, 202)
        self.assertTrue(resp.json()['pending'])
        self.assertEqual(self.get(latitude='abc').status_code, 400)
        with fake_overpass(error='HTTP 502'):
            self.assertEqual(self.get().status_code, 503)

    def test_post_is_supported(self):
        with fake_overpass():
            resp = self.client.post(URL, json.dumps({'latitude': LAT, 'longitude': LON, 'category': 'cafe'}),
                                    content_type='application/json')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()['category'], 'cafe')
