"""
Predictor Interface.
Defines the boundary contract for all revenue models, enabling the core prediction
module to be easily replaced with Machine Learning models (Random Forest, XGBoost)
without modifying views or data fetch layers.
"""

from abc import ABC, abstractmethod
from typing import List, Dict, Any
from .data_classes import OSMFeatures, PredictionResult

class PredictorInterface(ABC):
    """Abstract interface defining the prediction contract."""

    @abstractmethod
    def predict(
        self,
        features: OSMFeatures,
        elements: List[Dict[str, Any]],
        business_type: str,
        target_lat: float,
        target_lon: float,
        hour: int | None = None
    ) -> PredictionResult:
        """
        Generate revenue predictions and recommendations.
        
        Args:
            features: Engineered OSM features.
            elements: Raw OSM elements (for competitor and distance metrics).
            business_type: The type of business (cafe, restaurant, etc.).
            target_lat: Latitude of target location.
            target_lon: Longitude of target location.
            hour: Optional target hour for temporal predictions.
            
        Returns:
            PredictionResult dataclass containing revenues, scores, and factors.
        """
        pass
