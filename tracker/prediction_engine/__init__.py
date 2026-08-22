"""
Prediction Engine package.
Provides an ML-ready GIS prediction engine utilizing Huff and Extended Huff models.
"""

from typing import List, Dict, Any
from .data_classes import OSMFeatures, PredictionResult, HuffMetrics, ExtendedHuffMetrics
from .feature_extractor import FeatureExtractor, haversine_distance
from .huff_layer import HuffModel
from .extended_huff import ExtendedHuffModel
from .predictor import RevenuePredictor
from .predictor_interface import PredictorInterface

def predict_site_revenue(
    lat: float,
    lon: float,
    elements: List[Dict[str, Any]],
    business_type: str,
    hour: int | None = None
) -> PredictionResult:
    """
    High-level entrypoint to extract features and run the revenue prediction engine.
    
    Args:
        lat: Target location latitude.
        lon: Target location longitude.
        elements: Raw OSM POI elements in the area.
        business_type: Target business category (cafe, restaurant, etc.).
        hour: Target hour for peak predictions (optional).
        
    Returns:
        PredictionResult containing granular revenues and analytical scores.
    """
    # 1. Feature Extraction Layer
    extractor = FeatureExtractor(lat, lon, business_type)
    features = extractor.extract_features(elements)
    
    # 2. Prediction Model Layer (using RevenuePredictor which implements PredictorInterface)
    predictor = RevenuePredictor()
    return predictor.predict(
        features=features,
        elements=elements,
        business_type=business_type,
        target_lat=lat,
        target_lon=lon,
        hour=hour
    )
