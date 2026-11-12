"""
Tunable constants for Business Synergy Intelligence.

Weights and uplift caps can be overridden in Django settings:
  SYNERGY_WEIGHTS = {'business': .30, 'environment': .25, 'customer': .20, 'competition': .15, 'accessibility': .10}
  SYNERGY_UPLIFT_CAPS = {'conservative': .05, 'moderate': .10, 'optimistic': .15}
Weights must be non-negative and sum to 1.
"""
from django.conf import settings

DEFAULT_WEIGHTS = {
    'business': 0.30,       # complementary existing businesses
    'environment': 0.25,    # demand generators around the site (transit, campuses, homes, tourism)
    'customer': 0.20,       # how many of the customer groups this business suits are present
    'competition': 0.15,    # competition- and cluster-adjusted opportunity (higher = better)
    'accessibility': 0.10,  # engine accessibility score (transit, walkability, parking)
}

# Uplift at a synergy score of 100 with full data coverage. ILLUSTRATIVE scenario
# assumptions, not validated effects: the actual uplift is scaled down by the score
# and by data coverage (see revenue_uplift.py).
DEFAULT_UPLIFT_CAPS = {'conservative': 0.05, 'moderate': 0.10, 'optimistic': 0.15}

SEARCH_RADIUS_M = 1500          # places within this distance can contribute (about a 20-minute walk)
FULL_WEIGHT_WITHIN_M = 300      # a place this close counts fully …
MIN_DISTANCE_WEIGHT = 0.2       # … falling linearly to this weight at SEARCH_RADIUS_M
COMPETITION_RADIUS_M = 1000
CLUSTER_RADIUS_M = 400
COVERAGE_FULL_AT = 150          # mapped places within SEARCH_RADIUS_M for full data coverage
CUSTOMER_GROUP_SATURATION = 5.0 # distance-weighted places that make a customer group "fully present"

LEVELS = [(70, 'Strong'), (50, 'Moderate'), (30, 'Limited'), (0, 'Weak')]

LABELS = {
    'business': 'Nearby complementary businesses',
    'environment': 'Surrounding demand (transit, campuses, homes, tourism)',
    'customer': 'Matching customer groups',
    'competition': 'Competition-adjusted opportunity',
    'accessibility': 'Accessibility',
}


def weights():
    w = dict(DEFAULT_WEIGHTS)
    w.update(getattr(settings, 'SYNERGY_WEIGHTS', None) or {})
    if set(w) != set(DEFAULT_WEIGHTS) or any(v < 0 for v in w.values()) or abs(sum(w.values()) - 1.0) > 1e-6:
        raise ValueError('SYNERGY_WEIGHTS must have the keys business, environment, customer, competition, '
                         'accessibility with non-negative values summing to 1.')
    return w


def uplift_caps():
    caps = dict(DEFAULT_UPLIFT_CAPS)
    caps.update(getattr(settings, 'SYNERGY_UPLIFT_CAPS', None) or {})
    if any(not 0 <= v <= 0.5 for v in caps.values()):
        raise ValueError('SYNERGY_UPLIFT_CAPS values must be between 0 and 0.5')
    return caps


def level_for(score):
    for threshold, name in LEVELS:
        if score >= threshold:
            return name
    return LEVELS[-1][1]
