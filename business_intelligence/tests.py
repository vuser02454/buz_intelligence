from django.test import TestCase
from business_intelligence.prediction_engine import (
    FeatureExtractor,
    HuffModel,
    ExtendedHuffModel,
    RevenuePredictor,
    predict_site_revenue
)
from business_intelligence import utils

class PredictionEngineTestCase(TestCase):
    def setUp(self):
        self.target_lat = 19.0760
        self.target_lon = 72.8777
        self.business_type = 'cafe'
        
        # Construct mock OSM elements
        self.mock_elements = [
            # Target location (or very close to it)
            {
                'type': 'node',
                'lat': 19.0760,
                'lon': 72.8777,
                'tags': {'amenity': 'cafe', 'name': 'Target Cafe'}
            },
            # Competitor cafe (400 meters away)
            {
                'type': 'node',
                'lat': 19.0790,
                'lon': 72.8777,
                'tags': {'amenity': 'cafe', 'name': 'Competitor Cafe'}
            },
            # Residential building
            {
                'type': 'way',
                'center': {'lat': 19.0750, 'lon': 72.8760},
                'tags': {'building': 'residential'}
            },
            # Office building
            {
                'type': 'way',
                'center': {'lat': 19.0770, 'lon': 72.8790},
                'tags': {'building': 'office', 'office': 'it'}
            },
            # Metro station
            {
                'type': 'node',
                'lat': 19.0740,
                'lon': 72.8750,
                'tags': {'railway': 'subway_entrance', 'subway': 'yes'}
            },
            # Bus stop
            {
                'type': 'node',
                'lat': 19.0765,
                'lon': 72.8765,
                'tags': {'highway': 'bus_stop'}
            },
            # Parking
            {
                'type': 'node',
                'lat': 19.0755,
                'lon': 72.8785,
                'tags': {'amenity': 'parking'}
            },
            # Footpath
            {
                'type': 'way',
                'center': {'lat': 19.0762, 'lon': 72.8772},
                'tags': {'highway': 'footway'}
            },
            # Intersection (crossing)
            {
                'type': 'node',
                'lat': 19.0761,
                'lon': 72.8775,
                'tags': {'highway': 'crossing'}
            },
            # Tourism spot
            {
                'type': 'node',
                'lat': 19.0730,
                'lon': 72.8720,
                'tags': {'tourism': 'viewpoint'}
            }
        ]

    def test_feature_extraction(self):
        extractor = FeatureExtractor(self.target_lat, self.target_lon, self.business_type)
        features = extractor.extract_features(self.mock_elements)
        
        # Verify all 11 features are engineered and strongly typed
        self.assertGreater(features.expected_visitors, 0.0)
        self.assertGreater(features.accessibility_score, 0.0)
        self.assertGreater(features.business_attraction_score, 0.0)
        self.assertGreater(features.competition_score, 0.0)
        self.assertGreater(features.income_proxy, 0.0)
        self.assertGreater(features.demand_supply_ratio, 0.0)
        self.assertGreater(features.transit_score, 0.0)
        self.assertGreater(features.walkability_score, 0.0)
        self.assertGreater(features.parking_score, 0.0)
        self.assertGreater(features.area_diversity_score, 0.0)
        
        # Check Customer Mix proportions sum close to 1
        mix = features.customer_mix
        total_mix = sum(mix.values())
        self.assertAlmostEqual(total_mix, 1.0, places=2)
        self.assertIn('students', mix)
        self.assertIn('professionals', mix)
        self.assertIn('families', mix)
        self.assertIn('tourists', mix)
        self.assertIn('residents', mix)

    def test_huff_model(self):
        huff = HuffModel(self.target_lat, self.target_lon, self.business_type)
        metrics = huff.compute_huff_metrics(
            elements=self.mock_elements,
            accessibility_score=80.0,
            business_attraction_score=75.0,
            area_diversity_score=60.0,
            income_proxy=70.0,
            expected_visitors=500.0
        )
        
        # Check choice probability boundaries
        self.assertTrue(0.0 < metrics.choice_probability <= 1.0)
        self.assertTrue(0.0 < metrics.market_share <= 1.0)
        self.assertGreater(metrics.store_attraction, 0.0)
        self.assertGreater(metrics.distance_decay, 0.0)
        self.assertEqual(len(metrics.time_aware_visits), 24)

    def test_extended_huff(self):
        extended = ExtendedHuffModel(self.business_type)
        metrics = extended.compute_extended_metrics(
            elements=self.mock_elements,
            market_share=0.45,
            expected_visitors=500.0,
            accessibility_score=80.0,
            competition_score=35.0,
            demand_supply_ratio=1.4
        )
        
        # Verify competition adjustment discount factor
        self.assertTrue(0.0 < metrics.competition_adjustment <= 1.0)
        self.assertTrue(0.0 < metrics.business_performance <= 1.0)
        self.assertGreater(metrics.retail_turnover, 0.0)
        self.assertTrue(0.0 < metrics.revenue_confidence <= 100.0)

    def test_revenue_predictor(self):
        extractor = FeatureExtractor(self.target_lat, self.target_lon, self.business_type)
        features = extractor.extract_features(self.mock_elements)
        
        predictor = RevenuePredictor()
        res = predictor.predict(
            features=features,
            elements=self.mock_elements,
            business_type=self.business_type,
            target_lat=self.target_lat,
            target_lon=self.target_lon
        )
        
        # Verify revenue intervals align
        self.assertAlmostEqual(res.weekly_revenue, res.daily_revenue * 7.0, places=2)
        self.assertAlmostEqual(res.monthly_revenue, res.daily_revenue * 30.0, places=2)
        self.assertAlmostEqual(res.annual_revenue, res.daily_revenue * 365.0, places=2)
        
        # Verify output formats
        self.assertTrue(0 <= res.potential_score <= 100)
        self.assertTrue(0 <= res.confidence_score <= 100)
        self.assertLess(res.revenue_range[0], res.revenue_range[1])
        self.assertIn(res.business_health, ['Strong', 'Moderate', 'Weak'])
        self.assertIn(res.risk_level, ['Low', 'Medium', 'High'])
        self.assertGreater(len(res.top_positive_factors), 0)
        self.assertGreater(len(res.top_negative_factors), 0)
        self.assertGreater(len(res.actionable_recommendations), 0)

    def test_backward_compatibility_wrappers(self):
        # 1. Test calculate_smart_revenue wrapper
        result = utils.calculate_smart_revenue(
            self.mock_elements,
            business_type=self.business_type,
            lat=self.target_lat,
            lon=self.target_lon
        )
        
        # Verify legacy keys exist
        self.assertIn('estimated_daily_revenue', result)
        self.assertIn('estimated_monthly_revenue', result)
        self.assertIn('peak_hour_revenue', result)
        self.assertIn('potential_score', result)
        self.assertIn('business_health', result)
        self.assertIn('overload_risk', result)
        self.assertIn('recommendations', result)
        
        # Verify new keys exist
        self.assertIn('hourly_revenue', result)
        self.assertIn('daily_revenue', result)
        self.assertIn('weekly_revenue', result)
        self.assertIn('monthly_revenue', result)
        self.assertIn('annual_revenue', result)
        self.assertIn('confidence_score', result)
        self.assertIn('revenue_range', result)
        self.assertIn('risk_level', result)
        self.assertIn('top_positive_factors', result)
        self.assertIn('top_negative_factors', result)
        
        # 2. Test enrich_places_with_revenue wrapper
        enriched_places, total_revenue = utils.enrich_places_with_revenue(self.mock_elements)
        self.assertEqual(len(enriched_places), len(self.mock_elements))
        self.assertGreater(total_revenue, 0.0)
        
        # Check first place has been enriched with revenue_data
        first_place = enriched_places[0]
        self.assertIn('revenue_data', first_place)
        self.assertIn('estimated_monthly_revenue', first_place['revenue_data'])
        
        # 3. Test generate_best_location_candidates wrapper
        candidates = utils.generate_best_location_candidates(
            self.target_lat,
            self.target_lon,
            self.mock_elements,
            top_n=2
        )
        self.assertLessEqual(len(candidates), 2)
        if candidates:
            first_cand = candidates[0]
            self.assertIn('score', first_cand)
            self.assertIn('estimated_revenue', first_cand)
            self.assertIn('feasibility_factors', first_cand)
            self.assertIn('revenue_data', first_cand)
