// Tests for static/js/revenue-3d.js: formatting helpers and the Business Analytics graph flow.
// jsdom has no WebGL, so the 2D fallback path is exercised.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../../static/js/revenue-3d.js'), 'utf8');
const windows = [];
after(() => windows.forEach((w) => w.close()));

function payload(area, analysisId, scale = 1) {
    const view = (buckets, extra = {}) => {
        const series = { cafe: buckets.map((_, i) => (i + 1) * 1000 * scale), school: buckets.map(() => 500 * scale) };
        const totals = buckets.map((_, i) => series.cafe[i] + series.school[i]);
        return { buckets, series, totals, total: totals.reduce((a, b) => a + b, 0),
                 peak: { index: buckets.length - 1, label: buckets[buckets.length - 1], value: totals[totals.length - 1] },
                 top_category: 'cafe', growth_pct: 4.2, growth_label: 'vs yesterday', ...extra };
    };
    return {
        success: true, is_estimate: true, analysis_id: analysisId,
        area: { name: area, radius_m: 5000 },
        confidence: { level: 'medium', score: 66, note: '' },
        assumptions: { radius_m: 5000, mapped_places: 4229, places_estimated: 30, crowd_level: 'medium' },
        categories: [{ key: 'cafe', label: 'Cafe', places: 4 }, { key: 'school', label: 'School & education', places: 2 }],
        views: {
            live: view(['00:00', '01:00', '02:00'], { now_index: 2, now_rate_per_hour: 3456, now_label: '02:30:00', today_so_far: 9000, growth_label: 'rate vs one hour ago' }),
            daily: view(Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`)),
            weekly: view(['Mon 26', 'Tue 27', 'Wed 28', 'Thu 29', 'Fri 30', 'Sat 31', 'Sun 1'], { growth_pct: null, growth_label: 'no trend' }),
            monthly: view(['1–4 Oct', '5–11 Oct', '12–18 Oct', '19–25 Oct', '26–31 Oct']),
        },
    };
}

function setup(respond) {
    const dom = new JSDOM('<!DOCTYPE html><body><section id="revenue-analytics-3d"></section></body>',
        { runScripts: 'outside-only', url: 'http://127.0.0.1:8000/dashboard/?ai=true', pretendToBeVisual: true });
    const w = dom.window;
    windows.push(w);
    const calls = [];
    w.fetch = async (url, opts) => {
        const body = JSON.parse(opts.body);
        calls.push({ url, body, headers: opts.headers });
        const r = await respond(body, calls.length);
        return { status: r.status, json: async () => r.data };
    };
    w.SupabaseAuth = { getSession: async () => ({ access_token: 'tok' }) };
    w.getCookie = () => 'csrf';
    w.WebSocket = function () { throw new Error('no websockets here'); };
    w.eval(SCRIPT);
    return { w, calls, R: w.RevenueAnalytics3D, $: (s) => w.document.querySelector(s) };
}

const until = async (cond, ms = 3000) => {
    const t = Date.now();
    while (!cond()) {
        if (Date.now() - t > ms) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 10));
    }
};

test('Indian number formatting and compact axis labels', () => {
    const { R } = setup(() => ({}));
    assert.equal(R.formatINR(19574128), '₹1,95,74,128');
    assert.equal(R.formatINR(840000), '₹8,40,000');
    assert.equal(R.compactINR(19574128), '₹2 Cr');
    assert.equal(R.compactINR(18900000), '₹1.9 Cr');
    assert.equal(R.compactINR(840000), '₹8.4 L');
    assert.equal(R.compactINR(45200), '₹45.2 K');
    assert.equal(R.compactINR(950), '₹950');
    assert.equal(R.formatPct(3.14), '+3.1%');
    assert.equal(R.formatPct(null), '—');
    assert.deepEqual([...R.gradientColor(0)], [34, 211, 238]);   // cyan
    assert.deepEqual([...R.gradientColor(1)], [236, 72, 153]);   // pink
});

test('no analysed area: clean empty state, no request, no default data', async () => {
    const { R, calls, $ } = setup(() => ({}));
    R.show(null);
    assert.match($('.r3d-message').textContent, /No area analysed yet/);
    assert.equal($('.r3d-message a').getAttribute('href'), '/dashboard/?auto_map=true');
    assert.equal(calls.length, 0);
    assert.equal($('[data-kpi="total"]').textContent, '—');
});

test('renders the projection for the analysed area with KPIs, labels and auth', async () => {
    const { R, calls, $ } = setup(() => ({ status: 200, data: payload('Uttarahalli', 'a1') }));
    R.show({ name: 'Uttarahalli', lat: 12.9066, lng: 77.5468, radius: 5000, analysis_id: 'a1' });
    await until(() => $('.r3d-area-name').textContent === 'Uttarahalli' && $('[data-kpi="total"]').textContent !== '—');
    assert.equal(calls[0].url, '/api/revenue-timeseries/');
    assert.deepEqual([calls[0].body.lat, calls[0].body.lng, calls[0].body.radius], [12.9066, 77.5468, 5000]);
    assert.equal(calls[0].headers.Authorization, 'Bearer tok');
    assert.equal($('.r3d-radius').textContent, '5 km radius');
    assert.match($('.r3d-badge').textContent, /Projected estimate/);
    assert.match($('#r3d-method').textContent, /not sales data/);
    assert.equal($('[data-kpi="top"]').textContent, 'Cafe');
    assert.equal($('[data-kpi="growth"]').textContent, '+4.2%');
    assert.match($('.r3d-confidence').textContent, /Confidence: medium/);
    assert.ok($('.r3d-skeleton').classList.contains('d-none'));
    assert.ok(R._state.root.classList.contains('r3d-2d-mode'), 'WebGL unavailable -> 2D fallback');
});

test('tabs switch views; live shows today so far and the now rate', async () => {
    const { R, $, w } = setup(() => ({ status: 200, data: payload('X', 'a1') }));
    R.show({ name: 'X', lat: 1, lng: 2, analysis_id: 'a1' });
    await until(() => $('[data-kpi="total"]').textContent !== '—');
    $('.r3d-tab[data-view="live"]').click();
    assert.equal($('.r3d-tab[data-view="live"]').getAttribute('aria-selected'), 'true');
    assert.equal($('[data-kpi="total"]').textContent, '₹9,000');
    assert.match($('[data-kpi="total-note"]').textContent, /now ≈ ₹3.5 K\/hour/);
    $('.r3d-tab[data-view="weekly"]').click();
    assert.equal($('[data-kpi="growth"]').textContent, '—');
    assert.match($('[data-kpi="growth-note"]').textContent, /no trend/);
});

test('switching to a newly analysed area never shows the previous area', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { R, $ } = setup(async (body) => {
        if (body.name === 'Old area') { await gate; return { status: 200, data: payload('Old area', 'old', 5) }; }
        return { status: 200, data: payload('New area', 'new') };
    });
    R.show({ name: 'Old area', lat: 9.17, lng: 76.5, analysis_id: 'old' });
    R.show({ name: 'New area', lat: 12.9, lng: 77.5, analysis_id: 'new' });
    await until(() => R._state.data && R._state.data.analysis_id === 'new');
    release();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(R._state.data.analysis_id, 'new');
    assert.equal($('.r3d-area-name').textContent, 'New area');
});

test('API failure shows a Retry that reloads; pending shows progress', async () => {
    let n = 0;
    const { R, $ } = setup(() => {
        n += 1;
        if (n === 1) return { status: 202, data: { pending: true, retry_after: 0.01 } };
        if (n === 2) return { status: 503, data: { success: false, error: 'OpenStreetMap busy' } };
        return { status: 200, data: payload('X', 'a1') };
    });
    R.show({ name: 'X', lat: 1, lng: 2, analysis_id: 'a1' });
    await until(() => /OpenStreetMap busy/.test($('.r3d-message').textContent));
    $('.r3d-retry').click();
    await until(() => $('[data-kpi="total"]').textContent !== '—');
    assert.equal(n, 3);
});

test('live values fall back to polling when WebSockets are unavailable', async () => {
    const { R, calls, w } = setup((body) => ({ status: 200, data: payload('X', 'a1') }));
    const origSetInterval = w.setInterval;
    let pollFn = null;
    w.setInterval = (fn, ms) => { if (ms === 8000) pollFn = fn; return origSetInterval(() => {}, 1e6); };
    R.show({ name: 'X', lat: 1, lng: 2, analysis_id: 'a1' });
    await until(() => pollFn !== null);
    await pollFn();
    const poll = calls[calls.length - 1];
    assert.deepEqual(poll.body.views, ['live']);
});

test('table view lists every bucket and category with an accessible caption', async () => {
    const { R, $ } = setup(() => ({ status: 200, data: payload('X', 'a1') }));
    R.show({ name: 'X', lat: 1, lng: 2, analysis_id: 'a1' });
    await until(() => $('[data-kpi="total"]').textContent !== '—');
    $('.r3d-table-toggle').click();
    assert.equal($('.r3d-table-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal($('.r3d-table tbody').children.length, 24);
    assert.match($('.r3d-table caption').textContent, /model estimate/);
    assert.equal($('.r3d-table thead th:nth-child(2)').textContent, 'Cafe');
});
