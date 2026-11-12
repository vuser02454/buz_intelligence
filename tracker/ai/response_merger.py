"""
Response Merger for Gemini + Grok Dual-AI System.
Synthesizes primary analysis, critical review, and verified platform factsheets into a single executive response.
"""

from typing import Dict, Any, List, Optional
from .validators import validate_structured_action


def _format_inr(amount: float) -> str:
    """Format INR currency into human-readable Lakhs / Thousands."""
    if amount is None or amount <= 0:
        return "₹--"
    if amount >= 100000:
        return f"₹{amount / 100000:.2f}L/mo"
    return f"₹{amount:,.0f}/mo"


def _generate_deterministic_fallback(context: Dict[str, Any], user_query: str) -> str:
    """
    Generate a pure deterministic response based on verified platform models
    when external AI providers are unavailable or API keys are not set.
    """
    loc = context.get('location', {})
    loc_name = loc.get('name') or "Selected Location"
    pred_biz = context.get('business_prediction') or "General Retail"
    pot_score = context.get('potential_score') or context.get('crowd_score') or 50
    rev_data = context.get('revenue_prediction', {})
    monthly_est = rev_data.get('monthly_estimate') or rev_data.get('monthly_revenue') or 0
    confidence = rev_data.get('confidence') or rev_data.get('confidence_score') or 70
    if isinstance(confidence, float) and confidence <= 1.0:
        confidence = int(confidence * 100)
    competitors = context.get('competition', {}).get('nearby_competitors', 0)
    total_pois = context.get('poi_count') or len(context.get('popular_places') or [])
    
    status_verdict = "FAVORABLE POTENTIAL" if pot_score >= 70 else ("MODERATE POTENTIAL" if pot_score >= 40 else "HIGH RISK ZONE")
    
    return f"""📍 **Location:** {loc_name}
📊 **Platform Potential Score:** {pot_score}/100

🏢 **Predicted Business:** {pred_biz}
💰 **Estimated Monthly Revenue:** {_format_inr(monthly_est)} (Confidence: {confidence}%)
⚔️ **Monitored Competitors:** {competitors} | **Total Local POIs:** {total_pois}

💡 **Platform Assessment:**
• **Traffic & Demand:** The area demonstrates a crowd density score of {pot_score}/100 with {total_pois} active commercial sensors.
• **Competitive Saturation:** Detected {competitors} direct competitor(s) within the trading radius.
• **Recommendation:** **{status_verdict}** for opening a **{pred_biz}**. Verify physical storefront visibility and local transit footfall before finalizing lease terms.

*(Note: Deterministic analysis active. Configure GEMINI_API_KEY and GROK_API_KEY in .env for dual-AI deep reasoning.)*"""


def merge_ai_results(
    location_context: Dict[str, Any],
    gemini_result: Dict[str, Any],
    grok_result: Dict[str, Any],
    user_query: str
) -> Dict[str, Any]:
    """
    Merge Gemini and Grok results into a unified, actionable response.
    Includes structured website action intents for interactive UI buttons.
    """
    loc = location_context.get('location', {})
    loc_name = loc.get('name') or "Selected Location"
    pot_score = location_context.get('potential_score') or location_context.get('crowd_score') or 50
    pred_biz = location_context.get('business_prediction') or "Commercial Business"
    rev_data = location_context.get('revenue_prediction', {})
    monthly_est = rev_data.get('monthly_estimate') or rev_data.get('monthly_revenue') or 0
    confidence = rev_data.get('confidence') or rev_data.get('confidence_score') or 70
    if isinstance(confidence, float) and confidence <= 1.0:
        confidence = int(confidence * 100)
    competitors = location_context.get('competition', {}).get('nearby_competitors', 0)
    total_pois = location_context.get('poi_count') or 0

    has_gemini = gemini_result.get('success') and bool(gemini_result.get('analysis'))
    has_grok = grok_result.get('success') and bool(grok_result.get('review'))
    
    sections: List[str] = []
    
    # 1. Location Header & Score
    sections.append(f"📍 **{loc_name}** | **Platform Score: {pot_score}/100**")
    
    # 2. Case A: Both Models Available (Full Dual-AI Synthesis)
    if has_gemini and has_grok:
        sections.append(f"🤖 **Gemini Intelligence (Primary Analysis):**\n{gemini_result['analysis']}")
        sections.append(f"⚡ **Grok Critical Review (Second Opinion & Risks):**\n{grok_result['review']}")
        
        # Strategic Verdict
        verdict = "STRONG OPPORTUNITY" if pot_score >= 75 else ("VIABLE WITH STRATEGY" if pot_score >= 45 else "HIGH RISK LOCATION")
        sections.append(f"💡 **Combined Recommendation:**\n**{verdict}** — The location offers high baseline footfall for **{pred_biz}**, but competition ({competitors} existing venues) requires a clear value proposition.")

    # Case B: Gemini Only
    elif has_gemini and not has_grok:
        sections.append(f"🤖 **Gemini Intelligence:**\n{gemini_result['analysis']}")
        sections.append(f"💡 **Platform Recommendation:**\nProceed with feasibility verification for **{pred_biz}**. Investigate competitive footfall around peak transit hours.")

    # Case C: Grok Only
    elif has_grok and not has_gemini:
        sections.append(f"⚡ **Grok Location Analysis:**\n{grok_result['review']}")
        sections.append(f"💡 **Platform Recommendation:**\nTake note of the risk factors highlighted above before finalizing site commitments for **{pred_biz}**.")

    # Case D: Both Unavailable / Fallback
    else:
        return {
            "success": True,
            "message": _generate_deterministic_fallback(location_context, user_query),
            "structured_actions": _build_default_actions(location_context, pred_biz),
            "location_context": location_context,
            "providers_used": []
        }

    # 3. Verified Platform Factsheet (Anti-Hallucination Anchor)
    factsheet = f"""\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 **Verified Platform Metrics:**
• **Predicted Business:** {pred_biz}
• **Est. Monthly Revenue:** {_format_inr(monthly_est)} (Confidence: {confidence}%)
• **Nearby Competitors:** {competitors} | **Trading POIs:** {total_pois}"""
    sections.append(factsheet)

    # 4. Generate Predefined Safe Structured Actions
    structured_actions = _build_default_actions(location_context, pred_biz)

    providers_used = []
    if has_gemini:
        providers_used.append("gemini")
    if has_grok:
        providers_used.append("grok")

    final_message = "\n\n".join(sections)
    
    return {
        "success": True,
        "message": final_message,
        "structured_actions": structured_actions,
        "location_context": location_context,
        "providers_used": providers_used
    }


def _build_default_actions(context: Dict[str, Any], business_type: str) -> List[Dict[str, Any]]:
    """Build a list of validated interactive action buttons."""
    loc = context.get('location', {})
    loc_name = loc.get('name') or "Current Area"
    
    actions = [
        {"intent": "check_feasibility", "location": loc_name, "business_type": business_type, "label": f"🏢 Check {business_type} Feasibility"},
        {"intent": "find_alternative_locations", "location": loc_name, "label": "📍 Find Better AI Zones"},
        {"intent": "view_heatmap", "location": loc_name, "label": "🔥 View Crowd Heatmap"},
        {"intent": "compare_locations", "location": loc_name, "label": "⚖️ Compare Locations"},
    ]
    
    validated = []
    for act in actions:
        v = validate_structured_action(act)
        if v:
            validated.append(v)
    return validated
