"""
Business Synergy Intelligence: deterministic tests on synthetic OpenStreetMap-shaped data.
No network: Overpass is patched where an endpoint is called.
"""
import json
import math

from django.test import Client, SimpleTestCase, override_settings

from business_intelligence import synergy
from business_intelligence.synergy import configuration as cfg
from business_intelligence.synergy import revenue_uplift, scoring

LAT, LON = 12.9716, 77.5946


def at(distance_m, bearing_deg, tags, el_id=[0]):
    el_id[0] += 1
    d_lat = distance_m * math.cos(math.radians(bearing_deg)) / 110540.0
    d_lon = distance_m * math.sin(math.radians(bearing_deg)) / (111320.0 * math.cos(math.radians(LAT)))
    return {'type': 'node', 'id': el_id[0], 'lat': LAT + d_lat, 'lon': LON + d_lon, 'tags': tags}


def office_area(n_offices=8, n_cafes=0, extra=()):
    els = [at(100 + 40 * i, 20 * i, {'office': 'company', 'name': f'Office {i}'}) for i in range(n_offices)]
    els += [at(150 + 30 * i, 200 + 15 * i, {'amenity': 'cafe', 'name': f'Rival Cafe {i}'}) for i in range(n_cafes)]
    els += [at(250, 90, {'highway': 'bus_stop', 'name': 'Main Road Bus Stop'}),
            at(400, 180, {'amenity': 'college', 'name': 'City College'})]
    return els + list(extra)


class DistanceAndMappingTests(SimpleTestCase):
    def test_distance_weight(self):
        self.assertEqual(scoring.distance_weight(0), 1.0)
        self.assertEqual(scoring.distance_weight(cfg.FULL_WEIGHT_WITHIN_M), 1.0)
        self.assertAlmostEqual(scoring.distance_weight(cfg.SEARCH_RADIUS_M), cfg.MIN_DISTANCE_WEIGHT)
        self.assertEqual(scoring.distance_weight(cfg.SEARCH_RADIUS_M + 1), 0.0)
        self.assertGreater(scoring.distance_weight(600), scoring.distance_weight(1200))

    def test_relationship_mapping_uses_real_names(self):
        r = synergy.analyze(office_area(), LAT, LON, 'cafe', 100000)
        offices = next(l for l in r['relationships'] if l['anchor'] == 'office')
        self.assertEqual(offices['kind'], 'business')
        self.assertEqual(offices['count'], 8)
        self.assertEqual(offices['examples'][0]['name'], 'Office 0')
        self.assertGreater(offices['points'], 0)
        names = {e['name'] for l in r['relationships'] for e in l['examples']}
        real = {el['tags'].get('name') for el in office_area()}
        self.assertTrue(names <= real, 'only names from the input data may appear')

    def test_unnamed_places_are_labelled_not_invented(self):
        r = synergy.analyze([at(120, 0, {'office': 'company'})], LAT, LON, 'cafe', 1000)
        ex = next(l for l in r['relationships'] if l['anchor'] == 'office')['examples'][0]
        self.assertFalse(ex['named'])
        self.assertIn('mapped without a name', ex['name'])

    def test_environment_factors_identified(self):
        r = synergy.analyze(office_area(), LAT, LON, 'cafe', 100000)
        kinds = {l['anchor']: l['kind'] for l in r['relationships'] if l['count']}
        self.assertEqual(kinds.get('bus'), 'environment')
        self.assertIn('college', kinds)
        self.assertEqual(r['accessibility']['bus_stops_500m'], 1)

    def test_places_beyond_search_radius_ignored(self):
        far = [at(cfg.SEARCH_RADIUS_M + 200, 0, {'office': 'company', 'name': 'Far Office'})]
        r = synergy.analyze(far, LAT, LON, 'cafe', 1000)
        self.assertEqual(r['data']['mapped_places_1500m'], 0)
        self.assertFalse(any(l['count'] for l in r['relationships']))


class ScoreTests(SimpleTestCase):
    def test_score_is_weighted_sum_within_bounds(self):
        r = synergy.analyze(office_area(), LAT, LON, 'cafe', 100000)
        self.assertTrue(0 <= r['score'] <= 100)
        self.assertAlmostEqual(r['score'], sum(f['weight'] * f['score'] for f in r['factors']), delta=0.1)
        self.assertAlmostEqual(sum(f['weight'] for f in r['factors']), 1.0)
        self.assertEqual(r['level'], cfg.level_for(r['score']))
        for f in r['factors']:
            self.assertTrue(0 <= f['score'] <= 100, f)

    def test_more_complements_raise_the_score(self):
        low = synergy.analyze(office_area(n_offices=1), LAT, LON, 'cafe', 1000)['score']
        high = synergy.analyze(office_area(n_offices=12), LAT, LON, 'cafe', 1000)['score']
        self.assertGreater(high, low)

    def test_weights_are_configurable(self):
        default = synergy.analyze(office_area(), LAT, LON, 'cafe', 1000)
        weights = {'business': 1.0, 'environment': 0.0, 'customer': 0.0, 'competition': 0.0, 'accessibility': 0.0}
        with override_settings(SYNERGY_WEIGHTS=weights):
            only_business = synergy.analyze(office_area(), LAT, LON, 'cafe', 1000)
        business = next(f['score'] for f in default['factors'] if f['key'] == 'business')
        self.assertAlmostEqual(only_business['score'], business, delta=0.1)

    def test_invalid_weights_rejected(self):
        with override_settings(SYNERGY_WEIGHTS={'business': 0.9}):
            with self.assertRaises(ValueError):
                cfg.weights()

    def test_competition_lowers_the_competition_factor(self):
        comp = lambda r: next(f['score'] for f in r['factors'] if f['key'] == 'competition')
        none = synergy.analyze(office_area(n_cafes=0), LAT, LON, 'cafe', 1000, competitor_types=['cafe'])
        many = synergy.analyze(office_area(n_cafes=10), LAT, LON, 'cafe', 1000, competitor_types=['cafe'])
        self.assertGreater(comp(none), comp(many))
        self.assertEqual(many['competition']['competitors_1km'], 10)
        self.assertGreater(many['competition']['cluster_saturation'], 0)
        self.assertTrue(any('Competition' in r for r in many['explanation']['risks']))

    def test_cluster_attraction_for_destination_categories(self):
        rivals = [at(200 + 20 * i, 10 * i, {'shop': 'clothes', 'name': f'Boutique {i}'}) for i in range(4)]
        r = synergy.analyze(office_area(extra=rivals), LAT, LON, 'clothing_store', 1000, competitor_types=['clothes'])
        self.assertGreater(r['competition']['cluster_attraction'], 0)
        self.assertEqual(r['competition']['cluster_saturation'], 0)

    def test_missing_data_gives_low_confidence_not_errors(self):
        r = synergy.analyze([], LAT, LON, 'cafe', 50000)
        self.assertEqual(r['data']['confidence'], 'low')
        self.assertEqual(r['data']['mapped_places_1500m'], 0)
        self.assertLess(r['score'], 30)
        self.assertEqual(r['level'], 'Weak')
        self.assertTrue(r['explanation']['risks'][0].startswith('Weak synergy'))
        self.assertTrue(any('Limited map data' in x for x in r['explanation']['risks']))

    def test_unknown_business_uses_default_group(self):
        r = synergy.analyze(office_area(), LAT, LON, 'quantum_widget_studio', 1000)
        self.assertEqual(r['group'], 'default')
        self.assertTrue(0 <= r['score'] <= 100)

    def test_deterministic(self):
        a = synergy.analyze(office_area(), LAT, LON, 'cafe', 123456)
        b = synergy.analyze(office_area(), LAT, LON, 'cafe', 123456)
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))


class RevenueUpliftTests(SimpleTestCase):
    def test_formula(self):
        r = revenue_uplift.scenarios(100000, 80, 1.0)
        rows = {x['scenario']: x for x in r['rows']}
        self.assertEqual(rows['base']['monthly'], 100000)
        self.assertEqual(rows['conservative']['uplift_pct'], 4.0)   # 5% × 0.8 × 1.0
        self.assertEqual(rows['moderate']['monthly'], 108000)
        self.assertEqual(rows['optimistic']['additional'], 12000)
        self.assertTrue(r['is_estimate'])

    def test_low_coverage_halves_the_uplift(self):
        full = revenue_uplift.scenarios(100000, 100, 1.0)['rows'][2]['additional']
        none = revenue_uplift.scenarios(100000, 100, 0.0)['rows'][2]['additional']
        self.assertEqual(none * 2, full)

    def test_zero_base_and_zero_score(self):
        self.assertTrue(all(x['monthly'] == 0 for x in revenue_uplift.scenarios(0, 90, 1)['rows']))
        self.assertTrue(all(x['additional'] == 0 for x in revenue_uplift.scenarios(5000, 0, 1)['rows']))

    def test_caps_are_configurable(self):
        with override_settings(SYNERGY_UPLIFT_CAPS={'conservative': 0.02, 'moderate': 0.04, 'optimistic': 0.06}):
            rows = revenue_uplift.scenarios(100000, 100, 1.0)['rows']
        self.assertEqual([x['monthly'] for x in rows], [100000, 102000, 104000, 106000])

    def test_analysis_scenarios_match_its_score(self):
        r = synergy.analyze(office_area(), LAT, LON, 'cafe', 200000)
        expected = revenue_uplift.scenarios(200000, r['score'], r['data']['coverage'])
        self.assertEqual(r['revenue'], expected)


class ExplanationTests(SimpleTestCase):
    def test_explanation_sections(self):
        r = synergy.analyze(office_area(), LAT, LON, 'cafe', 100000)
        ex = r['explanation']
        for key in ('why', 'supports', 'how', 'opportunity', 'risks', 'actions', 'disclaimer'):
            self.assertTrue(ex[key], key)
        self.assertIn('Office 0', ex['why'])
        self.assertIn('not expected or guaranteed', ex['opportunity'])
        self.assertLessEqual(len(ex['actions']), 5)

    def test_summary_matches_full_result(self):
        r = synergy.analyze(office_area(), LAT, LON, 'cafe', 100000)
        s = synergy.summary(r)
        self.assertEqual(s['score'], r['score'])
        self.assertEqual(s['scenarios']['moderate']['monthly'], r['revenue']['rows'][2]['monthly'])
        self.assertLessEqual(len(s['sources']), 3)


class SynergyApiTests(SimpleTestCase):
    def setUp(self):
        from django.core.cache import cache
        cache.clear()

    def get(self, **params):
        from report_generator.tests.fixtures import fake_overpass
        with fake_overpass():
            return Client().get('/api/synergy/', params)

    def test_synergy_endpoint(self):
        res = self.get(latitude=LAT, longitude=LON, business_type='cafe', location_name='MG Road')
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertTrue(data['success'])
        r = data['synergy']
        self.assertEqual(r['business_key'], 'cafe')
        self.assertTrue(0 <= r['score'] <= 100)
        self.assertEqual(len(r['revenue']['rows']), 4)
        self.assertEqual(r['location']['name'], 'MG Road')

    def test_matches_for_location_and_engine_revenue(self):
        from business_intelligence import analysis, utils
        from report_generator.tests.fixtures import overpass_elements
        res = self.get(latitude=LAT, longitude=LON, business_type='cafe')
        els = analysis.elements_within(overpass_elements(), LAT, LON, analysis.HEATMAP_RADIUS_M)
        engine = utils.calculate_smart_revenue(els, business_type='cafe', lat=LAT, lon=LON)['monthly_revenue']
        r = res.json()['synergy']
        self.assertEqual(r['revenue']['base_monthly'], round(engine))
        self.assertEqual(r['score'], synergy.for_location(els, LAT, LON, 'cafe')['score'])

    def test_validation(self):
        self.assertEqual(self.get(latitude=LAT, longitude=LON).status_code, 400)
        self.assertEqual(self.get(latitude='abc', longitude=LON, business_type='cafe').status_code, 400)
        self.assertEqual(self.get(latitude=LAT, longitude=LON, business_type='<script>').status_code, 400)

    def test_overpass_unavailable(self):
        from report_generator.tests.fixtures import fake_overpass
        with fake_overpass(error='timeout'):
            res = Client().get('/api/synergy/', {'latitude': LAT, 'longitude': LON, 'business_type': 'cafe'})
        self.assertIn(res.status_code, (202, 503, 504))
        self.assertFalse(res.json().get('success', False))

    def test_rate_limited(self):
        from unittest.mock import patch
        with patch('business_intelligence.views.rate_limited', return_value=True):
            res = Client().get('/api/synergy/', {'latitude': LAT, 'longitude': LON, 'business_type': 'cafe'})
        self.assertEqual(res.status_code, 429)


class RecommendationIntegrationTests(SimpleTestCase):
    def test_recommendations_carry_synergy_and_comparison(self):
        from report_generator.tests.fixtures import fake_overpass
        with fake_overpass():
            res = Client().post('/api/location-recommendations/', json.dumps({'latitude': LAT, 'longitude': LON,
                                                                                'location_name': 'MG Road'}),
                                content_type='application/json')
        self.assertEqual(res.status_code, 200)
        data = res.json()
        recs = data['recommendations']
        self.assertTrue(recs)
        for rec in recs:
            syn = rec['synergy']
            self.assertTrue(0 <= syn['score'] <= 100)
            self.assertEqual(syn['scenarios']['base']['monthly'], round(rec['starting_monthly_revenue']))
            self.assertAlmostEqual(rec['overall_score'], round(0.6 * rec['model_score'] + 0.4 * syn['score'], 1), delta=0.11)
        cmp = data['comparison']
        self.assertEqual(cmp['model']['rank'], 1)
        for key in ('model', 'synergy', 'overall'):
            self.assertIn('name', cmp[key])
        self.assertIn('0.6', cmp['method'])
