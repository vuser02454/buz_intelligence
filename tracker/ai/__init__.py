"""
AI Intelligence Package for Crowd Heatmap & Business Intelligence Platform.
Orchestrates Google Gemini (Primary Location Intelligence) and xAI Grok (Secondary Critical Review).
"""

from .orchestrator import process_user_query
from .gemini_service import analyze_location as gemini_analyze_location
from .grok_service import review_location as grok_review_location
from .response_merger import merge_ai_results

__all__ = [
    'process_user_query',
    'gemini_analyze_location',
    'grok_review_location',
    'merge_ai_results',
]
