"""
Feature Extraction Layer.
Responsible for extracting spatial features from raw OpenStreetMap (Overpass API)
data and engineering 11 ML-ready scores.
"""

import math
import collections
from typing import List, Dict, Tuple, Any
from .config import (
    DEFAULT_HUFF_SIGMA,
    TRANSIT_POI_FACTOR,
    WALKABILITY_POI_FACTOR,
    PARKING_POI_FACTOR,
    ATTRACTOR_POI_FACTOR,
    COMPETITOR_POI_FACTOR,
    ACCESSIBILITY_WEIGHTS,
    CQI_MULTIPLIERS,
    BUSINESS_METRICS
)
from .data_classes import OSMFeatures

def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate the great-circle distance between two points in meters."""
    radius = 6371000.0  # Earth's radius in meters
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2.0) ** 2 +
         math.cos(p1) * math.cos(p2) * math.sin(dlon / 2.0) ** 2)
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return radius * c

class FeatureExtractor:
    """Extracts and engineers spatial features from OSM elements around a target coordinate."""

    def __init__(self, target_lat: float, target_lon: float, business_type: str):
        self.target_lat = target_lat
        self.target_lon = target_lon
        self.business_type = business_type.strip().lower().replace(' ', '_')
        self.sigma = DEFAULT_HUFF_SIGMA

    def _get_element_coords(self, el: Dict[str, Any]) -> Tuple[float, float] | None:
        """Extract lat/lon from raw element dict."""
        lat = el.get('lat') or (el.get('center') or {}).get('lat')
        lon = el.get('lon') or (el.get('center') or {}).get('lon')
        if lat is None or lon is None:
            return None
        return float(lat), float(lon)

    def extract_features(self, elements: List[Dict[str, Any]]) -> OSMFeatures:
        """Process OSM elements and generate a set of engineered features."""
        # 1. Initialize category counters (with distance-decay weighted scores)
        cat_scores = collections.defaultdict(float)
        cat_counts = collections.defaultdict(int)
        
        # We need counts/scores for our 20 categories:
        # residential, commercial, offices, schools, universities, hospitals,
        # shopping, markets, hotels, tourism, metro, railway, bus_stops,
        # parking, roads, footpaths, intersections, public_transport, competition, business_density
        
        competitors_list: List[Dict[str, Any]] = []
        business_tags_seen = []

        for el in elements:
            coords = self._get_element_coords(el)
            if not coords:
                continue
                
            dist = haversine_distance(self.target_lat, self.target_lon, coords[0], coords[1])
            # Weight decay decays exponentially with distance
            weight = math.exp(-dist / self.sigma)
            
            tags = el.get('tags') or {}
            amenity = tags.get('amenity', '')
            shop = tags.get('shop', '')
            tourism = tags.get('tourism', '')
            building = tags.get('building', '')
            office = tags.get('office', '')
            highway = tags.get('highway', '')
            railway = tags.get('railway', '')
            public_transport = tags.get('public_transport', '')
            
            # Determine which categories this element belongs to
            categories = []
            
            # 1. Residential Buildings
            if building in ('residential', 'apartments', 'house', 'terrace', 'detached', 'dormitory'):
                categories.append('residential')
                
            # 2. Commercial Buildings
            if building in ('commercial', 'retail', 'supermarket'):
                categories.append('commercial')
                
            # 3. Office Buildings
            if office or building == 'office':
                categories.append('offices')
                
            # 4. Schools
            if amenity == 'school':
                categories.append('schools')
                
            # 5. Universities
            if amenity in ('university', 'college'):
                categories.append('universities')
                
            # 6. Hospitals
            if amenity in ('hospital', 'clinic', 'doctors', 'dentist', 'pharmacy'):
                categories.append('hospitals')
                
            # 7. Shopping Areas
            if shop or amenity == 'mall' or building == 'retail':
                categories.append('shopping')
                
            # 8. Markets
            if amenity == 'marketplace' or shop == 'supermarket':
                categories.append('markets')
                
            # 9. Hotels
            if tourism in ('hotel', 'motel', 'guest_house', 'hostel'):
                categories.append('hotels')
                
            # 10. Tourism
            if tourism:
                categories.append('tourism')
                
            # 11. Metro Stations
            if railway in ('subway_entrance', 'subway') or tags.get('subway') == 'yes' or tags.get('metro') == 'yes':
                categories.append('metro')
                
            # 12. Railway Stations
            if railway == 'station':
                categories.append('railway')
                
            # 13. Bus Stops
            if highway in ('bus_stop', 'platform') or amenity == 'bus_station':
                categories.append('bus_stops')
                
            # 14. Parking
            if amenity == 'parking' or building == 'parking':
                categories.append('parking')
                
            # 15. Road Types
            if highway in ('primary', 'secondary', 'tertiary', 'trunk', 'motorway'):
                categories.append('roads')
                
            # 16. Footpaths
            if highway in ('footway', 'path', 'pedestrian', 'cycleway', 'steps'):
                categories.append('footpaths')
                
            # 17. Intersections
            if highway in ('crossing', 'traffic_signals', 'mini_roundabout', 'stop', 'give_way'):
                categories.append('intersections')
                
            # 18. Public Transport
            if public_transport or railway in ('station', 'subway_entrance', 'subway') or highway in ('bus_stop', 'platform'):
                categories.append('public_transport')
                
            # 19. Competition
            poi_type = (amenity or shop or tourism or '').lower().replace(' ', '_')
            if poi_type:
                business_tags_seen.append(poi_type)
                # Check if it matches target business type
                # If target is café, match café/coffee_shop etc.
                is_comp = False
                if self.business_type == 'default':
                    is_comp = False
                elif poi_type == self.business_type:
                    is_comp = True
                elif self.business_type in poi_type or poi_type in self.business_type:
                    is_comp = True
                
                # Check if it is a different POI coordinate
                if is_comp and dist > 10.0:  # Not the target store itself
                    categories.append('competition')
                    competitors_list.append(el)

            # 20. Business Density
            if shop or amenity or office or tourism:
                categories.append('business_density')
                
            # Apply weights and counts for matched categories
            for cat in categories:
                cat_scores[cat] += weight
                cat_counts[cat] += 1

        # --- ENGINEER METRIC FEATURES (Scale 0-100) ---
        
        # 1. Transit Score
        transit_val = (cat_scores['metro'] * 2.0 +
                       cat_scores['railway'] * 2.0 +
                       cat_scores['bus_stops'] * 1.0 +
                       cat_scores['public_transport'] * 1.0)
        transit_score = min(100.0, transit_val * TRANSIT_POI_FACTOR)
        
        # 2. Walkability Score
        walkability_val = (cat_scores['footpaths'] * 1.5 +
                           cat_scores['intersections'] * 1.0)
        walkability_score = min(100.0, walkability_val * WALKABILITY_POI_FACTOR)
        
        # 3. Parking Score
        parking_score = min(100.0, cat_scores['parking'] * PARKING_POI_FACTOR)
        
        # 4. Accessibility Score
        accessibility_score = (
            transit_score * ACCESSIBILITY_WEIGHTS['transit'] +
            walkability_score * ACCESSIBILITY_WEIGHTS['walkability'] +
            parking_score * ACCESSIBILITY_WEIGHTS['parking']
        )
        
        # 5. Business Attraction Score
        attraction_val = (cat_scores['shopping'] * 1.0 +
                          cat_scores['markets'] * 1.5 +
                          cat_scores['hotels'] * 1.2 +
                          cat_scores['tourism'] * 0.8)
        business_attraction_score = min(100.0, attraction_val * ATTRACTOR_POI_FACTOR)
        
        # 6. Competition Score
        competition_score = min(100.0, cat_scores['competition'] * COMPETITOR_POI_FACTOR)
        
        # 7. Customer Mix & Income Proxy
        customer_mix = self._calculate_customer_mix(cat_counts)
        income_proxy = self._calculate_income_proxy(customer_mix)
        
        # 8. Expected Visitors
        # Baseline footfall based on residential, office, transit, and attraction densities
        base_visitors = (
            cat_scores['residential'] * 1.2 +
            cat_scores['offices'] * 1.8 +
            cat_scores['schools'] * 0.5 +
            cat_scores['universities'] * 0.8 +
            (transit_score / 100.0) * 15.0 +
            (business_attraction_score / 100.0) * 10.0
        )
        # Scale to an actual average daily crowd estimate
        expected_visitors = max(10.0, base_visitors * 15.0)

        # 9. Demand Supply Ratio
        demand = (cat_scores['residential'] * 1.5 +
                  cat_scores['offices'] * 2.0 +
                  cat_scores['schools'] * 1.0 +
                  cat_scores['universities'] * 1.2 +
                  cat_scores['hotels'] * 1.0)
        supply = (cat_scores['competition'] * 2.0 +
                  cat_scores['shopping'] * 0.8 +
                  cat_scores['markets'] * 1.0)
        demand_supply_ratio = demand / max(supply, 1.0)
        
        # 10. Area Diversity Score
        area_diversity_score = self._calculate_shannon_entropy(business_tags_seen)
        
        return OSMFeatures(
            expected_visitors=round(expected_visitors, 2),
            accessibility_score=round(accessibility_score, 2),
            business_attraction_score=round(business_attraction_score, 2),
            competition_score=round(competition_score, 2),
            income_proxy=round(income_proxy, 2),
            customer_mix=customer_mix,
            demand_supply_ratio=round(demand_supply_ratio, 3),
            transit_score=round(transit_score, 2),
            walkability_score=round(walkability_score, 2),
            parking_score=round(parking_score, 2),
            area_diversity_score=round(area_diversity_score, 2)
        )

    def _calculate_customer_mix(self, counts: Dict[str, int]) -> Dict[str, float]:
        """Infers customer segment proportions from spatial POIs."""
        students = counts['schools'] * 2.0 + counts['universities'] * 3.0
        professionals = counts['offices'] * 2.5 + counts['commercial'] * 1.0
        families = counts['residential'] * 1.5 + counts['markets'] * 1.0 + counts['hospitals'] * 0.5
        tourists = counts['hotels'] * 3.0 + counts['tourism'] * 1.5
        
        # Baseline mix values to handle data sparsity
        total_counts = students + professionals + families + tourists
        if total_counts == 0:
            # Return standard default profile
            return {
                "students": 0.15,
                "professionals": 0.25,
                "families": 0.40,
                "tourists": 0.10,
                "residents": 0.10
            }
            
        students_prop = students / total_counts
        professionals_prop = professionals / total_counts
        families_prop = families / total_counts
        tourists_prop = tourists / total_counts
        residents_prop = max(0.05, 1.0 - (students_prop + professionals_prop + families_prop + tourists_prop))
        
        # Normalize
        norm_sum = students_prop + professionals_prop + families_prop + tourists_prop + residents_prop
        return {
            "students": round(students_prop / norm_sum, 3),
            "professionals": round(professionals_prop / norm_sum, 3),
            "families": round(families_prop / norm_sum, 3),
            "tourists": round(tourists_prop / norm_sum, 3),
            "residents": round(residents_prop / norm_sum, 3)
        }

    def _calculate_income_proxy(self, mix: Dict[str, float]) -> float:
        """Calculates a spatial income score 0-100 based on demographic weights."""
        weighted_cqi = (
            mix["students"] * CQI_MULTIPLIERS["student"] +
            mix["professionals"] * CQI_MULTIPLIERS["professional"] +
            mix["families"] * CQI_MULTIPLIERS["family"] +
            mix["tourists"] * CQI_MULTIPLIERS["tourist"] +
            mix["residents"] * CQI_MULTIPLIERS["resident"]
        )
        # Normalize against typical max quality index (around 2.5)
        # A quality index of 1.0 maps to a score of 40, index of 2.0 maps to 80, etc.
        income_proxy = (weighted_cqi / 2.5) * 100.0
        return min(100.0, max(10.0, income_proxy))

    def _calculate_shannon_entropy(self, tags: List[str]) -> float:
        """Compute normalized Shannon entropy (0-100) of POI types to measure diversity."""
        if not tags:
            return 50.0  # Default moderate diversity
            
        counter = collections.Counter(tags)
        total = len(tags)
        
        entropy = 0.0
        for count in counter.values():
            p = count / total
            entropy -= p * math.log(p)
            
        # Max entropy for N unique items is log(N). Let's normalize by maximum practical classes (e.g. 10)
        # to get a percentage score
        max_entropy = math.log(max(2, len(counter)))
        normalized = (entropy / max_entropy) * 100.0 if max_entropy > 0 else 0.0
        return min(100.0, max(0.0, normalized))
