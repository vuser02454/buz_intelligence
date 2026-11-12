from django.shortcuts import render, redirect
from django.http import JsonResponse
from django.urls import reverse
from django.utils.http import url_has_allowed_host_and_scheme
from django.contrib.auth.decorators import login_required  # kept for compatibility
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from django.contrib import messages
import json
import logging
import math
import requests
from django.core.cache import cache
from .forms import BusinessUserForm
from report_generator.auth import supabase_user_required
from .models import BusinessUser
from .consumers import get_bot_response
from . import utils
from .analysis import (  # noqa: F401  (re-exported for existing importers)
    _load_model,
    get_business_choices_for_intensity,
    get_all_business_choices,
    _INTENSITY_VARIANTS,
    _infer_area_from_pois,
    predict_business,
    _OVERPASS_URLS,
    _run_overpass_query,
    _build_overpass_query,
    classify_sectors,
    build_business_prediction,
    build_feasibility_query,
    evaluate_feasibility,
    feasibility_elements,
    feasibility_reasons,
    generate_location_business_recommendations,
    fetch_area_pois,
    elements_within,
    sample_places_across_sectors,
    HEATMAP_RADIUS_M,
    HIGH_DENSITY_PER_KM2,
    MEDIUM_DENSITY_PER_KM2,
)

logger = logging.getLogger(__name__)


def home(request):
    """Main page with map and controls."""
    return render(request, 'heatmap_app/home.html')




def dashboard(request):
    """Dashboard analytics view."""
    return render(request, 'heatmap_app/dashboard.html')


def safe_next_url(request, default=None):
    """`?next=` if it points back into this site, else `default` (the dashboard)."""
    default = default or reverse('dashboard')
    candidate = (request.GET.get('next') or '').strip()
    if (candidate.startswith('/') and not candidate.startswith('//')
            and url_has_allowed_host_and_scheme(candidate, allowed_hosts={request.get_host()},
                                                require_https=request.is_secure())):
        return candidate
    return default


def login_view(request):
    """
    Renders the Supabase-powered authentication page with Sign In & Sign Up.
    `next` is only honoured for same-site paths (no open redirect).
    """
    return render(request, 'heatmap_app/login.html', {
        'next_url': safe_next_url(request),
    })


def auth_callback(request):
    """
    Landing page for links in Supabase e-mails (signup confirmation, magic link,
    password recovery). The tokens arrive in the URL fragment, which never
    reaches the server; the page lets supabase-js read them, verifies the user
    with the auth server and then redirects to `next`.
    """
    return render(request, 'heatmap_app/auth_callback.html', {
        'next_url': safe_next_url(request),
    })


def profile_view(request):
    """
    Renders the user profile management page.
    Allows editing full name, login password, avatar, and other profile details.
    """
    return render(request, 'heatmap_app/profile.html')


@csrf_exempt
@require_http_methods(['POST'])
def log_activity_api(request):
    """
    Receives frontend activity events and logs them to the Supabase project DB.
    """
    try:
        data = json.loads(request.body)
    except (json.JSONDecodeError, TypeError):
        return JsonResponse({'success': False, 'message': 'Invalid JSON'}, status=400)

    event_type = data.get('event_type')
    if not event_type:
        return JsonResponse({'success': False, 'message': 'event_type is required'}, status=400)

    feature_name = data.get('feature_name', '')
    user_id = data.get('user_id')
    user_email = data.get('user_email')
    details = data.get('details', {})

    # Extract client IP
    x_forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR')
    if x_forwarded_for:
        ip_address = x_forwarded_for.split(',')[0].strip()
    else:
        ip_address = request.META.get('REMOTE_ADDR')

    # The Supabase write happens off the request thread: the browser fires this
    # with sendBeacon and nothing (in particular not sign-in) waits for it.
    from .supabase_service import log_activity_async
    log_activity_async(
        event_type=str(event_type)[:60],
        feature_name=str(feature_name or '')[:120],
        user_id=user_id,
        user_email=user_email,
        details=details if isinstance(details, dict) and len(json.dumps(details, default=str)) <= 4000 else {},
        ip_address=ip_address
    )
    return JsonResponse({'success': True, 'queued': True}, status=202)


@csrf_exempt
@require_http_methods(['POST'])
def report_user_location(request):
    """
    Receive user's current location (from browser geolocation or IP fallback).
    POST body: { "latitude": float, "longitude": float, "accuracy": int (optional), "source": "gps"|"ip" (optional) }
    Returns JSON: { "success": bool, "message": str }. Coordinates can be used for map/heatmap server-side if needed.
    """
    try:
        data = json.loads(request.body)
    except (json.JSONDecodeError, TypeError):
        return JsonResponse({'success': False, 'message': 'Invalid JSON'}, status=400)
    lat = data.get('latitude')
    lon = data.get('longitude')
    if lat is None or lon is None:
        return JsonResponse({'success': False, 'message': 'latitude and longitude are required'}, status=400)
    try:
        lat = float(lat)
        lon = float(lon)
    except (TypeError, ValueError):
        return JsonResponse({'success': False, 'message': 'latitude and longitude must be numbers'}, status=400)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return JsonResponse({'success': False, 'message': 'latitude/longitude out of range'}, status=400)
    source = data.get('source') or 'gps'
    accuracy = data.get('accuracy')
    # Optional: store in session for server-side use, e.g. request.session['user_lat'], request.session['user_lon']
    request.session['user_lat'] = lat
    request.session['user_lon'] = lon
    request.session['user_location_source'] = source
    return JsonResponse({
        'success': True,
        'message': 'Location received',
        'latitude': lat,
        'longitude': lon,
        'source': source,
    })


@csrf_exempt
@require_http_methods(['POST'])
def chat_message(request):
    """HTTP fallback for chatbot when WebSocket is not available."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'success': False, 'message': 'Invalid JSON'})
    user_message = (data.get('message') or '').strip()
    client_location = data.get('location')
    if not user_message:
        return JsonResponse({'success': False, 'message': 'Message is required'})
    from tracker.ai.orchestrator import process_user_query
    result = process_user_query(user_message, client_location_context=client_location)
    return JsonResponse({
        'success': result.get('success', True),
        'message': result.get('message', ''),
        'structured_actions': result.get('structured_actions', []),
        'location_context': result.get('location_context'),
        'providers_used': result.get('providers_used', [])
    })

@require_http_methods(['POST'])
def submit_form(request):
    """
    Startup form: validate, save the inquiry (BusinessUser), then run the
    feasibility check for the business type at the chosen location and compare
    the area's crowd sectors with the desired intensity. The response tells the
    page where to go on the map: {success, inquiry_id, feasibility, redirect}.
    The inquiry is saved even when OpenStreetMap is temporarily unavailable.
    """
    from report_generator.validators import ValidationError as InputError, validate_business_type

    post = request.POST
    name = post.get('name', '').strip()[:100]
    email = post.get('email', '').strip()[:254]
    phone = post.get('phone', '').strip()[:20]
    crowd_intensity = post.get('crowd_intensity', '').strip().lower()
    location_name = post.get('location_name', '').strip()[:200]

    errors = []
    if not name:
        errors.append('Name is required.')
    if not email or '@' not in email:
        errors.append('A valid email is required.')
    if not phone:
        errors.append('Phone is required.')
    try:
        business_type = validate_business_type(post.get('business_type'))
    except InputError as exc:
        business_type = ''
        errors.append(str(exc))
    if not business_type and not any('business_type' in e for e in errors):
        errors.append('Business type is required.')
    if crowd_intensity not in ('high', 'medium', 'low'):
        errors.append('Please select a crowd intensity.')
    try:
        lat, lon = _parse_lat_lon({'latitude': post.get('latitude'), 'longitude': post.get('longitude')})
    except ValueError:
        lat = lon = None
        errors.append('Choose the business location from the suggestions list.')
    if errors:
        return JsonResponse({'success': False, 'message': ' | '.join(errors)}, status=400)

    inquiry = BusinessUser.objects.create(
        name=name, email=email, phone=phone, business_type=business_type,
        recommended_business=(post.get('recommended_business') or '').strip()[:100] or None,
        crowd_intensity=crowd_intensity, latitude=lat, longitude=lon,
    )

    feasibility = {'status': 'unavailable'}
    verdict, unavailable = feasibility_verdict(lat, lon, business_type)
    if unavailable is not None:
        body = json.loads(unavailable.content)
        feasibility = {'status': 'pending' if body.get('pending') else 'unavailable', 'error': body.get('error')}
    else:
        area, _ = _area_elements(lat, lon, HEATMAP_RADIUS_M)
        grid = classify_sectors(area or [], lat, lon, HEATMAP_RADIUS_M)
        matching = grid[crowd_intensity]
        feasibility = {
            'status': 'ok',
            'feasible': verdict['feasible'],
            'verdict': 'Go' if verdict['feasible'] else 'No-Go',
            'message': verdict['message'],
            'reasons': feasibility_reasons(verdict),
            'dominant_intensity': grid['dominant'],
            'desired_intensity': crowd_intensity,
            'matching_sectors': len(matching),
            'intensity_note': (f"{len(matching)} of the area's sectors have the {crowd_intensity} crowd level you want."
                               if matching else f"No sector within 5 km has a {crowd_intensity} crowd level; "
                                                f"the area is mostly {grid['dominant']}."),
            'recommended_business': verdict['recommended_business'],
        }

    return JsonResponse({
        'success': True,
        'message': f'Thank you, {name}! Your business inquiry has been saved.',
        'inquiry_id': inquiry.id,
        'feasibility': feasibility,
        'redirect': {'latitude': lat, 'longitude': lon, 'name': location_name or f'{lat:.4f}, {lon:.4f}',
                     'business_type': business_type, 'crowd_intensity': crowd_intensity},
    })


@csrf_exempt
def search_location(request):
    """Search for locations using Nominatim API (OpenStreetMap)"""
    if request.method == 'POST':
        data = json.loads(request.body)
        query = data.get('query', '')
        
        # Call Nominatim API for location search (India-only)
        try:
            url = "https://nominatim.openstreetmap.org/search"
            headers = {'User-Agent': 'CrowdHeatmapApp/1.0'}
            params = {
                "q": query,
                "format": "json",
                "limit": 5,
                "addressdetails": 1,
                "countrycodes": "in",
                # India bounding box: left,top,right,bottom
                "viewbox": "68,37.5,97.5,6.5",
                "bounded": 1,
            }
            response = requests.get(url, headers=headers, params=params)
            results = response.json()
            return JsonResponse({'success': True, 'results': results})
        except Exception as e:
            return JsonResponse({'success': False, 'error': str(e)})
    
    return JsonResponse({'success': False, 'message': 'Invalid request method'})


@csrf_exempt
def autocomplete_location(request):
    """Return lightweight suggestions for location autocomplete."""
    if request.method == 'POST':
        try:
            data = json.loads(request.body)
        except json.JSONDecodeError:
            return JsonResponse({'success': False, 'message': 'Invalid JSON'})

        query = (data.get('query') or '').strip()
        if not query:
            return JsonResponse({'success': True, 'results': []})

        try:
            url = "https://nominatim.openstreetmap.org/search"
            headers = {'User-Agent': 'CrowdHeatmapApp/1.0'}
            params = {
                "q": query,
                "format": "json",
                "limit": 5,
                "addressdetails": 1,
                "countrycodes": "in",
                # India bounding box: left,top,right,bottom
                "viewbox": "68,37.5,97.5,6.5",
                "bounded": 1,
            }
            response = requests.get(url, headers=headers, params=params, timeout=10)
            response.raise_for_status()
            raw_results = response.json()

            suggestions = []
            for r in raw_results:
                suggestions.append({
                    "display_name": r.get("display_name"),
                    "lat": r.get("lat"),
                    "lon": r.get("lon"),
                })

            return JsonResponse({'success': True, 'results': suggestions})
        except Exception as e:
            return JsonResponse({'success': False, 'error': str(e)})

    return JsonResponse({'success': False, 'message': 'Invalid request method'})

def _haversine_distance_m(lat1, lon1, lat2, lon2):
    r = 6371000.0  # Earth's radius in meters
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


@csrf_exempt
@require_http_methods(['GET', 'POST'])
def get_location_recommendations(request):
    """
    Top 5 business opportunities for the 5 km circle around lat/lon, ranked from
    the area's real data (ML candidates + revenue engine + local competition).
    Params: latitude, longitude, location_name, category (optional filter), limit (1-10).
    202 + {pending: true} while OpenStreetMap is still answering.
    """
    if request.method == 'POST':
        try:
            data = json.loads(request.body or '{}')
        except json.JSONDecodeError:
            return JsonResponse({'success': False, 'error': 'Invalid JSON'}, status=400)
    else:
        data = request.GET
    try:
        lat, lon = _parse_lat_lon(data)
    except ValueError as exc:
        return JsonResponse({'success': False, 'error': str(exc)}, status=400)
    location_name = str(data.get('location_name') or data.get('name') or 'Selected Location')[:200]
    category = str(data.get('category') or '').strip()[:60] or None
    try:
        limit = max(1, min(10, int(data.get('limit') or 5)))
    except (TypeError, ValueError):
        limit = 5

    elements, unavailable = _area_elements(lat, lon, HEATMAP_RADIUS_M)
    if unavailable is not None:
        return unavailable
    from .analysis import recommend_businesses
    result = recommend_businesses(lat, lon, radius_m=HEATMAP_RADIUS_M, location_name=location_name,
                                  elements=elements, category=category, limit=limit)
    recs = result['recommendations']
    grid = classify_sectors(elements, lat, lon, HEATMAP_RADIUS_M)
    return JsonResponse({
        'success': True,
        'analysis_radius': HEATMAP_RADIUS_M,
        'location': {'name': location_name, 'latitude': lat, 'longitude': lon, 'radius': HEATMAP_RADIUS_M},
        'area': {'dominant': grid['dominant'], 'density_per_km2': grid['density_per_km2'], 'pois_analysed': len(elements)},
        'category': category,
        'recommendations': recs,
        'comparison': result['comparison'],
        'count': len(recs),
    })


@csrf_exempt
@require_http_methods(['GET', 'POST'])
def synergy_analysis(request):
    """
    Business Synergy Intelligence for one business at the selected location:
    score (0–100) with its five factors, the nearby places behind it, revenue
    scenarios on top of the revenue engine, and a plain-language explanation.
    Params: latitude, longitude, business_type (category), location_name.
    Same function and inputs as the PDF report, so both show the same numbers.
    """
    from . import synergy
    from report_generator.validators import ValidationError as InputError, validate_business_type

    if rate_limited('synergy', request.META.get('REMOTE_ADDR') or 'anon', ANALYTICS_RATE_LIMIT):
        return JsonResponse({'success': False, 'error': 'Too many requests. Please wait a minute.'}, status=429)
    if request.method == 'POST':
        try:
            data = json.loads(request.body or '{}')
        except json.JSONDecodeError:
            return JsonResponse({'success': False, 'error': 'Invalid JSON'}, status=400)
    else:
        data = request.GET
    try:
        lat, lon = _parse_lat_lon(data)
        business = validate_business_type(data.get('business_type') or data.get('category'))
    except (ValueError, InputError) as exc:
        return JsonResponse({'success': False, 'error': str(exc)}, status=400)
    if not business:
        return JsonResponse({'success': False, 'error': 'business_type is required (a business category such as "cafe").'},
                            status=400)
    name = str(data.get('location_name') or data.get('name') or '')[:200]

    elements, unavailable = _area_elements(lat, lon, HEATMAP_RADIUS_M)
    if unavailable is not None:
        return unavailable
    result = synergy.for_location(elements, lat, lon, business, location_name=name)
    return JsonResponse({'success': True, 'synergy': result})


def _parse_lat_lon(data):
    """(lat, lon) from a JSON body / query dict, or raise ValueError with a user-facing message."""
    lat = data.get('latitude', data.get('lat'))
    lon = data.get('longitude', data.get('lon', data.get('lng')))
    if lat in (None, '') or lon in (None, ''):
        raise ValueError('Latitude and longitude are required')
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        raise ValueError('Invalid coordinates')
    if not (math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError('Coordinates out of range')
    return lat, lon


def _area_unavailable(fetched):
    """JSON for an area whose OpenStreetMap data is not available (yet)."""
    pending = fetched['status'] == 'pending'
    return JsonResponse({
        'success': False,
        'pending': pending,
        'error': fetched['error'],
        'retry_after': fetched.get('retry_after', 5),
    }, status=202 if pending else 503)


def compute_area_analysis(lat, lon, location_name='Selected Location', radius_m=HEATMAP_RADIUS_M):
    """
    Everything the map shows for one location, computed once from one
    OpenStreetMap fetch: the sector heatmap, sector-balanced popular places
    with engine revenue estimates, the ML prediction and recommendations.
    Returns (analysis_dict, None) or (None, fetched) when data is not available.
    """
    fetched = fetch_area_pois(lat, lon, radius_m)
    if fetched['status'] != 'ok':
        return None, fetched
    memo_key = f"area_analysis:v2:{round(lat, 5)}:{round(lon, 5)}:{radius_m}:{fetched['fetched_at']}"
    analysis_result = cache.get(memo_key)
    if analysis_result is None:
        elements = elements_within(fetched['elements'], lat, lon, radius_m)
        targets = sample_places_across_sectors(elements, lat, lon, radius_m, limit=30)
        enriched_places, total_revenue = utils.enrich_places_with_revenue(elements, targets=targets)
        grid = classify_sectors(elements, lat, lon, radius_m)
        business_prediction = None
        try:
            business_prediction = build_business_prediction(grid['dominant'], elements)
            business_prediction.pop('area_hint', None)
        except Exception:
            logger.exception('ML prediction failed')
        analysis_result = {
            'elements': elements,
            'places': enriched_places,
            'total_revenue': total_revenue,
            'grid': grid,
            'business_prediction': business_prediction,
        }
        cache.set(memo_key, analysis_result, timeout=600)
    analysis_result = dict(analysis_result)
    analysis_result['fetched'] = fetched
    analysis_result['analysis_id'] = analysis_id_for(lat, lon, radius_m, fetched['fetched_at'])
    return analysis_result, None


def analysis_id_for(lat, lon, radius_m, fetched_at):
    """Stable id of one analysis result (area + radius + data version) shared by the map and analytics."""
    import hashlib
    raw = f'{round(float(lat), 5)}:{round(float(lon), 5)}:{int(radius_m)}:{fetched_at}'
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


def _crowd_payload(lat, lon, location_name, result, radius_m=HEATMAP_RADIUS_M):
    """Response shape of /analyze-crowd-intensity/ (also embedded in /find-popular-places/)."""
    grid, fetched = result['grid'], result['fetched']
    places_estimated = sum(1 for p in result['places'] if (p.get('revenue_data') or {}).get('estimated_monthly_revenue'))
    return {
        'success': True,
        'analysis_id': result['analysis_id'],
        'center': {'latitude': lat, 'longitude': lon, 'name': location_name},
        'high_intensity': grid['high'],
        'medium_intensity': grid['medium'],
        'low_intensity': grid['low'],
        'dominant': grid['dominant'],
        'density_per_km2': grid['density_per_km2'],
        'thresholds_per_km2': {'high': HIGH_DENSITY_PER_KM2, 'medium': MEDIUM_DENSITY_PER_KM2},
        'no_data': grid['placeholder_used'],
        # Real counts: mapped OpenStreetMap places inside the circle (not sensors).
        'total_pois': len(result['elements']),
        'active_sensors_count': len(result['elements']),
        'pois_analysed': len(result['elements']),
        'crowd_score': utils.calculate_crowd_score(result['elements']),
        # Sum of the revenue engine's estimates for the places listed, labelled as such.
        'estimated_revenue': round(result['total_revenue']),
        'estimated_revenue_basis': f'Sum of revenue-engine estimates for {places_estimated} mapped businesses in the 5 km radius',
        'business_prediction': result['business_prediction'],
        'business_by_intensity': get_all_business_choices(),
        'analysis_radius': radius_m,
        'is_live': fetched['is_live'],
        'stale': fetched['stale'],
        'fetched_at': fetched['fetched_at'],
        'data_source': fetched['data_source'],
        'data_quality': 'Cached OpenStreetMap data' if fetched['stale'] else 'Verified live',
    }


@csrf_exempt
@require_http_methods(['POST'])
def find_popular_places(request):
    """
    Popular places, sector heatmap and recommendations for the 5 km circle
    around the given point, from one (cached) OpenStreetMap fetch.
    202 + {pending: true, retry_after} while OpenStreetMap is still answering.
    """
    try:
        data = json.loads(request.body or '{}')
        lat, lon = _parse_lat_lon(data)
    except json.JSONDecodeError:
        return JsonResponse({'success': False, 'error': 'Invalid JSON'}, status=400)
    except ValueError as exc:
        return JsonResponse({'success': False, 'error': str(exc)}, status=400)
    loc_name = str(data.get('name') or data.get('location_name') or 'Selected Location')[:200]

    result, fetched = compute_area_analysis(lat, lon, loc_name)
    if result is None:
        return _area_unavailable(fetched)

    crowd = _crowd_payload(lat, lon, loc_name, result)
    recs = generate_location_business_recommendations(lat, lon, radius_m=HEATMAP_RADIUS_M, location_name=loc_name,
                                                      elements=result['elements'])
    return JsonResponse({
        'success': True,
        'analysis_id': crowd['analysis_id'],
        'center': crowd['center'],
        'results': result['places'],
        'places': result['places'],
        'total_area_revenue': crowd['estimated_revenue'],
        'estimated_revenue': crowd['estimated_revenue'],
        'estimated_revenue_basis': crowd['estimated_revenue_basis'],
        'active_sensors_count': crowd['pois_analysed'],
        'active_sensors': crowd['pois_analysed'],
        'pois_analysed': crowd['pois_analysed'],
        'analysis_radius': HEATMAP_RADIUS_M,
        'crowd_intensity': crowd,
        'recommendations': recs,
        'is_live': crowd['is_live'],
        'stale': crowd['stale'],
        'fetched_at': crowd['fetched_at'],
        'data_source': crowd['data_source'],
        'data_quality': crowd['data_quality'],
    })


@csrf_exempt
@require_http_methods(['POST'])
def analyze_crowd_intensity(request):
    """Sector heatmap (high/medium/low areas) for the 5 km circle around the given point."""
    try:
        data = json.loads(request.body or '{}')
        lat, lon = _parse_lat_lon(data)
    except json.JSONDecodeError:
        return JsonResponse({'success': False, 'error': 'Invalid JSON'}, status=400)
    except ValueError as exc:
        return JsonResponse({'success': False, 'error': str(exc)}, status=400)
    loc_name = str(data.get('name') or data.get('location_name') or 'Selected Location')[:200]

    result, fetched = compute_area_analysis(lat, lon, loc_name)
    if result is None:
        return _area_unavailable(fetched)
    return JsonResponse(_crowd_payload(lat, lon, loc_name, result))


def _area_elements(lat, lon, radius_m):
    """
    Features within `radius_m` (<= 5 km) of the point, taken from the shared
    cached 5 km area fetch, so one location costs one Overpass request.
    Returns (elements, None) or (None, JsonResponse) when the data is not available yet.
    """
    fetched = fetch_area_pois(lat, lon, HEATMAP_RADIUS_M)
    if fetched['status'] != 'ok':
        return None, _area_unavailable(fetched)
    return elements_within(fetched['elements'], lat, lon, radius_m), None


def feasibility_verdict(lat, lon, business_type):
    """Go/No-Go for `business_type` at the point (rules in analysis.evaluate_feasibility). (verdict, error_response)."""
    elements, unavailable = _area_elements(lat, lon, 2000)
    if unavailable is not None:
        return None, unavailable
    return evaluate_feasibility(feasibility_elements(elements), lat, lon, business_type), None


@csrf_exempt
@require_http_methods(['POST'])
def check_feasibility(request):
    """
    Check if a business type is feasible at the given location based on crowd intensity.
    POST: { latitude, longitude, business_type (optional) }
    Returns: { success, feasible, dominant_intensity, message, latitude, longitude }
    """
    try:
        data = json.loads(request.body or '{}')
        lat, lon = _parse_lat_lon(data)
    except json.JSONDecodeError:
        return JsonResponse({'success': False, 'message': 'Invalid JSON'}, status=400)
    except ValueError as exc:
        return JsonResponse({'success': False, 'message': str(exc)}, status=400)
    business_type = str(data.get('business_type') or '').strip()[:60]
    verdict, unavailable = feasibility_verdict(lat, lon, business_type)
    if unavailable is not None:
        return unavailable
    return JsonResponse({
        'success': True,
        'feasible': verdict['feasible'],
        'dominant_intensity': verdict['dominant_intensity'],
        'message': verdict['message'],
        'reasons': feasibility_reasons(verdict),
        'latitude': lat,
        'longitude': lon,
        'recommended_business': verdict['recommended_business'],
    })


def business_recommendations(request):
    # Keep legacy route but serve the dashboard AI flow directly so the
    # sidebar button always opens live recommendation data.
    return redirect(f"{reverse('dashboard')}?ai=true")


def _extract_coordinates(payload):
    lat = payload.get('latitude')
    lon = payload.get('longitude')
    if lat is None and payload.get('lat') is not None:
        lat = payload.get('lat')
    if lon is None and payload.get('lng') is not None:
        lon = payload.get('lng')
    if lat is None or lon is None:
        raise ValueError('Latitude and longitude are required')
    lat = float(lat)
    lon = float(lon)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError('Coordinates out of range')
    return lat, lon


@csrf_exempt
@require_http_methods(['POST'])
def analyze_location(request):
    """
    Analyze a selected location and return:
    - smart revenue forecast
    - strategic recommendations
    - crowd score and feasibility score
    """
    try:
        data = json.loads(request.body or '{}')
    except json.JSONDecodeError:
        return JsonResponse({'success': False, 'error': 'Invalid JSON'}, status=400)

    try:
        lat, lon = _extract_coordinates(data)
    except (ValueError, TypeError) as exc:
        return JsonResponse({'success': False, 'error': str(exc)}, status=400)

    business_type = (data.get('business_type') or data.get('type') or 'default').strip()

    elements, unavailable = _area_elements(lat, lon, 2000)
    if unavailable is not None:
        return unavailable
    revenue_data = utils.calculate_smart_revenue(elements, business_type=business_type, lat=lat, lon=lon)
    crowd_score = utils.calculate_crowd_score(elements)

    # Recommended business from location dynamics when caller did not pass specific type.
    area_hint = _infer_area_from_pois(elements)
    if crowd_score >= 70:
        dominant = 'high'
    elif crowd_score >= 35:
        dominant = 'medium'
    else:
        dominant = 'low'
    recommended_business = predict_business(dominant, area_hint=area_hint)

    return JsonResponse({
        'success': True,
        'latitude': lat,
        'longitude': lon,
        'business_type': business_type,
        'revenue_data': revenue_data,
        'recommendations': revenue_data.get('recommendations', []),
        'crowd_score': crowd_score,
        'feasibility_score': revenue_data.get('potential_score', 0),
        'potential_score': revenue_data.get('potential_score', 0),
        'recommended_business': recommended_business,
    })


@csrf_exempt
@require_http_methods(['POST'])
def generate_best_locations(request):
    """
    Generate 1-3 best business locations (ML-style feasibility) around a base point.
    """
    try:
        data = json.loads(request.body or '{}')
    except json.JSONDecodeError:
        return JsonResponse({'success': False, 'error': 'Invalid JSON'}, status=400)

    try:
        if data.get('latitude') is None or data.get('longitude') is None:
            # Fallback chain: session -> India center default.
            lat = request.session.get('user_lat', 19.0760)
            lon = request.session.get('user_lon', 72.8777)
        else:
            lat, lon = _extract_coordinates(data)
    except (ValueError, TypeError) as exc:
        return JsonResponse({'success': False, 'error': str(exc)}, status=400)

    query = _build_overpass_query(lat, lon, 8000)
    results, error = _run_overpass_query(query, timeout=30)
    if error or results is None:
        return JsonResponse({'success': False, 'error': error or 'Unable to generate locations'}, status=502)

    elements = results.get('elements', [])
    top = utils.generate_best_location_candidates(lat, lon, elements, top_n=3)

    return JsonResponse({
        'success': True,
        'base_location': {'lat': lat, 'lng': lon},
        'locations': top,
    })

@require_http_methods(['GET'])
def get_business_types(request):
    """Return all dynamic expected business choices for the form dropdown."""
    lat = request.GET.get('lat')
    lon = request.GET.get('lon')
    
    # Can optimize by returning all unique business choices
    choices_by_intensity = get_all_business_choices()
    all_choices = set()
    for intensity, choices in choices_by_intensity.items():
        all_choices.update(choices)
    
    # Format for the frontend
    business_types = [{'value': c, 'label': c.replace('_', ' ').title()} for c in sorted(all_choices)]
    return JsonResponse({'success': True, 'business_types': business_types})

@csrf_exempt
@require_http_methods(['POST'])
def find_matching_locations(request):
    """
    Find 1-3 locations in a 5km radius that satisfy the exact crowd intensity and business category.
    """
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'success': False, 'message': 'Invalid JSON'})
        
    lat = data.get('latitude')
    lon = data.get('longitude')
    business_type = (data.get('business_type') or '').strip().lower()
    crowd_intensity = (data.get('crowd_intensity') or '').strip().lower()
    
    if not lat or not lon:
        return JsonResponse({'success': False, 'message': 'Latitude and longitude are required'})
        
    try:
        lat = float(lat)
        lon = float(lon)
        
        # 1. Get POIs in 5km radius
        elements, unavailable = _area_elements(lat, lon, 5000)
        if unavailable is not None:
            return unavailable
        
        # 2. Divide area into sectors and calculate intensity
        sector_size = 5000 / 3
        sectors = {}
        
        for element in elements:
            elem_lat = element.get('lat') or (element.get('center', {}).get('lat'))
            elem_lon = element.get('lon') or (element.get('center', {}).get('lon'))
            if not elem_lat or not elem_lon: continue
            
            # Distance from center
            R = 6371000
            lat1_rad = math.radians(lat)
            lat2_rad = math.radians(elem_lat)
            delta_lat = math.radians(elem_lat - lat)
            delta_lon = math.radians(elem_lon - lon)
            a = math.sin(delta_lat/2)**2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(delta_lon/2)**2
            c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
            distance = R * c
            
            if distance > 5000: continue
            
            angle = math.atan2(elem_lat - lat, elem_lon - lon)
            angle_deg = math.degrees(angle) + 180
            angle_sector = int(angle_deg / 120)
            dist_sector = int(distance / sector_size)
            sector_key = f"{dist_sector}_{angle_sector}"
            
            if sector_key not in sectors: sectors[sector_key] = []
            sectors[sector_key].append({'lat': elem_lat, 'lon': elem_lon})

        matching_locations = []
        
        # 3. Find sectors matching the requested crowd intensity
        for sector_key, pois in sectors.items():
            count = len(pois)
            if count >= 15:
                sector_intensity = 'high'
            elif count >= 5:
                sector_intensity = 'medium'
            else:
                sector_intensity = 'low'
                
            # If the user's requested crowd intensity matches this sector's intensity
            if sector_intensity == crowd_intensity:
                # Check business feasibility in this sector
                # (For simplicity, if intensity matches, we consider it feasible,
                # as business types mapped to intensities are generally feasible there)
                
                avg_lat = sum(p['lat'] for p in pois) / count
                avg_lon = sum(p['lon'] for p in pois) / count
                
                matching_locations.append({
                    'lat': avg_lat,
                    'lon': avg_lon,
                    'intensity': sector_intensity,
                    'business': business_type
                })
                
                if len(matching_locations) >= 3:
                    break

        # 4. If no exact match, fallback to the requested base point (for UX)
        if not matching_locations:
            matching_locations.append({'lat': lat, 'lon': lon, 'intensity': crowd_intensity, 'business': business_type})
            
        return JsonResponse({
            'success': True,
            'matches': matching_locations
        })
        
    except Exception as e:
        logger.exception('find_matching_locations failed')
        return JsonResponse({'success': False, 'error': 'Unable to find matching locations right now.'}, status=500)


def rate_limited(bucket, owner_id, limit, window_s=60):
    """True when `owner_id` made more than `limit` calls to `bucket` in the current window."""
    import time as _time
    key = f'rl:{bucket}:{owner_id}:{int(_time.time() // window_s)}'
    if cache.add(key, 1, window_s + 5):
        return False
    try:
        return cache.incr(key) > limit
    except ValueError:
        return False


ANALYTICS_RATE_LIMIT = 60  # requests per user per minute


@require_http_methods(['POST'])
@supabase_user_required
def revenue_timeseries(request):
    """
    Projected revenue for the area around lat/lng in four views (live, daily, weekly,
    monthly), by business category. Reuses the cached Popular Places analysis; while the
    area's OpenStreetMap data is still being fetched it answers 202 {pending}.
    Body: {lat, lng, radius?=5000 (clamped to 500–5000), name?, analysis_id?, views?}.
    """
    from . import revenue_timeseries as ts

    if rate_limited('timeseries', request.report_owner_id, ANALYTICS_RATE_LIMIT):
        return JsonResponse({'success': False, 'error': 'Too many requests. Please wait a moment.'}, status=429)
    try:
        data = json.loads(request.body or '{}')
        if not isinstance(data, dict):
            raise ValueError('Expected a JSON object')
        lat, lon = _parse_lat_lon(data)
    except json.JSONDecodeError:
        return JsonResponse({'success': False, 'error': 'Invalid JSON'}, status=400)
    except ValueError as exc:
        return JsonResponse({'success': False, 'error': str(exc)}, status=400)
    radius = ts.clamp_radius(data.get('radius', ts.MAX_RADIUS_M))
    name = str(data.get('name') or 'Selected area')[:120]
    views = [v for v in (data.get('views') or []) if v in ('live', 'daily', 'weekly', 'monthly')] or None

    base, fetched = ts.base_for_area(lat, lon, radius, name)
    if base is None:
        return _area_unavailable(fetched)
    body = ts.payload(base, name, views=views)
    requested_id = data.get('analysis_id')
    body['analysis_changed'] = bool(requested_id) and requested_id != base.get('analysis_id')
    return JsonResponse(body)
