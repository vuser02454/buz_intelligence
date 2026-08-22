"""
Dataclasses and type definitions for the revenue prediction engine.
Ensures strong typing, ML compatibility, and clear boundaries between components.
"""

from dataclasses import dataclass, asdict
from typing import Dict, List, Tuple

@dataclass
class OSMFeatures:
    """Features extracted from OpenStreetMap data for ML and analytical models."""
    expected_visitors: float
    accessibility_score: float
    business_attraction_score: float
    competition_score: float
    income_proxy: float
    customer_mix: Dict[str, float]
    demand_supply_ratio: float
    transit_score: float
    walkability_score: float
    parking_score: float
    area_diversity_score: float

    def to_dict(self) -> Dict[str, any]:
        """Convert features to a dictionary for ML inference or JSON serialization."""
        return asdict(self)

    def to_features_list(self) -> List[float]:
        """Convert numerical features to a flat list ready for Random Forest/XGBoost input."""
        return [
            self.expected_visitors,
            self.accessibility_score,
            self.business_attraction_score,
            self.competition_score,
            self.income_proxy,
            self.customer_mix.get('students', 0.0),
            self.customer_mix.get('professionals', 0.0),
            self.customer_mix.get('families', 0.0),
            self.customer_mix.get('tourists', 0.0),
            self.customer_mix.get('residents', 0.0),
            self.demand_supply_ratio,
            self.transit_score,
            self.walkability_score,
            self.parking_score,
            self.area_diversity_score
        ]

@dataclass
class HuffMetrics:
    """Metrics computed by the Dynamic Huff Model layer (Paper 1)."""
    choice_probability: float
    distance_decay: float
    store_attraction: float
    market_share: float
    time_aware_visits: Dict[int, float]  # Hourly visits map

@dataclass
class ExtendedHuffMetrics:
    """Metrics computed by the Extended Huff Model layer (Paper 2)."""
    competition_adjustment: float
    demand_supply_ratio: float
    business_performance: float
    retail_turnover: float
    revenue_confidence: float

@dataclass
class PredictionResult:
    """Final output from the prediction engine."""
    hourly_revenue: float
    daily_revenue: float
    weekly_revenue: float
    monthly_revenue: float
    annual_revenue: float
    potential_score: int
    confidence_score: int
    revenue_range: Tuple[float, float]
    business_health: str
    risk_level: str
    top_positive_factors: List[str]
    top_negative_factors: List[str]
    actionable_recommendations: List[str]

    def to_dict(self) -> Dict[str, any]:
        """Convert results to a dictionary for API views."""
        res = asdict(self)
        # Convert tuple range to a dict for JSON compatibility
        res['revenue_range'] = {
            'min': self.revenue_range[0],
            'max': self.revenue_range[1]
        }
        return res
