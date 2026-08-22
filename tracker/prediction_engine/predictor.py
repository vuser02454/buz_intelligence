"""
Predictor Implementation.
Executes the final revenue prediction formula, potential scoring, risk assessment,
and factor extraction using the Huff and Extended Huff layers.
"""

from datetime import datetime
from typing import List, Dict, Tuple, Any
from .config import BUSINESS_METRICS, TEMPORAL_PATTERNS
from .data_classes import OSMFeatures, PredictionResult
from .huff_layer import HuffModel
from .extended_huff import ExtendedHuffModel
from .predictor_interface import PredictorInterface

class RevenuePredictor(PredictorInterface):
    """Fulfills the PredictorInterface using GIS gravity math and Extended Huff adjustments."""

    def predict(
        self,
        features: OSMFeatures,
        elements: List[Dict[str, Any]],
        business_type: str,
        target_lat: float,
        target_lon: float,
        hour: int | None = None
    ) -> PredictionResult:
        """Runs the multi-layered prediction engine."""
        b_key = business_type.strip().lower().replace(' ', '_')
        metrics = BUSINESS_METRICS.get(b_key, BUSINESS_METRICS['default'])
        
        # 1. Execute Huff Layer
        huff = HuffModel(target_lat, target_lon, b_key)
        huff_metrics = huff.compute_huff_metrics(
            elements=elements,
            accessibility_score=features.accessibility_score,
            business_attraction_score=features.business_attraction_score,
            area_diversity_score=features.area_diversity_score,
            income_proxy=features.income_proxy,
            expected_visitors=features.expected_visitors
        )
        
        # 2. Execute Extended Huff Layer
        extended = ExtendedHuffModel(b_key)
        extended_metrics = extended.compute_extended_metrics(
            elements=elements,
            market_share=huff_metrics.market_share,
            expected_visitors=features.expected_visitors,
            accessibility_score=features.accessibility_score,
            competition_score=features.competition_score,
            demand_supply_ratio=features.demand_supply_ratio
        )
        
        # 3. Time-aware Revenue Calculation
        # Final Revenue Formula: Expected Visitors * Market Share * Conv Rate * Avg Spend * Comp Adj * Time Factor
        # Daily Revenue is already benchmarked under Extended Huff. We use that as base.
        daily_revenue = extended_metrics.retail_turnover
        
        # Determine target hour
        if hour is None:
            now_hour = datetime.now().hour
        else:
            now_hour = int(hour) % 24
            
        time_mult, _ = TEMPORAL_PATTERNS.get(now_hour, (1.0, "Active"))
        # Sum of all diurnal multipliers to normalize the hourly share
        sum_multipliers = sum(mult for mult, _ in TEMPORAL_PATTERNS.values())
        
        # Hourly Revenue for target hour
        hourly_revenue = daily_revenue * (time_mult / sum_multipliers)
        
        weekly_revenue = daily_revenue * 7.0
        monthly_revenue = daily_revenue * 30.0
        annual_revenue = daily_revenue * 365.0
        
        # 4. Feasibility / Potential Score Calculation (0-100)
        # Accessibility (25%), Attraction (20%), Demand/Supply (20%), Market Share (20%), Diversity (15%)
        # Adjusted downward by competition
        pot_score = (
            features.accessibility_score * 0.25 +
            features.business_attraction_score * 0.20 +
            min(100.0, features.demand_supply_ratio * 40.0) * 0.20 +
            (huff_metrics.market_share * 100.0) * 0.20 +
            features.area_diversity_score * 0.15
        )
        potential_score = int(min(100.0, max(0.0, pot_score)))
        
        # 5. Risk Assessment
        risk_level = "Low"
        if (features.competition_score >= 70.0 or 
            features.demand_supply_ratio < 0.4 or 
            extended_metrics.business_performance < 0.6):
            risk_level = "High"
        elif (features.competition_score >= 45.0 or 
              features.demand_supply_ratio < 0.8 or 
              extended_metrics.business_performance < 0.85):
            risk_level = "Medium"
            
        # 6. Business Health Assessment
        business_health = "Moderate"
        if potential_score >= 75 and risk_level == "Low":
            business_health = "Strong"
        elif potential_score < 45 or risk_level == "High":
            business_health = "Weak"
            
        # 7. Confidence Score (directly from Extended Huff metrics)
        confidence_score = int(extended_metrics.revenue_confidence)
        
        # 8. Revenue Range (min/max based on confidence)
        # Low confidence = wider range, high confidence = narrow range
        range_percent = max(0.10, min(0.40, 1.0 - (confidence_score / 100.0)))
        rev_min = monthly_revenue * (1.0 - range_percent)
        rev_max = monthly_revenue * (1.0 + range_percent)
        revenue_range = (round(rev_min, 2), round(rev_max, 2))
        
        # 9. Extract Positive & Negative Factors
        pos_factors, neg_factors = self._extract_factors(features, huff_metrics, extended_metrics)
        
        # 10. Generate Recommendations
        recommendations = self._generate_recommendations(features, huff_metrics, extended_metrics, b_key)
        
        return PredictionResult(
            hourly_revenue=round(hourly_revenue, 2),
            daily_revenue=round(daily_revenue, 2),
            weekly_revenue=round(weekly_revenue, 2),
            monthly_revenue=round(monthly_revenue, 2),
            annual_revenue=round(annual_revenue, 2),
            potential_score=potential_score,
            confidence_score=confidence_score,
            revenue_range=revenue_range,
            business_health=business_health,
            risk_level=risk_level,
            top_positive_factors=pos_factors,
            top_negative_factors=neg_factors,
            actionable_recommendations=recommendations
        )

    def _extract_factors(
        self,
        f: OSMFeatures,
        h: Any,
        e: Any
    ) -> Tuple[List[str], List[str]]:
        """Identify factors that significantly support or hinder the business site."""
        pos = []
        neg = []
        
        # Accessibility
        if f.accessibility_score >= 70:
            pos.append("Excellent transit connectivity and pedestrian accessibility.")
        elif f.accessibility_score < 40:
            neg.append("Poor transit options and low walkability limits customer flow.")
            
        # Attraction
        if f.business_attraction_score >= 65:
            pos.append("High clustering of tourist attractions and commercial interest hubs.")
        elif f.business_attraction_score < 30:
            neg.append("Low local business pull factors to draw casual visitors.")
            
        # Competition
        if f.competition_score < 25:
            pos.append("Very low competitor saturation in the immediate trading area.")
        elif f.competition_score >= 65:
            neg.append("Intense competition; market share is highly diluted.")
            
        # Demand Supply Ratio
        if f.demand_supply_ratio >= 1.5:
            pos.append("Substantial underserved customer demand relative to supply.")
        elif f.demand_supply_ratio < 0.6:
            neg.append("Oversupplied market with excess competitor density.")
            
        # Market Share / Choice Probability
        if h.market_share >= 0.35:
            pos.append("Strong local gravitational dominance with high choice probability.")
        elif h.market_share < 0.12:
            neg.append("Weak gravity pull; competitor stores absorb major customer share.")
            
        # Capacity Benchmarking
        if e.business_performance < 0.7 and e.retail_turnover > 0:
            neg.append("Predicted crowd density exceeds optimal capacity, causing service bottleneck risks.")

        # Ensure we return at least 1 factor for each list to avoid empty UI sections
        if not pos:
            pos.append("Stable residential and baseline commercial footfall indicators.")
        if not neg:
            neg.append("Standard business overhead risk and general retail friction.")
            
        return pos[:3], neg[:3]

    def _generate_recommendations(
        self,
        f: OSMFeatures,
        h: Any,
        e: Any,
        business_type: str
    ) -> List[str]:
        """Produce concrete business operations advice based on site features."""
        recs = []
        metrics = BUSINESS_METRICS.get(business_type, BUSINESS_METRICS['default'])
        
        # 1. Low Accessibility
        if f.accessibility_score < 45:
            recs.append("Mitigate transit deficit by setting up close to parking zones or offering bicycle stands.")
            
        # 2. High Competition
        if f.competition_score >= 50:
            recs.append("Differentiate from local competitors by focusing on premium branding, loyalty rewards, or unique menu offerings.")
        else:
            recs.append("Leverage low competition by launching local flyers and targeted ads to capture the baseline market early.")
            
        # 3. High Demand Supply
        if f.demand_supply_ratio >= 1.4:
            recs.append("Capture unmet local demand by expanding store footprint or storefront display presence.")
            
        # 4. Low Walkability / Transit
        if f.walkability_score < 40 and f.transit_score > 60:
            recs.append("Pedestrian flow is weak but transit is high: orient entrance signage directly towards transit stop sightlines.")
            
        # 5. Overcrowding risk
        if e.business_performance < 0.8:
            if metrics['sensitivity'] == 'high':
                recs.append("Severe peak-hour bottlenecks predicted: implement queue automation, app-based ordering, or pre-booking.")
            else:
                recs.append("Introduce off-peak promotions and digital transaction terminals to speed up peak throughput.")
                
        # Fallback to make sure we always yield recommendations
        if len(recs) < 3:
            recs.append("Optimize staffing schedules around the predicted morning and evening peak hours.")
        if len(recs) < 3:
            recs.append("Tailor inventory and prices to high-spending segments based on local demographic mix.")
            
        return recs[:3]
