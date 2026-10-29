/**
 * Crowd Heatmap - Main Application Script
 * Handles map, dashboard, and universal UI enhancements.
 */

let map;
let baseTileLayer = null;
let userMarker = null;
let searchMarkers = [];
let popularPlacesMarkers = [];
let currentAccuracy = 0;
let crowdIntensityAreas = [];
let heatmapLayers = [];
let radiusCircle = null;
let buildingOutlineLayers = [];
let lastCrowdIntensityData = { high: [], medium: [], low: [] };
let businessByIntensity = {};
let businessRecommendationMarkers = [];
let aiSuggestedLocationMarkers = [];
let lastPopularPlacesResult = { places: [], lat: null, lon: null };
let routingControl = null;
let orangeMarkers = [];          // orange markers for business-type matches
let chatbotMinimized = false;
let aiBusinessFlowAwaitingIntensity = false;
let aiBusinessFlowLocationDesc = null;
let mapMinimized = false;
let chatSocket = null;
const feasibilityResultCache = new Map();
let feasibilityWarmupTimer = null;
let liveRevenueTimer = null;
let popularPlacesPanelRequested = false;
// Was never declared: the first `if (analysisRadiusCircle)` in every flow threw a
// ReferenceError, so search/GPS/map-click never drew the circle or ran the analysis.
let analysisRadiusCircle = null;

// ---- Analysis location: the single source of truth ------------------------
// Every way of choosing a place (search, suggestion, map click, GPS, deep link,
// startup form) goes through setAnalysisLocation(). Analyses carry a sequence
// number; a response for anything but the latest request is dropped, so a slow
// answer for an old place can never overwrite the current one.
const ANALYSIS_RADIUS_M = 5000;
const SELECTED_LOCATION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const RECENT_LOCATIONS_KEY = 'recentLocations';
let currentAnalysisLocation = null;
let analysisSeq = 0;
let analysisAbort = null;

function activeMapInstance() {
    if (typeof dashboardMap !== 'undefined' && dashboardMap) return dashboardMap;
    return (typeof map !== 'undefined' && map) ? map : null;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000, toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sameSpot(a, b, toleranceM = 30) {
    if (!a || !b) return false;
    const pt = (p) => [Number(p.lat ?? p.latitude), Number(p.lng ?? p.lon ?? p.longitude)];
    const [lat1, lon1] = pt(a), [lat2, lon2] = pt(b);
    return distanceMeters(lat1, lon1, lat2, lon2) <= toleranceM;
}

function getRecentLocations() {
    try {
        const list = JSON.parse(localStorage.getItem(RECENT_LOCATIONS_KEY) || '[]');
        return Array.isArray(list) ? list.filter(l => Number.isFinite(Number(l.lat)) && Number.isFinite(Number(l.lng))) : [];
    } catch (_e) {
        return [];
    }
}

function rememberRecentLocation(loc) {
    try {
        const list = getRecentLocations().filter(l => !sameSpot(l, loc, 150));
        list.unshift({ lat: loc.lat, lng: loc.lng, name: loc.name, ts: loc.ts });
        localStorage.setItem(RECENT_LOCATIONS_KEY, JSON.stringify(list.slice(0, 8)));
    } catch (_e) { /* storage blocked */ }
}

/** "Marathalli Bridge Service Road, Gandhi Nagar, Munekolala, …, India" -> first three parts. */
function shortPlaceName(name) {
    const parts = String(name || '').split(',').map(p => p.trim()).filter(Boolean);
    return (parts.slice(0, 3).join(', ') || 'Selected Location').slice(0, 120);
}

/**
 * The selected area: {name, lat, lng, radius, category, ts, analysis_id}. Written by
 * every way of choosing a place; read by Popular Locations, crowd analysis, reports and
 * analytics. `category` is a business category (never an address); analysis_id is set
 * when an analysis for exactly this area finishes.
 */
function setAnalysisLocation(lat, lon, name, opts = {}) {
    // Re-selecting the same spot (e.g. the map focusing on it) keeps its category and analysis.
    const same = currentAnalysisLocation && sameSpot(currentAnalysisLocation, { lat, lng: lon });
    const loc = {
        lat: Number(lat), lng: Number(lon), name: shortPlaceName(name),
        radius: ANALYSIS_RADIUS_M,
        category: String(opts.category || (same ? currentAnalysisLocation.category : '') || '').slice(0, 60),
        ts: Date.now(), analysis_id: same ? currentAnalysisLocation.analysis_id : null,
    };
    currentAnalysisLocation = loc;
    window.currentAnalysisLocation = loc;
    saveSelectedLocation(loc.lat, loc.lng, loc.name, loc.category);
    if (opts.remember !== false) rememberRecentLocation(loc);
    document.dispatchEvent(new CustomEvent('analysis:location', { detail: loc }));
    const latInput = document.getElementById('id_latitude');
    const lonInput = document.getElementById('id_longitude');
    if (latInput) latInput.value = loc.lat;
    if (lonInput) lonInput.value = loc.lng;
    return loc;
}

/** The place the user is working on now: chosen in this page, else a recent (<12 h) stored choice. */
function getCurrentAnalysisLocation() {
    if (currentAnalysisLocation) return currentAnalysisLocation;
    const stored = getSelectedLocation({ maxAgeMs: SELECTED_LOCATION_MAX_AGE_MS });
    return stored ? { ...stored, category: stored.category || stored.type || '', radius: stored.radius || ANALYSIS_RADIUS_M } : null;
}

// ---- Analysis context: the last *finished* area analysis (read by Business Analytics) ----
const ANALYSIS_CONTEXT_KEY = 'analysisContext';

function saveAnalysisContext(ctx) {
    const context = {
        name: shortPlaceName(ctx.name), lat: Number(ctx.lat), lng: Number(ctx.lng),
        radius: Number(ctx.radius) || ANALYSIS_RADIUS_M, analysis_id: ctx.analysis_id || null, ts: Date.now(),
    };
    try { sessionStorage.setItem(ANALYSIS_CONTEXT_KEY, JSON.stringify(context)); } catch (_e) { /* storage blocked */ }
    if (currentAnalysisLocation && sameSpot(currentAnalysisLocation, context)) currentAnalysisLocation.analysis_id = context.analysis_id;
    document.dispatchEvent(new CustomEvent('analysis:context', { detail: context }));
    return context;
}

/** The finished analysis to show in Business Analytics, or null (then the page shows an empty state). */
function getAnalysisContext() {
    try {
        const ctx = JSON.parse(sessionStorage.getItem(ANALYSIS_CONTEXT_KEY) || 'null');
        return ctx && Number.isFinite(Number(ctx.lat)) && Number.isFinite(Number(ctx.lng)) ? ctx : null;
    } catch (_e) {
        return null;
    }
}
window.getAnalysisContext = getAnalysisContext;

// Street-level zoom used when a specific place (search result, pin, recommendation,
// favorite, GPS, startup form) is chosen. Popular Locations keeps the whole 5 km view.
const PIN_ZOOM = 15;

/** Fly the map to a chosen pin (never zooms out if the user is already closer). */
function zoomToPin(lat, lon, zoom = PIN_ZOOM) {
    const m = activeMapInstance();
    if (!m || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return;
    const current = typeof m.getZoom === 'function' ? m.getZoom() : zoom;
    const target = Math.max(zoom, Math.min(current || zoom, 18));
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce && typeof m.flyTo === 'function') m.flyTo([Number(lat), Number(lon)], target, { duration: 1.1 });
    else m.setView([Number(lat), Number(lon)], target);
}
window.zoomToPin = zoomToPin;

/** Draw the real 5 km analysis circle and fit the map to it. */
function drawAnalysisRadius(lat, lon, { fit = true } = {}) {
    const m = activeMapInstance();
    if (!m || typeof L === 'undefined') return null;
    if (analysisRadiusCircle) {
        try { m.removeLayer(analysisRadiusCircle); } catch (_e) {}
    }
    if (radiusCircle) {
        try { m.removeLayer(radiusCircle); } catch (_e) {}
        radiusCircle = null;
    }
    analysisRadiusCircle = L.circle([lat, lon], {
        radius: ANALYSIS_RADIUS_M, color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 0.08,
        weight: 2, dashArray: '8, 8', interactive: false,
    }).addTo(m);
    if (fit) {
        try { m.fitBounds(analysisRadiusCircle.getBounds(), { padding: [16, 16] }); } catch (_e) {}
    }
    return analysisRadiusCircle;
}

function setMapStatus(text, { kind = 'info', retry = null } = {}) {
    const el = document.getElementById('map-status');
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind;
    if (retry) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-sm btn-outline-light ms-2 py-0';
        btn.textContent = 'Retry';
        btn.addEventListener('click', retry);
        el.appendChild(btn);
    }
}

/**
 * POST to an area-analysis endpoint, waiting through "pending" answers (202:
 * OpenStreetMap still fetching) up to `maxWaitMs`. Calls onProgress(seconds, pending).
 * Resolves to {ok, data, status, aborted}.
 */
async function postAreaAnalysis(url, body, { signal, onProgress, maxWaitMs = 120000 } = {}) {
    const started = Date.now();
    const ticker = onProgress ? setInterval(() => onProgress(Math.round((Date.now() - started) / 1000), false), 1000) : null;
    try {
        while (true) {
            let res;
            try {
                res = await fetch(url, {
                    method: 'POST', signal,
                    headers: { 'Content-Type': 'application/json', 'X-CSRFToken': getCookie('csrftoken') },
                    body: JSON.stringify(body),
                });
            } catch (err) {
                if (err.name === 'AbortError') return { ok: false, aborted: true };
                return { ok: false, status: 0, data: { error: 'Network error. Check your connection.' } };
            }
            const data = await res.json().catch(() => ({ error: `Server error (${res.status}).` }));
            if (res.status === 202 && data.pending) {
                if (Date.now() - started > maxWaitMs) {
                    return { ok: false, status: 504, data: { error: 'OpenStreetMap is very slow right now. Please retry in a minute.' } };
                }
                if (onProgress) onProgress(Math.round((Date.now() - started) / 1000), true);
                await new Promise((r) => setTimeout(r, Math.max(1, Number(data.retry_after) || 4) * 1000));
                if (signal && signal.aborted) return { ok: false, aborted: true };
                continue;
            }
            return { ok: res.ok && data.success !== false, status: res.status, data };
        }
    } finally {
        if (ticker) clearInterval(ticker);
    }
}

async function getFeasibilityWithCache(lat, lon, businessType, ttlMs = 120000) {
    const cacheKey = `${lat.toFixed(4)}|${lon.toFixed(4)}|${String(businessType || '').toLowerCase().trim()}`;
    const cacheHit = feasibilityResultCache.get(cacheKey);
    if (cacheHit && (Date.now() - cacheHit.ts) < ttlMs) {
        return cacheHit.data;
    }

    const feasRes = await fetch('/check-feasibility/', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRFToken': getCookie('csrftoken')
        },
        body: JSON.stringify({
            latitude: lat,
            longitude: lon,
            business_type: businessType || ''
        })
    });
    const feasData = await feasRes.json();
    feasibilityResultCache.set(cacheKey, { data: feasData, ts: Date.now() });
    return feasData;
}

// Forward declarations for business type elements (initialized in initBusinessTypeElements)
let businessTypeInput, businessTypeSelect, recommendedBusinessHidden;
// All available business categories (populated after location analysis)
let _allBusinessCategories = [];

// Page context: computed when DOM is ready
function isHeatmapPage() {
    const container = document.getElementById('heatmap-container') || document.getElementById('map');
    return !!(container && typeof L !== 'undefined');
}

// Full-colour MapTiler Basic base map (the platform's original map style). It sends CORS
// headers, so the PDF report can still capture the map.
const MAPTILER_KEY = 'SJwCksU5oVIkLOgs9ElB';
const MAP_ATTRIBUTION = '<a href="https://www.maptiler.com/copyright/" target="_blank">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>';

function addBaseLayers(targetMap) {
    const layer = L.tileLayer(`https://api.maptiler.com/maps/basic-v2/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`,
        { maxZoom: 19, crossOrigin: true, attribution: MAP_ATTRIBUTION });
    layer.addTo(targetMap);
    return layer;
}

/** Map control: the selected location's name with a heart to save it to Favorites. */
function addSaveLocationControl(targetMap) {
    const Control = L.Control.extend({
        options: { position: 'topright' },
        onAdd() {
            const el = L.DomUtil.create('div', 'leaflet-control mono-fav-control d-none');
            el.setAttribute('aria-live', 'polite');
            L.DomEvent.disableClickPropagation(el);
            const render = (loc) => {
                const payload = loc && window.Favorites ? window.Favorites.locationPayload(loc) : null;
                el.classList.toggle('d-none', !payload);
                if (!payload) return;
                el.innerHTML = `${window.Favorites.heartHtml(payload)}<span title="${escapeHtml(payload.name)}">${escapeHtml(payload.name)}</span>`;
                window.Favorites.refresh();
            };
            document.addEventListener('analysis:location', (e) => render(e.detail));
            render(getCurrentAnalysisLocation());
            return el;
        },
    });
    return new Control().addTo(targetMap);
}

// Heatmap container initialization - runs after DOM and Leaflet ready
function initHeatmapContainer() {
    const mapEl = document.getElementById('map');
    if (!mapEl || typeof L === 'undefined') return null;
    map = L.map('map').setView([51.505, -0.09], 13);
    baseTileLayer = addBaseLayers(map);
    addSaveLocationControl(map);
    // Recalc size after layout (fixes invisible map)
    requestAnimationFrame(function () {
        if (map && map.invalidateSize) map.invalidateSize();
    });
    window.addEventListener('load', function onMapLoad() {
        if (map && map.invalidateSize) map.invalidateSize();
        window.removeEventListener('load', onMapLoad);
    });

    // Attach map click listener here (safe once map is initialized)
    map.on('click', async function (e) {
        const lat = e.latlng.lat;
        const lon = e.latlng.lng;

        setAnalysisLocation(lat, lon, 'Map Selection');

        // Add temporary marker
        if (userMarker) {
            map.removeLayer(userMarker);
        }
        userMarker = L.marker([lat, lon]).addTo(map)
            .bindPopup('<b>Selected Location</b><br><small class="text-primary"><i class="fas fa-radar"></i> 5 km Analysis Zone Active</small>').openPopup();

        // Update accuracy (clicking on map has high accuracy)
        updateAccuracyMeter(95);
        showLocationError('');

        // Popular places and the crowd heatmap come back in one response.
        await findPopularPlaces(lat, lon, false, { name: 'Map Selection' });
        await analyzeLocationIntelligence(lat, lon, 'Map Selection');

        notifyChatFromMap(`Location set by map click (${lat.toFixed(4)}, ${lon.toFixed(4)}). Popular places and crowd intensity updated.`);
    });

    return map;
}

// Run map init when DOM ready (Only on Home page, Dashboard uses dynamic init)
function runMapInit() {
    if (!isHeatmapPage() || window.location.pathname.includes('/dashboard/')) return;
    initHeatmapContainer();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runMapInit);
} else {
    runMapInit();
}

// Popular places panel DOM references
let popularPlacesPanel = document.getElementById('popular-places-panel');
let popularPlacesList = document.getElementById('popular-places-list');
let popularPlacesCloseBtn = document.getElementById('popular-places-close');

// Wire up close button for popular places panel
if (popularPlacesCloseBtn && popularPlacesPanel) {
    popularPlacesCloseBtn.addEventListener('click', () => {
        popularPlacesPanel.style.display = 'none';
    });
}

// Show/hide location error message (no popup)
function showLocationError(msg) {
    const el = document.getElementById('location-error-msg');
    if (!el) return;
    if (msg) {
        el.textContent = msg;
        el.style.display = 'block';
    } else {
        el.textContent = '';
        el.style.display = 'none';
    }
}

// Update accuracy meter (safe if elements missing)
function updateAccuracyMeter(accuracy) {
    const num = Math.max(0, Math.min(100, Number(accuracy)));
    currentAccuracy = num;
    const meterFill = document.getElementById('accuracy-meter');
    const accuracyValue = document.getElementById('accuracy-value');
    if (meterFill) {
        meterFill.style.width = num + '%';
        meterFill.textContent = num + '%';
    }
    if (accuracyValue) {
        accuracyValue.textContent = num + '%';
    }
}

// Calculate accuracy based on location precision (always returns 5–100)
function calculateAccuracy(position) {
    const accuracyMeters = position.coords.accuracy;
    if (!accuracyMeters || accuracyMeters <= 0) return 95;
    // Better precision (smaller radius) => higher %. Cap so we never show 0 when we have a fix.
    const rawPercent = Math.max(0, 100 - (accuracyMeters / 2));
    return Math.round(Math.max(5, Math.min(100, rawPercent)));
}

// --- Utility: debounce ---
function debounce(fn, delay) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn.apply(this, args), delay);
    };
}

// Safe event listener - no-op when element missing (e.g. on dashboard page)
function safeOn(id, event, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
}

function saveSelectedLocation(lat, lon, name = 'Selected Location', type = '') {
    const payload = {
        lat: Number(lat),
        lng: Number(lon),
        name: name || 'Selected Location',
        type: String(type || '').trim(),
        ts: Date.now()
    };
    try {
        localStorage.setItem('selectedLocation', JSON.stringify(payload));
    } catch (err) {
        console.warn('Unable to persist selected location:', err);
    }
    return payload;
}

function isDashboardPage() {
    const path = window.location.pathname;
    return path.includes('/dashboard/');
}

function isBusinessRecommendationsMode() {
    if (!isDashboardPage()) return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('ai') === 'true';
}

function redirectToDashboardAIIfNeeded() {
    // Preserve current page view so home map and dashboard map interactions are never hijacked
    return false;
}

function getSelectedLocation(opts = {}) {
    try {
        const raw = localStorage.getItem('selectedLocation');
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || Number.isNaN(Number(parsed.lat)) || Number.isNaN(Number(parsed.lng))) return null;
        if (opts.maxAgeMs && (!parsed.ts || Date.now() - parsed.ts > opts.maxAgeMs)) return null;
        return parsed;
    } catch (_err) {
        return null;
    }
}

// Styled in-page toast (replaces alert for heatmap errors/success)
function showHeatmapToast(message, type) {
    const toast = document.getElementById('heatmap-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = 'heatmap-toast visible ' + (type || 'error');
    clearTimeout(toast._toastTimer);
    toast._toastTimer = setTimeout(function () {
        toast.classList.remove('visible');
    }, 5000);
}

// Search Location (logic)
async function searchLocation(query) {
    if (!query) {
        showHeatmapToast('Please enter a location to search', 'info');
        return;
    }
    // Clear previous AI recommendation
    const mlBox = document.getElementById('mlPrediction');
    if (mlBox) mlBox.style.display = 'none';

    // Switch to first tab when searching (if on home page)
    const firstTabBtn = document.getElementById('top-recs-tab') || document.getElementById('dash-recs-tab');
    if (firstTabBtn) {
        const tab = new bootstrap.Tab(firstTabBtn);
        tab.show();
    }

    updateBusinessTypeOptionsFromPrediction(null, null);

    try {
        const response = await fetch('/search-location/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCookie('csrftoken')
            },
            body: JSON.stringify({ query: query })
        });

        const data = await response.json();

        if (data.success) {
            // Clear previous search markers
            searchMarkers.forEach(marker => map.removeLayer(marker));
            searchMarkers = [];

            // Add markers for search results
            data.results.forEach((result, index) => {
                const lat = parseFloat(result.lat);
                const lon = parseFloat(result.lon);

                const marker = L.marker([lat, lon], {
                    icon: L.icon({
                        iconUrl: 'https://cdn.jsdelivr.net/gh/pointhi/leaflet-color-markers@master/img/marker-icon-red.png',
                        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
                        iconSize: [25, 41],
                        iconAnchor: [12, 41],
                        popupAnchor: [1, -34],
                        shadowSize: [41, 41]
                    })
                }).addTo(map)
                    .bindPopup(`<b>${escapeHtml(result.display_name)}</b><br><button onclick="selectSearchResult(${lat}, ${lon}, this.dataset.name)" data-name="${escapeHtml((result.display_name || '').split(',').slice(0, 2).join(','))}" style="margin-top: 5px; padding: 5px 10px; background: #4CAF50; color: white; border: none; border-radius: 3px; cursor: pointer;">Select This Location</button>`);

                searchMarkers.push(marker);
            });

            // Analyse the best match right away (other matches stay as red pins to pick instead).
            if (data.results.length > 0) {
                const firstResult = data.results[0];
                const lat = parseFloat(firstResult.lat);
                const lon = parseFloat(firstResult.lon);
                const name = (firstResult.display_name || query).split(',').slice(0, 2).join(',').trim();
                showLocationError('');
                await selectSearchResult(lat, lon, name);
                return { success: true, lat, lon };
            }
            showHeatmapToast(`No place found for "${query}" in India.`, 'info');
        } else {
            showHeatmapToast('Error searching location: ' + (data.error || data.message), 'error');
        }
    } catch (error) {
        console.error('Error:', error);
        showHeatmapToast('Error searching location', 'error');
    }
    return { success: false };
}

safeOn('search-btn', 'click', async function () {
    const query = document.getElementById('location-search').value.trim();
    await searchLocation(query);
});

// Enter key for search
safeOn('location-search', 'keypress', function (e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('search-btn').click();
    }
});

// --- Autocomplete for top search field ---
const locationSearchInput = document.getElementById('location-search');
const locationSuggestions = document.getElementById('location-suggestions');

async function fetchAutocompleteSuggestions(query, targetListElement) {
    if (!query || query.length < 3) {
        targetListElement.innerHTML = '';
        targetListElement.style.display = 'none';
        return;
    }

    try {
        const response = await fetch('/autocomplete-location/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCookie('csrftoken')
            },
            body: JSON.stringify({ query })
        });

        const data = await response.json();
        if (!data.success) {
            targetListElement.innerHTML = '';
            targetListElement.style.display = 'none';
            return;
        }

        const results = data.results || [];
        if (!results.length) {
            targetListElement.innerHTML = '';
            targetListElement.style.display = 'none';
            return;
        }

        // This block is added based on the instruction to activate the AI Strategy tab
        // and ensure the business suggestion card is visible.
        // Assuming 'business-suggestion-card' is where the AI suggestion would be displayed.
        const suggestionCard = document.getElementById('business-suggestion-card');
        if (suggestionCard) {
            suggestionCard.classList.remove('d-none'); // Ensure it's visible

            // Switch to AI tab to show the result
            const aiTabBtn = document.getElementById('ai-strategy-tab');
            if (aiTabBtn) {
                const tab = new bootstrap.Tab(aiTabBtn);
                tab.show();
            }
        }

        targetListElement.innerHTML = '';
        results.forEach(result => {
            const item = document.createElement('div');
            item.className = 'suggestion-item';
            item.textContent = result.display_name;
            item.addEventListener('click', async () => {
                const lat = parseFloat(result.lat);
                const lon = parseFloat(result.lon);

                locationSearchInput.value = result.display_name;
                targetListElement.innerHTML = '';
                targetListElement.style.display = 'none';

                // Center map and drop marker
                map.setView([lat, lon], 15);
                if (userMarker) {
                    map.removeLayer(userMarker);
                }
                userMarker = L.marker([lat, lon]).addTo(map)
                    .bindPopup('Selected Location').openPopup();

                // Update hidden coords, accuracy meter, and crowd intensity
                document.getElementById('id_latitude').value = lat;
                document.getElementById('id_longitude').value = lon;
                saveSelectedLocation(lat, lon, result.display_name || 'Search Selection', '');
                if (redirectToDashboardAIIfNeeded()) return;
                updateAccuracyMeter(85);
                // Automatically find popular places around the searched location
                await findPopularPlaces(lat, lon, false);
                await analyzeLocationIntelligence(lat, lon, result.display_name || 'Search Selection');
                notifyChatFromMap(`Selected: ${result.display_name}. Map and crowd data updated.`);
            });
            targetListElement.appendChild(item);
        });
        targetListElement.style.display = 'block';
    } catch (err) {
        console.error('Autocomplete error:', err);
        targetListElement.innerHTML = '';
        targetListElement.style.display = 'none';
    }
}

if (locationSearchInput && locationSuggestions) {
    locationSearchInput.addEventListener('input', debounce(function () {
        fetchAutocompleteSuggestions(this.value.trim(), locationSuggestions);
    }, 300));
}

// Hide suggestions when clicking outside
document.addEventListener('click', function (e) {
    if (locationSuggestions && !locationSuggestions.contains(e.target) && e.target !== locationSearchInput) {
        locationSuggestions.innerHTML = '';
        locationSuggestions.style.display = 'none';
    }
});

const IPSTACK_API_KEY = '10cf4a0c87fa9f2bc5c54c596c7788ef';
// Debug: set to true to see geolocation logs in console (production: false)
const GEOLOCATION_DEBUG = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
function geoLog(...args) {
    if (GEOLOCATION_DEBUG && typeof console !== 'undefined' && console.log) {
        console.log('[Geolocation]', ...args);
    }
}

// Check if geolocation is allowed by context (HTTPS or localhost only)
function isGeolocationSecure() {
    const secure = window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (!secure) geoLog('Geolocation requires HTTPS or localhost. Current origin:', window.location.origin);
    return secure;
}

// Send coordinates to Django backend (for map/heatmap and optional server-side use)
async function sendLocationToBackend(lat, lon, accuracy, source) {
    const url = '/api/user-location/';
    const body = JSON.stringify({
        latitude: lat,
        longitude: lon,
        accuracy: accuracy != null ? Math.round(accuracy) : null,
        source: source || 'gps'
    });
    geoLog('Sending location to backend:', body);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCookie('csrftoken'),
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: body
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data.success) {
            geoLog('Backend accepted location:', data);
            return true;
        }
        geoLog('Backend rejected or error:', response.status, data);
        return false;
    } catch (err) {
        geoLog('Failed to send location to backend:', err);
        return false;
    }
}

// Fallback: get approximate location via IP when browser geolocation fails
async function getLocationViaIP() {
    geoLog('Trying IP-based location fallback...');
    const apis = [
        `https://api.ipstack.com/check?access_key=${IPSTACK_API_KEY}`,
        'https://ipapi.co/json/',
        'https://ip-api.com/json/?fields=status,lat,lon,city,country'
    ];
    for (const url of apis) {
        try {
            const ctrl = new AbortController();
            const id = setTimeout(() => ctrl.abort(), 6000);
            const res = await fetch(url, { signal: ctrl.signal });
            clearTimeout(id);
            const data = await res.json();

            // Handle IPStack response
            if (url.includes('ipstack.com')) {
                if (data && data.latitude != null && data.longitude != null) {
                    geoLog('IP location from ipstack.com:', data.latitude, data.longitude);
                    return {
                        lat: data.latitude,
                        lon: data.longitude,
                        city: data.city || '',
                        country: data.country_name || '',
                        approximate: true
                    };
                }
                geoLog('ipstack.com returned no coords or error:', data.error || data);
                continue;
            }

            const lat = data.latitude ?? data.lat;
            const lon = data.longitude ?? data.lon;
            if (url.includes('ipapi.co') && lat != null && lon != null) {
                geoLog('IP location from ipapi.co:', lat, lon);
                return { lat, lon, city: data.city || '', country: data.country_name || '', approximate: true };
            }
            if (url.includes('ip-api') && data.status === 'success' && lat != null && lon != null) {
                geoLog('IP location from ip-api:', lat, lon);
                return { lat, lon, city: data.city || '', country: data.country || '', approximate: true };
            }
        } catch (e) {
            geoLog('IP API failed:', url, e);
            continue;
        }
    }
    geoLog('All IP fallbacks failed');
    return null;
}

// Map GeolocationPositionError code to user message
function getGeolocationErrorMessage(code, defaultMsg) {
    switch (code) {
        case 1: return 'Location permission denied. Allow location in browser settings or use search.';
        case 2: return 'Location unavailable. Try again or use search.';
        case 3: return 'Location request timed out. Check your connection or use search.';
        default: return defaultMsg || 'Location unavailable. Use search instead.';
    }
}

// Geolocation Logic
async function findMyLocation(btnId = 'find-location-btn') {
    const btn = document.getElementById(btnId);
    if (!btn) return;

    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    showLocationError('');

    function resetBtn() {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }

    async function onLocationSuccess(lat, lon, accuracy, approximate) {
        if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
            geoLog('Invalid coordinates:', lat, lon);
            showLocationError('Invalid location. Use search instead.');
            resetBtn();
            return;
        }
        geoLog('Location obtained:', { lat, lon, accuracy, approximate });
        showLocationError('');
        // GPS is a location choice like any other: later scans and reports must use it.
        setAnalysisLocation(lat, lon, approximate ? 'My approximate location' : 'My location');
        const activeMap = activeMapInstance();
        if (activeMap) {
            if (userMarker) {
                try { activeMap.removeLayer(userMarker); } catch (_e) {}
            }
            userMarker = L.marker([lat, lon]).addTo(activeMap)
                .bindPopup(approximate ? 'Your approximate location (from IP)' : 'Your Location').openPopup();
            drawAnalysisRadius(lat, lon, { fit: false });
            zoomToPin(lat, lon);
        }
        updateAccuracyMeter(accuracy != null ? accuracy : (approximate ? 30 : 95));

        sendLocationToBackend(lat, lon, accuracy, approximate ? 'ip' : 'gps');
        resetBtn();
        return { success: true, lat, lon };
    }

    if (!isGeolocationSecure()) {
        showLocationError('Location requires HTTPS or localhost.');
        geoLog('Insecure context — geolocation disabled');
        const ipLoc = await getLocationViaIP();
        if (ipLoc) return await onLocationSuccess(ipLoc.lat, ipLoc.lon, 30, true);
        else resetBtn();
        return { success: false };
    }

    if (!navigator.geolocation) {
        geoLog('navigator.geolocation not available');
        const ipLoc = await getLocationViaIP();
        if (ipLoc) return await onLocationSuccess(ipLoc.lat, ipLoc.lon, 30, true);
        else showLocationError('Location not supported. Use search instead.');
        resetBtn();
        return { success: false };
    }

    geoLog('Requesting position (getCurrentPosition)...');
    const options = {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
    };

    return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
            async function (position) {
                geoLog('getCurrentPosition success:', position.coords);
                const lat = position.coords.latitude;
                const lon = position.coords.longitude;
                const accuracy = calculateAccuracy(position);
                const res = await onLocationSuccess(lat, lon, accuracy, false);
                resolve(res);
            },
            async function (error) {
                geoLog('getCurrentPosition error:', error.code, error.message);
                const userMsg = getGeolocationErrorMessage(error.code, 'Location unavailable. Use search instead.');
                showLocationError(userMsg);
                updateAccuracyMeter(0);
                const ipLoc = await getLocationViaIP();
                if (ipLoc) {
                    const res = await onLocationSuccess(ipLoc.lat, ipLoc.lon, 30, true);
                    resolve(res);
                } else {
                    resetBtn();
                    resolve({ success: false });
                }
            },
            options
        );
    });
}

// Global button click
safeOn('find-location-btn', 'click', async function () {
    const geoRes = await findMyLocation('find-location-btn');
    if (geoRes && geoRes.success && typeof geoRes.lat === 'number') {
        await findPopularPlaces(geoRes.lat, geoRes.lon, false);
    }
});

// --- ANIMATION UTILS ---
function animateValue(obj, start, end, duration) {
    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        const current = Math.floor(progress * (end - start) + start);

        obj.innerHTML = new Intl.NumberFormat('en-IN', {
            style: 'currency', currency: 'INR', maximumFractionDigits: 0
        }).format(current);

        if (progress < 1) {
            window.requestAnimationFrame(step);
        } else {
            obj.innerHTML = new Intl.NumberFormat('en-IN', {
                style: 'currency', currency: 'INR', maximumFractionDigits: 0
            }).format(end);
        }
    };
    window.requestAnimationFrame(step);
}

function formatINR(value) {
    return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0
    }).format(Math.max(0, Number(value || 0)));
}

function animateNumberTo(el, targetValue, duration = 1200, formatter = (v) => String(Math.round(v))) {
    if (!el) return;
    const target = Number(targetValue || 0);
    const existing = Number((el.dataset.rawValue || '0'));
    const start = Number.isFinite(existing) ? existing : 0;
    const diff = target - start;
    const startTs = performance.now();

    const tick = (ts) => {
        const progress = Math.min(1, (ts - startTs) / duration);
        const current = start + (diff * progress);
        el.textContent = formatter(current);
        if (progress < 1) {
            requestAnimationFrame(tick);
        } else {
            el.dataset.rawValue = String(target);
            el.textContent = formatter(target);
        }
    };
    requestAnimationFrame(tick);
}

function getLiveDaypartMultiplier() {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 10) return 0.82;  // Morning low
    if (hour >= 10 && hour < 14) return 1.22; // Lunch spike
    if (hour >= 14 && hour < 17) return 0.95; // Afternoon
    if (hour >= 17 && hour < 22) return 1.35; // Evening peak
    return 0.62; // Night drop
}

function startLiveRevenueSimulation(baseRevenue) {
    const revenueVal = document.getElementById('revenue-value');
    if (!revenueVal) return;

    if (liveRevenueTimer) {
        clearInterval(liveRevenueTimer);
        liveRevenueTimer = null;
    }

    const base = Math.max(0, Number(baseRevenue || 0));
    let t = 0;
    const updateFrame = () => {
        const drift = 1 + (Math.sin(t / 2.3) * 0.04);
        const daypart = getLiveDaypartMultiplier();
        const value = base * daypart * drift;
        animateNumberTo(revenueVal, value, 900, formatINR);
        t += 1;
    };

    updateFrame();
    liveRevenueTimer = setInterval(updateFrame, 5000);
}

function updateBusinessIntelligencePanel(payload, sourceLabel = 'Selected Location') {
    if (!isDashboardPage()) return;
    if (!isBusinessRecommendationsMode()) return;
    if (!payload) return;

    const analyticsSection = document.getElementById('dashboard-analytics-section');
    if (analyticsSection) analyticsSection.classList.remove('d-none');

    const panel = document.getElementById('business-intelligence-panel');
    if (panel) {
        panel.classList.remove('d-none');
        panel.classList.add('ai-panel-visible');
    }

    const revenue = payload.revenue_data || payload.revenueData || {};
    const recommendations = payload.recommendations || revenue.recommendations || [];

    const monthly = revenue.estimated_monthly_revenue || 0;
    const daily = revenue.daily_revenue || 0;
    const peak = revenue.peak_hour_revenue || 0;
    const crowdScore = payload.crowd_score ?? '--';

    // The map footer shows the area analysis (mapped places, summed estimates); this
    // single-business forecast must not overwrite it (it used to put the capped
    // "crowd score" of 100 into the footer).
    const dailyVal = document.getElementById('daily-revenue-value');
    const peakVal = document.getElementById('peak-revenue-value');
    animateNumberTo(dailyVal, daily, 1000, formatINR);
    animateNumberTo(peakVal, peak, 1000, formatINR);

    const monthlyBi = document.getElementById('bi-estimated-monthly');
    const dailyBi = document.getElementById('bi-daily-revenue');
    const peakBi = document.getElementById('bi-peak-hour');
    const overloadBi = document.getElementById('bi-overload-risk');
    const potentialBi = document.getElementById('bi-potential-score');
    const healthBi = document.getElementById('bi-business-health');

    if (monthlyBi) monthlyBi.textContent = formatINR(monthly);
    if (dailyBi) dailyBi.textContent = formatINR(daily);
    if (peakBi) peakBi.textContent = formatINR(peak);
    if (overloadBi) overloadBi.textContent = `${revenue.overload_risk ?? '--'}%`;
    if (potentialBi) potentialBi.textContent = `${revenue.potential_score ?? '--'}/100`;
    if (healthBi) healthBi.textContent = revenue.business_health || '--';

    const suggestionContent = document.getElementById('business-suggestion-content');
    if (suggestionContent) {
        const recHtml = recommendations.map((r) => `<li>${escapeHtml(r)}</li>`).join('');
        const recommendedBusiness = payload.recommended_business || payload.business_type || 'General Business';
        suggestionContent.innerHTML = `
            <div class="bi-summary-head">
                <strong>${escapeHtml(sourceLabel)}</strong>
                <span class="badge bg-secondary ms-2">Est. ${formatINR(monthly)}/month</span>
                <span class="badge bg-info ms-2">Feasibility ${payload.feasibility_score ?? revenue.potential_score ?? '--'}</span>
            </div>
            <div class="mt-2 small text-light">Recommended Business: <strong>${escapeHtml(recommendedBusiness)}</strong></div>
            <div class="mt-2 small text-light">Daypart: ${revenue.daypart || 'Live'}</div>
            <ul class="mt-2 mb-0">${recHtml || '<li>Keep monitoring this area for better trend confidence.</li>'}</ul>
        `;
    }

    // Fire the AI chart hook so the dashboard panel updates its charts + location cache
    if (typeof window.onAIDataUpdated === 'function') {
        const _lat = (typeof lastPopularPlacesResult !== 'undefined' && lastPopularPlacesResult) ? lastPopularPlacesResult.lat : null;
        const _lon = (typeof lastPopularPlacesResult !== 'undefined' && lastPopularPlacesResult) ? lastPopularPlacesResult.lon : null;
        window.onAIDataUpdated(
            monthly,
            daily,
            peak,
            revenue.potential_score ?? crowdScore ?? 0,
            revenue.business_health || '--',
            _lat,
            _lon,
            sourceLabel
        );
    }
}

// --- NEW UI RENDERING LOGIC ---

// Helper: Calculate Distance
function getDistance(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return '0.5 km';
    function toRad(Value) { return Value * Math.PI / 180; }
    const R = 6371; // km
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1); // Corrected dLon calculation
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const d = R * c;
    return d.toFixed(1) + ' km';
}

// Helper: Best Time to Visit (Simulated based on type)
function getBestTimeForPlace(type) {
    const t = (type || '').toLowerCase();
    if (t.includes('cafe') || t.includes('coffee')) return 'Morning (8am - 11am)';
    if (t.includes('restaurant') || t.includes('food')) return 'Lunch (12pm - 2pm)';
    if (t.includes('bar') || t.includes('pub') || t.includes('night')) return 'Evening (7pm - 11pm)';
    if (t.includes('park') || t.includes('garden')) return 'Late Afternoon (4pm - 6pm)';
    if (t.includes('shop') || t.includes('store') || t.includes('mall')) return 'Afternoon (2pm - 5pm)';
    return 'Generic (10am - 6pm)';
}

// Helper: Current Density Label
function getCurrentDensity(revenueData) {
    const health = revenueData.business_health || 'Moderate';
    if (health === 'Overloaded') return { label: 'High Density', class: 'text-danger', icon: 'fa-users' };
    if (health === 'Low Traffic') return { label: 'Low Density', class: 'text-success', icon: 'fa-user' };
    return { label: 'Moderate Crowd', class: 'text-warning', icon: 'fa-user-friends' };
}

// Helper: Get Icon for Business Type
function getIconForType(type) {
    const t = (type || '').toLowerCase();
    if (t.includes('school') || t.includes('college')) return 'fa-graduation-cap';
    if (t.includes('hospital') || t.includes('clinic')) return 'fa-hospital';
    if (t.includes('cafe')) return 'fa-coffee';
    if (t.includes('food') || t.includes('restaurant')) return 'fa-utensils';
    if (t.includes('shop') || t.includes('store')) return 'fa-shopping-bag';
    if (t.includes('bank') || t.includes('atm')) return 'fa-money-bill-wave';
    if (t.includes('park')) return 'fa-tree';
    return 'fa-map-marker-alt';
}

function renderPopularPlacesFlashcards(places) {
    const container = document.getElementById('popular-places-flashcards');
    if (!container) return;
    container.classList.add('flashcards-wrapper');

    if (!places || places.length === 0) {
        container.innerHTML = `<div class="flashcard-empty-state text-center text-muted p-4">No popular places found nearby.</div>`;
        return;
    }

    const limitedPlaces = places.slice(0, 16); // Max 16 for 4x4 matrix
    const center = lastPopularPlacesResult || { lat: 12.9716, lon: 77.5946 };

    let html = '';
    limitedPlaces.forEach((place, index) => {
        const name = place.tags?.name || place.tags?.amenity || 'Unknown Place';
        const type = place.tags?.amenity || place.tags?.shop || 'Business';
        const revData = place.revenue_data || {};

        // Detailed Metrics
        const monthly = revData.estimated_monthly_revenue
            ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(revData.estimated_monthly_revenue)
            : 'Rs--';
        const daily = revData.estimated_daily_revenue ?
            new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(revData.estimated_daily_revenue)
            : 'Rs--';
        const peak = revData.peak_hour_revenue
            ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(revData.peak_hour_revenue)
            : 'Rs--';
        const potential = revData.potential_score || 50;
        const colorClass = potential > 75 ? 'text-success' : (potential > 40 ? 'text-warning' : 'text-danger');
        const health = revData.business_health || 'Moderate';
        const overload = (revData.overload_risk === 0 || revData.overload_risk) ? `${revData.overload_risk}%` : '--';

        const bestTime = getBestTimeForPlace(type);
        const density = getCurrentDensity(revData);

        const plat = place.lat || (place.center ? place.center.lat : 0);
        const plon = place.lon || (place.center ? place.center.lon : 0);
        const distance = getDistance(center.lat, center.lon, plat, plon);

        // Simulated Rating
        const rating = (3 + (potential / 100) * 2).toFixed(1); // Scale 3.0 to 5.0
        const icon = getIconForType(type);

        html += `
        <div class="place-flashcard detailed-card" onclick="panToPlace(${index})">
            <div class="flashcard-header">
                <div class="d-flex align-items-center gap-2">
                    <i class="fas ${icon} text-muted"></i>
                    <span class="place-type">${type}</span>
                </div>
                <div class="d-flex align-items-center gap-2">
                    ${window.Favorites ? Favorites.heartHtml(Favorites.fromOverpass(place)) : ''}
                    <span class="place-rank-badge">#${index + 1}</span>
                    <span class="place-rating"><i class="fas fa-star text-warning"></i> ${rating}</span>
                    <span class="place-distance badge bg-dark border border-secondary">${distance}</span>
                </div>
            </div>
            <div class="flashcard-body">
                <div class="d-flex justify-content-between align-items-start">
                    <h4 class="place-name mb-0">${name}</h4>
                    <span class="place-score-badge ${colorClass}">${potential}</span>
                </div>
                
                <div class="flashcard-details-grid mt-3">
                    <div class="detail-item">
                        <span class="detail-label">Monthly Revenue</span>
                        <strong class="detail-value">${monthly}</strong>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Daily Revenue</span>
                        <strong class="detail-value">${daily}</strong>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Peak Hour</span>
                        <strong class="detail-value">${peak}</strong>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Crowd Density</span>
                        <strong class="detail-value ${density.class}">
                            <i class="fas ${density.icon} me-1"></i>${density.label}
                        </strong>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Business Health</span>
                        <strong class="detail-value">${health}</strong>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Overload Risk</span>
                        <strong class="detail-value">${overload}</strong>
                    </div>
                    <div class="detail-item full-width">
                        <span class="detail-label">Location Score</span>
                        <strong class="detail-value ${colorClass}">${potential}/100</strong>
                    </div>
                    <div class="detail-item full-width">
                        <span class="detail-label">Best Time to Visit</span>
                        <strong class="detail-value text-info">
                            <i class="fas fa-clock me-1"></i>${bestTime}
                        </strong>
                    </div>
                </div>

                <div class="progress-mini mt-auto">
                    <div class="progress-bar" style="width: ${potential}%"></div>
                </div>
            </div>
        </div>`;
    });

    container.innerHTML = html;
    if (window.Favorites) Favorites.refresh();

    // Keep panel hidden until user explicitly requests Popular Places.
    if (popularPlacesPanelRequested) {
        const section = document.getElementById('dashboard-analytics-section');
        const panel = document.getElementById('popular-places-panel');
        if (section) section.classList.remove('d-none');
        if (panel) panel.classList.remove('d-none');
    }
}

// Logic to open AI Modal
safeOn('view-ai-insights-btn', 'click', function () {
    const modal = document.getElementById('ai-insights-modal');
    if (modal) modal.classList.remove('d-none');
});

safeOn('close-ai-modal', 'click', function () {
    const modal = document.getElementById('ai-insights-modal');
    if (modal) modal.classList.add('d-none');
});

// Helper to pan map to place from flashcard
window.panToPlace = function (index) {
    if (lastPopularPlacesResult && lastPopularPlacesResult.places[index]) {
        const place = lastPopularPlacesResult.places[index];
        const lat = place.lat || place.center.lat;
        const lon = place.lon || place.center.lon;
        zoomToPin(lat, lon, 16);
        if (popularPlacesMarkers[index]) {
            popularPlacesMarkers[index].openPopup();
        }
    }
};

async function analyzeLocationIntelligence(lat, lon, sourceLabel = 'Selected Location') {
    try {
        const businessInput = document.getElementById('id_business_type');
        const stored = getSelectedLocation();
        const businessType = (businessInput ? businessInput.value : '') || (stored ? stored.type : '');
        const response = await fetch('/api/analyze-location/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCookie('csrftoken')
            },
            body: JSON.stringify({
                lat: lat,
                lng: lon,
                latitude: lat,
                longitude: lon,
                type: businessType || '',
                business_type: businessType || ''
            })
        });

        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.error || data.message || 'Failed to analyze location');
        }

        updateBusinessIntelligencePanel(data, sourceLabel);
        return data;
    } catch (err) {
        console.error('Location analysis failed:', err);
        showHeatmapToast(`Location analysis failed: ${err.message}`, 'error');
        return null;
    }
}

function clearAIBestLocationMarkers() {
    const activeMap = (typeof dashboardMap !== 'undefined' && dashboardMap) ? dashboardMap : map;
    if (!activeMap) return;
    aiSuggestedLocationMarkers.forEach((m) => {
        try { activeMap.removeLayer(m); } catch (_err) { }
    });
    aiSuggestedLocationMarkers = [];
}

function aiMarkerIconClass(score) {
    if (score >= 75) return 'feasibility-high';
    if (score >= 50) return 'feasibility-medium';
    return 'feasibility-low';
}

function createAIBlackMarker(score) {
    return L.divIcon({
        className: `ai-black-marker ${aiMarkerIconClass(Number(score || 0))}`,
        html: '<span></span>',
        iconSize: [18, 18],
        iconAnchor: [9, 9]
    });
}

function renderGeneratedLocationsList(locations) {
    const listEl = document.getElementById('generated-best-locations-list');
    if (!listEl) return;
    if (!locations || !locations.length) {
        listEl.innerHTML = '<p class="text-muted mb-0">No AI locations available right now.</p>';
        return;
    }
    listEl.innerHTML = locations.map((loc, idx) => `
        <div class="generated-location-card ${aiMarkerIconClass(loc.score)}">
            <div class="d-flex justify-content-between align-items-center">
                <strong>#${idx + 1} ${loc.name}</strong>
                <span class="badge bg-dark">Score ${loc.score}</span>
            </div>
            <div class="small mt-1">${loc.business_type} • ${formatINR(loc.estimated_revenue)}</div>
        </div>
    `).join('');
}

async function generateBestLocations(lat, lon) {
    const activeMap = (typeof dashboardMap !== 'undefined' && dashboardMap) ? dashboardMap : map;
    if (!activeMap) return;

    try {
        const response = await fetch('/api/generate-best-locations/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCookie('csrftoken')
            },
            body: JSON.stringify({
                latitude: lat,
                longitude: lon
            })
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.error || data.message || 'Unable to generate best locations');
        }

        clearAIBestLocationMarkers();
        const bounds = [];

        (data.locations || []).forEach((loc) => {
            const marker = L.marker([loc.lat, loc.lng], {
                icon: createAIBlackMarker(loc.score)
            }).addTo(activeMap);

            marker.bindPopup(`
                <div class="ai-location-popup">
                    <strong>${loc.name}</strong><br>
                    <span>Feasibility: ${loc.score}/100</span><br>
                    <span>Revenue: ${formatINR(loc.estimated_revenue)}</span><br>
                    <span>Recommended: ${loc.business_type}</span>
                </div>
            `);

            marker.on('click', () => {
                updateBusinessIntelligencePanel({
                    crowd_score: '--',
                    feasibility_score: loc.score,
                    recommendations: [
                        `Launch with ${loc.business_type} in this zone.`,
                        'Use phased rollout with weekly conversion tracking.'
                    ],
                    revenue_data: {
                        estimated_monthly_revenue: loc.estimated_revenue,
                        daily_revenue: loc.estimated_revenue / 30,
                        peak_hour_revenue: loc.estimated_revenue / 220,
                        overload_risk: Math.max(5, 100 - Math.round(loc.score)),
                        potential_score: Math.round(loc.score),
                        business_health: loc.score >= 75 ? 'Strong' : (loc.score >= 50 ? 'Moderate' : 'Weak'),
                        daypart: 'AI Feasibility'
                    }
                }, loc.name);
            });

            aiSuggestedLocationMarkers.push(marker);
            bounds.push([loc.lat, loc.lng]);
        });

        renderGeneratedLocationsList(data.locations || []);
        if (bounds.length) activeMap.fitBounds(bounds, { padding: [30, 30] });

        const panel = document.getElementById('business-intelligence-panel');
        if (isBusinessRecommendationsMode() && panel) panel.classList.remove('d-none');
        showHeatmapToast(`Generated ${Math.min(3, (data.locations || []).length)} best locations`, 'success');
    } catch (err) {
        console.error(err);
        showHeatmapToast(`AI location generation failed: ${err.message}`, 'error');
    }
}

function setDashboardAIEmptyState(message) {
    if (!isDashboardPage()) return;
    if (!isBusinessRecommendationsMode()) return;
    const analyticsSection = document.getElementById('dashboard-analytics-section');
    const aiPanel = document.getElementById('business-intelligence-panel');
    const suggestion = document.getElementById('business-suggestion-content');
    const row = document.getElementById('business-recommendations-row');

    if (analyticsSection) analyticsSection.classList.remove('d-none');
    if (aiPanel) aiPanel.classList.remove('d-none');
    if (suggestion) {
        suggestion.innerHTML = `<div class="ai-empty-state">${message}</div>`;
    }
    if (row) {
        row.innerHTML = `
            <div class="text-center text-muted p-5">
                <i class="fas fa-map-marker-alt fa-3x mb-3 opacity-50"></i>
                <p>${message}</p>
                <a href="/dashboard/?auto_map=true" class="btn btn-primary-blue mt-3">Open Map</a>
            </div>
        `;
    }
}

async function loadRecommendationCardsForLocation(lat, lon, locName = 'Selected Location', category = '') {
    const row = document.getElementById('business-recommendations-row');
    const dashContainer = document.getElementById('dashboard-recommendations-cards-container');
    const setBoth = (html) => { if (row) row.innerHTML = html; if (dashContainer) dashContainer.innerHTML = html; };
    const spinner = (text) => `<div class="text-center text-muted p-5 col-12"><div class="spinner-border text-primary mb-3" role="status"></div><p>${text}</p></div>`;
    const subtitle = document.getElementById('recommendations-subtitle');
    if (subtitle) subtitle.textContent = `Opportunities within 5 km of ${locName}${category ? ` · ${category.replace(/_/g, ' ')}` : ''}, ranked from live map data, the ML model and the revenue engine`;
    setBoth(spinner(`Analysing the 5 km area around <strong>${escapeHtml(locName)}</strong>…`));

    const result = await postAreaAnalysis('/api/location-recommendations/',
        { latitude: lat, longitude: lon, location_name: locName, category: category || undefined }, {
            onProgress: (secs, pending) => setBoth(spinner(pending
                ? `OpenStreetMap is busy – still fetching data for <strong>${escapeHtml(locName)}</strong> (${secs}s)…`
                : `Analysing the 5 km area around <strong>${escapeHtml(locName)}</strong> (${secs}s)…`)),
        });
    if (!result.ok) {
        const msg = (result.data && result.data.error) || 'Unable to fetch recommendations.';
        setBoth(`<div class="text-center text-muted p-5 col-12"><i class="fas fa-triangle-exclamation fa-3x mb-3 opacity-50"></i>
            <p>Could not load recommendations: ${escapeHtml(msg)}</p>
            <button type="button" class="btn btn-sm btn-outline-primary" id="recs-retry-btn">Retry</button></div>`);
        document.getElementById('recs-retry-btn')?.addEventListener('click', () => loadRecommendationCardsForLocation(lat, lon, locName, category));
        return;
    }
    const recs = Array.isArray(result.data.recommendations) ? result.data.recommendations : [];
    if (!recs.length) {
        setBoth(`<div class="text-center text-muted p-5 col-12"><i class="fas fa-map-pin fa-3x mb-3 opacity-50"></i>
            <p>No ${category ? escapeHtml(category.replace(/_/g, ' ')) + ' ' : ''}opportunities could be estimated for ${escapeHtml(locName)} within 5 km.</p></div>`);
        return;
    }
    renderBusinessRecommendationCards(recs, lat, lon, result.data.comparison);
    if (window.SynergyIntel) window.SynergyIntel.setRecommendations(recs, result.data.comparison, lat, lon);
}

function recLocationValue(loc) {
    return JSON.stringify({ lat: Number(loc.lat), lng: Number(loc.lng ?? loc.longitude), name: loc.name || 'Selected Location' });
}

/** Location dropdown = current searched location + recent searches + saved favorites; plus a category filter. */
async function initDashboardRecsDropdown() {
    const dropdown = document.getElementById('dashboard-rec-location-select');
    const categorySelect = document.getElementById('dashboard-rec-category-select');
    const refreshBtn = document.getElementById('btn-dashboard-refresh-recs');
    if (!dropdown) return;

    const current = getCurrentAnalysisLocation();
    const seen = [];
    const addGroup = (label, items) => {
        const fresh = items.filter(l => Number.isFinite(Number(l.lat)) && !seen.some(s => sameSpot(s, l, 150)));
        if (!fresh.length) return;
        const group = document.createElement('optgroup');
        group.label = label;
        fresh.forEach(l => {
            seen.push(l);
            const opt = document.createElement('option');
            opt.value = recLocationValue(l);
            opt.textContent = l.name || `${Number(l.lat).toFixed(4)}, ${Number(l.lng).toFixed(4)}`;
            group.appendChild(opt);
        });
        dropdown.appendChild(group);
    };
    dropdown.innerHTML = `<option value="">${current ? 'Choose a location…' : 'Search a location on the map first…'}</option>`;
    if (current) addGroup('Current location', [current]);
    addGroup('Recent searches', getRecentLocations());
    try {
        if (window.SupabaseAuth && await window.SupabaseAuth.ready && window.Favorites) {
            const favs = await window.Favorites.load();
            addGroup('Saved favorites', (favs || []).map(f => ({ lat: f.latitude, lng: f.longitude, name: f.name })));
        }
    } catch (_e) { /* signed out or favorites unavailable */ }
    if (current) dropdown.selectedIndex = 1;

    if (categorySelect && categorySelect.options.length <= 1) {
        try {
            const res = await fetch('/api/business-types/');
            const data = await res.json();
            (data.business_types || []).forEach(t => {
                const opt = document.createElement('option');
                opt.value = t.value;
                opt.textContent = t.label;
                categorySelect.appendChild(opt);
            });
        } catch (_e) { /* filter stays at "All categories" */ }
    }

    if (dropdown._initialized) return;
    dropdown._initialized = true;
    const reload = async () => {
        if (!dropdown.value) return;
        const loc = JSON.parse(dropdown.value);
        setAnalysisLocation(loc.lat, loc.lng, loc.name);
        await loadRecommendationCardsForLocation(loc.lat, loc.lng, loc.name, categorySelect ? categorySelect.value : '');
        analyzeLocationIntelligence(loc.lat, loc.lng, loc.name);
    };
    dropdown.addEventListener('change', reload);
    if (categorySelect) categorySelect.addEventListener('change', reload);
    if (refreshBtn) refreshBtn.addEventListener('click', reload);
}

function showRecommendationsEmptyState() {
    const html = `<div class="text-center text-muted p-5 col-12"><i class="fas fa-map-marker-alt fa-3x mb-3 opacity-50"></i>
        <p>Search a location on the map (or pick a recent search or saved favorite above) to see recommendations for that area.</p>
        <a href="/dashboard/?auto_map=true" class="btn btn-primary-blue btn-sm mt-2">Open Map</a></div>`;
    const dash = document.getElementById('dashboard-recommendations-cards-container');
    const row = document.getElementById('business-recommendations-row');
    if (dash) dash.innerHTML = html;
    if (row) row.innerHTML = html;
}

async function loadRecommendationsForCurrentLocation() {
    await initDashboardRecsDropdown();
    const loc = getCurrentAnalysisLocation();
    if (!loc) { showRecommendationsEmptyState(); return; }
    const categorySelect = document.getElementById('dashboard-rec-category-select');
    analyzeLocationIntelligence(loc.lat, loc.lng, loc.name || 'Selected Location');
    await loadRecommendationCardsForLocation(loc.lat, loc.lng, loc.name || 'Selected Location', categorySelect ? categorySelect.value : '');
}

async function initDashboardAIFromStorage() {
    if (!isDashboardPage()) return;
    const query = new URLSearchParams(window.location.search);
    const forceAI = query.get('ai') === 'true';
    const launchpad = document.getElementById('dashboard-launchpad');
    const dynamicMapContainer = document.getElementById('dynamic-map-container');
    const analyticsSection = document.getElementById('dashboard-analytics-section');
    const aiPanel = document.getElementById('ai-panel') || document.getElementById('business-intelligence-panel');
    const popularPanel = document.getElementById('popular-places-panel');
    if (popularPanel) popularPanel.classList.add('d-none');
    popularPlacesPanelRequested = false;

    // Business intelligence data is dashboard recommendations mode only.
    if (!forceAI) {
        if (analyticsSection) analyticsSection.classList.add('d-none');
        if (aiPanel) aiPanel.classList.add('d-none');
        return;
    }

    if (analyticsSection) analyticsSection.classList.remove('d-none');
    if (aiPanel) aiPanel.classList.remove('d-none');
    if (launchpad) launchpad.classList.add('d-none');
    if (dynamicMapContainer) dynamicMapContainer.classList.add('d-none');
    const aiTab = document.getElementById('dash-ai-tab');
    if (aiTab) aiTab.click();
    // The data itself is loaded by openDashboardDataOnlyMode() once the auth gate passes.
}

/** Dashboard view with only the Top 5 Business Recommendations for the current location. */
async function openRecommendationsView() {
    if (!isDashboardPage()) {
        window.location.href = '/dashboard/?recs=true';
        return;
    }
    const params = new URLSearchParams(window.location.search);
    ['ai', 'auto_map', 'form'].forEach(k => params.delete(k));
    params.set('recs', 'true');
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);

    ['dashboard-launchpad', 'dynamic-map-container', 'popular-places-panel', 'business-intelligence-panel',
     'dashboard-startup-form-section'].forEach(id => document.getElementById(id)?.classList.add('d-none'));
    document.querySelector('.dashboard-main')?.classList.remove('map-active');
    document.querySelector('.dashboard-header')?.classList.remove('d-none');
    const analytics = document.getElementById('dashboard-analytics-section');
    if (analytics) { analytics.classList.remove('d-none'); analytics.style.display = ''; }
    const recs = document.getElementById('business-recommendations-section');
    if (recs) recs.classList.remove('d-none');
    popularPlacesPanelRequested = false;
    if (typeof setActiveSidebarLink === 'function') setActiveSidebarLink('sidebar-recs-link');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await loadRecommendationsForCurrentLocation();
}
window.openRecommendationsView = openRecommendationsView;

function gateRecommendations(e) {
    if (e) e.preventDefault();
    if (window.requireSupabaseAuth) window.requireSupabaseAuth('Business Recommendations', openRecommendationsView);
    else openRecommendationsView();
}

/**
 * Business Analytics view (?ai=true): the projected-revenue 3D graph for the last finished
 * map analysis, with the Top 5 recommendations below it. Opened by the existing sidebar link
 * "Business Analytics", the "AI Recommender" hero button, the "AI Business Recommender" and
 * "Revenue Intelligence" tiles, and the ?ai=true deep link.
 */
async function openDashboardDataOnlyMode(targetTab) {
    if (!isDashboardPage()) return;

    const params = new URLSearchParams(window.location.search);
    ['auto_map', 'recs', 'form'].forEach(k => params.delete(k));
    params.set('ai', 'true');
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}${window.location.hash}`);

    ['dashboard-launchpad', 'dynamic-map-container', 'popular-places-panel', 'dashboard-startup-form-section']
        .forEach(id => document.getElementById(id)?.classList.add('d-none'));
    document.querySelector('.dashboard-main')?.classList.remove('map-active');
    const analyticsSection = document.getElementById('dashboard-analytics-section');
    if (analyticsSection) { analyticsSection.classList.remove('d-none'); analyticsSection.style.display = ''; }
    document.getElementById('business-intelligence-panel')?.classList.remove('d-none');
    document.getElementById('business-recommendations-section')?.classList.remove('d-none');
    document.getElementById('dash-recs-tab')?.click();   // the pane that holds the graph
    popularPlacesPanelRequested = false;
    setActiveSidebarLink('sidebar-ai-link');

    // The graph reads the saved analysis context: no recomputation, no default location.
    if (window.RevenueAnalytics3D) window.RevenueAnalytics3D.show(getAnalysisContext());
    if (window.SynergyIntel) window.SynergyIntel.show(getAnalysisContext());
    // Chat deep links (/dashboard/?ai=true#synergy-revenue-intel) land on the section they name.
    const target = ['#revenue-analytics-3d', '#synergy-revenue-intel'].includes(window.location.hash)
        && document.querySelector(window.location.hash);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    await loadRecommendationsForCurrentLocation();
}

// A new map analysis finished while Business Analytics is on screen: switch the graph to it.
document.addEventListener('analysis:context', (e) => {
    const root = document.getElementById('revenue-analytics-3d');
    if (window.RevenueAnalytics3D && root && root.offsetParent !== null) window.RevenueAnalytics3D.show(e.detail);
    if (window.SynergyIntel && root && root.offsetParent !== null) window.SynergyIntel.show(e.detail);
});

// Function to find popular places (reusable)
function formatINRCurrency(value) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(value) || 0);
}

function placeLatLon(place) {
    if (place.lat != null && place.lon != null) return [Number(place.lat), Number(place.lon)];
    if (place.center) return [Number(place.center.lat), Number(place.center.lon)];
    return null;
}

function popularPlacePopup(place) {
    const name = escapeHtml(place.tags?.name || place.tags?.amenity || 'Popular Place');
    const amenity = escapeHtml(place.tags?.amenity || place.tags?.shop || place.tags?.tourism || 'Unknown');
    let html = `<div class="popup-card"><div class="popup-header"><strong class="popup-title">${name}</strong>
        <span class="popup-type">${amenity}</span></div>`;
    const r = place.revenue_data;
    if (r && r.estimated_monthly_revenue) {
        const healthClass = r.business_health === 'Optimal' ? 'text-success' : (r.business_health === 'Overloaded' ? 'text-danger' : 'text-warning');
        html += `<div class="popup-stats">
            <div class="stat-row main-stat"><span>Est. monthly revenue</span><span class="stat-value monitor-glow">${formatINRCurrency(r.estimated_monthly_revenue)}</span></div>
            <div class="stat-row"><span>Est. daily avg</span><span class="stat-value">${formatINRCurrency(r.estimated_daily_revenue)}</span></div>
            <div class="stat-row"><span>Health</span><span class="stat-value ${healthClass}">${escapeHtml(r.business_health)}</span></div>
            <div class="stat-row"><span>Potential Score</span><div class="progress-mini"><div class="progress-bar" style="width: ${Number(r.potential_score) || 0}%"></div></div></div>
        </div><div class="popup-footer"><small>Estimates from the revenue engine · ${place.distance_m ? (place.distance_m / 1000).toFixed(1) + ' km away' : ''}</small></div>`;
    }
    return html + '</div>';
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderAreaFooter(data) {
    const revenueDisplay = document.getElementById('revenue-prediction-display');
    if (!revenueDisplay) return;
    revenueDisplay.classList.remove('d-none');
    const countEl = document.getElementById('crowd-score-value');
    const revenueEl = document.getElementById('revenue-value');
    const count = Number(data.pois_analysed ?? data.active_sensors_count ?? data.total_pois ?? 0);
    if (countEl) {
        countEl.textContent = count.toLocaleString('en-IN');
        countEl.style.color = count >= 20 ? '#16a34a' : count >= 8 ? '#ca8a04' : '#dc2626';
        const label = countEl.parentElement?.querySelector('.revenue-label');
        if (label) label.textContent = 'Mapped Places (5 km)';
    }
    if (revenueEl) {
        const revenue = Number(data.total_area_revenue ?? data.estimated_revenue ?? 0);
        revenueEl.textContent = revenue > 0 ? formatINRCurrency(revenue) : '₹--';
        const item = document.getElementById('revenue-estimate-item') || revenueEl.parentElement;
        if (item) item.title = (data.estimated_revenue_basis || 'Estimate from the revenue engine') + '. Not measured sales.';
    }
}

function clearPopularPlaceMarkers(activeMap) {
    (popularPlacesMarkers || []).forEach(marker => { try { activeMap.removeLayer(marker); } catch (_e) {} });
    popularPlacesMarkers = [];
}

/**
 * Popular places + crowd heatmap for the 5 km circle around (lat, lon).
 * A newer call supersedes an older one (the older response is ignored).
 * Returns {success, count} or {success:false, error, superseded}.
 */
async function findPopularPlaces(lat, lon, showAlert = true, opts = {}) {
    lat = Number(lat);
    lon = Number(lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { success: false, error: 'Invalid location' };

    const name = opts.name || (currentAnalysisLocation && sameSpot(currentAnalysisLocation, { lat, lng: lon }) ? currentAnalysisLocation.name : 'Selected Location');
    if (!currentAnalysisLocation || !sameSpot(currentAnalysisLocation, { lat, lng: lon })) {
        setAnalysisLocation(lat, lon, name);
    }
    if (analysisAbort) analysisAbort.abort();
    analysisAbort = new AbortController();
    const seq = ++analysisSeq;
    const isCurrent = () => seq === analysisSeq;

    const triggerButtons = [document.getElementById('popular-places-btn'), document.getElementById('dashboard-popular-places-btn')].filter(Boolean);
    triggerButtons.forEach(btn => {
        btn.disabled = true;
        if (!btn.dataset.originalHtml) btn.dataset.originalHtml = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin me-1"></i>Scanning 5 km...';
    });

    const activeMap = activeMapInstance();
    // view 'pin' (default): fly in to the chosen place; 'area': show the whole 5 km circle.
    const areaView = opts.view === 'area';
    if (activeMap) {
        drawAnalysisRadius(lat, lon, { fit: areaView && opts.fit !== false });
        if (!areaView) zoomToPin(lat, lon);
    }
    setMapStatus('Scanning 5 km area: fetching OpenStreetMap data…');

    try {
        const result = await postAreaAnalysis('/find-popular-places/', { latitude: lat, longitude: lon, name }, {
            signal: analysisAbort.signal,
            onProgress: (secs, pending) => {
                if (!isCurrent()) return;
                setMapStatus(pending
                    ? `OpenStreetMap is busy – still fetching (${secs}s)…`
                    : `Scanning 5 km area: fetching OpenStreetMap data (${secs}s)…`);
                triggerButtons.forEach(btn => { btn.innerHTML = `<i class="fas fa-spinner fa-spin me-1"></i>Scanning… ${secs}s`; });
            },
        });
        if (!isCurrent() || result.aborted) return { success: false, superseded: true };

        const data = result.data || {};
        if (!result.ok) {
            const err = data.error || data.message || 'Unable to fetch popular places.';
            setMapStatus(err, { kind: 'error', retry: () => findPopularPlaces(lat, lon, true, { name, view: opts.view }) });
            if (showAlert) showHeatmapToast('Scan failed: ' + err, 'error');
            if (typeof updateCrowdIntensityDropdown === 'function') {
                await updateCrowdIntensityDropdown(lat, lon, { success: false, error: err });
            }
            return { success: false, error: err };
        }
        if (data.center && !sameSpot(data.center, { lat, lng: lon }, 5)) {
            return { success: false, superseded: true };  // answer for another place
        }

        const places = data.results || [];
        if (activeMap) {
            clearPopularPlaceMarkers(activeMap);
            if (popularPlacesPanelRequested && typeof L !== 'undefined') {
                places.forEach(place => {
                    const ll = placeLatLon(place);
                    if (!ll) return;
                    try {
                        const marker = L.marker(ll, {
                            zIndexOffset: 500,
                            icon: L.icon({
                                iconUrl: 'https://cdn.jsdelivr.net/gh/pointhi/leaflet-color-markers@master/img/marker-icon-blue.png',
                                shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
                                iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
                            })
                        }).addTo(activeMap).bindPopup(popularPlacePopup(place), { minWidth: 260, className: 'premium-popup' });
                        marker.on('click', () => zoomToPin(ll[0], ll[1], 16));
                        popularPlacesMarkers.push(marker);
                    } catch (e) {
                        console.warn('Marker create error:', e);
                    }
                });
            }
        }

        renderAreaFooter(data);
        lastPopularPlacesResult = { places, lat, lon, recommendations: data.recommendations || [] };
        if (typeof renderPopularPlacesFlashcards === 'function') renderPopularPlacesFlashcards(places);
        if (typeof renderBusinessRecommendationCards === 'function') {
            renderBusinessRecommendationCards((data.recommendations && data.recommendations.length) ? data.recommendations : places, lat, lon);
        }
        // The crowd analysis came with this response: no second request.
        if (typeof updateCrowdIntensityDropdown === 'function') {
            await updateCrowdIntensityDropdown(lat, lon, data.crowd_intensity);
        }
        if (!isCurrent()) return { success: false, superseded: true };

        // The finished analysis becomes the context Business Analytics reads (no recomputation).
        saveAnalysisContext({ name, lat, lng: lon, radius: data.analysis_radius, analysis_id: data.analysis_id });

        const source = data.stale ? `cached OpenStreetMap data from ${new Date(data.fetched_at).toLocaleString()}` : 'live OpenStreetMap data';
        setMapStatus(`Analysis ready: ${places.length} popular places, ${Number(data.pois_analysed || 0).toLocaleString('en-IN')} mapped places in 5 km (${source}).`,
            { kind: data.stale ? 'warning' : 'ok' });
        if (showAlert) showHeatmapToast(`5 km scan complete: ${places.length} popular places found.`, 'success');
        return { success: true, count: places.length };
    } finally {
        if (isCurrent()) {
            analysisAbort = null;
            triggerButtons.forEach(btn => {
                btn.disabled = false;
                if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
            });
        }
    }
}

// Thresholds for people count
const CROWD_THRESHOLDS = {
    lowMax: 80,     // below medium threshold
    mediumMax: 160  // between lowMax and mediumMax = medium, above = high
};

function pickBusinessForIntensity(level) {
    const key = (level || '').toLowerCase();
    const options = (businessByIntensity && businessByIntensity[key]) || [];
    if (!options || !options.length) return '';
    // Choose the first for determinism; could randomize if desired.
    return options[0];
}

function estimateBaseFootfall(place) {
    const tags = place.tags || {};
    const amenity = tags.amenity || '';
    const shop = tags.shop || '';
    const tourism = tags.tourism || '';
    const leisure = tags.leisure || '';

    if (amenity === 'restaurant' || amenity === 'cafe' || amenity === 'fast_food') return 110;
    if (shop === 'mall' || tourism === 'attraction') return 140;
    if (amenity === 'school' || amenity === 'college' || amenity === 'university') return 120;
    if (amenity === 'park' || leisure === 'park') return 70;

    // Default baseline
    return 90;
}

function classifyCrowd(peopleCount) {
    if (peopleCount < CROWD_THRESHOLDS.lowMax) return 'low';
    if (peopleCount < CROWD_THRESHOLDS.mediumMax) return 'medium';
    return 'high';
}

function buildCrowdProfileForPlace(place) {
    const base = estimateBaseFootfall(place);

    // Simple time-of-day multipliers (morning/afternoon/evening/night)
    const slots = [
        { id: 'morning', label: 'Morning', timeRange: '6am - 10am', multiplier: 0.55 },
        { id: 'midday', label: 'Mid‑day', timeRange: '10am - 4pm', multiplier: 0.85 },
        { id: 'evening', label: 'Evening', timeRange: '4pm - 8pm', multiplier: 1.1 },
        { id: 'night', label: 'Night', timeRange: '8pm - 11pm', multiplier: 0.65 }
    ];

    const enrichedSlots = slots.map(slot => {
        const people = Math.round(base * slot.multiplier);
        const crowd = classifyCrowd(people);
        return {
            id: slot.id,
            label: slot.label,
            timeRange: slot.timeRange,
            people,
            crowd,
            business: pickBusinessForIntensity(crowd),
        };
    });

    // Best time: first slot where crowd is below medium threshold (i.e. "low")
    let best = enrichedSlots.find(s => s.crowd === 'low') || enrichedSlots[0];
    const bestTimeLabel = `${best.label} (${best.timeRange}) – best time (crowd below medium)`;

    return {
        bestTimeLabel,
        slots: enrichedSlots
    };
}

function formatAddressFromTags(tags = {}) {
    const parts = [];
    if (tags['addr:housenumber']) parts.push(tags['addr:housenumber']);
    if (tags['addr:street']) parts.push(tags['addr:street']);
    if (tags['addr:neighbourhood']) parts.push(tags['addr:neighbourhood']);
    if (tags['addr:suburb']) parts.push(tags['addr:suburb']);
    if (tags['addr:city']) parts.push(tags['addr:city']);
    if (!parts.length && tags['addr:full']) parts.push(tags['addr:full']);
    return parts.join(', ');
}

/**
 * Create a unified business flashcard HTML for popular places and recommendations.
 */
/**
 * Create a unified business flashcard HTML for popular places and recommendations.
 */
function createBusinessCard(place, type, index, fallbackLat, fallbackLon) {
    const tags = place.tags || {};
    const name = tags.name || tags.amenity || tags.shop || tags.tourism || 'Business';

    // Format address - simpler for card logic
    let address = '';
    if (tags['addr:street']) address += tags['addr:street'];
    if (tags['addr:city']) address += (address ? ', ' : '') + tags['addr:city'];
    if (!address) {
        address = (place.display_name || '').split(',').slice(0, 2).join(', ');
    }
    // Truncate if too long
    if (address.length > 35) address = address.substring(0, 32) + '...';

    const profile = buildCrowdProfileForPlace(place);

    // Determine specific variations based on type
    let headerBadge = '';
    let isPopular = type === 'popular';
    let score = 0;

    if (isPopular) {
        headerBadge = '<span class="badge-popular">Popular</span>';
    } else {
        // Synthetic score logic
        score = 98 - (index * 2) - Math.floor(Math.random() * 3);
        const scoreClass = score >= 90 ? 'score-high' : (score >= 75 ? 'score-medium' : 'score-low');
        headerBadge = `<span class="recommendation-score ${scoreClass} ms-2">${score}%</span>`;
    }

    // Generate dynamic description text based on profile
    let crowdDesc = '';
    const busySlot = profile.slots.find(s => s.crowd === 'high');
    const moderateSlot = profile.slots.find(s => s.crowd === 'medium');

    const businessLabel = place.revenue_data?.business_label || 'General Business';

    if (busySlot) {
        crowdDesc = `High foot traffic area (${businessLabel}). Ideal for high-volume business during ${busySlot.label.toLowerCase()}.`;
    } else if (moderateSlot) {
        crowdDesc = `Steady medium crowd (${businessLabel}). Good for service-oriented businesses.`;
    } else {
        crowdDesc = `Quieter location (${businessLabel}) with low competition. Suitable for niche ventures.`;
    }

    // Add peak time info
    const bestTime = profile.bestTimeLabel.split('(')[0].trim();
    crowdDesc += ` Peak hours: ${bestTime}.`;

    // Coordinates
    let pLat = place.lat;
    let pLon = place.lon;
    if (!pLat && place.center) {
        pLat = place.center.lat;
        pLon = place.center.lon;
    }
    const finalLat = pLat || fallbackLat;
    const finalLon = pLon || fallbackLon;
    const escapedName = name.replace(/'/g, "\\'");
    const placeBusinessType = (tags.amenity || tags.shop || tags.tourism || '').replace(/'/g, "\\'");

    // Button Logic
    let buttonHtml = '';
    
    // Pass revenue data to analyzeAndTrack so it can render dynamic feedback
    let revenueDataB64 = '';
    if (place.revenue_data) {
        revenueDataB64 = btoa(unescape(encodeURIComponent(JSON.stringify(place.revenue_data))));
    }

    if (isPopular) {
        buttonHtml = `
            <button type="button" class="btn-track-full" onclick="analyzeAndTrack(${finalLat}, ${finalLon}, '${escapedName}', ${score}, '${revenueDataB64}')">
                Analyze & Track
            </button>`;
    } else {
        buttonHtml = `
            <button type="button" class="btn-track-full" onclick="analyzeAndTrack(${finalLat}, ${finalLon}, '${escapedName}', ${score}, '${revenueDataB64}')">
                Analyze & Track
            </button>`;
    }

    // Revenue Display (if available)
    let revenueHtml = '';
    let feedbackHtml = '';
    if (place.revenue_data && place.revenue_data.estimated_monthly_revenue) {
        const rev = new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            maximumFractionDigits: 0
        }).format(place.revenue_data.estimated_monthly_revenue);

        const realTimeBadge = place.revenue_data.is_real_time ?
            `<span class="badge bg-success border-0 small ms-1" style="font-size: 0.65rem; opacity: 0.8;"><i class="fas fa-bolt me-1"></i>Real-time</span>` : '';

        revenueHtml = `
            <div class="business-card-revenue mt-2 mb-2 p-2 border rounded bg-dark" style="border-color: rgba(255,255,255,0.1) !important;">
                <div class="d-flex justify-content-between align-items-center">
                    <span class="text-muted small">Est. Monthly Revenue:</span>
                    <span class="text-success fw-bold">${rev}${realTimeBadge}</span>
                </div>
                 <div class="d-flex justify-content-between">
                    <span class="text-muted small">Location Intelligence:</span>
                    <span class="text-info fw-bold">${place.revenue_data.potential_score}/100</span>
                </div>
            </div>
        `;
        
        const pos = place.revenue_data.top_positive_factors || [];
        const neg = place.revenue_data.top_negative_factors || [];
        if (pos.length > 0 || neg.length > 0) {
            feedbackHtml = `
            <div class="business-card-feedback mt-2 mb-2 p-2 border rounded" style="font-size: 0.75rem; background: rgba(0,0,0,0.2); border-color: rgba(255,255,255,0.05) !important;">
                <div class="text-success mb-1"><i class="fas fa-check-circle me-1"></i>${pos[0] || 'Strong local metrics'}</div>
                <div class="text-warning"><i class="fas fa-exclamation-triangle me-1"></i>${neg[0] || 'Standard competitive friction'}</div>
            </div>
            `;
        }
    }

    // Generate card HTML (New Visual Style)
    return `
        <div class="business-card">
            <div class="business-card-header d-flex justify-content-between align-items-center">
                <span class="business-name">${name}</span>
                <span class="d-flex align-items-center gap-2">
                    ${headerBadge}
                    ${window.Favorites ? Favorites.heartHtml(Favorites.fromOverpass(place)) : ''}
                </span>
            </div>
            
            <div class="business-location-row">
                <i class="fas fa-map-marker-alt"></i>
                <span>${address}</span>
            </div>

            ${revenueHtml}
            ${feedbackHtml}

            <div class="business-card-description">
                ${crowdDesc}
            </div>

            ${buttonHtml}
        </div>
    `;
}

/**
 * Track location AND open the Business Intelligence dashboard tab.
 */
function analyzeAndTrack(lat, lon, name, score, revenueDataB64) {
    // Business intelligence is restricted to dashboard recommendations mode.
    if (!isBusinessRecommendationsMode()) {
        saveSelectedLocation(lat, lon, name || 'Selected Location', '');
        window.location.href = '/dashboard/?ai=true';
        return;
    }

    // 1. Standard Tracking
    selectSearchResult(lat, lon, name);

    // 2. Open Dashboard Panel if closed
    const intelPanel = document.getElementById('business-intelligence-panel');
    if (intelPanel && intelPanel.closest('.dashboard-analytics-section')) {
        const section = intelPanel.closest('.dashboard-analytics-section');
        section.classList.remove('d-none');
    }

    // 3. Switch to AI Strategy Tab
    const aiTabBtn = document.getElementById('dash-ai-tab');
    if (aiTabBtn) {
        const tab = new bootstrap.Tab(aiTabBtn);
        tab.show();
    }

    // 4. Populate AI Strategy Content using the new AI Revenue Model data
    const contentDiv = document.getElementById('business-suggestion-content');
    if (contentDiv) {
        let revData = null;
        try {
            if (revenueDataB64) {
                revData = JSON.parse(decodeURIComponent(escape(atob(revenueDataB64))));
            }
        } catch (e) {
            console.error("Failed to parse revenue data for feedback", e);
        }

        let recommendationsHtml = '';
        let scoreDisplay = score || 0;
        let riskText = 'Competition density is low in a 500m radius.';
        
        if (revData) {
            scoreDisplay = revData.potential_score || scoreDisplay;
            if (revData.actionable_recommendations && revData.actionable_recommendations.length > 0) {
                recommendationsHtml = revData.actionable_recommendations.map(r => `<li>• ${r}</li>`).join('');
            } else {
                recommendationsHtml = `<li>• General Retail operations</li><li>• Adaptive dynamic pricing recommended</li>`;
            }
            if (revData.risk_level) {
                riskText = `Risk Level: <strong>${revData.risk_level}</strong>. Confidence Score: <strong>${revData.confidence_score}%</strong>.`;
            }
        } else {
            recommendationsHtml = `
                <li>• Retail / Convenience Store</li>
                <li>• Quick Service Restaurant</li>
                <li>• Coworking Space</li>
            `;
        }

        contentDiv.innerHTML = `
            <div class="p-3">
                <h5 class="text-white mb-3">AI Analysis for ${name}</h5>
                <div class="alert alert-info mb-3">
                    <i class="fas fa-brain me-2"></i>
                    <strong>Feasibility Score: ${scoreDisplay}%</strong>
                </div>
                <p class="text-light small mb-2">Strategic Recommendations (Based on New Prediction Engine):</p>
                <ul class="text-muted small mb-3">
                    ${recommendationsHtml}
                </ul>
                <p class="text-muted tiny">
                    ${riskText}
                </p>
                <button class="btn btn-sm btn-outline-light mt-2" onclick="alert('Full report generated!')">Download PDF Report</button>
            </div>
        `;
    }
}

function renderPopularPlacesTable(places, lat, lon) {
    if (!popularPlacesPanel || !popularPlacesList) return;

    // Dashboard mode: render the detailed matrix flashcards when the container exists.
    const flashcardsContainer = document.getElementById('popular-places-flashcards');
    if (flashcardsContainer) {
        renderPopularPlacesFlashcards(places);
        if (popularPlacesPanelRequested) {
            if (popularPlacesPanel.classList.contains('d-none')) {
                popularPlacesPanel.classList.remove('d-none');
            } else {
                popularPlacesPanel.style.display = 'block';
            }
        }
        return;
    }

    popularPlacesList.innerHTML = '';

    if (!places.length) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'popular-place-item';
        emptyDiv.textContent = 'No popular places found within 2km.';
        popularPlacesList.appendChild(emptyDiv);
        if (popularPlacesPanelRequested) {
            if (popularPlacesPanel.classList.contains('d-none')) {
                popularPlacesPanel.classList.remove('d-none');
            } else {
                popularPlacesPanel.style.display = 'block';
            }
        }
        return;
    }

    // Limit to top 8-10 items to keep UI compact
    const topPlaces = places.slice(0, 10);

    topPlaces.forEach((place, index) => {
        const col = document.createElement('div');
        col.className = 'col-12 mb-3';
        col.innerHTML = createBusinessCard(place, 'popular', index, lat, lon);
        popularPlacesList.appendChild(col);
    });
    if (window.Favorites) Favorites.refresh();

    if (popularPlacesPanelRequested) {
        if (popularPlacesPanel.classList.contains('d-none')) {
            popularPlacesPanel.classList.remove('d-none');
        } else {
            popularPlacesPanel.style.display = 'block';
        }
    }
}

/**
 * Render dynamic "Top Business Recommendations" cards based on popular places.
 */
function createOpportunityCard(rec, lat, lon) {
    const money = (v) => (v || v === 0) ? formatINRCurrency(v) : '—';
    const targetLat = Number(rec.target_lat ?? lat);
    const targetLon = Number(rec.target_lon ?? lon);
    const competition = rec.competition_level || '—';
    const compBadge = competition === 'Low' ? 'bg-success' : (competition === 'Moderate' ? 'bg-warning text-dark' : 'bg-danger');
    const crowd = rec.crowd_level ? rec.crowd_level.charAt(0).toUpperCase() + rec.crowd_level.slice(1) : '—';
    const crowdBadge = rec.crowd_level === 'high' ? 'bg-danger' : (rec.crowd_level === 'medium' ? 'bg-warning text-dark' : 'bg-success');
    const breakEven = rec.break_even_months ? `${rec.break_even_months} months` : '—';
    const reasons = (rec.reasons || []).slice(0, 4).map(r => `<li class="small mb-1 text-light"><i class="fas fa-check text-success me-2"></i>${escapeHtml(r)}</li>`).join('');
    const payload = escapeHtml(JSON.stringify({ lat: targetLat, lng: targetLon, name: rec.locality || 'Selected location',
                                                title: `${rec.name} – best spot near ${rec.locality || 'here'}`, category: rec.category || '' }));

    return `
        <div class="col-12 col-md-6 col-xl-4 mb-3">
            <div class="business-opportunity-card card bg-dark text-light border-secondary h-100 shadow-sm" style="border-radius: 12px; overflow: hidden; background: linear-gradient(145deg, #182234 0%, #0f172a 100%);">
                <div class="card-header border-secondary d-flex justify-content-between align-items-center py-2 px-3" style="background: rgba(255,255,255,0.03);">
                    <div class="d-flex align-items-center gap-2">
                        <span class="badge bg-primary rounded-pill">#${Number(rec.rank) || ''}</span>
                        <i class="${escapeHtml(rec.icon || 'fas fa-store')} text-warning fs-5"></i>
                        <strong class="text-truncate" style="max-width: 200px;">${escapeHtml(rec.name)}</strong>
                    </div>
                    <div class="d-flex align-items-center gap-2">
                        <span class="badge bg-info-subtle text-info border border-info">${escapeHtml(rec.badge || '')}</span>
                        ${window.Favorites ? window.Favorites.heartHtml({ ...window.Favorites.locationPayload({
                            lat: targetLat, lng: targetLon, name: `${rec.name} – ${rec.locality || 'selected area'}`, category: rec.category || '' }),
                            potential_score: rec.potential_score }) : ''}
                    </div>
                </div>
                <div class="card-body p-3 d-flex flex-column justify-content-between">
                    <div>
                        <div class="d-flex align-items-center text-muted small mb-2">
                            <i class="fas fa-map-marker-alt text-danger me-1"></i>
                            <span>Best spot near ${escapeHtml(rec.locality || 'the selected area')} · ${targetLat.toFixed(4)}, ${targetLon.toFixed(4)}</span>
                        </div>
                        <div class="row g-2 text-center my-2 p-2 rounded" style="background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.05);">
                            <div class="col-4">
                                <div class="text-muted" style="font-size: 0.7rem;">Est. revenue</div>
                                <strong class="text-success" style="font-size: 0.95rem;">${money(rec.starting_monthly_revenue)}</strong>
                                <div class="text-muted" style="font-size: 0.65rem;">/month</div>
                            </div>
                            <div class="col-4 border-start border-end border-secondary">
                                <div class="text-muted" style="font-size: 0.7rem;">Est. profit</div>
                                <span class="text-info" style="font-size: 0.9rem;">${money(rec.estimated_monthly_profit)}</span>
                                <div class="text-muted" style="font-size: 0.65rem;">/month</div>
                            </div>
                            <div class="col-4">
                                <div class="text-muted" style="font-size: 0.7rem;">Break-even</div>
                                <strong class="text-warning" style="font-size: 0.95rem;">${breakEven}</strong>
                                <div class="text-muted" style="font-size: 0.65rem;">setup ${money(rec.setup_cost_estimate)}</div>
                            </div>
                        </div>
                        <div class="d-flex justify-content-between align-items-center my-2 px-1 flex-wrap gap-1">
                            <span class="small text-muted">Crowd: <span class="badge ${crowdBadge} ms-1">${crowd}</span></span>
                            <span class="small text-muted">Competition: <span class="badge ${compBadge} ms-1">${escapeHtml(competition)}</span>
                                <span class="ms-1">(${Number(rec.competitors_1km) || 0} ≤1 km)</span></span>
                        </div>
                        <ul class="list-unstyled my-2 ps-1">${reasons}</ul>
                        ${window.SynergyIntel ? window.SynergyIntel.cardBlock(rec.synergy) : ''}
                    </div>
                    <div>
                        <div class="pt-2 mt-2 border-top border-secondary text-muted" style="font-size: 0.7rem;" title="${escapeHtml(rec.assumptions || '')}">
                            <i class="fas fa-info-circle me-1"></i>Estimates · ${escapeHtml(rec.confidence || '')}${rec.uses_default_assumptions ? ' · generic assumptions' : ''}
                        </div>
                        <button type="button" class="btn btn-outline-primary btn-sm w-100 mt-2 d-flex align-items-center justify-content-center gap-2 rec-view-map" data-loc="${payload}">
                            <i class="fas fa-map-marked-alt text-warning"></i><span>View on Live Map (5 km)</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>`;
}

/** Switch to the map view (same page when possible) and fly to the location with its crowd analysis. */
async function navigateToMapOpportunity(lat, lon, name, category, title) {
    lat = Number(lat); lon = Number(lon);
    setAnalysisLocation(lat, lon, name, { category });
    const showMapBtn = document.getElementById('btn-show-map');
    if (!isDashboardPage() || !showMapBtn) {
        window.location.href = `/dashboard/?auto_map=true&lat=${lat}&lon=${lon}&name=${encodeURIComponent(name || '')}`;
        return;
    }
    document.getElementById('dashboard-analytics-section')?.classList.add('d-none');
    const params = new URLSearchParams(window.location.search);
    params.delete('ai'); params.set('auto_map', 'true');
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
    showMapBtn.click();
    await new Promise(r => setTimeout(r, 350));   // map container becomes visible / initialises
    popularPlacesPanelRequested = true;
    await focusMapOnOpportunityOrLocation(lat, lon, title || name, null, { locationName: name });
}
window.navigateToMapOpportunity = navigateToMapOpportunity;
window.createOpportunityCard = createOpportunityCard;

document.addEventListener('click', (e) => {
    const btn = e.target.closest('.rec-view-map');
    if (!btn) return;
    const loc = JSON.parse(btn.dataset.loc);
    navigateToMapOpportunity(loc.lat, loc.lng, loc.name, loc.category, loc.title);
});

/**
 * Render dynamic "Top Business Recommendations" cards based on opportunities or popular places.
 */
function renderBusinessRecommendationCards(places, lat, lon, comparison = null) {
    const row = document.getElementById('business-recommendations-row');
    const dashContainer = document.getElementById('dashboard-recommendations-cards-container');

    if (!places || !places.length) {
        if (row) row.innerHTML = '<div class="text-center text-muted p-4 col-12">No recommendations available for this location.</div>';
        if (dashContainer) dashContainer.innerHTML = '<div class="text-center text-muted p-4 col-12">No recommendations available for this location.</div>';
        return;
    }

    // Only fills the cards: which section is visible is decided by the view functions
    // (un-hiding here made the recommendations appear under the map after every scan).
    const isOpportunityList = places[0] && (places[0].starting_monthly_revenue !== undefined || places[0].target_lat !== undefined);

    let html = '';
    if (isOpportunityList) {
        if (comparison && window.SynergyIntel) html += window.SynergyIntel.comparisonStrip(comparison);
        places.slice(0, 5).forEach((rec, idx) => {
            html += createOpportunityCard(rec, lat, lon);
        });
    } else {
        places.slice(0, 10).forEach((place, index) => {
            const col = document.createElement('div');
            col.className = 'col-12 col-md-6 col-lg-4 mb-3';
            col.innerHTML = createBusinessCard(place, 'recommended', index, lat, lon);
            html += col.outerHTML;
        });
    }

    if (row) row.innerHTML = html;
    if (dashContainer) dashContainer.innerHTML = html;

    if (window.Favorites) Favorites.refresh();
}

// Default center when no location selected (Bangalore)
const DEFAULT_MAP_CENTER = { lat: 12.9716, lon: 77.5946 };

// Find Popular Places Button
safeOn('popular-places-btn', 'click', async function () {
    // Scan the place the user chose; never silently fall back to a default city.
    const loc = getCurrentAnalysisLocation();
    if (!loc) {
        showHeatmapToast('Choose a location first: search, click the map or use "My Location".', 'info');
        return;
    }
    popularPlacesPanelRequested = true;
    await findPopularPlaces(loc.lat, loc.lng, true, { name: loc.name, view: 'area' });
});

// Toggles and WebSocket handled globally

function connectChatbot() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/chat/`;

    chatSocket = new WebSocket(wsUrl);
    console.log('Chatbot: Connecting to WebSocket...', wsUrl);

    chatSocket.onopen = function (e) {
        console.log('Chatbot: WebSocket connection established');
    };

    chatSocket.onmessage = function (e) {
        hideTypingIndicator();
        console.log('Chatbot: Message received', e.data);
        const data = JSON.parse(e.data);
        const message = data.message;
        const actions = data.structured_actions;

        addChatMessage(message, 'bot', actions);
        runAutoChatActions(actions);

        // Allow the bot to control the map by parsing its response for commands
        const result = handleChatCommand(message);
        if (result.handled && result.feedback) {
            console.log('Bot-triggered map action:', result.feedback);
        }
    };

    chatSocket.onclose = function (e) {
        console.warn('Chatbot: WebSocket closed unexpectedly', e.code, e.reason);
        setTimeout(connectChatbot, 2000);
    };

    chatSocket.onerror = function (error) {
        console.error('Chatbot: WebSocket error:', error);
    };
}

// Add message to chatbot with markdown formatting and structured interactive buttons
function addChatMessage(message, sender, actions) {
    const messagesContainer = document.getElementById('chatbot-messages');
    if (!messagesContainer) return;
    const messageDiv = document.createElement('div');
    messageDiv.className = 'chatbot-message ' + sender;
    
    if (sender === 'bot') {
        // Format basic markdown safely
        let formatted = (message || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/•\s+(.*?)(?=\n|$)/g, '• $1')
            .replace(/━━━━━━━━━━━━━━━━━━━━━━━━━━━━/g, '<hr style="border:0;border-top:1px solid rgba(255,255,255,0.15);margin:8px 0;">')
            .replace(/\n/g, '<br>');
        
        messageDiv.innerHTML = formatted;

        // If structured actions are provided, render interactive action buttons
        if (actions && Array.isArray(actions) && actions.length > 0) {
            const actionsContainer = document.createElement('div');
            actionsContainer.className = 'chat-actions-container';
            
            actions.forEach(act => {
                if (!act || !act.intent) return;
                const btn = document.createElement('button');
                btn.className = 'chat-action-btn';
                btn.textContent = act.label || act.intent.replace(/_/g, ' ');
                btn.type = 'button';
                btn.addEventListener('click', function(e) {
                    e.preventDefault();
                    handleStructuredChatAction(act);
                });
                actionsContainer.appendChild(btn);
            });
            
            messageDiv.appendChild(actionsContainer);
        }
    } else {
        messageDiv.textContent = message;
    }
    
    messagesContainer.appendChild(messageDiv);

    // Auto-scroll to bottom
    setTimeout(() => {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }, 50);
}

// ==========================================
// Comprehensive Site Intelligence Knowledge Base
// Fast-load client-side search & instant navigation
// ==========================================
const SITE_FEATURES_KNOWLEDGE = [
    {
        key: 'map',
        title: 'Live Crowd Heatmap',
        category: 'Live Map',
        icon: 'fas fa-map-marked-alt',
        synonyms: [
            'map', 'live map', 'heatmap', 'heat map', 'crowd', 'crowds', 'crowd density',
            'footfall', 'heat overlay', 'crowd circle', 'crowd circles', 'red circle',
            'yellow circle', 'green circle', 'satellite', 'satellite view', 'layers',
            'zoom map', 'pan map', 'open map', 'view map', 'show map', 'go to map',
            'take me to map', 'launch map', 'traffic', 'pedestrian', 'density'
        ],
        description: '🗺️ **Live Crowd Heatmap**\n\nThe Live Heatmap displays real-time pedestrian and footfall density across city areas with dynamic color-coded crowd circles:\n• 🔴 **Red Circles (High Density, ~420m)**: Prime commercial footfall zones with maximum pedestrian activity.\n• 🟡 **Yellow Circles (Medium Density, ~300m)**: Steady footfall areas with balanced competition.\n• 🟢 **Green Circles (Low Density, ~200m)**: Quieter developing or residential zones.\n\nYou can search any location, toggle satellite/vector layers, zoom, and click to inspect coordinates.',
        actionLabel: '🚀 Open Live Heatmap',
        directCommandRegex: /^(?:(?:go\s+to|open|show|launch|take\s+me\s+to|view|bring\s+me\s+to)\s+)?(?:the\s+)?(?:live\s+)?(?:crowd\s+)?(?:heat\s*map|map|crowds?|density)(?:\s+(?:view|page|feature))?$/i
    },
    {
        key: 'analytics',
        title: 'Business Analytics & Recommendations',
        category: 'Analytics',
        icon: 'fas fa-chart-line',
        synonyms: [
            'analytics', 'business analytics', 'ai recommender', 'recommendations',
            'recommender', 'charts', 'graphs', 'market demand', 'competition',
            'competition index', 'footfall metrics', 'insights', 'category breakdown',
            'business recommendations', 'best locations', 'ai analysis', 'market analysis',
            'open analytics', 'go to analytics', 'show analytics', 'take me to analytics',
            'revenue graph', '3d graph', '3d chart', 'revenue chart', 'projected revenue', 'live revenue',
            'daily revenue', 'weekly revenue', 'monthly revenue', 'show business analytics'
        ],
        description: '📊 **Business Analytics**\n\nFor the area you last analysed with **Popular Locations** on the map:\n• **3D projected-revenue graph** within the 5 km radius, by business category, with **Live | Daily | Weekly | Monthly** views (drag to rotate, pinch/scroll to zoom, or view as a table).\n• **KPIs**: total projected revenue, peak period, top category and growth.\n• **Top 5 Business Recommendations** with revenue, break-even and competition.\n\nThe figures are a **model projection** from OpenStreetMap places and the platform\'s revenue engine, not real sales data. Run Popular Locations on the map first; the graph then opens for that area.',
        actionLabel: '📊 Go to Business Analytics',
        directCommandRegex: /^(?:(?:go\s+to|open|show|launch|take\s+me\s+to|view)\s+)?(?:the\s+)?(?:business\s+)?(?:analytics|recommendations|recommender|charts|ai\s+recommender)(?:\s+(?:page|section|feature))?$/i
    },
    {
        key: 'startup-form',
        title: 'Startup Planning Form',
        category: 'Feasibility Tool',
        icon: 'fas fa-clipboard-list',
        synonyms: [
            'startup form', 'startup', 'form', 'business form', 'submit business',
            'feasibility form', 'feasibility engine', 'open form', 'open business form',
            'fill form', 'plan business', 'enter business details', 'budget criteria',
            'business planner', 'criteria form'
        ],
        description: '📋 **Startup Planning Form & Feasibility Engine**\n\nInput your startup venture criteria to receive customized feasibility scores and location recommendations:\n• **Business Category**: Cafe, restaurant, pharmacy, retail, gym, salon, grocery, etc.\n• **Target Budget**: Define your capital expenditure limit.\n• **Required Footfall**: Specify desired customer volume.\n• **Operating Hours & Target Audience**: Tailors demographic matching.',
        actionLabel: '📋 Open Startup Form',
        directCommandRegex: /^(?:(?:go\s+to|open|show|launch|take\s+me\s+to|fill)\s+)?(?:the\s+)?(?:startup\s+)?(?:business\s+)?(?:form|feasibility\s+engine)(?:\s+(?:modal|page|section))?$/i
    },
    {
        key: 'favorites',
        title: 'My Favorites & Saved Places',
        category: 'Saved Items',
        icon: 'fas fa-heart',
        synonyms: [
            'favorites', 'favourite', 'favorite', 'favourites', 'saved', 'saved places',
            'bookmarks', 'saved spots', 'my favorites', 'saved locations', 'heart',
            'pinned places', 'open favorites', 'go to favorites', 'show favorites'
        ],
        description: '⭐ **My Favorites Hub**\n\nAccess all your shortlisted locations and saved opportunities:\n• Tap the **heart icon** on any recommended business card or popular place to save it.\n• Review all pinned spots side-by-side with crowd metrics.\n• Easily access and manage your saved business intelligence reports.',
        actionLabel: '⭐ Open Favorites',
        directCommandRegex: /^(?:(?:go\s+to|open|show|launch|take\s+me\s+to|view)\s+)?(?:the\s+)?(?:my\s+)?(?:favorites|favourites|saved\s+places|bookmarks)(?:\s+(?:page|section|hub))?$/i
    },
    {
        key: 'reports',
        title: 'Generated Business Intelligence Reports',
        category: 'PDF Reports',
        icon: 'fas fa-file-pdf',
        synonyms: [
            'reports', 'report', 'pdf', 'pdf report', 'business report', 'detailed report',
            'download report', 'download reports', 'generated reports', 'full report',
            'export report', 'market report', 'intelligence report', 'feasibility report',
            'view reports', 'show reports', 'open reports', 'go to reports'
        ],
        description: '📄 **Generated Business Intelligence Reports (PDF)**\n\nDownload executive-grade PDF reports for any analyzed location:\n• **Feasibility & Viability Score**: Algorithmic ROI rating.\n• **Footfall & Demographic Analysis**: Exact crowd metrics, peak times, and customer profiles.\n• **SWOT Matrix & Competitor Mapping**: Highlights strengths, risks, and market gaps.\n• Generated reports are permanently saved in your **Favorites** tab for quick download anytime.',
        actionLabel: '📄 Open Reports Hub',
        directCommandRegex: /^(?:(?:go\s+to|open|show|launch|take\s+me\s+to|download|view)\s+)?(?:the\s+)?(?:generated\s+)?(?:business\s+)?(?:pdf\s+)?(?:reports?)(?:\s+(?:section|hub|tab))?$/i
    },
    {
        key: 'popular-places',
        title: 'Popular Places Radar (Nearby POIs)',
        category: 'Map Tool',
        icon: 'fas fa-store',
        synonyms: [
            'popular places', 'popular place', 'nearby', 'nearby places', 'poi', 'points of interest',
            'shops', 'stores', 'cafes near me', 'restaurants near me', 'explore places',
            'radar', 'commercial places', 'nearby businesses'
        ],
        description: '📍 **Popular Places Radar**\n\nScans around any coordinate or selected neighborhood to locate commercial points of interest:\n• Discover established competitors, cafes, retail hubs, supermarkets, and gyms.\n• Analyze local footfall anchors.\n• Click any business card to highlight its pin or save it to your Favorites.',
        actionLabel: '📍 Scan Popular Places',
        directCommandRegex: /^(?:(?:find|search|scan|show|open|go\s+to)\s+)?(?:the\s+)?(?:nearby\s+)?popular\s+places(?:\s+radar)?$/i
    },
    {
        key: 'find-location',
        title: 'Find My Location (GPS)',
        category: 'Location Tool',
        icon: 'fas fa-crosshairs',
        synonyms: [
            'find my location', 'my location', 'locate me', 'where am i', 'current location',
            'gps', 'locate', 'find me', 'pin my location', 'gps location', 'here',
            'detect location', 'track location'
        ],
        description: '📡 **Find My Location (GPS)**\n\nUses browser geolocation to instantly center the map on your exact coordinates:\n• Inspect immediate pedestrian crowd density circles.\n• Discover nearby commercial businesses around you.\n• Check feasibility of opening a business right at your current spot.',
        actionLabel: '📡 Locate Me Now',
        directCommandRegex: /^(?:(?:find|show|get|track|pin)\s+)?(?:my\s+)?(?:current\s+)?location|where\s+am\s+i|locate\s+me$/i
    },
    {
        key: 'revenue',
        title: 'Revenue Intelligence',
        category: 'Financial Tool',
        icon: 'fas fa-coins',
        synonyms: [
            'revenue', 'revenue intelligence', 'earnings', 'income', 'profit', 'projections',
            'financial', 'sales', 'forecast', 'flashcards', 'business flashcards', 'turnover',
            'money', 'roi'
        ],
        description: '💰 **Revenue Intelligence**\n\nCalculates financial potential based on local traffic and business sector benchmarks:\n• **Projected Daily & Monthly Turnover**: Based on footfall conversion models.\n• **Break-Even Analysis**: Compares startup investment against projected margins.\n• **Opportunity Index**: Identifies high-margin niches.',
        actionLabel: '💰 View Revenue Projections',
        directCommandRegex: /^(?:(?:go\s+to|open|show|view)\s+)?(?:revenue|revenue\s+intelligence|financial\s+projections)(?:\s+(?:page|flashcards))?$/i
    },
    {
        key: 'dashboard',
        title: 'Dashboard Overview',
        category: 'Navigation',
        icon: 'fas fa-th-large',
        synonyms: [
            'dashboard', 'launchpad', 'main dashboard', 'control center', 'overview',
            'home dashboard', 'go to dashboard', 'open dashboard'
        ],
        description: '🚀 **Dashboard Launchpad**\n\nThe central launchpad gives you direct access to all core platform features:\n• Live Heatmap & Crowd Circles\n• AI Business Recommendations & Market Demand Analytics\n• Startup Planning Form & Feasibility Engine\n• Quick statistics and platform telemetry.',
        actionLabel: '🚀 Open Dashboard',
        directCommandRegex: /^(?:(?:go\s+to|open|show|view)\s+)?(?:the\s+)?dashboard$/i
    },
    {
        key: 'home',
        title: 'Homepage',
        category: 'Navigation',
        icon: 'fas fa-home',
        synonyms: [
            'home', 'homepage', 'landing page', 'main map', 'front page', 'go home', 'open home'
        ],
        description: '🏠 **Homepage**\n\nThe homepage provides a full-window map canvas, instant location search, and quick access to platform tools.',
        actionLabel: '🏠 Go to Homepage',
        directCommandRegex: /^(?:(?:go\s+to|open|show|view)\s+)?(?:the\s+)?(?:home|homepage|landing\s+page)$/i
    },
    {
        key: 'profile',
        title: 'Account & Profile Settings',
        category: 'Account',
        icon: 'fas fa-user-circle',
        synonyms: [
            'profile', 'account', 'settings', 'user', 'sign in', 'login', 'logout',
            'supabase', 'auth', 'my account', 'account settings'
        ],
        description: '👤 **Account & Profile**\n\nManage your user profile, secure sign-in and synced preferences.\n• Access protected reports and saved custom analyses across sessions.',
        actionLabel: '👤 Open Profile',
        directCommandRegex: /^(?:(?:go\s+to|open|show|view)\s+)?(?:the\s+)?(?:profile|account|account\s+settings)$/i
    },
    {
        key: 'contact',
        title: 'Contact Us & Support',
        category: 'Support',
        icon: 'fas fa-envelope',
        synonyms: [
            'contact', 'contact us', 'support', 'help', 'email', 'feedback', 'team',
            'help desk', 'customer support'
        ],
        description: '✉️ **Contact Support**\n\nNeed enterprise consulting, custom GIS data feeds, or have feedback?\n• Reach out to our Business Intelligence team directly through our Contact portal.',
        actionLabel: '✉️ Contact Us',
        directCommandRegex: /^(?:(?:go\s+to|open|show|view)\s+)?(?:the\s+)?(?:contact|contact\s+us|support|help)$/i
    }
];

function findBestSiteFeatureMatch(rawQuery) {
    if (!rawQuery || typeof rawQuery !== 'string') return null;
    const query = rawQuery.trim().toLowerCase().replace(/[?!.,;]/g, '');
    if (!query) return null;

    // 1. Direct Regex Match (Exact navigation commands)
    for (const item of SITE_FEATURES_KNOWLEDGE) {
        if (item.directCommandRegex && item.directCommandRegex.test(query)) {
            return { item, isExplicitNavigation: true };
        }
    }

    // 2. Keyword & Synonyms Scoring
    const queryWords = query.split(/\s+/).filter(w => w.length > 1);
    let bestMatch = null;
    let highestScore = 0;
    const hasNavVerb = /\b(go to|open|show|launch|take me to|navigate to|redirect to|view|bring me to)\b/i.test(rawQuery);

    for (const item of SITE_FEATURES_KNOWLEDGE) {
        let score = 0;

        // Exact match with key or title
        if (query === item.key || query === item.title.toLowerCase()) {
            score += 10;
        }

        // Substring match in title or synonyms
        for (const syn of item.synonyms) {
            if (query === syn) {
                score += 8;
            } else if (query.includes(syn)) {
                score += 5;
            } else if (syn.includes(query) && query.length >= 3) {
                score += 4;
            }
        }

        // Individual word hits
        for (const word of queryWords) {
            for (const syn of item.synonyms) {
                if (syn.includes(word) && word.length >= 3) {
                    score += 2;
                }
            }
        }

        if (score > highestScore) {
            highestScore = score;
            bestMatch = item;
        }
    }

    if (bestMatch && highestScore >= 4) {
        return { item: bestMatch, isExplicitNavigation: hasNavVerb || highestScore >= 8 };
    }

    return null;
}

function navigateToFeature(featureKey) {
    console.log('Navigating to feature:', featureKey);
    const isDashboard = window.location.pathname.includes('/dashboard');

    switch (featureKey) {
        case 'map':
        case 'heatmap':
            if (isDashboard) {
                const mapBtn = document.getElementById('btn-show-map');
                const sidebarHeatmapLink = document.getElementById('sidebar-heatmap-link');
                if (mapBtn) {
                    mapBtn.click();
                } else if (sidebarHeatmapLink) {
                    sidebarHeatmapLink.click();
                }
            } else {
                window.location.href = '/dashboard/?auto_map=true';
            }
            break;

        case 'analytics':
        case 'ai-recommender':
            if (isDashboard) {
                // Same login gate as the sidebar link.
                if (window.requireSupabaseAuth) window.requireSupabaseAuth('Business Analytics', () => openDashboardDataOnlyMode('ai'));
                else openDashboardDataOnlyMode('ai');
            } else {
                window.location.href = '/dashboard/?ai=true';
            }
            break;

        case 'startup-form':
        case 'form':
            if (isDashboard) {
                const sidebarStartupLink = document.getElementById('sidebar-startup-form-link');
                const launchpadStartupBtn = document.getElementById('btn-show-startup-form-from-launchpad');
                if (sidebarStartupLink) {
                    sidebarStartupLink.click();
                } else if (launchpadStartupBtn) {
                    launchpadStartupBtn.click();
                }
            } else {
                const formModal = document.getElementById('form-modal');
                if (formModal) {
                    formModal.style.display = 'block';
                } else {
                    window.location.href = '/dashboard/';
                }
            }
            break;

        case 'favorites':
        case 'saved':
            window.location.href = '/favorites/';
            break;

        case 'reports':
            window.location.href = '/favorites/';
            break;

        case 'dashboard':
        case 'launchpad':
            if (isDashboard) {
                const backBtn = document.getElementById('btn-back-to-dashboard') || document.getElementById('sidebar-dashboard-link');
                if (backBtn) backBtn.click();
            } else {
                window.location.href = '/dashboard/';
            }
            break;

        case 'home':
            window.location.href = '/';
            break;

        case 'popular-places':
            if (isDashboard) {
                const mapBtn = document.getElementById('btn-show-map');
                if (mapBtn) mapBtn.click();
                setTimeout(() => {
                    const popBtn = document.getElementById('popular-places-btn') || document.getElementById('dash-popular-places-btn');
                    if (popBtn) popBtn.click();
                }, 350);
            } else {
                const popBtn = document.getElementById('popular-places-btn');
                if (popBtn) popBtn.click();
            }
            break;

        case 'find-location':
            const findBtn = document.getElementById('find-location-btn') || document.getElementById('dash-find-location-btn');
            if (findBtn) {
                findBtn.click();
            } else {
                window.location.href = '/dashboard/?auto_map=true';
            }
            break;

        case 'revenue':
            if (isDashboard) {
                const flashBtn = document.getElementById('btn-show-flashcards');
                if (flashBtn) {
                    flashBtn.click();
                } else if (typeof openDashboardDataOnlyMode === 'function') {
                    openDashboardDataOnlyMode('recs');
                }
            } else {
                window.location.href = '/dashboard/?ai=true';
            }
            break;

        case 'profile':
            window.location.href = '/profile/';
            break;

        case 'contact':
            window.location.href = '/contact-us/';
            break;

        default:
            console.warn('Unknown feature key for navigation:', featureKey);
    }
}

// Handle structured AI actions securely
function handleStructuredChatAction(action) {
    if (!action) return;
    if (typeof action === 'string') {
        navigateToFeature(action);
        return;
    }
    const intent = action.intent || '';
    if (intent === 'navigate_feature' || action.featureKey) {
        navigateToFeature(action.featureKey || intent);
        return;
    }
    console.log('Executing structured AI action:', action);
    
    const locName = action.location || '';
    const bType = action.business_type || '';

    if (intent === 'check_feasibility') {
        if (typeof runFeasibilityFlow === 'function') {
            runFeasibilityFlow(bType || 'cafe', locName);
        } else {
            notifyChatFromMap(`Checking feasibility for ${bType} in ${locName}...`);
        }
    } else if (intent === 'find_alternative_locations') {
        if (typeof generateBestLocations === 'function') {
            generateBestLocations();
        } else {
            redirectToDashboardAIIfNeeded();
        }
    } else if (intent === 'view_heatmap') {
        if (typeof analyzeCrowdIntensity === 'function') {
            analyzeCrowdIntensity();
        } else {
            window.location.href = '/';
        }
    } else if (intent === 'compare_locations') {
        redirectToDashboardAIIfNeeded();
    } else if (intent === 'open_dashboard') {
        window.location.href = '/dashboard/?ai=true';
    } else if (intent === 'open_form') {
        const formModal = document.getElementById('form-modal');
        if (formModal) formModal.style.display = 'block';
    } else if (intent === 'find_popular_places') {
        const loc = getCurrentAnalysisLocation();
        if (loc) {
            findPopularPlaces(loc.lat, loc.lng, true, { name: loc.name, view: 'area' });
        } else {
            notifyChatFromMap('Choose a location first: search for a place, click the map or use "Find My Location".');
        }
    } else if (intent === 'generate_report') {
        if (window.ReportGenerator) window.ReportGenerator.start({ source: 'chat' });
    } else if (intent === 'download_report') {
        if (window.ReportGenerator && action.report_id) window.ReportGenerator.download(action.report_id);
    } else if (intent === 'view_revenue_graph') {
        openAnalyticsSection('revenue-analytics-3d');
    } else if (intent === 'view_synergy') {
        openAnalyticsSection('synergy-revenue-intel');
    } else if (intent === 'open_favorites') {
        navigateToFeature('favorites');
    }
}

// Open Business Analytics and scroll to one of its sections (3D revenue graph, synergy panel).
function openAnalyticsSection(sectionId) {
    if (!window.location.pathname.includes('/dashboard')) {
        window.location.href = `/dashboard/?ai=true#${sectionId}`;
        return;
    }
    navigateToFeature('analytics');
    setTimeout(() => {
        const el = document.getElementById(sectionId);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 400);
}

// Run actions the server marked auto_run (currently only report generation the user asked for).
function runAutoChatActions(actions) {
    (actions || []).forEach(act => {
        if (act && act.auto_run === true && act.intent === 'generate_report') handleStructuredChatAction(act);
    });
}

function showTypingIndicator() {
    const messagesContainer = document.getElementById('chatbot-messages');
    if (!messagesContainer || document.querySelector('.typing-indicator')) return;

    const indicator = document.createElement('div');
    indicator.className = 'typing-indicator';
    indicator.innerHTML = `
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
    `;
    messagesContainer.appendChild(indicator);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function hideTypingIndicator() {
    const indicator = document.querySelector('.typing-indicator');
    if (indicator) indicator.remove();
}

// Notify chat when a map action happens (links map buttons to chatbot)
function notifyChatFromMap(message) {
    addChatMessage(message, 'bot');
}

// Chatbot send message
// Global delegated Enter key listener for chatbot input
document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target && e.target.id === 'chatbot-input') {
        e.preventDefault();
        sendChatMessage();
    }
});

// Place a single brown business marker at (lat, lon) for feasible location
function placeFeasibilityMarker(lat, lon, label) {
    if (typeof map === 'undefined' || !map) return;
    if (Array.isArray(businessRecommendationMarkers)) {
        businessRecommendationMarkers.forEach(m => {
            try { map.removeLayer(m); } catch (e) {}
        });
        businessRecommendationMarkers = [];
    }
    const color = '#8B4513';   // brown
    if (typeof L !== 'undefined' && L.circleMarker) {
        try {
            const marker = L.circleMarker([lat, lon], {
                radius: 14,
                color,
                fillColor: color,
                fillOpacity: 0.9,
                weight: 3
            }).addTo(map)
                .bindPopup(`<b>Business location (feasible)</b><br>${label || 'Recommended spot'}`);
            if (Array.isArray(businessRecommendationMarkers)) {
                businessRecommendationMarkers.push(marker);
            }
        } catch (e) {
            console.warn('Could not place feasibility marker:', e);
        }
    }
}

// Framework: user command like "open cafe in Koramangala" -> 4.1 point location, 4.2 popular places 2km, 4.3 feasibility, 4.4 brown marker or not feasible
async function runFeasibilityFlow(placeText, businessType) {
    try {
        const normalizedPlace = (placeText || '').toLowerCase().trim();
        const useCurrentArea = /^(this area|this location|current location|my location|here|near me|around me)$/.test(normalizedPlace);

        let lat = Number.NaN;
        let lon = Number.NaN;
        let locationLabel = placeText;

        if (useCurrentArea) {
            const latInput = parseFloat(document.getElementById('id_latitude')?.value || '');
            const lonInput = parseFloat(document.getElementById('id_longitude')?.value || '');
            if (!Number.isNaN(latInput) && !Number.isNaN(lonInput)) {
                lat = latInput;
                lon = lonInput;
            } else if (userMarker && typeof userMarker.getLatLng === 'function') {
                const markerLatLng = userMarker.getLatLng();
                lat = parseFloat(markerLatLng.lat);
                lon = parseFloat(markerLatLng.lng);
            }

            if (Number.isNaN(lat) || Number.isNaN(lon)) {
                notifyChatFromMap('Please set your location first using "find my location", map click, or place search.');
                return;
            }
            locationLabel = 'your selected area';
        } else {
            const response = await fetch('/search-location/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': getCookie('csrftoken')
                },
                body: JSON.stringify({ query: placeText.includes(',') ? placeText : `${placeText}, India` })
            });
            const data = await response.json();
            const results = (data && data.results) || [];
            if (!data.success || !results.length) {
                notifyChatFromMap(`Could not find location "${placeText}". Try a different place name.`);
                return;
            }
            const first = results[0];
            lat = parseFloat(first.lat);
            lon = parseFloat(first.lon);
            if (Number.isNaN(lat) || Number.isNaN(lon)) {
                notifyChatFromMap(`Invalid coordinates for "${placeText}".`);
                return;
            }
            locationLabel = first.display_name || placeText;
        }

        notifyChatFromMap(`Pointing to ${locationLabel} and checking feasibility for "${businessType || 'business'}".`);
        // 4.1 Point to the location if map is loaded on current page
        if (typeof map !== 'undefined' && map) {
            try {
                map.setView([lat, lon], 15);
                if (userMarker) {
                    try { map.removeLayer(userMarker); } catch (e) {}
                }
                if (typeof L !== 'undefined' && L.marker) {
                    userMarker = L.marker([lat, lon]).addTo(map)
                        .bindPopup(locationLabel).openPopup();
                }
            } catch (e) {
                console.warn('Map view error:', e);
            }
        }
        const latInput = document.getElementById('id_latitude');
        const lonInput = document.getElementById('id_longitude');
        if (latInput) latInput.value = lat;
        if (lonInput) lonInput.value = lon;
        if (typeof updateAccuracyMeter === 'function') updateAccuracyMeter(85);
        if (typeof showLocationError === 'function') showLocationError('');
        // The business type is chat text, not a category: it is not stored with the location.
        setAnalysisLocation(lat, lon, locationLabel);

        // 4.2 Popular places + crowd heatmap for the 5 km analysis radius
        await findPopularPlaces(lat, lon, false, { name: locationLabel });
        // 4.3 & 4.4 Check feasibility and place brown marker or show not feasible
        const feasData = await getFeasibilityWithCache(lat, lon, businessType || '');
        if (feasData.success) {
            if (feasData.feasible) {
                placeFeasibilityMarker(lat, lon, businessType ? `${businessType} (feasible)` : 'Feasible location');
                notifyChatFromMap(feasData.message);
            } else {
                notifyChatFromMap(feasData.message);
            }
        } else {
            notifyChatFromMap(`Could not check feasibility: ${feasData.error || feasData.message || 'Unknown error'}.`);
        }
    } catch (err) {
        console.error('Feasibility flow error:', err);
        notifyChatFromMap('Something went wrong. Please try again or search for the location manually.');
    }
}

// Try to run a map/form action from a chat command; returns { handled: true, feedback?: string } or { handled: false }
function handleChatCommand(message) {
    const lower = message.toLowerCase().trim();
    const trimmed = message.trim();

    // Report requests ("give me a business feasibility report") go to the server,
    // which starts the report flow; don't also treat them as map commands.
    if (window.ReportGenerator && window.ReportGenerator.looksLikeReportRequest(trimmed)) {
        return { handled: false };
    }

    if (/\b(help|commands|what can you do|how to use|assist me)\b/i.test(lower)) {
        return {
            handled: true,
            feedback: '🤖 I can help with map actions. Try: "find my location", "search for Indiranagar", "open cafe in Koramangala", or "popular places".',
            suppressLLM: true,
        };
    }

    // Business feasibility commands
    const openBizInMatch = trimmed.match(/\b(?:i\s+want\s+to\s+)?(?:open|start)\s+(?:a\s+)?(.+?)\s+in\s+(.+)/i);
    const businessInMatch = trimmed.match(/\b(cafe|restaurant|shop|store|pharmacy|supermarket|dairy\s*shop|book\s*store|fast\s*food|warehouse|clothing\s*store|food\s*court)\s+in\s+(.+)/i);
    const checkFeasibleMatch = trimmed.match(/\b(?:check\s+)?(.+?)\s+feasibility\s+in\s+(.+)/i);
    const isFeasibleMatch = trimmed.match(/\bis\s+(.+?)\s+feasible\s+in\s+(.+)/i);
    const feasibilityForMatch = trimmed.match(/\bfeasibility\s+for\s+(.+?)\s+in\s+(.+)/i);

    let placeText = null;
    let businessType = null;

    if (openBizInMatch && openBizInMatch[1].trim() && openBizInMatch[2].trim()) {
        businessType = openBizInMatch[1].trim();
        placeText = openBizInMatch[2].trim();
    } else if (businessInMatch && businessInMatch[2].trim()) {
        businessType = (businessInMatch[1] || '').replace(/\s+/g, ' ').trim();
        placeText = businessInMatch[2].trim();
    } else if (checkFeasibleMatch && checkFeasibleMatch[1].trim() && checkFeasibleMatch[2].trim()) {
        businessType = checkFeasibleMatch[1].trim();
        placeText = checkFeasibleMatch[2].trim();
    } else if (isFeasibleMatch && isFeasibleMatch[1].trim() && isFeasibleMatch[2].trim()) {
        businessType = isFeasibleMatch[1].trim();
        placeText = isFeasibleMatch[2].trim();
    } else if (feasibilityForMatch && feasibilityForMatch[1].trim() && feasibilityForMatch[2].trim()) {
        businessType = feasibilityForMatch[1].trim();
        placeText = feasibilityForMatch[2].trim();
    }

    if (placeText) {
        runFeasibilityFlow(placeText, businessType);
        return {
            handled: true,
            feedback: `🏢 Checking feasibility for "${businessType || 'business'}" at ${placeText}...`,
            suppressLLM: true,
        };
    }

    // Business-planning flow (no specific business type)
    const openBizMatch = trimmed.match(/\b(?:open|start)\s+(?:a\s+)?business\s+in\s+(.+)/i);
    if (openBizMatch && openBizMatch[1].trim()) {
        const area = openBizMatch[1].trim();
        runBusinessPlanningFlow(area);
        return {
            handled: true,
            feedback: `Great, I'll analyze ${area} and then ask what crowd intensity you want.`,
            suppressLLM: true,
        };
    }

    // Locate user
    if (/\b(find\s+my\s+location|my\s+location|where\s+am\s+i|locate\s+me|get\s+my\s+location|show\s+my\s+location)\b/i.test(lower)) {
        const btn = document.getElementById('find-location-btn');
        if (btn) btn.click();
        return {
            handled: true,
            feedback: '📡 Finding your location on the map...',
            suppressLLM: true,
        };
    }

    // Search location
    let query = null;
    const searchForMatch = trimmed.match(/\bsearch\s+(?:for\s+)?(.+)/i);
    const findMatch = trimmed.match(/\bfind\s+(.+)/i);
    const locateMatch = trimmed.match(/\blocate\s+(.+)/i);
    const showMatch = trimmed.match(/\bshow\s+(?:me\s+)?(.+)/i);
    const goToMatch = trimmed.match(/\bgo\s+to\s+(.+)/i);
    if (searchForMatch && searchForMatch[1].trim()) query = searchForMatch[1].trim();
    else if (findMatch && findMatch[1].trim()) query = findMatch[1].trim();
    else if (locateMatch && locateMatch[1].trim()) query = locateMatch[1].trim();
    else if (showMatch && showMatch[1].trim()) query = showMatch[1].trim();
    else if (goToMatch && goToMatch[1].trim()) query = goToMatch[1].trim();

    if (query && !/\bpopular\s+places\b/i.test(query)) {
        const searchInput = document.getElementById('location-search');
        const searchBtn = document.getElementById('search-btn');
        if (searchInput && searchBtn) {
            searchInput.value = query;
            searchBtn.click();
        }

        return {
            handled: true,
            feedback: `🔎 Searching the map for "${query}"...`,
            suppressLLM: true,
        };
    }

    if (/\b(check\s+feasibility|business\s+feasibility|is\s+it\s+feasible)\b/i.test(lower)) {
        return {
            handled: true,
            feedback: '🏢 Business feasibility commands:\n1) "open cafe in Koramangala"\n2) "check pharmacy feasibility in Indiranagar"\n3) "is restaurant feasible in HSR Layout"',
            suppressLLM: true,
        };
    }

    if (/\b(popular\s+places|find\s+popular|show\s+popular\s+places)\b/i.test(lower)) {
        const popularBtn = document.getElementById('popular-places-btn');
        if (popularBtn) {
            popularBtn.click();
        } else {
            notifyChatFromMap('Popular places is only available on the map page. Go to Home and try again.');
        }
        return {
            handled: true,
            feedback: '📍 Finding popular places on the map...',
            suppressLLM: true,
        };
    }

    if (/\b(minimize\s+map|maximize\s+map|toggle\s+map|hide\s+map|show\s+map)\b/i.test(lower)) {
        const btn = document.getElementById('map-toggle-btn');
        if (btn) btn.click();
        return {
            handled: true,
            feedback: '🗺️ Toggling map view...',
            suppressLLM: true,
        };
    }

    if (/\b(open\s+(?:the\s+)?form|submit\s+business|business\s+form|business\s+info|open\s+business\s+form|fill\s+(?:the\s+)?form|submit\s+(?:my\s+)?business)\b/i.test(lower)) {
        const btn = document.getElementById('form-trigger-btn');
        if (btn) btn.click();
        return {
            handled: true,
            feedback: '📋 Opening business form...',
            suppressLLM: true,
        };
    }

    if (/\b(close\s+(?:the\s+)?form|close\s+business\s+form|hide\s+form)\b/i.test(lower)) {
        const modal = document.getElementById('form-modal');
        if (modal && modal.style.display === 'block') {
            modal.style.display = 'none';
            notifyChatFromMap('✅ Form closed.');
        }
        return {
            handled: true,
            suppressLLM: true,
        };
    }

    return { handled: false };
}

// Friendly conversational responses (instant answers like Gemini & ChatGPT)
function getFriendlyChatResponse(rawQuery) {
    if (!rawQuery || typeof rawQuery !== 'string') return null;
    const clean = rawQuery.trim().toLowerCase().replace(/[^\w\s]/g, '');

    // Name & Identity queries
    if (/\b(what\s+is\s+your\s+name|whats\s+your\s+name|what\s+is\s+ur\s+name|whats\s+ur\s+name|what\s+ur\s+name|your\s+name|ur\s+name|who\s+are\s+you|who\s+r\s+u|tell\s+me\s+your\s+name)\b/i.test(clean)) {
        return "Hey there! 😊 I'm **AI Assistant**, your smart location intelligence co-pilot and business partner! You can chat with me just like a friend. I can help you evaluate crowd density, scout locations, check feasibility, or navigate anywhere on the platform. What's on your mind today?";
    }

    // Greetings
    if (/^(hi|hello|hey|heya|hola|yo|sup|howdy|good\s+morning|good\s+afternoon|good\s+evening)$/i.test(clean) || /^(hi|hello|hey|yo)\b/i.test(clean)) {
        return "Hey! 👋 Great to chat with you! How's your day going? Feel free to ask me anything about the platform, locations, or tell me what business ideas you're exploring!";
    }

    // How are you
    if (/\b(how\s+are\s+you|how\s+r\s+u|how\s+are\s+you\s+doing|hows\s+it\s+going|whats\s+up|how\s+do\s+you\s+do)\b/i.test(clean)) {
        return "I'm doing fantastic, thanks for asking! 😊 Always excited to help you scout great locations and explore business feasibility. How are you doing today?";
    }

    // Be friends
    if (/\b(can\s+we\s+be\s+friends|be\s+my\s+friend|are\s+we\s+friends|lets\s+be\s+friends)\b/i.test(clean)) {
        return "Of course we can! 🤝 I'd love to be your friend and business brainstorming buddy. Tell me, what kind of venture or ideas are you passionate about?";
    }

    // Jokes
    if (/\b(tell\s+me\s+a\s+joke|joke|make\s+me\s+laugh|say\s+something\s+funny)\b/i.test(clean)) {
        return "Why did the coffee shop open next to the gym? Because they knew the customers loved an extra shot of energy! ☕💪 What kind of business would you love to start?";
    }

    // Gratitude
    if (/\b(thank\s+you|thanks|thx|thank\s+u|appreciate\s+it)\b/i.test(clean)) {
        return "You're very welcome! Always happy to help a friend. 😊 Let me know anytime you want to check another spot or view the heatmap!";
    }

    // Affirmations
    if (/^(cool|awesome|nice|great|good|super|amazing|ok|okay|got\s+it)$/i.test(clean)) {
        return "Awesome! 👍 Whenever you're ready, ask me about any area, or let me know if you want to jump to the map, analytics, or reports!";
    }

    // Who created you
    if (/\b(who\s+created\s+you|who\s+made\s+you|who\s+built\s+you|who\s+is\s+your\s+creator)\b/i.test(clean)) {
        return "I was built by the Business Intelligence team using real-time spatial analytics and dual-AI intelligence to make finding profitable business locations effortless! 🧠✨";
    }

    return null;
}

function sendChatMessage() {
    const input = document.getElementById('chatbot-input');
    const message = input.value.trim();
    if (!message) return;

    addChatMessage(message, 'user');
    input.value = '';

    const searchPreview = document.getElementById('chatbot-search-preview');
    if (searchPreview) {
        searchPreview.classList.add('d-none');
        searchPreview.innerHTML = '';
    }

    // If the whole message is wrapped in double quotes, treat the
    // quoted text as an explicit "command string" for the map.
    // Example: "find my location", "popular places", "open form".
    let commandText = message;
    const quotedMatch = message.match(/^\s*"([^"]+)"\s*$/);
    if (quotedMatch && quotedMatch[1].trim()) {
        commandText = quotedMatch[1].trim();
    }

    // If we are in the middle of the AI business planning flow and
    // waiting specifically for the desired crowd intensity, handle that first.
    if (aiBusinessFlowAwaitingIntensity) {
        const handled = handleCrowdIntensityReply(commandText);
        // If a valid intensity was given, we stop here so this message
        // is not also interpreted as a generic chat question.
        if (handled) {
            return;
        }
    }

    // 1. Business feasibility check (e.g. "open cafe in Koramangala")
    const result = handleChatCommand(commandText);
    if (result.handled && result.feedback) {
        notifyChatFromMap(result.feedback);
    }
    if (result.handled && result.suppressLLM) {
        return;
    }

    // 2. Instant Website Features Knowledge Match & Fast Redirect
    const match = findBestSiteFeatureMatch(commandText);
    if (match && match.item) {
        showTypingIndicator();
        setTimeout(() => {
            hideTypingIndicator();
            const actions = [
                {
                    intent: 'navigate_feature',
                    featureKey: match.item.key,
                    label: match.item.actionLabel
                }
            ];
            let responseText = match.item.description;
            if (match.isExplicitNavigation) {
                responseText += `\n\n⚡ *Redirecting to **${match.item.title}** now...*`;
                addChatMessage(responseText, 'bot', actions);
                setTimeout(() => {
                    navigateToFeature(match.item.key);
                }, 350);
            } else {
                addChatMessage(responseText, 'bot', actions);
            }
        }, 80);
        return;
    }

    // 2.5 Friendly Conversational Chat (instant responses like Gemini & ChatGPT)
    const friendlyReply = getFriendlyChatResponse(commandText);
    if (friendlyReply) {
        showTypingIndicator();
        setTimeout(() => {
            hideTypingIndicator();
            addChatMessage(friendlyReply, 'bot');
        }, 70);
        return;
    }

    // 3. Fallback to Dual-AI WebSocket / Backend LLM
    showTypingIndicator();

    const selectedLoc = typeof getSelectedLocation === 'function' ? getSelectedLocation() : null;
    const chatPayload = {
        message: message,
        location: selectedLoc ? {
            lat: selectedLoc.lat,
            lon: selectedLoc.lng || selectedLoc.lon,
            name: selectedLoc.name || selectedLoc.label || ''
        } : null
    };

    if (chatSocket && chatSocket.readyState === WebSocket.OPEN) {
        chatSocket.send(JSON.stringify(chatPayload));
        return;
    }

    // HTTP fallback when WebSocket is not available
    fetch('/chat/', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRFToken': getCookie('csrftoken')
        },
        body: JSON.stringify(chatPayload)
    })
        .then(function (res) { return res.json(); })
        .then(function (data) {
            hideTypingIndicator();
            if (data.success && data.message) {
                addChatMessage(data.message, 'bot', data.structured_actions);
                runAutoChatActions(data.structured_actions);
            } else {
                addChatMessage('Sorry, I could not respond right now. Please try again.', 'bot');
            }
        })
        .catch(function () {
            hideTypingIndicator();
            addChatMessage('Connection error. Please check the server and try again.', 'bot');
        });
}

// Chatbot toggle and close listeners handled in initGlobalFloatingUI

// Global Floating UI Initialization (Chatbot and Form Modal)
function initGlobalFloatingUI() {
    // Form Modal logic
    const formModal = document.getElementById('form-modal');
    const formTriggerBtn = document.getElementById('form-trigger-btn');
    const closeBtn = document.querySelector('.close');

    if (formModal && formTriggerBtn && closeBtn) {
        formTriggerBtn.addEventListener('click', function () {
            const lat = document.getElementById('id_latitude').value;
            const lon = document.getElementById('id_longitude').value;

            if (!lat || !lon) {
                alert('Please select a location on the map first. You can:\n1. Click on the map\n2. Use "Find My Location"\n3. Search for a location');
                notifyChatFromMap('Business form: select a location on the map first (click map, Find My Location, or search), then try "open form" again.');
                return;
            }

            formModal.style.display = 'block';
            const formMessage = document.getElementById('form-message');
            if (formMessage) {
                formMessage.textContent = '';
                formMessage.className = 'form-message';
            }
            notifyChatFromMap('Business form opened. Fill in your details and submit when ready.');
        });

        closeBtn.addEventListener('click', function () {
            formModal.style.display = 'none';
            notifyChatFromMap('✅ Form closed.');
        });

        window.addEventListener('click', function (event) {
            if (event.target === formModal) {
                formModal.style.display = 'none';
                notifyChatFromMap('✅ Form closed.');
            }
        });
    }

    // Chatbot Initialization
    if (document.getElementById('chatbot-messages')) {
        connectChatbot();

        // Add welcome message
        setTimeout(() => {
            addChatMessage("👋 **Hello! I'm your AI Business Intelligence Assistant.**\n\nI can answer questions about any feature on this platform, analyze business feasibility, or instantly take you to any page.\n\n*Try asking:*\n• *\"Take me to the map\"* or *\"Show crowd heatmap\"*\n• *\"Open business analytics\"* or *\"Where are my reports?\"*\n• *\"Is a cafe feasible in Koramangala?\"*", 'bot');
        }, 600);
    }

    // Global Action Button Listeners
    safeOn('chat-toggle-btn', 'click', function () {
        const sidebar = document.getElementById('chatbot-sidebar');
        if (sidebar) {
            sidebar.classList.toggle('chatbot-sidebar-closed');
            sidebar.classList.toggle('chatbot-sidebar-open');
        }
        document.body.classList.toggle('chat-open');
        if (map && typeof map.invalidateSize === 'function') {
            setTimeout(() => map.invalidateSize(), 300);
        }
    });

    safeOn('map-toggle-btn', 'click', function () {
        const toggleBtn = document.getElementById('map-toggle-btn');
        const body = document.body;

        if (mapMinimized) {
            body.classList.remove('map-focus');
            toggleBtn.textContent = 'Focus Map';
            mapMinimized = false;
        } else {
            body.classList.add('map-focus');
            toggleBtn.textContent = 'Show Panels';
            mapMinimized = true;
        }

        // Trigger map resize
        setTimeout(() => {
            map.invalidateSize();
        }, 300);
    });

    safeOn('chatbot-toggle', 'click', function () {
        const chatbotContainer = document.getElementById('chatbot-container');
        const toggleBtn = document.getElementById('chatbot-toggle');

        if (chatbotMinimized) {
            chatbotContainer.classList.remove('minimized');
            toggleBtn.textContent = '-';
            chatbotMinimized = false;
        } else {
            chatbotContainer.classList.add('minimized');
            toggleBtn.textContent = '+';
            chatbotMinimized = true;
        }
    });

    safeOn('chatbot-close-btn', 'click', function () {
        const sidebar = document.getElementById('chatbot-sidebar');
        if (sidebar) {
            sidebar.classList.add('chatbot-sidebar-closed');
            sidebar.classList.remove('chatbot-sidebar-open');
            document.body.classList.remove('chat-open');
        }
    });

    safeOn('chatbot-send', 'click', function () {
        sendChatMessage();
    });

    const chatInput = document.getElementById('chatbot-input');
    if (chatInput) {
        chatInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendChatMessage();
            }
        });
    }

    // Chatbot Live Search Preview as user types
    const searchPreview = document.getElementById('chatbot-search-preview');

    if (chatInput && searchPreview) {
        chatInput.addEventListener('input', debounce(function () {
            const val = this.value.trim().toLowerCase();
            if (val.length < 2) {
                searchPreview.classList.add('d-none');
                searchPreview.innerHTML = '';
                return;
            }

            const matches = [];
            for (const item of SITE_FEATURES_KNOWLEDGE) {
                if (item.title.toLowerCase().includes(val) || 
                    item.key.includes(val) || 
                    item.synonyms.some(s => s.includes(val))) {
                    matches.push(item);
                    if (matches.length >= 4) break;
                }
            }

            if (matches.length === 0) {
                searchPreview.classList.add('d-none');
                searchPreview.innerHTML = '';
                return;
            }

            searchPreview.innerHTML = `
                <div class="search-preview-header">
                    <span><i class="fas fa-bolt text-warning me-1"></i> Quick Jump to Feature</span>
                </div>
                <div class="search-preview-list">
                    ${matches.map(m => `
                        <div class="search-preview-item" data-key="${m.key}">
                            <div class="preview-item-left">
                                <i class="${m.icon} preview-icon"></i>
                                <div>
                                    <div class="preview-title">${m.title}</div>
                                    <div class="preview-category">${m.category}</div>
                                </div>
                            </div>
                            <span class="preview-jump-btn">Go &rarr;</span>
                        </div>
                    `).join('')}
                </div>
            `;
            searchPreview.classList.remove('d-none');
        }, 60));

        searchPreview.addEventListener('click', function (e) {
            const item = e.target.closest('.search-preview-item');
            if (item) {
                const key = item.getAttribute('data-key');
                searchPreview.classList.add('d-none');
                searchPreview.innerHTML = '';
                chatInput.value = '';
                navigateToFeature(key);
            }
        });

        // Hide preview on outside click
        document.addEventListener('click', function (e) {
            if (!chatInput.contains(e.target) && !searchPreview.contains(e.target)) {
                searchPreview.classList.add('d-none');
            }
        });
    }
}

function renderChatbotSuggestions(suggestions) {
    // Quick-action chips removed per user request. Kept empty for backwards compatibility.
    const container = document.getElementById('chatbot-suggestions-container');
    if (container) container.innerHTML = '';
}

// --- Autocomplete for form location field ---
const formLocationInput = document.getElementById('form-location-search');
const formLocationSuggestions = document.getElementById('form-location-suggestions');

if (formLocationInput && formLocationSuggestions) {
    formLocationInput.addEventListener('input', debounce(function () {
        fetchAutocompleteSuggestions(this.value.trim(), formLocationSuggestions);
    }, 300));

    formLocationSuggestions.addEventListener('click', function (e) {
        const item = e.target.closest('.suggestion-item');
        if (!item) return;
    });

    // Reuse fetchAutocompleteSuggestions but customize click handling
    async function updateFormSuggestions(query) {
        if (!query || query.length < 3) {
            formLocationSuggestions.innerHTML = '';
            formLocationSuggestions.style.display = 'none';
            return;
        }

        try {
            const response = await fetch('/autocomplete-location/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': getCookie('csrftoken')
                },
                body: JSON.stringify({ query })
            });

            const data = await response.json();
            if (!data.success) {
                formLocationSuggestions.innerHTML = '';
                formLocationSuggestions.style.display = 'none';
                return;
            }

            const results = data.results || [];
            if (!results.length) {
                formLocationSuggestions.innerHTML = '';
                formLocationSuggestions.style.display = 'none';
                return;
            }

            formLocationSuggestions.innerHTML = '';
            results.forEach(result => {
                const item = document.createElement('div');
                item.className = 'suggestion-item';
                item.textContent = result.display_name;
                item.addEventListener('click', async () => {
                    const lat = parseFloat(result.lat);
                    const lon = parseFloat(result.lon);

                    formLocationInput.value = result.display_name;
                    formLocationSuggestions.innerHTML = '';
                    formLocationSuggestions.style.display = 'none';

                    // Center map and update marker/coords
                    map.setView([lat, lon], 15);
                    if (userMarker) {
                        map.removeLayer(userMarker);
                    }
                    userMarker = L.marker([lat, lon]).addTo(map)
                        .bindPopup('Business Location').openPopup();

                    document.getElementById('id_latitude').value = lat;
                    document.getElementById('id_longitude').value = lon;
                    updateAccuracyMeter(85);

                    // Show loading state in business type dropdown
                    if (businessTypeSelect) {
                        businessTypeSelect.innerHTML = '<option value="">Loading business types...</option>';
                        businessTypeSelect.disabled = true;
                    }
                    const hint = document.getElementById('form-flow-hint');
                    if (hint) {
                        hint.textContent = 'Analyzing crowd intensity for this location...';
                        hint.style.color = '#aaa';
                    }

                    await findPopularPlaces(lat, lon, false);
                    notifyChatFromMap('Business location in form set to: ' + result.display_name);
                });
                formLocationSuggestions.appendChild(item);
            });
            formLocationSuggestions.style.display = 'block';
        } catch (err) {
            console.error('Form autocomplete error:', err);
            formLocationSuggestions.innerHTML = '';
            formLocationSuggestions.style.display = 'none';
        }
    }

    formLocationInput.addEventListener('input', debounce(function () {
        updateFormSuggestions(this.value.trim());
    }, 300));

    document.addEventListener('click', function (e) {
        if (!formLocationSuggestions.contains(e.target) && e.target !== formLocationInput) {
            formLocationSuggestions.innerHTML = '';
            formLocationSuggestions.style.display = 'none';
        }
    });
}

// Legacy form submit handler removed; dashboard/form submission is handled in initDashboardFloatingUI().

// Select search result location
async function selectSearchResult(lat, lon, name = 'Selected Location', businessType = '') {
    // Ensure coordinates are numbers
    const flat = parseFloat(lat);
    const flon = parseFloat(lon);

    if (isNaN(flat) || isNaN(flon)) {
        console.error('Invalid coordinates for tracking:', lat, lon);
        return;
    }

    // If no map is present (e.g., business recommendations page),
    // persist selection and move to dashboard AI flow.
    if (!map || typeof map.getCenter !== 'function') {
        saveSelectedLocation(flat, flon, name || 'Selected Location', businessType || '');
        window.location.href = '/dashboard/?ai=true';
        return;
    }

    // Route only from a nearby previous marker (a "how do I get there" route). Routing from
    // wherever the map happened to be (another city) re-fitted the map away from the analysis.
    const startLatLng = userMarker ? userMarker.getLatLng() : null;

    setAnalysisLocation(flat, flon, name || 'Selected Location');

    if (userMarker) {
        map.removeLayer(userMarker);
    }

    // Add tracking marker (Violet color - highly visible)
    userMarker = L.marker([flat, flon], {
        icon: L.icon({
            iconUrl: 'https://cdn.jsdelivr.net/gh/pointhi/leaflet-color-markers@master/img/marker-icon-violet.png',
            shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
            iconSize: [25, 41],
            iconAnchor: [12, 41],
            popupAnchor: [1, -34],
            shadowSize: [41, 41]
        }),
        zIndexOffset: 1000
    }).addTo(map)
        .bindPopup(`<b>${escapeHtml(name)}</b><br>Coordinates: ${flat.toFixed(4)}, ${flon.toFixed(4)}<br><small class="text-primary"><i class="fas fa-radar"></i> 5 km analysis radius</small>`).openPopup();

    drawAnalysisRadius(flat, flon, { fit: false });
    zoomToPin(flat, flon);
    if (startLatLng && distanceMeters(startLatLng.lat, startLatLng.lng, flat, flon) <= 25000) {
        calculateRoute(startLatLng.lat, startLatLng.lng, flat, flon, name);
    } else if (routingControl) {
        try { map.removeControl(routingControl); } catch (_e) {}
        routingControl = null;
    }

    updateAccuracyMeter(90);
    await findPopularPlaces(flat, flon, false, { name: name || 'Selected Location' });
    await analyzeLocationIntelligence(flat, flon, name || 'Selected Location');
}

/**
 * Calculate shortest path using Leaflet Routing Machine (Dijkstra based)
 */
function calculateRoute(startLat, startLon, endLat, endLon, destinationName = 'Destination') {
    if (typeof L.Routing === 'undefined') {
        console.error('Routing machine not loaded.');
        return;
    }

    // Remove previous route
    if (routingControl) {
        map.removeControl(routingControl);
        routingControl = null;
    }

    try {
        routingControl = L.Routing.control({
            waypoints: [
                L.latLng(startLat, startLon),
                L.latLng(endLat, endLon)
            ],
            lineOptions: {
                styles: [{ color: '#7c3aed', opacity: 0.8, weight: 6 }]
            },
            createMarker: function () { return null; }, // We use our own markers
            addWaypoints: false,
            draggableWaypoints: false,
            fitSelectedRoutes: false,  // keep the map on the 5 km analysis circle
            showAlternatives: false,
            // Custom instructions provider
            router: L.Routing.osrmv1({
                serviceUrl: 'https://router.project-osrm.org/trip/v1/driving/' // Dijkstra backend
            })
        }).on('routesfound', function (e) {
            const routes = e.routes;
            const summary = routes[0].summary;

            // Convert time to reach (seconds to mins)
            const timeMins = Math.round(summary.totalTime / 60);
            const distKm = (summary.totalDistance / 1000).toFixed(2);

            const arrivalText = `Travel time: ~${timeMins} min (${distKm} km)`;

            if (userMarker) {
                userMarker.getPopup().setContent(`<b>${escapeHtml(destinationName)}</b><br>${arrivalText}`);
            }

            notifyChatFromMap(`Route calculated to ${destinationName}. ${arrivalText}`);
        }).addTo(map);

    } catch (err) {
        console.error('Routing error:', err);
    }
}

// Get CSRF Token
function getCookie(name) {
    let cookieValue = null;
    if (document.cookie && document.cookie !== '') {
        const cookies = document.cookie.split(';');
        for (let i = 0; i < cookies.length; i++) {
            const cookie = cookies[i].trim();
            if (cookie.substring(0, name.length + 1) === (name + '=')) {
                cookieValue = decodeURIComponent(cookie.substring(name.length + 1));
                break;
            }
        }
    }
    return cookieValue;
}

// Initialize chatbot connection (handled in initGlobalFloatingUI)

// Helper: highlight areas for a chosen intensity with brown markers
function highlightBusinessAreasForIntensity(level) {
    const key = (level || '').toLowerCase();
    const areas = (lastCrowdIntensityData && lastCrowdIntensityData[key]) || [];

    // Clear previous recommendation markers
    businessRecommendationMarkers.forEach(m => map.removeLayer(m));
    businessRecommendationMarkers = [];

    if (!areas.length) {
        addChatMessage('I could not find any analysed zones for that intensity near the selected location.', 'bot');
        return;
    }

    const color = '#8B4513';   // brown

    areas.slice(0, 10).forEach(area => {
        if (typeof area.latitude !== 'number' || typeof area.longitude !== 'number') return;
        const marker = L.circleMarker([area.latitude, area.longitude], {
            radius: 10,
            color,
            fillColor: color,
            fillOpacity: 0.9,
            weight: 3
        }).addTo(map)
            .bindPopup(`<b>Recommended zone (${key} crowd)</b><br>${area.count || 0} nearby points of interest.`);
        businessRecommendationMarkers.push(marker);
    });

    addChatMessage(
        `I’ve highlighted recommended zones for ${key} crowd with brown markers on the map. Zoom in to explore specific spots.`,
        'bot'
    );
}

// Handle the user replying with their desired crowd intensity
function handleCrowdIntensityReply(message) {
    const lower = message.toLowerCase();
    const match = lower.match(/\b(high|medium|low)\b/);
    if (!match) {
        addChatMessage('Please tell me which crowd intensity you prefer: "high", "medium", or "low".', 'bot');
        return false;
    }

    const level = match[1];
    aiBusinessFlowAwaitingIntensity = false;

    const locText = aiBusinessFlowLocationDesc || 'this area';
    addChatMessage(
        `Got it — you want to attract a ${level} crowd around ${locText}. I’ll highlight the best zones on the map.`,
        'bot'
    );
    highlightBusinessAreasForIntensity(level);
    return true;
}

// Run the multi-step business-planning flow for a given area name
async function runBusinessPlanningFlow(areaText) {
    try {
        addChatMessage(
            `Looking up ${areaText} in Bangalore and analysing nearby places for your business…`,
            'bot'
        );

        const response = await fetch('/search-location/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCookie('csrftoken')
            },
            body: JSON.stringify({ query: `${areaText}, Bangalore` })
        });

        const data = await response.json();
        const results = (data && data.results) || [];

        if (!data.success || !results.length) {
            addChatMessage(
                `I could not find a clear location for "${areaText}". Try mentioning a well-known area or district in Bangalore.`,
                'bot'
            );
            return;
        }

        const first = results[0];
        const lat = parseFloat(first.lat);
        const lon = parseFloat(first.lon);

        if (Number.isNaN(lat) || Number.isNaN(lon)) {
            addChatMessage(
                `The location I found for "${areaText}" does not have valid coordinates. Please try another nearby area.`,
                'bot'
            );
            return;
        }

        // Center map and mark this as the planning anchor location
        map.setView([lat, lon], 15);
        if (userMarker) {
            map.removeLayer(userMarker);
        }
        userMarker = L.marker([lat, lon]).addTo(map)
            .bindPopup(first.display_name || 'Selected Location').openPopup();

        document.getElementById('id_latitude').value = lat;
        document.getElementById('id_longitude').value = lon;
        updateAccuracyMeter(85);

        // Step 2: discover popular places and run intensity analysis
        await findPopularPlaces(lat, lon, false);

        aiBusinessFlowLocationDesc = first.display_name || areaText;
        aiBusinessFlowAwaitingIntensity = true;

        // Step 3: ask for desired crowd intensity
        addChatMessage(
            `Around ${aiBusinessFlowLocationDesc}, what kind of crowd intensity do you want to attract for your business? Type "high", "medium", or "low".`,
            'bot'
        );
    } catch (err) {
        console.error('Business planning flow error:', err);
        addChatMessage(
            'Something went wrong while analysing that area. Please try again or pick a slightly different location.',
            'bot'
        );
    }
}

// --- Recommended business select (driven by ML/CSV prediction) ---
// (Variables declared at the top of the file)

// Initialize business type elements after DOM is ready
function initBusinessTypeElements() {
    businessTypeInput = document.getElementById('id_business_type');
    businessTypeSelect = document.getElementById('id_business_type_select'); // hidden compat
    recommendedBusinessHidden = document.getElementById('id_recommended_business');

    const searchInput = document.getElementById('id_business_type_search');
    const suggestionsBox = document.getElementById('business-type-suggestions');

    if (searchInput && suggestionsBox) {
        // Sync visible input → hidden field on every keystroke
        searchInput.addEventListener('input', function () {
            const val = this.value.trim();
            if (businessTypeInput) businessTypeInput.value = val;
            filterBusinessSuggestions(val, searchInput, suggestionsBox);
        });

        searchInput.addEventListener('focus', function () {
            if (_allBusinessCategories.length > 0 && !this.value.trim()) {
                filterBusinessSuggestions('', searchInput, suggestionsBox);
            }
        });

        // Hide suggestions when clicking outside
        document.addEventListener('click', function (e) {
            if (!suggestionsBox.contains(e.target) && e.target !== searchInput) {
                suggestionsBox.style.display = 'none';
            }
        });
    }

    // Pre-submit: sync visible input to hidden field if user typed without selecting
    const form = document.getElementById('business-form');
    if (form && searchInput && businessTypeInput) {
        form.addEventListener('submit', function () {
            if (!businessTypeInput.value && searchInput.value.trim()) {
                businessTypeInput.value = searchInput.value.trim();
            }
        }, true); // capture phase so it runs before our main submit handler
    }
}

// Filter and display business type suggestions
function filterBusinessSuggestions(query, inputEl, suggestionsBox) {
    if (!_allBusinessCategories.length) {
        suggestionsBox.style.display = 'none';
        return;
    }

    const lower = query.toLowerCase();
    const filtered = query
        ? _allBusinessCategories.filter(cat => cat.toLowerCase().includes(lower))
        : _allBusinessCategories;

    if (!filtered.length) {
        suggestionsBox.style.display = 'none';
        return;
    }

    suggestionsBox.innerHTML = '';
    filtered.slice(0, 20).forEach(cat => {
        const item = document.createElement('div');
        item.className = 'suggestion-item';
        // Highlight matching part
        if (query) {
            const idx = cat.toLowerCase().indexOf(lower);
            item.innerHTML = cat.slice(0, idx)
                + '<strong style="color:#4CAF50">' + cat.slice(idx, idx + query.length) + '</strong>'
                + cat.slice(idx + query.length);
        } else {
            item.textContent = cat;
        }
        item.addEventListener('mousedown', function (e) {
            e.preventDefault(); // prevent blur before click fires
            inputEl.value = cat;
            suggestionsBox.style.display = 'none';
            // Update hidden inputs for form submission
            const hiddenInput = document.getElementById('id_business_type');
            if (hiddenInput) hiddenInput.value = cat;
            const hiddenSelect = document.getElementById('id_business_type_select');
            if (hiddenSelect) hiddenSelect.value = cat;
            if (recommendedBusinessHidden) recommendedBusinessHidden.value = cat;
            const lat = parseFloat(document.getElementById('id_latitude')?.value || '');
            const lon = parseFloat(document.getElementById('id_longitude')?.value || '');
            if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
                getFeasibilityWithCache(lat, lon, cat).catch(() => { });
            }
        });
        suggestionsBox.appendChild(item);
    });
    suggestionsBox.style.display = 'block';
}

// Initialize elements when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBusinessTypeElements);
} else {
    initBusinessTypeElements();
}

function normalizeBusinessLabel(raw) {
    if (!raw) return '';
    const formatted = String(raw).replace(/_/g, ' ').trim();
    if (!formatted) return '';
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

// Cache for business_by_intensity from backend
let _businessByIntensityCache = null;

function updateBusinessTypeOptionsFromPrediction(prediction, businessByIntensity) {
    const searchInput = document.getElementById('id_business_type_search');
    const suggestionsBox = document.getElementById('business-type-suggestions');

    // Cache the full mapping if provided
    if (businessByIntensity && typeof businessByIntensity === 'object') {
        _businessByIntensityCache = businessByIntensity;
    }

    // Reset categories
    _allBusinessCategories = [];

    // If no prediction, disable search and reset
    if (!prediction) {
        if (searchInput) {
            searchInput.value = '';
            searchInput.placeholder = 'Search a location first to load types...';
            searchInput.disabled = true;
        }
        if (suggestionsBox) suggestionsBox.style.display = 'none';
        const hiddenInput = document.getElementById('id_business_type');
        if (hiddenInput) hiddenInput.value = '';
        return;
    }

    // Determine dominant intensity from prediction
    let dominant = 'high';
    if (prediction && typeof prediction === 'object' && prediction.intensity) {
        dominant = prediction.intensity;
    }

    // Use full business_by_intensity map (from cache or from prediction.choices fallback)
    const intensityMap = _businessByIntensityCache || {};

    // Intensity group config: dominant first, then others
    const intensityConfig = {
        high: { emoji: '', label: 'High Crowd' },
        medium: { emoji: '', label: 'Medium Crowd' },
        low: { emoji: '', label: 'Low Crowd' },
    };

    // Order: dominant first, then the rest
    const order = [dominant, ...['high', 'medium', 'low'].filter(i => i !== dominant)];

    // Collect all categories (dominant first, then others)
    const seen = new Set();
    order.forEach(intensity => {
        const businesses = intensityMap[intensity] || [];
        businesses.forEach(name => {
            const label = normalizeBusinessLabel(name);
            if (label && !seen.has(label)) {
                seen.add(label);
                _allBusinessCategories.push(label);
            }
        });
    });

    // Fallback: if no grouped data, use prediction.choices flat list
    if (_allBusinessCategories.length === 0 && prediction) {
        const fallbackChoices = new Set();
        if (typeof prediction === 'string') {
            fallbackChoices.add(prediction);
        } else {
            if (prediction.primary) fallbackChoices.add(prediction.primary);
            (prediction.alternatives || []).forEach(alt => { if (alt && alt.business) fallbackChoices.add(alt.business); });
            (prediction.choices || []).forEach(name => { if (name) fallbackChoices.add(name); });
        }
        fallbackChoices.forEach(name => {
            const label = normalizeBusinessLabel(name);
            if (label) _allBusinessCategories.push(label);
        });
    }

    const totalAdded = _allBusinessCategories.length;
    const cfg = intensityConfig[dominant] || {};

    // Enable and update the search input
    if (searchInput) {
        searchInput.disabled = totalAdded === 0;
        searchInput.value = '';
        searchInput.placeholder = totalAdded > 0
            ? `Type to search ${totalAdded} business types...`
            : 'No business types available';
    }

    // Update hint text
    const hint = document.getElementById('form-flow-hint');
    if (hint && totalAdded > 0) {
        hint.textContent = `${totalAdded} business types loaded - ${cfg.label || dominant} area. Start typing to search.`;
        hint.style.color = dominant === 'high' ? '#dc2626' : dominant === 'medium' ? '#ca8a04' : '#16a34a';
    }
}

// --- Building outlines for dark mode ---
function clearBuildingOutlines() {
    if (!buildingOutlineLayers.length) return;
    buildingOutlineLayers.forEach(layer => map.removeLayer(layer));
    buildingOutlineLayers = [];
}

async function updateBuildingOutlines(lat, lon) {
    const currentTheme = localStorage.getItem('theme') || 'dark';

    // Only draw building outlines in dark mode
    if (currentTheme === 'light') {
        clearBuildingOutlines();
        return;
    }

    clearBuildingOutlines();

    const query = `
        [out:json][timeout:10][maxsize:16777216];
        (
          way["building"](around:400,${lat},${lon});
        );
        (._;>;);
        out body;
    `;

    try {
        const body = new URLSearchParams();
        body.append('data', query);

        // Decorative only: bounded and abortable, and never awaited by the crowd analysis
        // (awaiting it used to keep Popular Locations "Scanning…" for minutes).
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            body,
            signal: controller.signal
        }).finally(() => clearTimeout(timer));
        if (!res.ok) return;

        const data = await res.json();
        const elements = data.elements || [];

        const nodeIndex = {};
        elements.forEach(el => {
            if (el.type === 'node' && typeof el.lat === 'number' && typeof el.lon === 'number') {
                nodeIndex[el.id] = [el.lat, el.lon];
            }
        });

        let drawn = 0;
        const MAX_BUILDINGS = 200; // safeguard for performance

        elements.forEach(el => {
            if (drawn >= MAX_BUILDINGS) return;
            if (el.type !== 'way' || !Array.isArray(el.nodes)) return;

            const coords = el.nodes
                .map(nodeId => nodeIndex[nodeId])
                .filter(Boolean);

            if (coords.length < 3) return;

            const poly = L.polygon(coords, {
                color: '#475569',
                weight: 0.8,
                opacity: 0.7,
                fill: false
            }).addTo(map);

            buildingOutlineLayers.push(poly);
            drawn += 1;
        });
    } catch (err) {
        console.error('Building outline fetch error:', err);
    }
}

// Update crowd intensity dropdown based on location
const CROWD_LEVEL_STYLE = {
    high: { color: '#b91c1c', fill: '#ef4444', radius: 750, label: 'High', note: 'Dense commercial activity – prime footfall' },
    medium: { color: '#b45309', fill: '#f59e0b', radius: 600, label: 'Medium', note: 'Steady consumer activity, balanced competition' },
    low: { color: '#15803d', fill: '#22c55e', radius: 450, label: 'Low', note: 'Quieter or developing area, lower competition' },
};

/** Sector areas of the analysis on the map for one level ('high' | 'medium' | 'low'). */
function getCrowdAreas(level) {
    return (lastCrowdIntensityData && lastCrowdIntensityData[level]) || [];
}

function clearCrowdLayers(activeMap) {
    if (!activeMap) return;
    crowdIntensityAreas.forEach(layer => { try { activeMap.removeLayer(layer); } catch (_e) {} });
    heatmapLayers.forEach(layer => { try { activeMap.removeLayer(layer); } catch (_e) {} });
    crowdIntensityAreas = [];
    heatmapLayers = [];
}

function resetCrowdDropdown(dropdown) {
    if (!dropdown) return;
    dropdown.innerHTML = `
        <option value="">Select crowd intensity</option>
        <option value="high">High - High intensity crowded area</option>
        <option value="medium">Moderate (medium crowd)</option>
        <option value="low">Low (low crowd)</option>`;
    dropdown.disabled = false;
}

function drawCrowdSectors(activeMap, lat, lon, data) {
    ['high', 'medium', 'low'].forEach(level => {
        const style = CROWD_LEVEL_STYLE[level];
        (data[`${level}_intensity`] || []).forEach(area => {
            if (distanceMeters(lat, lon, area.latitude, area.longitude) > ANALYSIS_RADIUS_M) return;
            const density = area.density_per_km2 != null ? ` · ${area.density_per_km2}/km²` : '';
            const popup = `
                <div style="font-family: system-ui, -apple-system, sans-serif; min-width: 180px;">
                    <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
                        <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${style.fill};"></span>
                        <strong style="color:${style.color}; font-size:0.9rem;">${style.label} Activity Sector</strong>
                    </div>
                    <div style="font-size:0.8rem; color:#475569; margin-bottom:4px;"><strong>${Number(area.count)}</strong> mapped places${density}</div>
                    <div style="font-size:0.75rem; color:#64748b;">${style.note}</div>
                </div>`;
            const circle = L.circle([area.latitude, area.longitude], {
                radius: style.radius, color: style.color, fillColor: style.fill, fillOpacity: 0.3, weight: 2,
            }).addTo(activeMap).bindPopup(popup);
            heatmapLayers.push(circle);
            const dot = L.circleMarker([area.latitude, area.longitude], {
                radius: 6, color: style.color, fillColor: style.fill, fillOpacity: 1, weight: 2,
            }).addTo(activeMap).bindPopup(popup);
            crowdIntensityAreas.push(dot);
        });
    });
}

/**
 * Crowd heatmap for (lat, lon). With `preloadedData` (from /find-popular-places/)
 * nothing is fetched. Resolves to {success, lat, lon} for that exact location,
 * or {success:false, error|superseded} – callers (e.g. the report) can wait on it.
 */
async function updateCrowdIntensityDropdown(lat, lon, preloadedData = null) {
    lat = Number(lat);
    lon = Number(lon);
    const dropdown = document.getElementById('id_crowd_intensity') || document.getElementById('dashboard-id_crowd_intensity');
    const activeMap = activeMapInstance();
    let data = preloadedData;
    let seq = analysisSeq;

    if (!data) {
        const h = window.lastHeatmapAnalysis;
        if (h && sameSpot(h, { lat, lng: lon }) && Date.now() - h.ts < 120000) {
            return { success: true, lat, lon, cached: true };
        }
        if (!currentAnalysisLocation || !sameSpot(currentAnalysisLocation, { lat, lng: lon })) {
            setAnalysisLocation(lat, lon, 'Selected Location');
        }
        seq = ++analysisSeq;
        if (dropdown) {
            dropdown.innerHTML = '<option value="">Analyzing crowd intensity...</option>';
            dropdown.disabled = true;
        }
        if (activeMap) drawAnalysisRadius(lat, lon, { fit: true });
        setMapStatus('Analysing crowd intensity in 5 km…');
        const result = await postAreaAnalysis('/analyze-crowd-intensity/', { latitude: lat, longitude: lon, name: currentAnalysisLocation?.name }, {
            onProgress: (secs, pending) => {
                if (seq === analysisSeq) setMapStatus(pending ? `OpenStreetMap is busy – still fetching (${secs}s)…` : `Analysing crowd intensity (${secs}s)…`);
            },
        });
        if (seq !== analysisSeq) return { success: false, superseded: true };
        data = result.ok ? result.data : { success: false, error: (result.data && result.data.error) || 'Unable to analyse crowd intensity.' };
    }
    if (seq !== analysisSeq) return { success: false, superseded: true };
    if (data && data.center && !sameSpot(data.center, { lat, lng: lon }, 5)) return { success: false, superseded: true };

    if (!data || data.success === false) {
        clearCrowdLayers(activeMap);
        lastCrowdIntensityData = { high: [], medium: [], low: [] };
        document.getElementById('business-suggestion-card')?.style.setProperty('display', 'none');
        updateBusinessTypeOptionsFromPrediction(null);
        resetCrowdDropdown(dropdown);
        const err = (data && data.error) || 'Crowd analysis failed.';
        setMapStatus(err, { kind: 'error', retry: () => findPopularPlaces(lat, lon, true) });
        return { success: false, error: err };
    }

    clearCrowdLayers(activeMap);
    if (activeMap && !popularPlacesPanelRequested) clearPopularPlaceMarkers(activeMap);

    // Recommendations for the AI tab and the business-type form options
    const pred = data.business_prediction;
    let recommendations = [];
    if (pred) {
        if (typeof pred === 'string') {
            recommendations.push(pred);
        } else {
            if (pred.primary) recommendations.push(pred.primary);
            (pred.alternatives || []).forEach(alt => recommendations.push(alt.business || alt));
            (pred.choices || []).forEach(c => recommendations.push(c));
        }
    }
    recommendations = [...new Set(recommendations.map(r => {
        const s = String(r).replace(/_/g, ' ').trim();
        return s.charAt(0).toUpperCase() + s.slice(1);
    }))].filter(Boolean).slice(0, 5);

    const allowBusinessIntelUI = isBusinessRecommendationsMode();
    const suggestionContent = document.getElementById('business-suggestion-content');
    if (allowBusinessIntelUI && suggestionContent && recommendations.length) {
        suggestionContent.innerHTML = '<h5 class="mb-3 text-info"><i class="fas fa-robot me-2"></i>Model recommendations for this area</h5><div class="list-group">'
            + recommendations.map((rec, idx) => `
                <div class="list-group-item d-flex justify-content-between align-items-center bg-dark text-light border-secondary">
                    <div><span class="badge bg-primary rounded-pill me-2">${idx + 1}</span><strong>${escapeHtml(rec)}</strong></div>
                </div>`).join('')
            + '</div><p class="mt-3 small text-muted">From the ML model, using this area\'s crowd level and mapped places.</p>';
        const suggestionCard = document.getElementById('business-suggestion-card');
        if (suggestionCard) { suggestionCard.style.display = 'block'; suggestionCard.classList.remove('d-none'); }
    }
    updateBusinessTypeOptionsFromPrediction(pred, data.business_by_intensity);
    if (data.business_by_intensity && typeof data.business_by_intensity === 'object') {
        businessByIntensity = data.business_by_intensity;
    }
    const box = document.getElementById('mlPrediction');
    if (box) box.style.display = 'none';

    if (allowBusinessIntelUI && lastPopularPlacesResult.places.length && sameSpot({ lat: lastPopularPlacesResult.lat, lng: lastPopularPlacesResult.lon }, { lat, lng: lon })) {
        renderPopularPlacesTable(lastPopularPlacesResult.places, lat, lon);
    }

    // Cached for the report and the chatbot: which location the map shows now.
    window.lastHeatmapAnalysis = {
        lat, lon,
        name: currentAnalysisLocation && sameSpot(currentAnalysisLocation, { lat, lng: lon }) ? currentAnalysisLocation.name : 'Selected Location',
        counts: {
            high: (data.high_intensity || []).length,
            medium: (data.medium_intensity || []).length,
            low: (data.low_intensity || []).length,
        },
        radius_m: data.analysis_radius || ANALYSIS_RADIUS_M,
        ts: Date.now(),
    };
    lastCrowdIntensityData = { high: data.high_intensity || [], medium: data.medium_intensity || [], low: data.low_intensity || [] };

    if (activeMap && typeof L !== 'undefined') drawCrowdSectors(activeMap, lat, lon, data);
    renderAreaFooter(data);

    if (dropdown) {
        dropdown.innerHTML = '<option value="">Select crowd intensity</option>';
        const labels = { high: 'High - High intensity crowded area', medium: 'Moderate (medium crowd)', low: 'Low (low crowd)' };
        ['high', 'medium', 'low'].forEach(level => {
            const n = (data[`${level}_intensity`] || []).length;
            if (!n) return;
            const option = document.createElement('option');
            option.value = level;
            option.textContent = `${labels[level]} – ${n} sector${n === 1 ? '' : 's'}`;
            dropdown.appendChild(option);
        });
        if (dropdown.options.length === 1) resetCrowdDropdown(dropdown);
        dropdown.disabled = false;
    }
    if (data.no_data) setMapStatus('No mapped places were found within 5 km of this point.', { kind: 'warning' });
    return { success: true, lat, lon };
}

// Welcome message handled in initGlobalFloatingUI

// Dark/Light Mode Toggle
function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    const body = document.body;
    const themeIcon = document.getElementById('theme-icon');
    if (themeIcon) {
        if (savedTheme === 'light') {
            body.classList.add('light-mode');
            themeIcon.textContent = 'â˜€ï¸';
        } else {
            body.classList.remove('light-mode');
            themeIcon.textContent = '🌙';
        }
    }
    if (isHeatmapPage() && map) updateMapTiles(savedTheme);
}

function toggleTheme() {
    const body = document.body;
    const themeIcon = document.getElementById('theme-icon');
    if (!themeIcon) return;
    const isLightMode = body.classList.contains('light-mode');
    if (isLightMode) {
        body.classList.remove('light-mode');
        localStorage.setItem('theme', 'dark');
        themeIcon.textContent = '🌙';
        if (isHeatmapPage() && map) updateMapTiles('dark');
    } else {
        body.classList.add('light-mode');
        localStorage.setItem('theme', 'light');
        themeIcon.textContent = 'â˜€ï¸';
        if (isHeatmapPage() && map) updateMapTiles('light');
    }
}

function updateMapTiles(_theme) {
    // The site uses the full-colour map in both colour modes.
    if (!isHeatmapPage() || !map || typeof L === 'undefined') return;
    if (baseTileLayer) map.removeLayer(baseTileLayer);
    baseTileLayer = addBaseLayers(map);
}

// Initialize theme on page load
initTheme();

// Theme toggle button event listener
safeOn('theme-toggle-btn', 'click', toggleTheme);

// --- Universal Enhancements ---

// 1. Smooth scroll for anchor links (e.g. .hero-cta, a[href^="#"])
document.addEventListener('click', function (e) {
    const link = e.target.closest('a[href^="#"]');
    if (!link) return;
    const id = link.getAttribute('href');
    if (id === '#') return;
    const target = document.querySelector(id);
    if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth' });
    }
});

// 2. Sidebar toggle for mobile (dashboard)
safeOn('sidebar-toggle-btn', 'click', function () {
    const sidebar = document.querySelector('.dashboard-sidebar');
    const wrapper = document.querySelector('.dashboard-wrapper');
    if (sidebar && wrapper) {
        sidebar.classList.toggle('sidebar-open');
        wrapper.classList.toggle('sidebar-overlay-active');
    }
});

// Close sidebar when clicking overlay or link (mobile)
document.addEventListener('click', function (e) {
    const wrapper = document.querySelector('.dashboard-wrapper');
    const sidebar = document.querySelector('.dashboard-sidebar');
    if (!wrapper || !sidebar) return;
    if (wrapper.classList.contains('sidebar-overlay-active') &&
        !sidebar.contains(e.target) && !e.target.closest('#sidebar-toggle-btn')) {
        sidebar.classList.remove('sidebar-open');
        wrapper.classList.remove('sidebar-overlay-active');
    }
});

// 3. WebSocket connection placeholder (for future real-time updates)
const WebSocketService = {
    socket: null,
    url: null,
    reconnectAttempts: 0,
    maxReconnectAttempts: 5,
    onMessage: null,
    connect: function (url) {
        this.url = url;
        // Placeholder: connect when WebSocket backend is ready
        // this.socket = new WebSocket(url);
        // this.socket.onmessage = (e) => this.onMessage && this.onMessage(JSON.parse(e.data));
        // this.socket.onclose = () => this._reconnect();
    },
    disconnect: function () {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
    },
    send: function (data) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(typeof data === 'string' ? data : JSON.stringify(data));
        }
    },
    _reconnect: function () {
        if (this.reconnectAttempts < this.maxReconnectAttempts && this.url) {
            this.reconnectAttempts++;
            setTimeout(() => this.connect(this.url), 1000 * this.reconnectAttempts);
        }
    }
};

// 4. Heatmap container init - already defined above as initHeatmapContainer()

// 5. Animated number counter for dashboard cards
function animateCounter(el, targetValue, duration) {
    if (!el) return;
    const start = 0;
    const startTime = performance.now();
    const numericTarget = parseInt(String(targetValue).replace(/\D/g, ''), 10);
    const hasCommas = String(targetValue).includes(',');
    const fmt = (n) => hasCommas ? n.toLocaleString() : String(n);

    function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easeOut = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(start + (numericTarget - start) * easeOut);
        el.textContent = fmt(current);
        if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

function initDashboardCounters() {
    document.querySelectorAll('.dashboard-card-value').forEach(function (el) {
        const text = el.textContent.trim();
        if (!text) return;
        el.setAttribute('data-target', text);
        el.textContent = '0';
        animateCounter(el, text, 1200);
    });
}

if (document.querySelector('.dashboard-card-value')) {
    initDashboardCounters();
}
// Explore Mode Toggle (Cinematic View)
document.addEventListener('DOMContentLoaded', () => {
    const exploreBtn = document.getElementById('explore-mode-toggle');
    if (exploreBtn) {
        exploreBtn.addEventListener('click', () => {
            const isCinematic = document.body.classList.toggle('cinematic-mode');
            exploreBtn.classList.toggle('active', isCinematic);
            const icon = exploreBtn.querySelector('i');
            if (icon) {
                icon.className = isCinematic ? 'fas fa-eye-slash' : 'fas fa-eye';
            }

            // Re-trigger map size recalc if entering/exiting
            if (typeof map !== 'undefined' && map.invalidateSize) {
                setTimeout(() => map.invalidateSize(), 500);
            }
        });
    }
});

// ========== Dashboard & Dynamic Map Logic ==========

let dashboardMap = null;

function setActiveSidebarLink(targetId) {
    document.querySelectorAll('.sidebar-link').forEach(link => {
        link.classList.remove('active');
    });
    const target = document.getElementById(targetId);
    if (target) {
        target.classList.add('active');
    }
}
window.setActiveSidebarLink = setActiveSidebarLink;

function initDashboardInteractions() {
    const showMapBtn = document.getElementById('btn-show-map');
    const backToDashboardBtn = document.getElementById('btn-back-to-dashboard');
    const launchpad = document.getElementById('dashboard-launchpad');
    const dynamicMapContainer = document.getElementById('dynamic-map-container');

    const sidebarDashboardLink = document.getElementById('sidebar-dashboard-link');
    if (sidebarDashboardLink) {
        sidebarDashboardLink.addEventListener('click', (e) => {
            if (isDashboardPage()) {
                e.preventDefault();
                setActiveSidebarLink('sidebar-dashboard-link');
                if (dynamicMapContainer) dynamicMapContainer.classList.add('d-none');
                // Remove map-active so padding/scroll is restored
                const dashMain = document.querySelector('.dashboard-main');
                if (dashMain) dashMain.classList.remove('map-active');
                // Restore dashboard header
                const dashHeader = document.querySelector('.dashboard-header');
                if (dashHeader) dashHeader.classList.remove('d-none');
                const analyticsSection = document.getElementById('dashboard-analytics-section');
                if (analyticsSection) analyticsSection.classList.add('d-none');
                const startupFormSection = document.getElementById('dashboard-startup-form-section');
                if (startupFormSection) startupFormSection.classList.add('d-none');
                if (launchpad) launchpad.classList.remove('d-none');
                const bgAnimation = document.getElementById('bg-animation');
                if (bgAnimation) bgAnimation.style.display = 'block';

                const params = new URLSearchParams(window.location.search);
                params.delete('auto_map');
                params.delete('ai');
                const queryStr = params.toString() ? `?${params.toString()}` : '';
                window.history.replaceState({}, '', `${window.location.pathname}${queryStr}`);
            }
        });
    }

    if (showMapBtn) {
        showMapBtn.addEventListener('click', () => {
            const openMap = () => {
                setActiveSidebarLink('sidebar-heatmap-link');
                if (launchpad) launchpad.classList.add('d-none');
                document.getElementById('business-recommendations-section')?.classList.add('d-none');
                document.getElementById('dashboard-startup-form-section')?.classList.add('d-none');
                if (!isBusinessRecommendationsMode()) {
                    const aiPanel = document.getElementById('business-intelligence-panel');
                    if (aiPanel) aiPanel.classList.add('d-none');
                }
                if (dynamicMapContainer) {
                    dynamicMapContainer.classList.remove('d-none');
                    // Add map-active to remove padding/scroll from the parent
                    const dashMain = document.querySelector('.dashboard-main');
                    if (dashMain) dashMain.classList.add('map-active');
                    // Explicitly hide the dashboard header to eliminate the gap
                    const dashHeader = document.querySelector('.dashboard-header');
                    if (dashHeader) dashHeader.classList.add('d-none');
                    // Scroll to top so map bar sits flush against navbar
                    window.scrollTo(0, 0);
                    initDynamicDashboardMap();
                    if (dashboardMap) {
                        setTimeout(() => dashboardMap.invalidateSize(), 150);
                    }
                }
            };
            if (window.requireSupabaseAuth) {
                window.requireSupabaseAuth('Live Crowd Heatmap', openMap);
            } else {
                openMap();
            }
        });
    }

    // AI Recommender Launchpad Card
    const showAiBtn = document.getElementById('btn-show-ai-recommender');
    if (showAiBtn) {
        showAiBtn.addEventListener('click', () => {
            const openAi = async () => {
                await openDashboardDataOnlyMode('ai');
            };
            if (window.requireSupabaseAuth) {
                window.requireSupabaseAuth('AI Business Recommender', openAi);
            } else {
                openAi();
            }
        });
    }

    // Business Flashcards Launchpad Card (Revenue Intelligence)
    const showFlashBtn = document.getElementById('btn-show-flashcards');
    if (showFlashBtn) {
        showFlashBtn.addEventListener('click', () => {
            const openFlash = async () => {
                await openDashboardDataOnlyMode('recs');
            };
            if (window.requireSupabaseAuth) {
                window.requireSupabaseAuth('Revenue Intelligence', openFlash);
            } else {
                openFlash();
            }
        });
    }

    // Feasibility Engine Launchpad Card
    const showFeasibilityBtn = document.getElementById('btn-show-feasibility');
    if (showFeasibilityBtn) {
        showFeasibilityBtn.addEventListener('click', () => {
            const openFeasibility = () => {
                const sidebarLink = document.getElementById('sidebar-startup-form-link');
                if (sidebarLink) sidebarLink.click();
            };
            if (window.requireSupabaseAuth) {
                window.requireSupabaseAuth('Feasibility Engine', openFeasibility);
            } else {
                openFeasibility();
            }
        });
    }

    // Feature showcase tile: extra Launch Map tiles (btn-show-map-2 and btn-show-map-3)
    ['btn-show-map-2', 'btn-show-map-3'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.addEventListener('click', () => {
                const featName = id === 'btn-show-map-3' ? 'Popular Places Radar' : 'Live Heatmap Tile';
                if (window.requireSupabaseAuth) {
                    window.requireSupabaseAuth(featName, () => {
                        const primaryMapBtn = document.getElementById('btn-show-map');
                        if (primaryMapBtn) primaryMapBtn.click();
                    });
                } else {
                    const primaryMapBtn = document.getElementById('btn-show-map');
                    if (primaryMapBtn) primaryMapBtn.click();
                }
            });
        }
    });

    // Business Recommendations: sidebar link, hero button and launchpad tile
    ['sidebar-recs-link', 'btn-show-recommendations', 'btn-show-recommendations-2'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', gateRecommendations);
    });

    // Feature showcase tile: extra AI recommender
    const showAiBtn2 = document.getElementById('btn-show-ai-recommender-2');
    if (showAiBtn2) {
        showAiBtn2.addEventListener('click', () => {
            if (window.requireSupabaseAuth) {
                window.requireSupabaseAuth('AI Business Recommender', async () => {
                    await openDashboardDataOnlyMode('ai');
                });
            } else {
                openDashboardDataOnlyMode('ai');
            }
        });
    }

    // Feature showcase tile: Startup Form direct from launchpad
    const showStartupFromLaunchpad = document.getElementById('btn-show-startup-form-from-launchpad');
    if (showStartupFromLaunchpad) {
        showStartupFromLaunchpad.addEventListener('click', () => {
            if (window.requireSupabaseAuth) {
                window.requireSupabaseAuth('Startup Form & Feasibility', () => {
                    const sidebarLink = document.getElementById('sidebar-startup-form-link');
                    if (sidebarLink) sidebarLink.click();
                });
            } else {
                const sidebarLink = document.getElementById('sidebar-startup-form-link');
                if (sidebarLink) sidebarLink.click();
            }
        });
    }

    // Sidebar navigation auth gates
    const sidebarHeatmapLink = document.getElementById('sidebar-heatmap-link');
    if (sidebarHeatmapLink) {
        sidebarHeatmapLink.addEventListener('click', (e) => {
            e.preventDefault();
            setActiveSidebarLink('sidebar-heatmap-link');
            const openMap = () => {
                setActiveSidebarLink('sidebar-heatmap-link');
                const startupFormSection = document.getElementById('dashboard-startup-form-section');
                if (startupFormSection) startupFormSection.classList.add('d-none');
                const analyticsSection = document.getElementById('dashboard-analytics-section');
                if (analyticsSection) analyticsSection.classList.add('d-none');

                const primaryMapBtn = document.getElementById('btn-show-map');
                if (primaryMapBtn) primaryMapBtn.click();

                const params = new URLSearchParams(window.location.search);
                params.set('auto_map', 'true');
                params.delete('ai');
                window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
            };

            if (window.requireSupabaseAuth) {
                window.requireSupabaseAuth('Map', openMap);
            } else {
                openMap();
            }
        });
    }

    const sidebarAiLink = document.getElementById('sidebar-ai-link');
    if (sidebarAiLink) {
        sidebarAiLink.addEventListener('click', (e) => {
            e.preventDefault();
            setActiveSidebarLink('sidebar-ai-link');
            const openAi = async () => {
                setActiveSidebarLink('sidebar-ai-link');
                const startupFormSection = document.getElementById('dashboard-startup-form-section');
                if (startupFormSection) startupFormSection.classList.add('d-none');

                await openDashboardDataOnlyMode('ai');
            };

            if (window.requireSupabaseAuth) {
                window.requireSupabaseAuth('Business Analytics', openAi);
            } else {
                openAi();
            }
        });
    }

    // Sidebar Startup Form Link
    const sidebarStartupFormLink = document.getElementById('sidebar-startup-form-link');
    console.log('Sidebar startup form link found:', sidebarStartupFormLink);

    if (sidebarStartupFormLink) {
        console.log('Adding event listener to sidebar startup form link');
        sidebarStartupFormLink.addEventListener('click', (e) => {
            e.preventDefault();
            console.log('Sidebar startup form link clicked');

            const openStartupForm = () => {
                // Hide other sections
                const launchpad = document.getElementById('dashboard-launchpad');
                if (launchpad) launchpad.classList.add('d-none');
                const dynamicMapContainer = document.getElementById('dynamic-map-container');
                if (dynamicMapContainer) dynamicMapContainer.classList.add('d-none');

                // Hide other panels inside analytics section (but keep the section visible for the form)
                const popularPanel = document.getElementById('popular-places-panel');
                if (popularPanel) popularPanel.classList.add('d-none');
                const intelligencePanel = document.getElementById('business-intelligence-panel');
                if (intelligencePanel) intelligencePanel.classList.add('d-none');

                // Hide the business-recommendations section explicitly
                const businessRecsSection = document.querySelector('.business-recommendations-section');
                if (businessRecsSection) businessRecsSection.classList.add('d-none');

                // Hide global layout elements that waste space
                const bgAnimation = document.getElementById('bg-animation');
                if (bgAnimation) bgAnimation.style.display = 'none';

                // Also hide the business-recommendations section (row containing Top 5 cards)
                document.querySelectorAll('.business-recs-section, [data-section="business-recs"]').forEach(el => el.classList.add('d-none'));
                document.querySelectorAll('.col-12 .dashboard-analytics-panel:not(#popular-places-panel):not(#business-intelligence-panel)').forEach(el => el.classList.add('d-none'));

                // Ensure analytics section (parent container) is visible
                const analyticsSection = document.getElementById('dashboard-analytics-section');
                if (analyticsSection) {
                    analyticsSection.classList.remove('d-none');
                    analyticsSection.style.display = 'block';
                }

                // Show startup form
                const startupFormSection = document.getElementById('dashboard-startup-form-section');
                console.log('Startup form section found:', startupFormSection);
                if (startupFormSection) {
                    startupFormSection.classList.remove('d-none');
                    startupFormSection.style.opacity = '1';
                    startupFormSection.style.height = 'auto';
                    startupFormSection.style.visibility = 'visible';
                    startupFormSection.style.overflow = 'visible';
                    startupFormSection.style.display = 'block';
                    console.log('Startup form section shown');
                    // Scroll to the form
                    setTimeout(() => startupFormSection.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
                    // Initialize form functionality
                    initDashboardStartupForm();
                } else {
                    console.error('Startup form section not found!');
                }

                // Update active state in sidebar
                document.querySelectorAll('.sidebar-link').forEach(link => {
                    link.classList.remove('active');
                });
                sidebarStartupFormLink.classList.add('active');
            };

            if (window.requireSupabaseAuth) {
                window.requireSupabaseAuth('Startup Form', openStartupForm);
            } else {
                openStartupForm();
            }
        });
    } else {
        console.error('Sidebar startup form link not found!');
    }

    // Close buttons for Dashboard Panels
    safeOn('close-popular-places', 'click', () => {
        const panel = document.getElementById('popular-places-panel');
        if (panel) panel.classList.add('d-none');
        popularPlacesPanelRequested = false;
    });

    safeOn('close-intelligence-panel', 'click', () => {
        const panel = document.getElementById('business-intelligence-panel');
        if (panel) panel.classList.add('d-none');
    });

    if (backToDashboardBtn) {
        backToDashboardBtn.addEventListener('click', () => {
            setActiveSidebarLink('sidebar-dashboard-link');
            if (dynamicMapContainer) dynamicMapContainer.classList.add('d-none');
            const dashMain = document.querySelector('.dashboard-main');
            if (dashMain) dashMain.classList.remove('map-active');
            // Restore dashboard header
            const dashHeader = document.querySelector('.dashboard-header');
            if (dashHeader) dashHeader.classList.remove('d-none');
            const analyticsSection = document.getElementById('dashboard-analytics-section');
            if (analyticsSection) analyticsSection.classList.add('d-none');
            const startupFormSection = document.getElementById('dashboard-startup-form-section');
            if (startupFormSection) startupFormSection.classList.add('d-none');
            if (launchpad) launchpad.classList.remove('d-none');

            const params = new URLSearchParams(window.location.search);
            params.delete('auto_map');
            params.delete('ai');
            const queryStr = params.toString() ? `?${params.toString()}` : '';
            window.history.replaceState({}, '', `${window.location.pathname}${queryStr}`);
        });
    }

    // Back button for startup form
    const backToLaunchpadFromFormBtn = document.getElementById('btn-back-to-launchpad-from-form');
    if (backToLaunchpadFromFormBtn) {
        backToLaunchpadFromFormBtn.addEventListener('click', () => {
            const startupFormSection = document.getElementById('dashboard-startup-form-section');
            if (startupFormSection) startupFormSection.classList.add('d-none');
            const analyticsSection = document.getElementById('dashboard-analytics-section');
            if (analyticsSection) analyticsSection.classList.add('d-none');
            const dynamicMapContainer = document.getElementById('dynamic-map-container');
            if (dynamicMapContainer) dynamicMapContainer.classList.add('d-none');
            const dashMain = document.querySelector('.dashboard-main');
            if (dashMain) dashMain.classList.remove('map-active');
            if (launchpad) launchpad.classList.remove('d-none');

            // Show global elements again
            const bgAnimation = document.getElementById('bg-animation');
            if (bgAnimation) bgAnimation.style.display = 'block';

            // Restore active state to Dashboard link
            document.querySelectorAll('.sidebar-link').forEach(link => {
                link.classList.remove('active');
            });
            const dashboardLink = document.querySelector('a[href*="dashboard"]');
            if (dashboardLink) dashboardLink.classList.add('active');
        });
    }

    // Dashboard search integration
    safeOn('dashboard-search-btn', 'click', async () => {
        const query = document.getElementById('dashboard-location-search').value.trim();
        if (!query) return;
        await searchLocation(query);
    });

    // Enter key for dashboard search
    safeOn('dashboard-location-search', 'keypress', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('dashboard-search-btn').click();
        }
    });

    // Dashboard "My Location" trigger
    safeOn('dashboard-find-location-btn', 'click', async () => {
        const geoRes = await findMyLocation('dashboard-find-location-btn');
        if (geoRes && geoRes.success && typeof geoRes.lat === 'number') {
            await findPopularPlaces(geoRes.lat, geoRes.lon, false);
        }
    });

    // Dashboard "Popular Places" trigger
    safeOn('dashboard-popular-places-btn', 'click', async () => {
        popularPlacesPanelRequested = true;
        let loc = getCurrentAnalysisLocation();
        if (!loc) {
            showHeatmapToast('Finding your location first...', 'info');
            const geoRes = await findMyLocation('dashboard-find-location-btn');
            if (!geoRes || !geoRes.success) {
                showHeatmapToast('Please search for a location first!', 'info');
                popularPlacesPanelRequested = false;
                return;
            }
            loc = getCurrentAnalysisLocation();
        }
        const { lat, lng } = loc;

        // Ensure analytics section is visible
        const analyticsSection = document.getElementById('dashboard-analytics-section');
        if (analyticsSection) analyticsSection.classList.remove('d-none');

        // Ensure popular places panel is visible in dashboard
        const panel = document.getElementById('popular-places-panel');
        if (panel) panel.classList.remove('d-none');
        if (!isBusinessRecommendationsMode()) {
            const aiPanel = document.getElementById('business-intelligence-panel');
            if (aiPanel) aiPanel.classList.add('d-none');
        }

        await findPopularPlaces(lat, lng, true, { name: loc.name, view: 'area' });
    });

    safeOn('generate-best-locations-btn', 'click', async () => {
        const selected = getCurrentAnalysisLocation();
        let lat = selected?.lat;
        let lon = selected?.lng;

        if ((lat == null || lon == null) && userMarker) {
            const pt = userMarker.getLatLng();
            lat = pt.lat;
            lon = pt.lng;
        }

        if (lat == null || lon == null) {
            showHeatmapToast('Select a location first to generate best locations.', 'info');
            return;
        }

        await generateBestLocations(lat, lon);
    });
}

async function focusMapOnOpportunityOrLocation(targetLat, targetLon, targetName, targetRev, opts = {}) {
    const lat = parseFloat(targetLat);
    const lon = parseFloat(targetLon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return;

    const activeMap = activeMapInstance();
    if (!activeMap) return;

    // opts.locationName: the area's name (the popup title can be more specific).
    const locationName = opts.locationName || targetName || 'Opportunity Location';
    setAnalysisLocation(lat, lon, locationName);
    if (userMarker) {
        try { activeMap.removeLayer(userMarker); } catch (_e) {}
    }
    drawAnalysisRadius(lat, lon, { fit: false });
    zoomToPin(lat, lon);

    const revFormatted = targetRev && Number(targetRev) > 0
        ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(targetRev)) + ' /mo'
        : '';

    const popupHtml = `
        <div style="min-width: 220px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            <div style="font-weight: 700; font-size: 1rem; color: #1e293b; margin-bottom: 4px;">
                <i class="fas fa-bullseye text-primary me-1"></i>${escapeHtml(targetName || 'Opportunity Location')}
            </div>
            ${revFormatted ? `<div style="font-size: 0.85rem; color: #16a34a; font-weight: 600; margin-bottom: 4px;"><i class="fas fa-chart-line me-1"></i>Starting Rev: ${revFormatted}</div>` : ''}
            <div style="font-size: 0.8rem; color: #64748b; margin-bottom: 6px;">
                Lat/Lon: ${lat.toFixed(4)}, ${lon.toFixed(4)} • 5 km Analysis Zone Active
            </div>
        </div>
    `;

    userMarker = L.marker([lat, lon], {
        icon: L.icon({
            iconUrl: 'https://cdn.jsdelivr.net/gh/pointhi/leaflet-color-markers@master/img/marker-icon-orange.png',
            shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
            iconSize: [25, 41],
            iconAnchor: [12, 41],
            popupAnchor: [1, -34],
            shadowSize: [41, 41]
        }),
        zIndexOffset: 1000
    }).addTo(activeMap).bindPopup(popupHtml).openPopup();

    const searchInput = document.getElementById('dashboard-location-search');
    if (searchInput) searchInput.value = locationName;

    // Trigger crowd analysis and popular places for 5000m radius
    return findPopularPlaces(lat, lon, false, { name: locationName });
}
window.focusMapOnOpportunityOrLocation = focusMapOnOpportunityOrLocation;

function initDynamicDashboardMap() {
    const mapEl = document.getElementById('dashboard-map');
    if (!mapEl || dashboardMap) {
        if (dashboardMap) {
            setTimeout(() => dashboardMap.invalidateSize(), 400);
        }
        return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const stored = getCurrentAnalysisLocation();
    const initialLat = parseFloat(urlParams.get('lat')) || (stored ? parseFloat(stored.lat) : 12.9716);
    const initialLon = parseFloat(urlParams.get('lon')) || (stored ? parseFloat(stored.lng) : 77.5946);

    // Initialize Leaflet on the dashboard-specific viewport
    dashboardMap = L.map('dashboard-map').setView([initialLat, initialLon], 13);
    baseTileLayer = addBaseLayers(dashboardMap);
    addSaveLocationControl(dashboardMap);

    // Sync with global 'map' variable for compatibility with existing search/location functions
    map = dashboardMap;

    const statusEl = document.getElementById('map-status');
    if (statusEl) statusEl.textContent = 'Map Ready';

    // Decorative building outlines (dark theme) only at street zoom, never during the analysis.
    let buildingTimer = null;
    dashboardMap.on('zoomend moveend', () => {
        clearTimeout(buildingTimer);
        if (dashboardMap.getZoom() < 16) { clearBuildingOutlines(); return; }
        buildingTimer = setTimeout(() => {
            const c = dashboardMap.getCenter();
            updateBuildingOutlines(c.lat, c.lng);
        }, 800);
    });

    dashboardMap.on('click', async function (e) {
        const lat = e.latlng.lat;
        const lon = e.latlng.lng;
        const searchInput = document.getElementById('dashboard-location-search');

        if (searchInput) searchInput.value = 'Locating...';

        let placeName = 'Selected Area';
        try {
            const response = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`);
            const data = await response.json();
            if (data && data.display_name) {
                // Name the area, not whatever feature happens to be nearest (e.g. "auto repair shop").
                const a = data.address || {};
                const local = a.neighbourhood || a.suburb || a.quarter || a.village || a.road || data.display_name.split(',')[0].trim();
                const city = a.city || a.town || a.county || a.state_district || '';
                placeName = city && city !== local ? `${local}, ${city}` : local;
            }
        } catch (err) {
            console.error('Reverse geocode failed:', err);
        }

        if (searchInput) searchInput.value = placeName;
        await selectSearchResult(lat, lon, placeName);  // runs the analysis for this point
    });

    // Invalidate size after animation completes
    setTimeout(() => {
        dashboardMap.invalidateSize();
    }, 500);
}

// ========== Search Autocomplete ==========

let _autocompleteTimer = null;

function initSearchAutocomplete() {
    const searchInput = document.getElementById('dashboard-location-search');
    const suggestionsBox = document.getElementById('dashboard-search-suggestions');
    if (!searchInput || !suggestionsBox) return;

    // Debounced input listener
    searchInput.addEventListener('input', function () {
        clearTimeout(_autocompleteTimer);
        const query = this.value.trim();
        if (query.length < 2) {
            suggestionsBox.innerHTML = '';
            suggestionsBox.style.display = 'none';
            return;
        }
        _autocompleteTimer = setTimeout(() => {
            fetchSearchSuggestions(query, suggestionsBox);
        }, 300);
    });

    // Close dropdown on click outside
    document.addEventListener('click', function (e) {
        if (!searchInput.contains(e.target) && !suggestionsBox.contains(e.target)) {
            suggestionsBox.innerHTML = '';
            suggestionsBox.style.display = 'none';
        }
    });

    // Close dropdown on Escape
    searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            suggestionsBox.innerHTML = '';
            suggestionsBox.style.display = 'none';
        }
    });
}

async function fetchSearchSuggestions(query, container) {
    try {
        // Call Nominatim API directly from the browser
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=1&countrycodes=in`;
        const response = await fetch(url, {
            headers: { 'Accept': 'application/json' }
        });

        const results = await response.json();
        if (!results || !results.length) {
            container.innerHTML = '<div class="search-suggestion-item text-muted"><i class="fas fa-search me-2"></i> No results found</div>';
            container.style.display = 'block';
            return;
        }

        container.innerHTML = '';
        results.forEach(result => {
            const item = document.createElement('div');
            item.className = 'search-suggestion-item';

            // Parse display name into name + region
            const parts = (result.display_name || '').split(',').map(p => p.trim());
            const placeName = parts[0] || 'Unknown';
            const region = parts.slice(1, 4).join(', ');

            item.innerHTML = `
                <div class="suggestion-icon">
                    <i class="fas fa-map-marker-alt"></i>
                </div>
                <div class="suggestion-text">
                    <div class="suggestion-name">${placeName}</div>
                    <div class="suggestion-region">${region}</div>
                </div>
            `;
            item.addEventListener('click', function () {
                const searchInput = document.getElementById('dashboard-location-search');
                if (searchInput) searchInput.value = result.display_name;

                container.innerHTML = '';
                container.style.display = 'none';

                const lat = parseFloat(result.lat);
                const lon = parseFloat(result.lon);
                if (lat && lon) {
                    dashboardQuickSelectLocation(lat, lon, placeName);
                }
            });
            container.appendChild(item);
        });
        container.style.display = 'block';
    } catch (err) {
        console.error('Autocomplete error:', err);
        container.innerHTML = '';
        container.style.display = 'none';
    }
}

// Dashboard autocomplete wrapper that preserves the main selection flow.
function dashboardQuickSelectLocation(lat, lon, name) {
    selectSearchResult(lat, lon, name || 'Selected Location');
}

// Global initialization for Dashboard specific logic
document.addEventListener('DOMContentLoaded', () => {
    initGlobalFloatingUI(); // Initialize global floating components
    initDashboardFloatingUI(); // Dashboard-specific floating/form behavior
    initDashboardInteractions();
    initSearchAutocomplete();

    // Auto-init if we are on dashboard and hash is #map or auto_map param is present
    const urlParams = new URLSearchParams(window.location.search);
    const triggerMap = (window.location.hash === '#map' || urlParams.get('auto_map') === 'true');
    const triggerAi = (urlParams.get('ai') === 'true');
    const triggerForm = (urlParams.get('form') === 'startup');
    // Declared before use: reading it earlier threw a ReferenceError that aborted
    // this whole initialiser on every plain /dashboard/ load. Only a recent choice is reused.
    const stored = getCurrentAnalysisLocation();

    if (triggerMap) {
        setActiveSidebarLink('sidebar-heatmap-link');
        const dashMain = document.querySelector('.dashboard-main');
        if (dashMain) dashMain.classList.add('map-active');
    } else if (triggerAi) {
        setActiveSidebarLink('sidebar-ai-link');
    } else {
        setActiveSidebarLink('sidebar-dashboard-link');
    }

    const optLat = urlParams.get('lat') || (stored ? stored.lat : null);
    const optLon = urlParams.get('lon') || (stored ? stored.lng : null);
    const optName = urlParams.get('name') || (stored ? stored.name : 'Selected Location');
    const optRev = urlParams.get('rev') || null;

    if (triggerMap && document.getElementById('btn-show-map')) {
        setTimeout(() => {
            setActiveSidebarLink('sidebar-heatmap-link');
            const openAndFocus = () => {
                document.getElementById('btn-show-map').click();
                if (optLat && optLon) {
                    setTimeout(async () => {
                        await focusMapOnOpportunityOrLocation(optLat, optLon, optName, optRev);
                    }, 400);
                }
            };
            if (window.requireSupabaseAuth) {
                window.requireSupabaseAuth('Live Crowd Heatmap', openAndFocus);
            } else {
                openAndFocus();
            }
        }, 200);
    } else if (triggerAi && document.getElementById('btn-show-ai-recommender')) {
        setTimeout(() => {
            setActiveSidebarLink('sidebar-ai-link');
            if (window.requireSupabaseAuth) {
                window.requireSupabaseAuth('AI Business Recommender', () => {
                    document.getElementById('btn-show-ai-recommender').click();
                });
            } else {
                document.getElementById('btn-show-ai-recommender').click();
            }
        }, 200);
    } else if (urlParams.get('recs') === 'true') {
        setTimeout(() => gateRecommendations(), 200);
    } else if (triggerForm && document.getElementById('sidebar-startup-form-link')) {
        setTimeout(() => document.getElementById('sidebar-startup-form-link').click(), 200);
    }

    initDashboardAIFromStorage();
});

// ========== Global Floating UI (Form Modal + Chatbot) ==========

function initDashboardFloatingUI() {
    // --- Form Modal Open/Close ---
    const formModal = document.getElementById('form-modal');
    const formTriggerBtn = document.getElementById('form-trigger-btn');
    const closeBtn = formModal ? formModal.querySelector('.close') : null;

    if (formTriggerBtn && formModal) {
        formTriggerBtn.addEventListener('click', () => {
            formModal.classList.add('modal-open');
            const formMessage = document.getElementById('form-message');
            if (formMessage) {
                formMessage.textContent = '';
                formMessage.className = 'form-message';
            }
            // Detect which flow to use when modal opens
            _initFormFlow();
        });
    }

    if (closeBtn && formModal) {
        closeBtn.addEventListener('click', () => {
            formModal.classList.remove('modal-open');
        });
    }

    // Close on backdrop click
    if (formModal) {
        formModal.addEventListener('click', (e) => {
            if (e.target === formModal) {
                formModal.classList.remove('modal-open');
            }
        });
    }

    // --- Form Location Autocomplete (Nominatim) — used in Flow A ---
    const formLocInput = document.getElementById('form-location-search');
    const formLocSuggestions = document.getElementById('form-location-suggestions');

    if (formLocInput && formLocSuggestions) {
        let formLocTimer = null;
        formLocInput.addEventListener('input', function () {
            clearTimeout(formLocTimer);
            const q = this.value.trim();
            if (q.length < 3) {
                formLocSuggestions.innerHTML = '';
                formLocSuggestions.style.display = 'none';
                return;
            }
            formLocTimer = setTimeout(async () => {
                try {
                    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`;
                    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
                    const results = await res.json();
                    formLocSuggestions.innerHTML = '';
                    if (!results || !results.length) {
                        formLocSuggestions.style.display = 'none';
                        return;
                    }
                    results.forEach(r => {
                        const item = document.createElement('div');
                        item.className = 'suggestion-item';
                        item.textContent = r.display_name;
                        item.addEventListener('click', async () => {
                            formLocInput.value = r.display_name;
                            formLocSuggestions.innerHTML = '';
                            formLocSuggestions.style.display = 'none';
                            const lat = parseFloat(r.lat);
                            const lon = parseFloat(r.lon);
                            const latField = document.getElementById('id_latitude');
                            const lonField = document.getElementById('id_longitude');
                            if (latField) latField.value = lat;
                            if (lonField) lonField.value = lon;

                            // Flow A: fetch popular places for this location to populate business types
                            _setFlowHint('Loading nearby business types...');
                            const bizSearch = document.getElementById('id_business_type_search');
                            if (bizSearch) {
                                bizSearch.value = '';
                                bizSearch.placeholder = 'Loading business types...';
                                bizSearch.disabled = true;
                            }
                            const result = await findPopularPlaces(lat, lon, false);
                            if (result && result.success) {
                                populateBusinessTypeFromPopularPlaces(lastPopularPlacesResult.places);
                                _setFlowHint('From searched location: ' + lastPopularPlacesResult.places.length + ' places found');
                            } else {
                                if (bizSearch) {
                                    bizSearch.value = '';
                                    bizSearch.placeholder = 'No business types found nearby';
                                    bizSearch.disabled = true;
                                }
                                _setFlowHint('No popular places found for this location');
                            }
                        });
                        formLocSuggestions.appendChild(item);
                    });
                    formLocSuggestions.style.display = 'block';
                } catch (e) {
                    formLocSuggestions.style.display = 'none';
                }
            }, 300);
        });

        // Hide suggestions on outside click
        document.addEventListener('click', (e) => {
            if (!formLocInput.contains(e.target) && !formLocSuggestions.contains(e.target)) {
                formLocSuggestions.style.display = 'none';
            }
        });
    }

    const businessForm = document.getElementById('business-form');
    const formMessage = document.getElementById('form-message');

    // --- Crowd Intensity change -> place orange markers immediately (form-scoped) ---
    const crowdSelect = businessForm ? businessForm.querySelector('select[name="crowd_intensity"]') : null;
    const bizTypeSelect = businessForm ? businessForm.querySelector('#id_business_type') : null;
    const bizTypeSearchInForm = businessForm ? businessForm.querySelector('#id_business_type_search') : null;
    const latFieldInForm = businessForm ? businessForm.querySelector('input[name="latitude"]') : null;
    const lonFieldInForm = businessForm ? businessForm.querySelector('input[name="longitude"]') : null;
    const warmupFeasibility = () => {
        clearTimeout(feasibilityWarmupTimer);
        feasibilityWarmupTimer = setTimeout(async () => {
            const lat = parseFloat(latFieldInForm?.value || '');
            const lon = parseFloat(lonFieldInForm?.value || '');
            const bizType = (bizTypeSelect?.value || bizTypeSearchInForm?.value || '').trim();
            if (Number.isNaN(lat) || Number.isNaN(lon) || !bizType) return;
            try {
                await getFeasibilityWithCache(lat, lon, bizType);
            } catch (e) {
                // Silent warm-up failure; submit path still handles full check/errors.
            }
        }, 250);
    };
    if (crowdSelect) {
        crowdSelect.addEventListener('change', () => {
            const bizType = bizTypeSelect ? bizTypeSelect.value : '';
            const intensity = crowdSelect.value;
            if (bizType && intensity && lastPopularPlacesResult.places.length > 0) {
                placeOrangeMarkers(bizType, intensity, lastPopularPlacesResult.places,
                    lastPopularPlacesResult.lat, lastPopularPlacesResult.lon);
            }
            warmupFeasibility();
        });
    }
    if (bizTypeSelect) {
        bizTypeSelect.addEventListener('change', () => {
            const bizType = bizTypeSelect.value;
            const intensity = crowdSelect ? crowdSelect.value : '';
            if (bizType && intensity && lastPopularPlacesResult.places.length > 0) {
                placeOrangeMarkers(bizType, intensity, lastPopularPlacesResult.places,
                    lastPopularPlacesResult.lat, lastPopularPlacesResult.lon);
            }
            warmupFeasibility();
        });
    }

    // --- Form Submit Handler ---
    if (businessForm) {
        businessForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            const submitBtn = document.getElementById('submit-business-form-btn');
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Processing...'; }

            // Read business type from the new select dropdown first, fallback to hidden field
            const typeDropdownEl = document.getElementById('id_business_type_dropdown');
            const bizType = (typeDropdownEl?.value || bizTypeSelect?.value || bizTypeSearchInForm?.value || '').trim();
            const intensity = (crowdSelect?.value || '').trim();
            let lat = parseFloat(latFieldInForm?.value || '');
            let lon = parseFloat(lonFieldInForm?.value || '');
            if (Number.isNaN(lat) || Number.isNaN(lon)) {
                if (!Number.isNaN(lastPopularPlacesResult.lat) && !Number.isNaN(lastPopularPlacesResult.lon)) {
                    lat = lastPopularPlacesResult.lat;
                    lon = lastPopularPlacesResult.lon;
                } else if (userMarker && typeof userMarker.getLatLng === 'function') {
                    const ll = userMarker.getLatLng();
                    lat = parseFloat(ll.lat);
                    lon = parseFloat(ll.lng);
                }
            }

            // Validation
            const feasBanner = document.getElementById('feasibility-result-banner');
            const showBanner = (msg, type) => {
                if (!feasBanner) return;
                feasBanner.style.display = 'block';
                feasBanner.textContent = msg;
                feasBanner.style.background = type === 'success' ? 'rgba(74,222,128,0.12)' : 'rgba(248,113,113,0.12)';
                feasBanner.style.border = `1px solid ${type === 'success' ? 'rgba(74,222,128,0.4)' : 'rgba(248,113,113,0.4)'}`;
                feasBanner.style.color = type === 'success' ? '#16a34a' : '#dc2626';
            };

            if (!bizType) {
                showBanner('⚠ Please select a Business Type from the dropdown.', 'error');
                if (formMessage) { formMessage.textContent = ''; }
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-check-circle me-2"></i>Check Feasibility & Submit'; }
                return;
            }
            if (!intensity) {
                showBanner('⚠ Please select a Crowd Intensity level.', 'error');
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-check-circle me-2"></i>Check Feasibility & Submit'; }
                return;
            }
            if (!lat || !lon) {
                showBanner('⚠ Please search and select a Business Location.', 'error');
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-check-circle me-2"></i>Check Feasibility & Submit'; }
                return;
            }

            const hasCachedPlacesForSubmit = (
                lastPopularPlacesResult.places.length > 0 &&
                Math.abs((lastPopularPlacesResult.lat || 0) - lat) <= 0.01 &&
                Math.abs((lastPopularPlacesResult.lon || 0) - lon) <= 0.01
            );

            // Keep submit fast: do not refetch popular places here. If cache is stale/missing,
            // we still proceed using available crowd-zone data and center fallback.
            if (!hasCachedPlacesForSubmit && formMessage) {
                formMessage.textContent = 'Using current map analysis. For richer matches, pick location from suggestions first.';
                formMessage.className = 'form-message';
            }

            // Match behavior with feasibility flow: check first, then show ranked orange zones only if feasible.
            if (feasBanner) feasBanner.style.display = 'none';
            if (formMessage) { formMessage.textContent = ''; }
            if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i>Checking...'; }

            const feasData = await getFeasibilityWithCache(lat, lon, bizType || '');

            if (!feasData.success) {
                const errText = feasData.error || feasData.message || 'Could not check feasibility.';
                showBanner('✗ ' + errText, 'error');
                notifyChatFromMap('Feasibility check failed: ' + errText);
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-check-circle me-2"></i>Check Feasibility & Submit'; }
                return;
            }

            if (!feasData.feasible) {
                const msg = feasData.message || 'This business type is not feasible for the selected location and crowd level.';
                showBanner('✗ Not Feasible: ' + msg, 'error');
                notifyChatFromMap(msg);
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-check-circle me-2"></i>Check Feasibility & Submit'; }
                return;
            }

            // ✓ Feasible — place orange markers on the map
            const placesForRanking = hasCachedPlacesForSubmit ? lastPopularPlacesResult.places : [];
            placeOrangeMarkers(bizType, intensity, placesForRanking,
                lastPopularPlacesResult.lat || lat, lastPopularPlacesResult.lon || lon);

            const successMsg = feasData.message || `${bizType.replace(/_/g, ' ')} is feasible here for ${intensity} crowd intensity!`;
            showBanner('✓ Feasible! ' + successMsg + ' — Orange markers placed on map.', 'success');
            notifyChatFromMap(feasData.message || `Feasible. Orange markers placed for ${bizType}.`);

            // Then take the user to the map, zoomed in on the business location.
            setTimeout(() => {
                if (formModal) formModal.classList.remove('modal-open');
                if (feasBanner) feasBanner.style.display = 'none';
                const placeName = (getCurrentAnalysisLocation() && sameSpot(getCurrentAnalysisLocation(), { lat, lng: lon }))
                    ? getCurrentAnalysisLocation().name : 'Business location';
                navigateToMapOpportunity(lat, lon, placeName, bizType);
            }, 2000);

            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-check-circle me-2"></i>Check Feasibility & Submit'; }
        });
    }

}

// Detect and set up the correct flow when the form modal opens
function _initFormFlow() {
    const formLocInput = document.getElementById('form-location-search');
    const bizSearch = document.getElementById('id_business_type_search');
    const hiddenBiz = document.getElementById('id_business_type');

    const storedLocation = getSelectedLocation();
    const hasLocation = lastPopularPlacesResult.places.length > 0 || !!storedLocation;

    if (hasLocation) {
        // ── FLOW B: Location already selected on map ──
        // Pre-fill location field (read-only)
        const flowLat = lastPopularPlacesResult.lat || storedLocation?.lat;
        const flowLon = lastPopularPlacesResult.lon || storedLocation?.lng;
        if (formLocInput) {
            formLocInput.value = 'Current map location (' +
                (flowLat || '').toString().substring(0, 7) + ', ' +
                (flowLon || '').toString().substring(0, 7) + ')';
            formLocInput.readOnly = true;
            formLocInput.style.opacity = '0.7';
            formLocInput.style.cursor = 'not-allowed';
        }
        // Set hidden lat/lon
        const latField = document.getElementById('id_latitude');
        const lonField = document.getElementById('id_longitude');
        if (latField) latField.value = flowLat || '';
        if (lonField) lonField.value = flowLon || '';

        // Populate business type from cached popular places
        if (lastPopularPlacesResult.places.length > 0) {
            populateBusinessTypeFromPopularPlaces(lastPopularPlacesResult.places);
            _setFlowHint('From your selected map location: ' + lastPopularPlacesResult.places.length + ' places nearby');
        } else {
            _setFlowHint('Location selected. Click Popular Places to load nearby business types.');
        }
    } else {
        // ── FLOW A: No location selected yet ──
        if (formLocInput) {
            formLocInput.value = '';
            formLocInput.readOnly = false;
            formLocInput.style.opacity = '1';
            formLocInput.style.cursor = 'text';
        }
        if (hiddenBiz) hiddenBiz.value = '';
        _allBusinessCategories = [];
        if (bizSearch) {
            bizSearch.value = '';
            bizSearch.disabled = true;
            bizSearch.placeholder = 'Search a location first to load types...';
        }
        _setFlowHint('Search a location above to load business types');
    }
}

// Update the hint text below the business type dropdown
function _setFlowHint(text) {
    const hint = document.getElementById('form-flow-hint');
    if (hint) hint.textContent = text;
}

// ========== Populate Business Type from Popular Places ==========

function populateBusinessTypeFromPopularPlaces(places) {
    const searchInput = document.getElementById('id_business_type_search');
    const suggestionsBox = document.getElementById('business-type-suggestions');
    const hiddenInput = document.getElementById('id_business_type');
    const hiddenSelect = document.getElementById('id_business_type_select');
    // NEW: The dedicated select dropdown
    const typeDropdown = document.getElementById('id_business_type_dropdown');

    // Extract unique business categories from popular places tags
    const typeMap = new Map();
    (places || []).forEach(place => {
        const tags = place.tags || {};
        const type = tags.amenity || tags.shop || tags.tourism || tags.leisure;
        if (type && !typeMap.has(type)) {
            const label = type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            typeMap.set(type, label);
        }
    });

    // Keep global autocomplete categories in sync with current location data.
    _allBusinessCategories = Array.from(typeMap.values())
        .sort((a, b) => a.localeCompare(b));

    if (hiddenInput) hiddenInput.value = '';
    if (hiddenSelect) hiddenSelect.value = '';
    if (recommendedBusinessHidden) recommendedBusinessHidden.value = '';
    if (suggestionsBox) suggestionsBox.style.display = 'none';

    // ---------- POPULATE the new <select> dropdown ----------
    if (typeDropdown) {
        typeDropdown.innerHTML = '';
        const defaultOpt = document.createElement('option');
        defaultOpt.value = '';
        defaultOpt.textContent = typeMap.size === 0 ? '-- No types found nearby --' : '-- Choose a business type --';
        typeDropdown.appendChild(defaultOpt);

        typeMap.forEach((label, value) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            typeDropdown.appendChild(opt);
        });
    }

    if (typeMap.size === 0) {
        if (searchInput) {
            searchInput.value = '';
            searchInput.disabled = true;
            searchInput.placeholder = 'No business types found nearby';
        }
        _setFlowHint('No business types detected. Try a busier location.');
        return;
    }

    if (searchInput) {
        searchInput.disabled = false;
        searchInput.value = '';
        searchInput.placeholder = `Type to search ${_allBusinessCategories.length} business types...`;
    }
    _setFlowHint(`${typeMap.size} business types available — select one above.`);
}

// ========== Place Orange Markers for Matching Business Type + Crowd Intensity ==========

function placeOrangeMarkers(businessType, crowdIntensity, places, centerLat, centerLon) {
    // Clear previous orange markers
    const activeMap = (typeof map !== 'undefined' && map) ? map : null;
    if (activeMap) {
        orangeMarkers.forEach(m => activeMap.removeLayer(m));
    }
    orangeMarkers = [];

    if (!activeMap) return;

    // Normalize intensity: 'moderate' maps to 'medium' in classifyCrowd
    let intensityNorm = (crowdIntensity === 'moderate' ? 'medium' : crowdIntensity || '').toLowerCase();
    const bizKey = String(businessType || '').trim().toLowerCase().replace(/\s+/g, '_');
    const allPlaces = Array.isArray(places) ? places : [];

    const orangeIcon = L.icon({
        iconUrl: 'https://cdn.jsdelivr.net/gh/pointhi/leaflet-color-markers@master/img/marker-icon-orange.png',
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
        iconSize: [25, 41],
        iconAnchor: [12, 41],
        popupAnchor: [1, -34],
        shadowSize: [41, 41]
    });

    const intensityColors = { low: '#4CAF50', medium: '#FFC107', high: '#F44336' };
    const intensityLabels = { low: 'Low', medium: 'Moderate', high: 'High' };

    // Infer preferred crowd intensity from backend mapping when not explicitly selected.
    if (!intensityNorm && businessByIntensity && typeof businessByIntensity === 'object') {
        const order = ['low', 'medium', 'high'];
        intensityNorm = order.find(level => {
            const arr = businessByIntensity[level] || [];
            return arr.some(x => String(x).toLowerCase().replace(/\s+/g, '_') === bizKey);
        }) || '';
    }

    function haversineMeters(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const toRad = deg => (deg * Math.PI) / 180;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function normalizeType(value) {
        return String(value || '').toLowerCase().replace(/\s+/g, '_').trim();
    }

    function placeTypeFor(place) {
        const tags = place.tags || {};
        return normalizeType(tags.amenity || tags.shop || tags.tourism || tags.leisure || '');
    }

    function coordsFor(place) {
        let pLat = place.lat;
        let pLon = place.lon;
        if (!pLat && place.center) { pLat = place.center.lat; pLon = place.center.lon; }
        if (!pLat || !pLon) return null;
        return { lat: parseFloat(pLat), lon: parseFloat(pLon) };
    }

    function typeMatches(place) {
        if (!bizKey) return false;
        const tags = place.tags || {};
        const pType = placeTypeFor(place);
        const pName = normalizeType(tags.name || '');
        if (!pType && !pName) return false;
        const bizToken = bizKey.split('_')[0] || bizKey;
        return pType === bizKey || pType.includes(bizKey) || bizKey.includes(pType) || pName.includes(bizToken);
    }

    // ML category match: compare selected intensity's recommended categories with place type/name.
    const mlCategorySet = new Set(
        ((businessByIntensity && intensityNorm && businessByIntensity[intensityNorm]) || [])
            .map(v => normalizeType(v))
            .filter(Boolean)
    );
    function mlMatches(place) {
        if (!mlCategorySet.size) return true; // if no ML map available, do not block.
        const tags = place.tags || {};
        const pType = placeTypeFor(place);
        const pName = normalizeType(tags.name || '');
        if (!pType && !pName) return false;
        for (const mlType of mlCategorySet) {
            const token = mlType.split('_')[0] || mlType;
            if (pType === mlType || pType.includes(mlType) || mlType.includes(pType) || pName.includes(token)) {
                return true;
            }
        }
        return false;
    }

    // Candidate popular places that match user-selected business and ML-recommended categories.
    const matchingPlaces = [];
    allPlaces.forEach(place => {
        if (!typeMatches(place)) return;
        if (!mlMatches(place)) return;
        const pt = coordsFor(place);
        if (!pt) return;
        const footfall = estimateBaseFootfall(place);
        const placeIntensity = classifyCrowd(footfall);
        if (intensityNorm && placeIntensity !== intensityNorm) return;
        matchingPlaces.push({
            place,
            lat: pt.lat,
            lon: pt.lon,
            placeIntensity,
            placeType: placeTypeFor(place),
        });
    });

    // Priority 1: place orange markers directly at matched place points (as requested).
    let matchCount = 0;
    if (matchingPlaces.length > 0) {
        matchingPlaces
            .sort((a, b) => {
                const da = (!Number.isNaN(centerLat) && !Number.isNaN(centerLon))
                    ? haversineMeters(parseFloat(centerLat), parseFloat(centerLon), a.lat, a.lon)
                    : 0;
                const db = (!Number.isNaN(centerLat) && !Number.isNaN(centerLon))
                    ? haversineMeters(parseFloat(centerLat), parseFloat(centerLon), b.lat, b.lon)
                    : 0;
                return da - db;
            })
            .slice(0, 10)
            .forEach(mp => {
                const tags = mp.place.tags || {};
                const name = tags.name || mp.placeType || 'Business';
                const typeLabel = (mp.placeType || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                const crowdLabel = intensityLabels[mp.placeIntensity] || mp.placeIntensity;
                const color = intensityColors[mp.placeIntensity] || '#FFA500';
                const popupHtml = `
                    <div style="min-width:190px;">
                        <b>${name}</b><br>
                        <b>Category:</b> ${typeLabel}<br>
                        <b>Crowd:</b> ${crowdLabel}<br>
                        <small>Matched with selected business + ML category rules</small>
                        <div style="margin-top:4px;background:${color};height:6px;border-radius:999px;"></div>
                    </div>`;
                const marker = L.marker([mp.lat, mp.lon], { icon: orangeIcon })
                    .addTo(activeMap)
                    .bindPopup(popupHtml);
                orangeMarkers.push(marker);
                matchCount += 1;
            });
    }

    // Priority 2 fallback: rank crowd zones by nearby matching places.
    const zones = (lastCrowdIntensityData && lastCrowdIntensityData[intensityNorm]) || [];
    const zoneRadiusM = 900;
    const zoneCandidates = zones
        .map(zone => {
            const zLat = parseFloat(zone.latitude);
            const zLon = parseFloat(zone.longitude);
            if (Number.isNaN(zLat) || Number.isNaN(zLon)) return null;

            let nearbyMatchCount = 0;
            matchingPlaces.forEach(mp => {
                if (haversineMeters(zLat, zLon, mp.lat, mp.lon) <= zoneRadiusM) nearbyMatchCount += 1;
            });

            const baseCount = parseFloat(zone.count || 0) || 0;
            const centerDistance = (!Number.isNaN(centerLat) && !Number.isNaN(centerLon))
                ? haversineMeters(parseFloat(centerLat), parseFloat(centerLon), zLat, zLon)
                : 0;

            // Higher nearby business matches + higher crowd evidence wins.
            const score = (nearbyMatchCount * 1000) + baseCount - (centerDistance * 0.001);
            return { zone, zLat, zLon, nearbyMatchCount, baseCount, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);

    if (matchCount === 0) {
        const topZones = zoneCandidates.slice(0, 5);
        topZones.forEach((z, idx) => {
            const popupHtml = `
                <div style="min-width:200px;">
                    <b>Best Match Zone #${idx + 1}</b><br>
                    <b>Business:</b> ${(businessType || 'Business').replace(/_/g, ' ')}<br>
                    <b>Crowd:</b> ${(intensityLabels[intensityNorm] || intensityNorm || 'Any')}<br>
                    <b>Matched nearby places:</b> ${z.nearbyMatchCount}<br>
                    <b>Total POIs in zone:</b> ${Math.round(z.baseCount)}
                </div>`;
            const marker = L.marker([z.zLat, z.zLon], { icon: orangeIcon })
                .addTo(activeMap)
                .bindPopup(popupHtml);
            orangeMarkers.push(marker);
            matchCount += 1;
        });
    }

    // If no zone ranking available, fall back to top matching business places.
    if (matchCount === 0 && matchingPlaces.length > 0) {
        matchingPlaces.slice(0, 5).forEach(mp => {
            const tags = mp.place.tags || {};
            const name = tags.name || mp.placeType || 'Business';
            const typeLabel = (mp.placeType || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            const crowdLabel = intensityLabels[mp.placeIntensity] || mp.placeIntensity;
            const color = intensityColors[mp.placeIntensity] || '#FFA500';
            const popupHtml = `
                <div style="min-width:180px;">
                    <b style="font-size:1rem;">${name}</b><br>
                    <span style="color:#666;font-size:0.85rem;">${typeLabel}</span><br>
                    <span style="background:${color};color:#fff;padding:2px 8px;border-radius:10px;font-size:0.8rem;font-weight:700;display:inline-block;margin-top:4px;">${crowdLabel} Crowd</span>
                </div>`;
            const marker = L.marker([mp.lat, mp.lon], { icon: orangeIcon })
                .addTo(activeMap)
                .bindPopup(popupHtml);
            orangeMarkers.push(marker);
            matchCount += 1;
        });
    }

    // Last-resort fallback only if we have absolutely no map data to rank.
    if (matchCount === 0 && !Number.isNaN(parseFloat(centerLat)) && !Number.isNaN(parseFloat(centerLon))) {
        const marker = L.marker([parseFloat(centerLat), parseFloat(centerLon)], { icon: orangeIcon })
            .addTo(activeMap)
            .bindPopup('<b>No ranked zones found for this combination here yet.</b>');
        orangeMarkers.push(marker);
        matchCount = 1;
    }

    if (typeof showHeatmapToast === 'function') {
        const typeLabel = String(businessType || 'business').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const intensityLabel = (intensityNorm || crowdIntensity || 'any').charAt(0).toUpperCase() + (intensityNorm || crowdIntensity || 'any').slice(1);
        if (matchCount > 0) {
            showHeatmapToast(`Found ${matchCount} best matching spot(s) for ${typeLabel} (${intensityLabel} crowd).`, 'success');
        } else {
            showHeatmapToast(`No matches for "${typeLabel}" and "${intensityLabel}" crowd. Try another intensity or location.`, 'error');
        }
    }

    // If we have matches, fit map to show them all
    if (matchCount > 0 && activeMap) {
        try {
            const group = L.featureGroup(orangeMarkers);
            activeMap.fitBounds(group.getBounds().pad(0.2));
        } catch (e) {
            // fallback: just center on the search location
            if (centerLat && centerLon) activeMap.setView([centerLat, centerLon], 14);
        }
    }
}
// Ensure AI/Recommendations section is shown immediately on page load if requested via URL params
document.addEventListener('DOMContentLoaded', () => {
    if (!window.location.pathname.includes('/dashboard')) return;
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('ai') === 'true') {
        const recsSection = document.querySelector('.business-recommendations-section');
        if (recsSection) recsSection.classList.remove('d-none');
    }
});
