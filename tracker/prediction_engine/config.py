"""
Configuration and constants for the revenue prediction engine.
All weights, rates, spend averages, and decay constants are defined here.
"""

from typing import Dict, Tuple, Any

# --- HUFF MODEL CONFIGURATION ---
DEFAULT_HUFF_LAMBDA: float = 1.5       # Default distance decay parameter (power law exponent)
DEFAULT_HUFF_SIGMA: float = 800.0      # Exponential decay distance (in meters) for features
DEFAULT_HUFF_BETA: float = 0.002       # Exponential decay parameter for choice probability

# --- EXTENDED HUFF CONFIGURATION ---
DEFAULT_EXTENDED_GAMMA: float = 0.15   # Competition decay factor (saturation rate)
DEFAULT_EXTENDED_EPSILON: float = 1e-6 # Avoid division by zero

# --- BUSINESS TYPE METRICS ---
# Config parameters for each business category
BUSINESS_METRICS: Dict[str, Dict[str, Any]] = {
    'cafe': {
        'avg_spend': 350.0,
        'base_conv': 0.18,
        'label': 'Hospitality',
        'optimal_range': (20, 60),     # Optimal hourly customer count
        'sensitivity': 'high',         # High sensitivity to crowding
        'attractiveness_base': 1.2,
    },
    'restaurant': {
        'avg_spend': 1200.0,
        'base_conv': 0.10,
        'label': 'Dining',
        'optimal_range': (40, 100),
        'sensitivity': 'medium',
        'attractiveness_base': 1.5,
    },
    'fast_food': {
        'avg_spend': 500.0,
        'base_conv': 0.25,
        'label': 'Dining',
        'optimal_range': (50, 150),
        'sensitivity': 'low',
        'attractiveness_base': 1.3,
    },
    'shop': {
        'avg_spend': 2000.0,
        'base_conv': 0.08,
        'label': 'Retail',
        'optimal_range': (10, 50),
        'sensitivity': 'medium',
        'attractiveness_base': 1.0,
    },
    'supermarket': {
        'avg_spend': 1800.0,
        'base_conv': 0.35,
        'label': 'Retail',
        'optimal_range': (50, 200),
        'sensitivity': 'low',
        'attractiveness_base': 1.8,
    },
    'pharmacy': {
        'avg_spend': 800.0,
        'base_conv': 0.40,
        'label': 'Healthcare',
        'optimal_range': (10, 40),
        'sensitivity': 'high',
        'attractiveness_base': 1.1,
    },
    'default': {
        'avg_spend': 600.0,
        'base_conv': 0.05,
        'label': 'General Business',
        'optimal_range': (10, 50),
        'sensitivity': 'medium',
        'attractiveness_base': 1.0,
    }
}

# --- CUSTOMER DEMOGRAPHIC MULTIPLIERS ---
# Maps specific customer categories to their spending power multipliers
CQI_MULTIPLIERS: Dict[str, float] = {
    'student': 0.6,       # Lower spending power
    'professional': 1.8,  # Higher spending power
    'family': 1.3,        # Moderate-high spending power
    'tourist': 2.5,       # Very high spending power
    'resident': 1.0       # Baseline spending power
}

# --- TEMPORAL DIURNAL PATTERNS ---
# Hourly multipliers for customer volumes
# Keys are hours 0-23. Values are (multiplier, label)
TEMPORAL_PATTERNS: Dict[int, Tuple[float, str]] = {
    0: (0.2, "Late Night"),
    1: (0.15, "Late Night"),
    2: (0.1, "Late Night"),
    3: (0.05, "Late Night"),
    4: (0.05, "Late Night"),
    5: (0.1, "Early Morning"),
    6: (0.3, "Early Morning"),
    7: (0.6, "Morning Rush"),
    8: (0.8, "Morning Rush"),
    9: (0.9, "Morning Rush"),
    10: (1.0, "Morning"),
    11: (1.2, "Lunch Spike"),
    12: (1.4, "Lunch Spike"),
    13: (1.3, "Lunch Spike"),
    14: (0.9, "Afternoon Slump"),
    15: (0.9, "Afternoon Slump"),
    16: (1.0, "Afternoon"),
    17: (1.3, "Evening Peak"),
    18: (1.6, "Evening Peak"),
    19: (1.7, "Evening Peak"),
    20: (1.5, "Evening Peak"),
    21: (1.2, "Late Evening"),
    22: (0.8, "Late Evening"),
    23: (0.4, "Late Evening"),
}

# --- FEATURE EXTRACTION WEIGHTS ---
# Normalization ranges and multipliers for scores
TRANSIT_POI_FACTOR: float = 15.0
WALKABILITY_POI_FACTOR: float = 10.0
PARKING_POI_FACTOR: float = 25.0
ATTRACTOR_POI_FACTOR: float = 8.0
COMPETITOR_POI_FACTOR: float = 20.0

ACCESSIBILITY_WEIGHTS: Dict[str, float] = {
    'transit': 0.4,
    'walkability': 0.4,
    'parking': 0.2
}
