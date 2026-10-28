// Frontend tests for the map analysis flow in static/js/main.js (bugs 4 and 5):
// pending/retry with progress, stale-response guard, real 5 km circle + fitBounds,
// level colours, clear error with Retry, GPS location becoming the analysis location.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../../static/js/main.js'), 'utf8');
const FORM_SCRIPT = fs.readFileSync(path.join(__dirname, '../../static/js/dashboard-form.js'), 'utf8');
const FAV_SCRIPT = fs.readFileSync(path.join(__dirname, '../../static/js/favorites.js'), 'utf8');
const UTTARAHALLI = { lat: 12.9066, lng: 77.5468 };

function fakeLeaflet(log) {
    const layer = (kind, ll, opts = {}) => {
        const l = {
            kind, ll, opts,
            addTo(m) { log.added.push(l); m.layers.add(l); return l; },
            bindPopup() { return l; }, bindTooltip() { return l; }, openPopup() { return l; },
            getBounds() { return { kind: 'bounds', center: ll, radius: opts.radius }; },
            getLatLng() { return { lat: ll[0], lng: ll[1] }; },
            getPopup() { return { setContent() { return this; } }; },
            on() { return l; },
        };
        return l;
    };
    return {
        map() {
            const m = {
                layers: new Set(), zoom: 13,
                setView(ll, z) { log.views.push({ ll, z }); m.zoom = z; return m; }, fitBounds(b) { log.fit.push(b); return m; },
                flyTo(ll, z) { log.views.push({ ll, z, fly: true }); m.zoom = z; return m; },
                removeLayer(l) { m.layers.delete(l); return m; }, on() { return m; }, once() { return m; },
                getZoom() { return m.zoom; }, getCenter() { return { lat: 0, lng: 0 }; }, invalidateSize() {},
                getBounds() { return { contains: () => true }; }, eachLayer() {}, removeControl() {},
            };
            return m;
        },
        tileLayer: (url, opts) => ({ kind: 'tile', url, opts, addTo: () => ({}) }),
        layerGroup: (layers) => ({ kind: 'group', layers, addTo(m) { log.added.push(this); m.layers.add(this); return this; } }),
        Control: { extend: (proto) => function Control() { Object.assign(this, proto);
            this.addTo = (m) => { this.el = this.onAdd(m); log.controls = (log.controls || []).concat(this); return this; }; } },
        DomUtil: { create: (tag, cls) => { const el = globalThis.__doc.createElement(tag); el.className = cls; return el; } },
        DomEvent: { disableClickPropagation() {} },
        circle: (ll, o) => layer('circle', ll, o),
        circleMarker: (ll, o) => layer('circleMarker', ll, o),
        marker: (ll, o) => layer('marker', ll, o),
        icon: (o) => o,
        latLng: (a, b) => ({ lat: a, lng: b }),
    };
}

function json(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function areaResponse(lat, lon, extra = {}) {
    return {
        success: true,
        center: { latitude: lat, longitude: lon, name: 'X' },
        results: [{ type: 'node', id: 1, lat: lat + 0.01, lon: lon + 0.01, tags: { name: 'Cafe A', amenity: 'cafe' },
                    revenue_data: { estimated_monthly_revenue: 90000, estimated_daily_revenue: 3000, potential_score: 70, business_health: 'Strong' } }],
        total_area_revenue: 90000, pois_analysed: 4228, active_sensors_count: 4228,
        estimated_revenue_basis: 'Sum of revenue-engine estimates for 1 mapped businesses in the 5 km radius',
        recommendations: [], is_live: true, stale: false, fetched_at: '2026-10-28T16:00:00+00:00',
        crowd_intensity: {
            success: true, center: { latitude: lat, longitude: lon, name: 'X' },
            high_intensity: [{ latitude: lat + 0.01, longitude: lon, count: 180, sector: '0_1', density_per_km2: 62 }],
            medium_intensity: [{ latitude: lat - 0.02, longitude: lon, count: 300, sector: '1_2', density_per_km2: 35 }],
            low_intensity: [{ latitude: lat, longitude: lon - 0.03, count: 220, sector: '2_0', density_per_km2: 15 }],
            pois_analysed: 4228, estimated_revenue: 90000, analysis_radius: 5000, business_by_intensity: {},
            estimated_revenue_basis: 'Sum of revenue-engine estimates for 1 mapped businesses in the 5 km radius',
        },
        ...extra,
    };
}

const windows = [];
// main.js starts timers (chat reconnect, live counters); close windows so the run can exit.
after(() => windows.forEach((w) => w.close()));

function setup({ fetchImpl } = {}) {
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => { if (!/navigation|Not implemented/.test(e.message)) console.error(e); });
    const dom = new JSDOM(`<!DOCTYPE html><body>
        <div id="dashboard-map"></div><div id="map-status">Map Ready</div>
        <div id="revenue-prediction-display" class="d-none">
          <div class="revenue-item"><span class="revenue-label">Mapped Places (5 km)</span><span id="crowd-score-value"></span></div>
          <div class="revenue-item" id="revenue-estimate-item"><span class="revenue-label">Est.</span><span id="revenue-value"></span></div>
        </div>
        <button id="dashboard-popular-places-btn">Popular</button>
        <input type="hidden" id="id_latitude"><input type="hidden" id="id_longitude">
        <select id="id_crowd_intensity"></select></body>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1:8000/dashboard/?x=1', virtualConsole: vc, pretendToBeVisual: true });
    const w = dom.window;
    windows.push(w);
    globalThis.__doc = w.document;
    const log = { added: [], fit: [], fetches: [], views: [] };
    w.L = fakeLeaflet(log);
    w.fetch = async (url, opts = {}) => {
        log.fetches.push({ url, body: typeof opts.body === 'string' ? JSON.parse(opts.body) : null });
        return fetchImpl(url, opts, log);
    };
    w.WebSocket = function () { return { send() {}, close() {}, readyState: 0 }; };
    w.SupabaseAuth = w.SupabaseAuth || { getSession: async () => null, requireAuth: (_n, fn) => fn(), showNotification() {} };
    w.eval(FAV_SCRIPT);
    w.eval(SCRIPT + '\n;window.__t = { addMonoBaseLayers, addSaveLocationControl, focusMapOnOpportunityOrLocation, setDashboardMap: (m) => { dashboardMap = m; map = m; }, findPopularPlaces, updateCrowdIntensityDropdown, getCurrentAnalysisLocation, setAnalysisLocation, findMyLocation, selectSearchResult, createOpportunityCard, loadRecommendationCardsForLocation, initDashboardRecsDropdown, openRecommendationsView, renderBusinessRecommendationCards, openDashboardDataOnlyMode };');
    const m = w.L.map();
    w.__t.setDashboardMap(m);
    return { w, log, m };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('pending (202) is waited out with progress, then the result is drawn inside a fitted 5 km circle', async () => {
    let calls = 0;
    const statuses = [];
    const { w, log, m } = setup({
        fetchImpl: async (url, opts) => {
            calls += 1;
            if (calls === 1) return json(202, { success: false, pending: true, retry_after: 0.01, error: 'busy' });
            const b = JSON.parse(opts.body);
            return json(200, areaResponse(b.latitude, b.longitude));
        },
    });
    const obs = new w.MutationObserver(() => statuses.push(w.document.getElementById('map-status').textContent));
    obs.observe(w.document.getElementById('map-status'), { childList: true, characterData: true, subtree: true });
    const res = await w.__t.findPopularPlaces(UTTARAHALLI.lat, UTTARAHALLI.lng, false, { name: 'Uttarahalli', view: 'area' });
    assert.equal(res.success, true);
    assert.equal(calls, 2);
    assert.ok(statuses.some((s) => /still fetching/i.test(s)), statuses.join(' | '));
    const radius = log.added.find((l) => l.kind === 'circle' && l.opts.radius === 5000);
    assert.ok(radius, 'the 5 km analysis circle is drawn');
    assert.ok(m.layers.has(radius));
    assert.equal(log.fit[0].radius, 5000, 'map is fitted to the analysis circle');
    assert.equal(w.document.getElementById('crowd-score-value').textContent, '4,228');
    assert.match(w.document.getElementById('revenue-estimate-item').title, /Sum of revenue-engine estimates/);
    assert.equal(w.lastHeatmapAnalysis.lat, UTTARAHALLI.lat);
    assert.match(w.document.getElementById('map-status').textContent, /Analysis ready/);
});

test('crowd circles are coloured by level (not all red)', async () => {
    const { w, log } = setup({ fetchImpl: async (u, o) => { const b = JSON.parse(o.body); return json(200, areaResponse(b.latitude, b.longitude)); } });
    await w.__t.findPopularPlaces(UTTARAHALLI.lat, UTTARAHALLI.lng, false);
    const fills = new Set(log.added.filter((l) => l.kind === 'circle' && l.opts.radius !== 5000).map((l) => l.opts.fillColor));
    assert.deepEqual([...fills].sort(), ['#22c55e', '#ef4444', '#f59e0b']);
});

test('a slow answer for an older location never overwrites the newer one', async () => {
    const gates = [];
    const { w } = setup({
        fetchImpl: (url, opts) => new Promise((resolve) => {
            const b = JSON.parse(opts.body);
            gates.push(() => resolve(json(200, areaResponse(b.latitude, b.longitude))));
        }),
    });
    const kerala = w.__t.findPopularPlaces(9.17, 76.50, false, { name: 'Kayamkulam' });
    await tick();
    const bengaluru = w.__t.findPopularPlaces(UTTARAHALLI.lat, UTTARAHALLI.lng, false, { name: 'Uttarahalli' });
    await tick();
    gates[1]();                 // newer request answers first
    assert.equal((await bengaluru).success, true);
    gates[0]();                 // the old one answers late
    const old = await kerala;
    assert.notEqual(old.success, true);
    assert.equal(w.lastHeatmapAnalysis.lat, UTTARAHALLI.lat);
    assert.equal(w.__t.getCurrentAnalysisLocation().name, 'Uttarahalli');
    assert.equal(JSON.parse(w.localStorage.getItem('selectedLocation')).name, 'Uttarahalli');
});

test('Overpass failure: clear error with a Retry button, no fake data', async () => {
    const { w, log } = setup({ fetchImpl: async () => json(503, { success: false, error: 'OpenStreetMap data could not be retrieved right now. Please retry in a minute.' }) });
    const res = await w.__t.findPopularPlaces(UTTARAHALLI.lat, UTTARAHALLI.lng, false);
    assert.equal(res.success, false);
    const status = w.document.getElementById('map-status');
    assert.match(status.textContent, /could not be retrieved/);
    assert.ok(status.querySelector('button'), 'retry button');
    assert.equal(log.added.filter((l) => l.kind === 'marker').length, 0);
});

test('Find My Location makes the GPS point the analysis location (no ReferenceError)', async () => {
    const { w, log } = setup({ fetchImpl: async () => json(200, { success: true }) });
    w.document.body.insertAdjacentHTML('beforeend', '<button id="dashboard-find-location-btn">Find</button>');
    w.localStorage.setItem('selectedLocation', JSON.stringify({ lat: 9.17, lng: 76.5, name: 'Kayamkulam', ts: Date.now() - 3 * 864e5 }));
    Object.defineProperty(w.navigator, 'geolocation', { value: {
        getCurrentPosition: (ok) => ok({ coords: { latitude: UTTARAHALLI.lat, longitude: UTTARAHALLI.lng, accuracy: 20 } }),
    } });
    const res = await w.__t.findMyLocation('dashboard-find-location-btn');
    assert.equal(res.success, true);
    const loc = w.__t.getCurrentAnalysisLocation();
    assert.equal(loc.lat, UTTARAHALLI.lat);
    assert.ok(log.added.some((l) => l.kind === 'circle' && l.opts.radius === 5000));
});

test('a days-old stored location is not reused as the current location', async () => {
    const { w } = setup({ fetchImpl: async () => json(200, {}) });
    w.localStorage.setItem('selectedLocation', JSON.stringify({ lat: 9.17, lng: 76.5, name: 'Kayamkulam', ts: Date.now() - 3 * 864e5 }));
    assert.equal(w.__t.getCurrentAnalysisLocation(), null);
});

test('recommendation cards show revenue, break-even, competition and crowd level – no invented defaults', async () => {
    const { w } = setup({ fetchImpl: async () => json(200, {}) });
    const html = w.__t.createOpportunityCard({ rank: 1, name: 'Pharmacy', locality: 'Uttarahalli', category: 'pharmacy',
        target_lat: 12.91, target_lon: 77.55, starting_monthly_revenue: 293700, estimated_monthly_profit: 73400,
        break_even_months: 16.3, setup_cost_estimate: 1200000, competition_level: 'Low', competitors_1km: 1,
        crowd_level: 'medium', reasons: ['<b>x</b>'], badge: 'ML top pick' }, 12.9, 77.5);
    assert.match(html, /₹2,93,700/);
    assert.match(html, /16\.3 months/);
    assert.match(html, /Medium/);
    assert.match(html, /\(1 ≤1 km\)/);
    assert.ok(!html.includes('<b>x</b>'), 'reasons are escaped');
    const empty = w.__t.createOpportunityCard({ rank: 2, name: 'X' }, 12.9, 77.5);
    assert.ok(!/50,000|28,000|22,000/.test(empty), 'no hard-coded fallback money values');
});

test('recommendations are requested for the chosen location and category', async () => {
    const { w, log } = setup({ fetchImpl: async (url) => json(200, { success: true, recommendations: [
        { rank: 1, name: 'Cafe', category: 'cafe', starting_monthly_revenue: 600000, target_lat: 12.9, target_lon: 77.5 }] }) });
    w.document.body.insertAdjacentHTML('beforeend', '<div id="dashboard-recommendations-cards-container"></div>');
    await w.__t.loadRecommendationCardsForLocation(12.9066, 77.5468, 'Uttarahalli', 'Cafe');
    const req = log.fetches.find((f) => f.url === '/api/location-recommendations/');
    assert.equal(req.body.latitude, 12.9066);
    assert.equal(req.body.category, 'Cafe');
    assert.match(w.document.getElementById('dashboard-recommendations-cards-container').textContent, /Cafe/);
});

test('location dropdown lists the current location and recent searches, not hard-coded areas', async () => {
    const { w } = setup({ fetchImpl: async () => json(200, { business_types: [{ value: 'Cafe', label: 'Cafe' }] }) });
    w.document.body.insertAdjacentHTML('beforeend', '<select id="dashboard-rec-location-select"></select><select id="dashboard-rec-category-select"><option value="">All</option></select>');
    w.__t.setAnalysisLocation(9.17, 76.5, 'Kayamkulam');
    w.__t.setAnalysisLocation(12.9066, 77.5468, 'Uttarahalli');
    await w.__t.initDashboardRecsDropdown();
    const sel = w.document.getElementById('dashboard-rec-location-select');
    const labels = [...sel.querySelectorAll('optgroup')].map((g) => g.label);
    assert.deepEqual(labels, ['Current location', 'Recent searches']);
    assert.equal(JSON.parse(sel.value).name, 'Uttarahalli');
    assert.ok(![...sel.options].some((o) => /MG Road|Koramangala/.test(o.textContent)));
    assert.equal(w.document.getElementById('dashboard-rec-category-select').options.length, 2);
});

test('startup form: one submission, location required, then map + verdict + report button', async () => {
    const submits = [];
    const { w } = setup({ fetchImpl: async (url, opts) => {
        if (url === '/submit-form/') {
            submits.push(opts);
            return json(200, { success: true, message: 'Thank you, Rajan! Your business inquiry has been saved.', inquiry_id: 1,
                feasibility: { status: 'ok', feasible: true, verdict: 'Go', message: 'Feasible', reasons: ['<i>r</i>'], intensity_note: '2 sectors match' },
                redirect: { latitude: 12.9066, longitude: 77.5468, name: 'Uttarahalli', business_type: 'Cafe', crowd_intensity: 'medium' } });
        }
        const b = typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
        return json(200, areaResponse(b.latitude, b.longitude));
    } });
    w.document.body.insertAdjacentHTML('beforeend', `
        <div id="dashboard-startup-form-section"><form id="dashboard-business-form">
          <input name="csrfmiddlewaretoken" value="t"><input id="dashboard-form-location-search" name="location_name">
          <div id="dashboard-form-location-suggestions"></div>
          <select id="dashboard-id_business_type_dropdown" name="business_type"><option value="Cafe" selected>Cafe</option></select>
          <input type="hidden" id="dashboard-id_latitude" name="latitude"><input type="hidden" id="dashboard-id_longitude" name="longitude">
          <button id="dashboard-submit-business-form-btn" type="submit"></button><button id="dashboard-reset-business-form-btn" type="button"></button>
        </form><div id="dashboard-feasibility-result-banner" class="d-none"></div><div id="dashboard-form-message"></div></div>
        <button id="btn-show-map"></button>`);
    w.eval(FORM_SCRIPT + '\n;window.__f = { initDashboardStartupForm };');
    w.__f.initDashboardStartupForm();
    w.__f.initDashboardStartupForm();   // opening the form twice must not double-submit
    const form = w.document.getElementById('dashboard-business-form');

    form.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await tick(10);
    assert.equal(submits.length, 0);
    assert.match(w.document.getElementById('dashboard-form-message').textContent, /suggestions list/);

    w.document.getElementById('dashboard-id_latitude').value = '12.9066';
    w.document.getElementById('dashboard-id_longitude').value = '77.5468';
    form.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await tick(50);
    assert.equal(submits.length, 1);
    assert.match(w.document.getElementById('dashboard-feasibility-result-banner').textContent, /Go/);
    assert.ok(w.document.getElementById('dashboard-feasibility-result-banner').textContent.includes('<i>r</i>'), 'reasons escaped');
    await tick(2000);  // 1.2 s delay, then the map flow
    assert.equal(w.__t.getCurrentAnalysisLocation().name, 'Uttarahalli');
    assert.equal(w.lastHeatmapAnalysis.lat, 12.9066);
    const panel = w.document.getElementById('startup-verdict-panel');
    assert.ok(panel && /Go/.test(panel.textContent));
    assert.equal(panel.querySelector('button:not(.report-progress-close)'), null, 'no extra buttons');
    // The existing report button reads the selected area, which now carries the form's category.
    assert.equal(w.__t.getCurrentAnalysisLocation().category, 'Cafe');
});

test('Business Recommendations view: shows only the recommendations for the current location', async () => {
    const { w, log } = setup({ fetchImpl: async (url) => json(200, String(url).includes('business-types') ? { business_types: [] }
        : { success: true, recommendations: [{ rank: 1, name: 'Pharmacy', category: 'pharmacy', starting_monthly_revenue: 290000, target_lat: 12.9, target_lon: 77.5, locality: 'Uttarahalli' }] }) });
    w.document.body.insertAdjacentHTML('beforeend', `
        <div id="dashboard-launchpad"></div><div id="dynamic-map-container"></div>
        <a id="sidebar-recs-link" class="sidebar-link"></a>
        <div id="dashboard-analytics-section" class="d-none"><div id="business-intelligence-panel"></div>
          <div id="business-recommendations-section" class="d-none"><select id="dashboard-rec-location-select"></select>
            <select id="dashboard-rec-category-select"><option value="">All</option></select>
            <div id="dashboard-recommendations-cards-container"></div></div></div>`);
    await tick(50);  // let the page's own DOMContentLoaded start-up run first, as in the browser
    w.__t.setAnalysisLocation(12.9066, 77.5468, 'Uttarahalli');
    await w.__t.openRecommendationsView();
    const hidden = (id) => w.document.getElementById(id).classList.contains('d-none');
    assert.equal(hidden('business-recommendations-section'), false);
    assert.equal(hidden('dashboard-analytics-section'), false);
    assert.equal(hidden('dynamic-map-container'), true);
    assert.equal(hidden('dashboard-launchpad'), true);
    assert.equal(hidden('business-intelligence-panel'), true);
    assert.ok(w.document.getElementById('sidebar-recs-link').classList.contains('active'));
    assert.equal(log.fetches.find((f) => f.url === '/api/location-recommendations/').body.location_name, 'Uttarahalli');
    assert.match(w.location.search, /recs=true/);
    assert.match(w.document.getElementById('dashboard-recommendations-cards-container').textContent, /Pharmacy/);
});

test('rendering recommendation cards never un-hides sections (no cards under the map)', async () => {
    const { w } = setup({ fetchImpl: async () => json(200, {}) });
    w.document.body.insertAdjacentHTML('beforeend', `<div id="dashboard-analytics-section" class="d-none">
        <div id="business-recommendations-section" class="d-none"><div id="dashboard-recommendations-cards-container"></div></div></div>`);
    w.__t.renderBusinessRecommendationCards([{ rank: 1, name: 'Cafe', starting_monthly_revenue: 1, target_lat: 1, target_lon: 1 }], 1, 1);
    assert.ok(w.document.getElementById('dashboard-analytics-section').classList.contains('d-none'));
    assert.ok(w.document.getElementById('business-recommendations-section').classList.contains('d-none'));
});

test('selected-area state: radius, category and shortened name; analysis context saved on a finished scan', async () => {
    const { w } = setup({ fetchImpl: async (u, o) => { const b = JSON.parse(o.body); return json(200, areaResponse(b.latitude, b.longitude, { analysis_id: 'abc123', analysis_radius: 5000 })); } });
    const loc = w.__t.setAnalysisLocation(12.9758, 77.7027, 'Marathalli Bridge Service Road, Gandhi Nagar, Munekolala, Bengaluru, Karnataka, 560037, India', { category: 'Cafe' });
    assert.equal(loc.name, 'Marathalli Bridge Service Road, Gandhi Nagar, Munekolala');
    assert.equal(loc.radius, 5000);
    assert.equal(loc.category, 'Cafe');
    assert.equal(w.getAnalysisContext(), null, 'no context before an analysis finishes');
    let event = null;
    w.document.addEventListener('analysis:context', (e) => { event = e.detail; });
    await w.__t.findPopularPlaces(12.9758, 77.7027, false);
    const ctx = w.getAnalysisContext();
    assert.equal(ctx.analysis_id, 'abc123');
    assert.equal(ctx.lat, 12.9758);
    assert.equal(ctx.name, 'Marathalli Bridge Service Road, Gandhi Nagar, Munekolala');
    assert.equal(event.analysis_id, 'abc123');
    assert.equal(w.__t.getCurrentAnalysisLocation().analysis_id, 'abc123');
});

test('existing Business Analytics entry shows the graph for the last Popular Locations analysis', async () => {
    const { w } = setup({ fetchImpl: async (u, o) => {
        const b = typeof o.body === 'string' ? JSON.parse(o.body) : {};
        return json(200, u === '/find-popular-places/' ? areaResponse(b.latitude, b.longitude, { analysis_id: 'ctx-1', analysis_radius: 5000 })
                                                        : { success: true, recommendations: [], business_types: [] });
    } });
    w.document.body.insertAdjacentHTML('beforeend', `<div id="dashboard-launchpad"></div><div id="dynamic-map-container"></div>
        <a id="sidebar-ai-link" class="sidebar-link"></a><a id="sidebar-recs-link" class="sidebar-link active"></a>
        <div id="dashboard-analytics-section" class="d-none"><div id="business-intelligence-panel" class="d-none"><section id="revenue-analytics-3d"></section></div>
        <div id="business-recommendations-section" class="d-none"><div id="dashboard-recommendations-cards-container"></div></div></div>`);
    const shown = [];
    w.RevenueAnalytics3D = { show: (ctx) => shown.push(ctx), hide() {} };
    await tick(50);
    w.history.replaceState({}, '', '/dashboard/?recs=true&ai=true');

    await w.__t.openDashboardDataOnlyMode('ai');
    assert.equal(shown[0], null, 'no analysis yet -> empty state, never a default area');

    w.__t.setAnalysisLocation(12.9066, 77.5468, 'Uttarahalli');
    await w.__t.findPopularPlaces(12.9066, 77.5468, false);
    await w.__t.openDashboardDataOnlyMode('ai');
    const ctx = shown[shown.length - 1];
    assert.equal(ctx.analysis_id, 'ctx-1');
    assert.equal(ctx.lat, 12.9066);
    assert.equal(w.location.search, '?ai=true', 'recs/auto_map removed from the URL');
    assert.ok(w.document.getElementById('sidebar-ai-link').classList.contains('active'));
    assert.ok(!w.document.getElementById('sidebar-recs-link').classList.contains('active'));
    const hidden = (id) => w.document.getElementById(id).classList.contains('d-none');
    assert.equal(hidden('business-intelligence-panel'), false);
    assert.equal(hidden('business-recommendations-section'), false, 'recommendations stay below the graph');
    assert.equal(hidden('dynamic-map-container'), true);
});

test('choosing a place zooms the map in to its pin; Popular Locations keeps the whole 5 km view', async () => {
    const { w, log } = setup({ fetchImpl: async (u, o) => { const b = typeof o.body === 'string' ? JSON.parse(o.body) : {}; return json(200, areaResponse(b.latitude, b.longitude)); } });
    await w.__t.selectSearchResult(UTTARAHALLI.lat, UTTARAHALLI.lng, 'Uttarahalli');
    const fly = log.views.find((v) => v.fly);
    assert.ok(fly, 'map flies to the pin');
    assert.deepEqual([...fly.ll], [UTTARAHALLI.lat, UTTARAHALLI.lng]);
    assert.ok(fly.z >= 15);
    assert.equal(log.fit.length, 0, 'not zoomed back out to the 5 km circle');
    assert.ok(log.added.some((l) => l.kind === 'circle' && l.opts.radius === 5000), 'radius still drawn');

    const before = log.views.length;
    await w.__t.findPopularPlaces(UTTARAHALLI.lat, UTTARAHALLI.lng, false, { view: 'area' });
    assert.equal(log.fit[0].radius, 5000);
    assert.equal(log.views.length, before, 'area view does not zoom to the pin');
});

test('startup form flow ends zoomed in on the submitted location', async () => {
    const { w, log } = setup({ fetchImpl: async (u, o) => { const b = typeof o.body === 'string' ? JSON.parse(o.body) : {}; return json(200, areaResponse(b.latitude, b.longitude)); } });
    await w.__t.findPopularPlaces(12.9758, 77.7027, false, { name: 'Marathahalli' });
    const fly = log.views.filter((v) => v.fly).pop();
    assert.deepEqual([...fly.ll], [12.9758, 77.7027]);
});


test('heatmap base map: darkened satellite plus white road/building outline layer, both CORS-enabled', () => {
    const { w, m } = setup({ fetchImpl: async () => json(200, {}) });
    const group = w.__t.addMonoBaseLayers(m);
    const [sat, lines] = group.layers;
    assert.match(sat.url, /maptiler\.com\/tiles\/satellite-v2/);
    assert.equal(sat.opts.className, 'mono-sat');
    assert.match(lines.url, /maptiler\.com\/maps\/toner-v2/);
    assert.equal(lines.opts.className, 'mono-lines');
    assert.ok(sat.opts.crossOrigin && lines.opts.crossOrigin, 'PDF capture needs CORS tiles');
    assert.ok(lines.opts.zIndex > sat.opts.zIndex);
    assert.match(sat.opts.attribution, /OpenStreetMap/);
});

test('map control offers a heart for the selected location (search, pin, GPS, form all set it)', () => {
    const { w, m, log } = setup({ fetchImpl: async () => json(200, {}) });
    w.__t.addSaveLocationControl(m);
    const el = log.controls[0].el;
    assert.equal(el.classList.contains('d-none'), true, 'hidden until a location is chosen');
    w.__t.setAnalysisLocation(12.905512, 77.545488, 'Uttarahalli, Bengaluru, Karnataka');
    assert.equal(el.classList.contains('d-none'), false);
    const heart = el.querySelector('.fav-btn');
    assert.equal(heart.dataset.key, 'geo:12.9055:77.5455:');
    assert.match(el.textContent, /Uttarahalli/);
    w.__t.setAnalysisLocation(12.9352, 77.6245, 'Koramangala');
    assert.equal(el.querySelector('.fav-btn').dataset.key, 'geo:12.9352:77.6245:');
});

test('recommendation cards carry a heart for their suggested spot', () => {
    const { w } = setup({ fetchImpl: async () => json(200, {}) });
    const html = w.__t.createOpportunityCard({ rank: 1, name: 'Pharmacy', category: 'pharmacy', locality: 'Uttarahalli',
        target_lat: 12.9249, target_lon: 77.5408, starting_monthly_revenue: 100000, potential_score: 64 }, 12.9, 77.5);
    const div = w.document.createElement('div');
    div.innerHTML = html;
    const heart = div.querySelector('.fav-btn');
    assert.ok(heart);
    assert.equal(heart.dataset.key, 'geo:12.9249:77.5408:');
});

test('opening a saved location selects it, draws its circle and runs the existing analysis', async () => {
    const { w, log } = setup({ fetchImpl: async (url) => json(200, url.includes('popular') ? areaResponse(12.9352, 77.6245) : {}) });
    await w.__t.focusMapOnOpportunityOrLocation('12.9352', '77.6245', 'Koramangala');
    const loc = w.__t.getCurrentAnalysisLocation();
    assert.equal(loc.lat, 12.9352);
    assert.equal(loc.name, 'Koramangala');
    const scan = log.fetches.find((f) => f.url.includes('find-popular-places'));
    assert.ok(scan, 'analysis requested through the existing pipeline');
    assert.equal(Number(scan.body.latitude), 12.9352);
    assert.ok(log.added.some((l) => l.kind === 'circle' && l.opts.radius === 5000), '5 km analysis circle drawn');
});
