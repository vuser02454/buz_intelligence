"""
xAI Grok Secondary Location Analysis Service.
Provides independent critical review, competitive risk analysis, and reflection questions.
"""

import os
import json
import logging
from typing import Dict, Any, Optional

import requests
from .prompts import GROK_SYSTEM_PROMPT
from .validators import sanitize_context_for_ai, sanitize_input

logger = logging.getLogger(__name__)

GROK_API_ENDPOINT = "https://api.x.ai/v1/chat/completions"


def _get_grok_config():
    """Retrieve and validate Grok credentials from environment."""
    api_key = os.getenv("GROK_API_KEY")
    model_name = os.getenv("GROK_MODEL_NAME", "grok-2-latest")
    return api_key, model_name


def review_location(
    context: Dict[str, Any],
    gemini_analysis: Optional[str],
    user_query: str
) -> Dict[str, Any]:
    """
    Secondary critical review using xAI Grok.
    Takes trusted spatial context + Gemini's primary analysis to produce an objective critique.
    """
    api_key, model_name = _get_grok_config()
    
    if not api_key:
        return {
            "success": False,
            "provider": "grok",
            "error": "GROK_API_KEY is not configured in .env",
            "review": None
        }

    clean_context = sanitize_context_for_ai(context)
    clean_query = sanitize_input(user_query, 800)
    clean_gemini_analysis = sanitize_input(gemini_analysis or "Primary analysis not available.", 1500)
    
    prompt = f"""TRUSTED PLATFORM LOCATION DATA:
{json.dumps(clean_context, indent=2, ensure_ascii=False)}

PRIMARY ANALYSIS (FROM GEMINI):
{clean_gemini_analysis}

USER QUERY:
"{clean_query}"

INSTRUCTIONS:
As the independent strategic reviewer:
1. Provide a candid, realistic second opinion on this location.
2. Challenge any overly optimistic assumptions based on the competitor count, risk metrics, or market saturation.
3. Identify 2 specific risks or friction points (e.g. high competition, footfall conversion limits, overhead pressure).
4. State 2 essential questions the entrepreneur must investigate before opening.

Keep your response direct, analytical, and under 120 words. Use bullet points for risks and reflection questions."""

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": GROK_SYSTEM_PROMPT},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.3,
        "max_tokens": 400
    }

    try:
        response = requests.post(
            GROK_API_ENDPOINT,
            headers=headers,
            json=payload,
            timeout=12.0
        )
        
        if response.status_code == 200:
            data = response.json()
            choices = data.get("choices", [])
            if choices and choices[0].get("message", {}).get("content"):
                review_text = choices[0]["message"]["content"].strip()
                return {
                    "success": True,
                    "provider": "grok",
                    "model": model_name,
                    "review": review_text,
                    "error": None
                }
            else:
                return {
                    "success": False,
                    "provider": "grok",
                    "error": "Grok returned empty response choices.",
                    "review": None
                }
        elif response.status_code == 401:
            return {
                "success": False,
                "provider": "grok",
                "error": "Invalid GROK_API_KEY.",
                "review": None
            }
        elif response.status_code == 429:
            return {
                "success": False,
                "provider": "grok",
                "error": "Grok API rate limit reached.",
                "review": None
            }
        else:
            return {
                "success": False,
                "provider": "grok",
                "error": f"Grok API error HTTP {response.status_code}: {response.text[:100]}",
                "review": None
            }
            
    except requests.exceptions.Timeout:
        logger.warning("Grok API request timed out.")
        return {
            "success": False,
            "provider": "grok",
            "error": "Grok request timed out.",
            "review": None
        }
    except Exception as exc:
        err_msg = str(exc)
        logger.warning(f"Grok service error: {err_msg}")
        return {
            "success": False,
            "provider": "grok",
            "error": f"Grok review unavailable ({err_msg[:80]}).",
            "review": None
        }
