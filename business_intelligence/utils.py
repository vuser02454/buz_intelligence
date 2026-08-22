import requests
import math
import random
from datetime import datetime

# --- ADVANCED BUSINESS METRICS & CONFIG ---
BUSINESS_METRICS = {
    'cafe': {
        'avg_spend': 350, 
        'base_conv': 0.18, 
        'label': 'Hospitality',
        'optimal_range': (20, 60),  # Ideal crowd per hour
        'sensitivity': 'high'       # Highly sensitive to overcrowding
    },
    'restaurant': {
        'avg_spend': 1200, 
        'base_conv': 0.10, 
        'label': 'Dining',
        'optimal_range': (40, 100),
        'sensitivity': 'medium'
    },
    'fast_food': {
        'avg_spend': 500, 
        'base_conv': 0.25, 
        'label': 'Dining',
        'optimal_range': (50, 150),
        'sensitivity': 'low'
    },
    'shop': {
        'avg_spend': 2000, 
        'base_conv': 0.08, 
        'label': 'Retail',
        'optimal_range': (10, 50),
        'sensitivity': 'medium'
    },
    'supermarket': {
        'avg_spend': 1800, 
        'base_conv': 0.35, 
        'label': 'Retail',
        'optimal_range': (50, 200),
        'sensitivity': 'low'
    },
    'pharmacy': {
        'avg_spend': 800, 
        'base_conv': 0.40, 
        'label': 'Healthcare',
        'optimal_range': (10, 40),
        'sensitivity': 'high' # People need quick service
    },
    'default': {
        'avg_spend': 600, 
        'base_conv': 0.05, 
        'label': 'General Business',
        'optimal_range': (10, 50),
        'sensitivity': 'medium'
    }
}

# CQI Multipliers (Spending Power)
CQI_MULTIPLIERS = {
    'student': 0.6,    # Low spend
    'professional': 1.8, # High spend
    'family': 1.3,      # Medium-High
    'tourist': 2.5,     # Very High
    'resident': 1.0     # Baseline
}

# --- HELPER FUNCTIONS ---

def get_temporal_multiplier():
    """Smart time-of-day multiplier for crowd quality & volume."""
    hour = datetime.now().hour
    # Late Night (0-6)
    if 0 <= hour < 6: return 0.2
    # Morning Rush (6-10) - High volume, low browse time
    if 6 <= hour < 10: return 0.8
    # Lunch Peak (11-14) - Professionals eating out
    if 11 <= hour < 14: return 1.4
    # Afternoon Slump (14-17)
    if 14 <= hour < 17: return 0.9
    # Evening Peak (17-21) - Leisure + Shopping
    if 17 <= hour < 21: return 1.6
    # Late Evening (21-24)
    return 1.1

def calculate_cqi(area_type):
    """
    Calculate Customer Quality Index (CQI) based on inferred area type.
    Returns: float multiplier for revenue.
    """
    # Simply mapping area types to dominant customer profiles
    if area_type == 'college':
        return CQI_MULTIPLIERS['student']
    elif area_type == 'commercial':
        return CQI_MULTIPLIERS['professional']
    elif area_type == 'market' or area_type == 'mall':
        return CQI_MULTIPLIERS['family']
    elif area_type == 'tourism' or area_type == 'attraction':
        return CQI_MULTIPLIERS['tourist']
    return CQI_MULTIPLIERS['resident']

def get_overload_penalty(current_crowd, optimal_max, sensitivity):
    """
    Apply revenue penalty if crowd exceeds optimal capacity.
    Too many people = bad service = lost revenue.
    """
    if current_crowd <= optimal_max:
        return 1.0 # No penalty
    
    excess_ratio = (current_crowd - optimal_max) / optimal_max
    
    # Penalty severity based on business type
    factor = 0.5 if sensitivity == 'high' else 0.2
    
    # If 50% over capacity, penalty is 1.0 - (0.5 * 0.5) = 0.75 (25% loss)
    penalty = max(0.4, 1.0 - (excess_ratio * factor))
    return penalty

def calculate_crowd_score(elements):
    """Returns a score 0-100 indicating crowd density."""
    if not elements: return 0
    return min(len(elements), 100) # Simple cap for UI score

def predict_revenue(dummy_score):
    """Legacy wrapper for simple single-value return (backward compatibility)."""
    score = max(0, min(100, int(dummy_score or 0)))
    # Keep this deterministic and simple for compatibility paths.
    return int(120000 + (score * 7200))

def _infer_area_type(places):
    """Heuristics to guess area type from POIs."""
    counts = {'shop': 0, 'office': 0, 'tourism': 0, 'amenity': 0}
    for p in places:
        tags = p.get('tags', {})
        if 'shop' in tags: counts['shop'] += 1
        if 'office' in tags: counts['office'] += 1
        if 'tourism' in tags: counts['tourism'] += 1
        if 'amenity' in tags: counts['amenity'] += 1
    
    total = len(places)
    if not total: return 'residential'
    
    if counts['office'] > total * 0.2: return 'commercial'
    if counts['tourism'] > total * 0.1: return 'tourism'
    if counts['shop'] > total * 0.4: return 'market'
    return 'residential'

# --- MAIN REVENUE ENGINE ---

def _coord_from_element(el):
    lat = el.get('lat') or (el.get('center') or {}).get('lat')
    lon = el.get('lon') or (el.get('center') or {}).get('lon')
    if lat is None or lon is None:
        return None
    return float(lat), float(lon)


def enrich_places_with_revenue(places):
    """
    Advanced Revenue AI calculation.
    Enriches top popular POIs using spatial prediction engine while using all places as context.
    """
    if not places:
        return [], 0.0
    
    from .prediction_engine import predict_site_revenue
    
    # Filter target places: named businesses / POIs (amenity, shop, tourism)
    target_places = []
    for p in places:
        tags = p.get('tags', {})
        if 'name' in tags and ('amenity' in tags or 'shop' in tags or 'tourism' in tags):
            target_places.append(p)
            if len(target_places) >= 30:
                break
                
    # If no named places found, fallback to first 20 elements that have coords
    if not target_places:
        for p in places:
            if _coord_from_element(p):
                target_places.append(p)
                if len(target_places) >= 20:
                    break

    target_ids = {p.get('id') for p in target_places if p.get('id') is not None}
    
    # For smaller inputs (e.g. tests <= 50 items), retain all elements;
    # For massive Overpass responses (> 50 items), return top target places to avoid 30MB JSON payload.
    pool = places if len(places) <= 50 else target_places
    
    enriched_places = []
    total_area_monthly_revenue = 0.0
    
    for p in pool:
        coords = _coord_from_element(p)
        if not coords:
            continue
            
        p_lat, p_lon = coords
        tags = p.get('tags') or {}
        
        # If this is not a target business, add baseline revenue structure
        if target_ids and p.get('id') not in target_ids:
            enriched = dict(p)
            enriched['revenue_data'] = {
                'estimated_daily_revenue': 0.0,
                'estimated_monthly_revenue': 0.0,
                'peak_hour_revenue': 0.0,
                'potential_score': 0,
                'business_health': 'Weak',
                'overload_risk': 0,
            }
            enriched_places.append(enriched)
            continue
            
        # Align OSM tags with BUSINESS_METRICS in config.py
        raw_amenity = tags.get('amenity')
        raw_shop = tags.get('shop')
        
        if raw_amenity in ['cafe', 'restaurant', 'fast_food', 'pharmacy']:
            b_type = raw_amenity
        elif raw_amenity in ['pub', 'bar', 'food_court', 'biergarten']:
            b_type = 'restaurant'
        elif raw_shop == 'supermarket':
            b_type = 'supermarket'
        elif raw_shop:
            b_type = 'shop'
        else:
            b_type = 'default'
        
        # Filter elements within 1500m radius of this place to construct its local context
        local_elements = []
        for other in places:
            other_coords = _coord_from_element(other)
            if other_coords:
                dist = _haversine_m(p_lat, p_lon, other_coords[0], other_coords[1])
                if dist <= 1500:
                    local_elements.append(other)
                    
        # Run prediction
        res = predict_site_revenue(p_lat, p_lon, local_elements, b_type)
        res_dict = res.to_dict()
        
        revenue_data = {
            'estimated_daily_revenue': res_dict['daily_revenue'],
            'estimated_monthly_revenue': res_dict['monthly_revenue'],
            'peak_hour_revenue': res_dict['hourly_revenue'],
            'potential_score': res_dict['potential_score'],
            'business_health': res_dict['business_health'],
            'overload_risk': int(100 - res_dict['confidence_score']),
            'confidence_score': res_dict['confidence_score'],
            'risk_level': res_dict['risk_level'],
            'revenue_range': res_dict['revenue_range'],
            'hourly_revenue': res_dict['hourly_revenue'],
            'daily_revenue': res_dict['daily_revenue'],
            'weekly_revenue': res_dict['weekly_revenue'],
            'monthly_revenue': res_dict['monthly_revenue'],
            'annual_revenue': res_dict['annual_revenue'],
            'top_positive_factors': res_dict['top_positive_factors'],
            'top_negative_factors': res_dict['top_negative_factors'],
            'recommendations': res_dict['actionable_recommendations'],
            'actionable_recommendations': res_dict['actionable_recommendations'],
        }
        
        enriched = dict(p)
        enriched['revenue_data'] = revenue_data
        enriched_places.append(enriched)
        total_area_monthly_revenue += res.monthly_revenue
        
    enriched_places.sort(key=lambda x: x.get('revenue_data', {}).get('estimated_monthly_revenue', 0), reverse=True)
    return enriched_places, round(total_area_monthly_revenue, 2)




def _haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


def _daypart_multiplier(hour):
    if 5 <= hour < 10:
        return 0.78, "Morning"
    if 10 <= hour < 14:
        return 1.22, "Lunch Spike"
    if 14 <= hour < 17:
        return 0.95, "Afternoon"
    if 17 <= hour < 22:
        return 1.35, "Evening Peak"
    return 0.58, "Night Drop"


def _infer_customer_mix(elements):
    total = max(1, len(elements))
    students = 0
    professionals = 0
    families = 0
    tourists = 0

    for el in elements:
        tags = el.get('tags') or {}
        amenity = str(tags.get('amenity') or '').lower()
        shop = str(tags.get('shop') or '').lower()
        tourism = str(tags.get('tourism') or '').lower()

        if amenity in {'school', 'college', 'university'}:
            students += 2
        if amenity in {'bank', 'office', 'restaurant', 'cafe'}:
            professionals += 2
        if shop in {'supermarket', 'mall', 'clothes', 'clothing', 'department_store'}:
            families += 2
        if tourism:
            tourists += 3
        if amenity in {'park', 'cinema', 'hospital'}:
            families += 1

    # Baseline mix so sparse data still works.
    students += int(total * 0.10)
    professionals += int(total * 0.16)
    families += int(total * 0.14)
    tourists += int(total * 0.08)

    mix_total = max(1, students + professionals + families + tourists)
    return {
        "students": students / mix_total,
        "professionals": professionals / mix_total,
        "families": families / mix_total,
        "tourists": tourists / mix_total,
    }


def _customer_quality_index(mix):
    return (
        mix["students"] * CQI_MULTIPLIERS["student"] +
        mix["professionals"] * CQI_MULTIPLIERS["professional"] +
        mix["families"] * CQI_MULTIPLIERS["family"] +
        mix["tourists"] * CQI_MULTIPLIERS["tourist"]
    )


def _competition_density(elements, business_type):
    if not elements:
        return 0.0
    needle = (business_type or '').strip().lower().replace(' ', '_')
    if not needle:
        return 0.2
    same = 0
    for el in elements:
        tags = el.get('tags') or {}
        poi = str(tags.get('amenity') or tags.get('shop') or tags.get('tourism') or '').lower().replace(' ', '_')
        if poi and (poi == needle or needle in poi or poi in needle):
            same += 1
    return min(1.0, same / max(1, len(elements)))


def _recommendations_from_metrics(metrics):
    recs = []
    if metrics['overload_risk'] >= 70:
        recs.append("High overload risk detected: add queue automation and split peak-hour staffing.")
    elif metrics['overload_risk'] >= 40:
        recs.append("Moderate overload risk: introduce time-slot discounts to flatten spikes.")
    else:
        recs.append("Low overload risk: scale marketing during lunch/evening to capture unused capacity.")

    if metrics['conversion_rate'] < 0.08:
        recs.append("Conversion is weak: improve storefront visibility and local ad targeting.")
    else:
        recs.append("Conversion is healthy: prioritize upsell bundles to lift average spend.")

    if metrics['customer_quality'] < 1.1:
        recs.append("Customer quality is budget-sensitive: offer value packs and loyalty rewards.")
    elif metrics['customer_quality'] > 1.6:
        recs.append("High-spend audience detected: premium positioning can materially increase revenue.")

    return recs[:3]


def calculate_smart_revenue(elements, business_type='default', hour=None, lat=None, lon=None):
    """
    Wrapper around the redesigned prediction engine to calculate smart revenue.
    """
    from .prediction_engine import predict_site_revenue, FeatureExtractor
    
    # Extract lat/lon if not provided
    if lat is None or lon is None:
        lats = []
        lons = []
        for el in (elements or []):
            el_lat = el.get('lat') or (el.get('center', {}).get('lat'))
            el_lon = el.get('lon') or (el.get('center', {}).get('lon'))
            if el_lat is not None and el_lon is not None:
                lats.append(float(el_lat))
                lons.append(float(el_lon))
        lat = sum(lats)/len(lats) if lats else 19.0760
        lon = sum(lons)/len(lons) if lons else 72.8777
        
    res = predict_site_revenue(lat, lon, elements or [], business_type, hour)
    res_dict = res.to_dict()
    
    # Map back to legacy keys for frontend compatibility
    # and provide the new requested parameters
    result = {
        'estimated_daily_revenue': res_dict['daily_revenue'],
        'daily_revenue': res_dict['daily_revenue'],
        'estimated_monthly_revenue': res_dict['monthly_revenue'],
        'monthly_revenue': res_dict['monthly_revenue'],
        'peak_hour_revenue': res_dict['hourly_revenue'],
        'hourly_revenue': res_dict['hourly_revenue'],
        'weekly_revenue': res_dict['weekly_revenue'],
        'annual_revenue': res_dict['annual_revenue'],
        'potential_score': res_dict['potential_score'],
        'confidence_score': res_dict['confidence_score'],
        'revenue_range': res_dict['revenue_range'],
        'business_health': res_dict['business_health'],
        'risk_level': res_dict['risk_level'],
        'top_positive_factors': res_dict['top_positive_factors'],
        'top_negative_factors': res_dict['top_negative_factors'],
        'recommendations': res_dict['actionable_recommendations'],
        'actionable_recommendations': res_dict['actionable_recommendations'],
        'overload_risk': int(100 - res_dict['confidence_score']),
    }
    
    # Fallback/mock values for helper metrics (retaining legacy fields for stability)
    extractor = FeatureExtractor(lat, lon, business_type)
    features = extractor.extract_features(elements or [])
    
    now_hour = datetime.now().hour if hour is None else int(hour) % 24
    from .prediction_engine.config import TEMPORAL_PATTERNS
    _, daypart = TEMPORAL_PATTERNS.get(now_hour, (1.0, "Active"))
    
    result.update({
        'daypart': daypart,
        'footfall': features.expected_visitors,
        'conversion_rate': round(features.competition_score / 1000.0, 4), # mock proxy
        'customer_quality': round(features.income_proxy / 40.0, 3), # mock proxy
        'dynamic_avg_spend': round(features.income_proxy * 10.0, 2), # mock proxy
        'effective_customers': round(features.expected_visitors * 0.1, 2)
    })
    
    return result


def generate_best_location_candidates(base_lat, base_lon, elements, top_n=3):
    """
    Generate 1-3 best locations around a selected point using feasibility scoring.
    """
    offsets = [
        (0.0000, 0.0000), (0.0080, 0.0045), (-0.0080, -0.0040),
        (0.0065, -0.0060), (-0.0060, 0.0065), (0.0120, 0.0000),
        (0.0000, -0.0120), (-0.0110, 0.0020)
    ]

    candidates = []
    for i, (dlat, dlon) in enumerate(offsets, start=1):
        c_lat = float(base_lat) + dlat
        c_lon = float(base_lon) + dlon

        # Build local neighborhood for each candidate.
        local = []
        for el in (elements or []):
            coord = _coord_from_element(el)
            if not coord:
                continue
            if _haversine_m(c_lat, c_lon, coord[0], coord[1]) <= 1700:
                local.append(el)

        # Use our new feature extractor to determine local factors
        from .prediction_engine import FeatureExtractor, predict_site_revenue
        extractor = FeatureExtractor(c_lat, c_lon, 'default')
        features = extractor.extract_features(local)
        
        # Determine the best business type using features
        rec_business = 'supermarket'
        if features.income_proxy > 60.0 and features.competition_score < 45.0:
            rec_business = 'restaurant'
        elif features.demand_supply_ratio > 1.3 and features.expected_visitors > 300:
            rec_business = 'cafe'
        elif features.competition_score > 60.0:
            rec_business = 'pharmacy'

        # Run our prediction engine for this candidate site
        res = predict_site_revenue(c_lat, c_lon, local, rec_business)
        res_dict = res.to_dict()

        # Map factors for candidate representation
        factors = {
            'footfall_potential': round(features.expected_visitors / 10.0, 2), # normalized
            'competition_density': round(features.competition_score, 2),
            'spending_power': round(features.income_proxy, 2),
            'area_growth': round(features.accessibility_score, 2),
            'demand_supply_gap': round(features.demand_supply_ratio * 40.0, 2)
        }

        candidates.append({
            'lat': round(c_lat, 6),
            'lng': round(c_lon, 6),
            'name': f"AI Zone {i}",
            'business_type': rec_business.replace('_', ' ').title(),
            'score': round(res.potential_score, 1),
            'estimated_revenue': round(res.monthly_revenue, 2),
            'feasibility_factors': factors,
            'revenue_data': res_dict,
        })

    candidates.sort(key=lambda x: x['score'], reverse=True)
    return candidates[:max(1, min(3, int(top_n or 3)))]
