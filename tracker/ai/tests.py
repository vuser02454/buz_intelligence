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
    def test_orchestrator_end_to_end(self, mock_grok, mock_gemini):
        mock_gemini.return_value = {"success": True, "analysis": "Primary analysis."}
        mock_grok.return_value = {"success": True, "review": "Secondary review."}

        output = process_user_query("What business should I open in Indiranagar?")
        self.assertTrue(output["success"])
        self.assertIn("Indiranagar", output["message"])
        self.assertTrue(len(output["structured_actions"]) > 0)
