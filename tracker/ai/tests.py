"""
Unit tests for Dual-AI Intelligence System (Gemini + Grok + Orchestrator).
"""

from unittest.mock import patch, MagicMock
from django.test import TestCase

from tracker.ai import validators
from tracker.ai.gemini_service import analyze_location as gemini_analyze
from tracker.ai.grok_service import review_location as grok_review
from tracker.ai.response_merger import merge_ai_results
from tracker.ai.orchestrator import process_user_query


class DualAITestCase(TestCase):

    def setUp(self):
        self.mock_context = {
            "location": {
                "name": "Indiranagar, Bengaluru",
                "latitude": 12.9719,
                "longitude": 77.6412
            },
            "radius_km": 2.0,
            "crowd_score": 85,
            "potential_score": 88,
            "business_prediction": "Cafe",
            "revenue_prediction": {
                "monthly_estimate": 450000,
                "confidence": 0.82,
                "confidence_score": 82
            },
            "competition": {
                "target_business": "Cafe",
                "nearby_competitors": 12
            },
            "poi_count": 145,
            "secret_token": "should_be_stripped_12345"
        }

    def test_scope_validator_rejection(self):
        """Ensure off-topic questions (e.g. coding, games, sports) are rejected."""
        self.assertFalse(validators.is_platform_relevant("Write a python game for me"))
        self.assertFalse(validators.is_platform_relevant("Who won yesterday's cricket match?"))
        self.assertFalse(validators.is_platform_relevant("Give me a recipe for chocolate cake"))
        self.assertFalse(validators.is_platform_relevant("Solve this calculus integral problem"))

    def test_scope_validator_allowance(self):
        """Ensure location and business intelligence questions are allowed."""
        self.assertTrue(validators.is_platform_relevant("What business should I open in Indiranagar?"))
        self.assertTrue(validators.is_platform_relevant("Is a cafe feasible in Koramangala?"))
        self.assertTrue(validators.is_platform_relevant("Analyze crowd density in Whitefield"))
        self.assertTrue(validators.is_platform_relevant("How does the revenue prediction work?"))
        self.assertTrue(validators.is_platform_relevant("Koramangala"))

    def test_context_sanitizer_security(self):
        """Ensure sensitive keys are stripped before sending to external AI."""
        clean = validators.sanitize_context_for_ai(self.mock_context)
        self.assertNotIn("secret_token", clean)
        self.assertIn("location", clean)
        self.assertIn("business_prediction", clean)

    def test_structured_action_validator(self):
        """Ensure structured action validation permits safe intents and rejects arbitrary ones."""
        valid = validators.validate_structured_action({
            "intent": "check_feasibility",
            "location": "Indiranagar",
            "business_type": "Cafe"
        })
        self.assertIsNotNone(valid)
        self.assertEqual(valid["intent"], "check_feasibility")

        invalid = validators.validate_structured_action({
            "intent": "arbitrary_javascript_eval",
            "code": "alert(1)"
        })
        self.assertIsNone(invalid)

    @patch('tracker.ai.gemini_service._get_gemini_config')
    @patch('google.generativeai.GenerativeModel')
    def test_gemini_service_success(self, mock_model_cls, mock_cfg):
        mock_cfg.return_value = ("fake_gemini_key", "models/gemini-2.0-flash")
        mock_instance = MagicMock()
        mock_instance.generate_content.return_value = MagicMock(text="Strong potential for a cafe.")
        mock_model_cls.return_value = mock_instance

        res = gemini_analyze(self.mock_context, "Is cafe good here?")
        self.assertTrue(res["success"])
        self.assertIn("Strong potential", res["analysis"])

    @patch('tracker.ai.grok_service._get_grok_config')
    @patch('requests.post')
    def test_grok_service_success(self, mock_post, mock_cfg):
        mock_cfg.return_value = ("fake_grok_key", "grok-2-latest")
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "choices": [{"message": {"content": "High competition with 12 existing cafes."}}]
        }
        mock_post.return_value = mock_resp

        res = grok_review(self.mock_context, "Gemini says good.", "Is cafe good?")
        self.assertTrue(res["success"])
        self.assertIn("High competition", res["review"])

    def test_response_merger_both_providers(self):
        gemini_res = {"success": True, "analysis": "High footfall in Indiranagar indicates great demand."}
        grok_res = {"success": True, "review": "Watch out for 12 existing competitors nearby."}

        merged = merge_ai_results(self.mock_context, gemini_res, grok_res, "Cafe in Indiranagar")
        self.assertTrue(merged["success"])
        self.assertIn("Gemini Intelligence", merged["message"])
        self.assertIn("Grok Critical Review", merged["message"])
        self.assertIn("Combined Recommendation", merged["message"])
        self.assertIn("Verified Platform Metrics", merged["message"])
        self.assertIn("Cafe", merged["message"])

    def test_response_merger_deterministic_fallback(self):
        """If both providers fail or are unconfigured, fallback must succeed without crash."""
        gemini_res = {"success": False, "analysis": None}
        grok_res = {"success": False, "review": None}

        merged = merge_ai_results(self.mock_context, gemini_res, grok_res, "Cafe in Indiranagar")
        self.assertTrue(merged["success"])
        self.assertIn("Platform Potential Score", merged["message"])
        self.assertIn("Predicted Business:** Cafe", merged["message"])
        self.assertIn("Deterministic analysis active", merged["message"])

    @patch('tracker.ai.orchestrator.gemini_analyze')
    @patch('tracker.ai.orchestrator.grok_review')
    @patch('tracker.ai.orchestrator._geocode_place',
           return_value={'name': 'Indiranagar, Bengaluru', 'lat': 12.9784, 'lon': 77.6408})
    def test_orchestrator_end_to_end(self, _geocode, mock_grok, mock_gemini):
        # No network: geocoding and OpenStreetMap are faked.
        from report_generator.tests.fixtures import fake_overpass
        mock_gemini.return_value = {"success": True, "analysis": "Primary analysis."}
        mock_grok.return_value = {"success": True, "review": "Secondary review."}

        with fake_overpass():
            output = process_user_query("What business should I open in Indiranagar?")
        self.assertTrue(output["success"])
        self.assertIn("Indiranagar", output["message"])
        self.assertTrue(len(output["structured_actions"]) > 0)


class FeatureAnswerTestCase(TestCase):
    """The chatbox explains the current features and links to them, without calling the AI providers."""

    def intents(self, query):
        res = process_user_query(query)
        return res, [a['intent'] for a in res['structured_actions']]

    def test_synergy_question(self):
        res, intents = self.intents("What is synergy analysis?")
        self.assertIn('Synergy', res['message'])
        self.assertIn('view_synergy', intents)

    def test_revenue_graph_question(self):
        res, intents = self.intents("How do I see the 3D revenue graph?")
        self.assertIn('Live, Daily, Weekly and Monthly', res['message'])
        self.assertIn('view_revenue_graph', intents)

    def test_favorites_question(self):
        _, intents = self.intents("open my favorites")
        self.assertEqual(intents, ['open_favorites'])

    def test_report_question_is_not_a_generation_request(self):
        res, intents = self.intents("What is in the report?")
        self.assertIn('Key points at a glance', res['message'])
        self.assertNotIn('auto_run', str(res['structured_actions']))
        self.assertIn('generate_report', intents)

    def test_help_lists_new_features(self):
        res, intents = self.intents("help")
        for word in ('Synergy', '3D graph', 'Favorites', 'PDF report'):
            self.assertIn(word, res['message'])
        self.assertIn('view_revenue_graph', intents)

    def test_new_intents_pass_validation(self):
        for intent in ('view_revenue_graph', 'view_synergy', 'open_favorites'):
            self.assertEqual(validators.validate_structured_action({'intent': intent})['intent'], intent)

    @patch('tracker.ai.orchestrator._build_trusted_location_context', side_effect=RuntimeError('offline'))
    @patch('tracker.ai.orchestrator._geocode_place', return_value=None)
    def test_location_request_still_reaches_analysis(self, _geo, _ctx):
        with patch('tracker.ai.orchestrator.gemini_analyze', return_value={'analysis': 'x'}) as g, \
             patch('tracker.ai.orchestrator.grok_review', return_value={}), \
             patch('tracker.ai.orchestrator.merge_ai_results', return_value={'success': True, 'message': 'ok', 'structured_actions': []}):
            process_user_query("projected revenue for a cafe in Indiranagar")
        g.assert_called_once()
