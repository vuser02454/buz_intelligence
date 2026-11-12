"""
Google Gemini Primary Location Intelligence Service.
Interprets spatial context, ML recommendations, and revenue forecasts.
"""

import os
import json
import logging
from typing import Dict, Any, Optional

import google.generativeai as genai
from .prompts import GEMINI_SYSTEM_PROMPT
from .validators import sanitize_context_for_ai, sanitize_input

logger = logging.getLogger(__name__)


def _get_gemini_config():
    """Retrieve and validate Gemini credentials from environment."""
    api_key = os.getenv("GEMINI_API_KEY")
    model_name = os.getenv("GEMINI_MODEL_NAME", "models/gemini-2.5-flash")
    if model_name and not model_name.startswith("models/") and "/" not in model_name:
        model_name = f"models/{model_name}"
    return api_key, model_name


def analyze_location(
    context: Dict[str, Any],
    user_query: str,
    session_history: Optional[Any] = None
) -> Dict[str, Any]:
    """
    Primary location analysis using Google Gemini.
    Takes trusted spatial context and user query, returning structured insights.
    """
    api_key, model_name = _get_gemini_config()
    
    if not api_key:
        return {
            "success": False,
            "provider": "gemini",
            "error": "GEMINI_API_KEY is not configured in .env",
            "analysis": None
        }

    clean_context = sanitize_context_for_ai(context)
    clean_query = sanitize_input(user_query, 800)
    
    # Construct context-grounded prompt
    prompt = f"""TRUSTED PLATFORM LOCATION DATA:
{json.dumps(clean_context, indent=2, ensure_ascii=False)}

USER QUERY:
"{clean_query}"

INSTRUCTIONS:
Using ONLY the facts, metrics, and figures from the TRUSTED PLATFORM LOCATION DATA above:
1. Provide a concise Location & Business Opportunity assessment.
2. Explain the platform's crowd density, ML business prediction, and revenue forecast without inventing any other numbers.
3. Highlight key local catalysts (transit, footfall density, competitor count).
4. Suggest 1-2 actionable next steps for the user.

Keep your entire analysis concise, professional, and within 100-140 words. Use bullet points."""

    try:
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel(
            model_name=model_name,
            system_instruction=GEMINI_SYSTEM_PROMPT
        )
        
        response = model.generate_content(
            prompt,
            request_options={"timeout": 12.0}
        )
        
        if not response or not response.text:
            return {
                "success": False,
                "provider": "gemini",
                "error": "Gemini returned an empty response.",
                "analysis": None
            }
            
        return {
            "success": True,
            "provider": "gemini",
            "model": model_name,
            "analysis": response.text.strip(),
            "error": None
        }
        
    except Exception as exc:
        err_msg = str(exc)
        logger.warning(f"Gemini service error: {err_msg}")
        
        if "404" in err_msg:
            friendly_err = f"Gemini model '{model_name}' was not found. Please verify GEMINI_MODEL_NAME in .env."
        elif "429" in err_msg:
            friendly_err = "Gemini API rate limit reached. Using fallback analysis."
        elif "401" in err_msg or "API_KEY_INVALID" in err_msg:
            friendly_err = "Invalid GEMINI_API_KEY."
        elif "timeout" in err_msg.lower():
            friendly_err = "Gemini request timed out."
        else:
            friendly_err = f"Gemini analysis unavailable ({err_msg[:80]})."
            
        return {
            "success": False,
            "provider": "gemini",
            "error": friendly_err,
            "analysis": None
        }
