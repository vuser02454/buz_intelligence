// Tests for static/js/favorites.js: saved-location hearts and the /favorites/ page
// (Supabase session and fetch are stubbed; no network).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../../static/js/favorites.js'), 'utf8');
const windows = [];
after(() => windows.forEach((w) => w.close()));

const PAGE = `<div id="favorites-page">
    <div id="fav-gate" class="d-none"></div>
    <div id="fav-content" class="d-none">
        <span id="fav-count"></span><button id="btn-download-favs-report"></button>
        <div class="fav-search-wrap d-none"><input id="fav-search"></div>
        <div id="fav-chips"></div><div id="fav-list"></div>
        <span id="reports-count"></span><div id="reports-list"></div>
        <p id="rec-sub"></p><div id="rec-list"></div>
    </div></div>`;

const FAVS = [
    { id: 1, place_key: 'geo:12.9055:77.5455:', name: 'Uttarahalli', category: '', latitude: 12.9055, longitude: 77.5455,
      address: '', potential_score: null, created_at: '2026-10-27T10:00:00Z', analysis: { status: 'fresh', places: 9823 } },
    { id: 2, place_key: 'osm:node:5', name: 'Cafe Day', category: 'cafe', latitude: 12.97, longitude: 77.59,
      address: 'MG Road', potential_score: 64, created_at: '2026-10-20T10:00:00Z', analysis: { status: 'stale' } },
    { id: 3, place_key: 'geo:12.9352:77.6245:', name: 'Koramangala', category: '', latitude: 12.9352, longitude: 77.6245,
      address: '', potential_score: null, created_at: '2026-10-12T10:00:00Z', analysis: { status: 'none' } },
];

function setup({ page = true, signedIn = true, favorites = FAVS } = {}) {
    const dom = new JSDOM(`<!DOCTYPE html><body>${page ? PAGE : ''}</body>`,
        { runScripts: 'outside-only', url: 'http://127.0.0.1:8000/favorites/' });
    const w = dom.window;
    windows.push(w);
    const calls = [];
    let rows = favorites.slice();
    w.fetch = async (url, opts = {}) => {
        calls.push({ url, opts });
        const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
        if (url === '/api/favorites/' && (!opts.method || opts.method === 'GET')) return json({ success: true, favorites: rows });
        if (url === '/api/favorites/toggle/') {
            const body = JSON.parse(opts.body);
            const had = rows.some((r) => r.place_key === body.place_key);
            rows = had ? rows.filter((r) => r.place_key !== body.place_key) : [...rows, { id: 9, ...body }];
            return json({ success: true, favorited: !had, place_key: body.place_key, favorite: { id: 9 } });
        }
        if (url.startsWith('/api/favorites/') && opts.method === 'DELETE') {
            const id = Number(url.split('/')[3]);
            rows = rows.filter((r) => r.id !== id);
            return json({ success: true });
        }
        if (url.startsWith('/api/favorites/recommendations/')) return json({ success: true, personalized: false, recommendations: [] });
        if (url === '/api/reports/') return json({ success: true, reports: [] });
        if (url === '/api/location-recommendations/') {
            return json({ success: true, recommendations: [{ name: 'Grocery Store', starting_monthly_revenue: 2911800, synergy: { score: 83.1 } }] });
        }
        return json({}, 404);
    };
    const toasts = [];
    w.SupabaseAuth = {
        getSession: async () => (signedIn ? { access_token: 'tok' } : null),
        requireAuth: (_n, fn) => fn(),
        showNotification: (msg) => toasts.push(msg),
    };
    w.eval(SCRIPT);
    return { w, calls, toasts, rows: () => rows };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('locationPayload: name-independent key, so a spot is saved once', () => {
    const { w } = setup({ page: false });
    const a = w.Favorites.locationPayload({ lat: 12.905512, lng: 77.545488, name: 'Uttarahalli' });
    const b = w.Favorites.locationPayload({ latitude: 12.90551, longitude: 77.54549, name: 'Map Selection' });
    assert.equal(a.place_key, 'geo:12.9055:77.5455:');
    assert.equal(a.place_key, b.place_key);
    assert.equal(w.Favorites.placeKey(a), a.place_key);
    assert.equal(w.Favorites.locationPayload({ lat: 'x', lng: 1 }), null);
    assert.match(w.Favorites.locationPayload({ lat: 1, lng: 2 }).name, /^Location 1\.0000, 2\.0000$/);
});

test('heart toggles a saved location on and off (with confirmation)', async () => {
    const { w, calls, toasts } = setup({ page: false, favorites: [] });
    const payload = w.Favorites.locationPayload({ lat: 12.9055, lng: 77.5455, name: 'Uttarahalli' });
    w.document.body.innerHTML = w.Favorites.heartHtml(payload);
    const btn = () => w.document.querySelector('.fav-btn');
    assert.equal(btn().getAttribute('aria-pressed'), 'false');
    btn().click();
    await tick();
    assert.equal(btn().classList.contains('active'), true);
    assert.equal(btn().getAttribute('aria-pressed'), 'true');
    assert.equal(toasts.at(-1), 'Saved to your favorites');
    btn().click();
    await tick();
    assert.equal(btn().classList.contains('active'), false);
    assert.equal(toasts.at(-1), 'Removed from favorites');
    const toggles = calls.filter((c) => c.url === '/api/favorites/toggle/');
    assert.equal(toggles.length, 2);
    assert.equal(toggles[0].opts.headers.Authorization, 'Bearer tok');
});

test('favorites page: cards with saved date, coordinates, analysis state and open link', async () => {
    const { w } = setup();
    await tick(80);
    const cards = [...w.document.querySelectorAll('#fav-list .fav-card')];
    assert.equal(cards.length, 3);
    assert.equal(w.document.getElementById('fav-count').textContent, '3');
    const [utt, cafe, kor] = cards;
    assert.match(utt.textContent, /Uttarahalli/);
    assert.match(utt.textContent, /12\.9055, 77\.5455/);
    assert.match(utt.textContent, /Saved/);
    assert.match(utt.querySelector('.fav-cat').textContent, /Location/);
    assert.match(utt.querySelector('.fav-analysis').textContent, /up to date/);
    assert.match(cafe.querySelector('.fav-analysis').textContent, /refreshes when opened/);
    assert.match(kor.querySelector('.fav-analysis').textContent, /Not analysed yet/);
    const open = new URL(utt.querySelector('.fav-open').getAttribute('href'), 'http://x');
    assert.equal(open.pathname, '/dashboard/');
    assert.equal(open.searchParams.get('auto_map'), 'true');
    assert.equal(open.searchParams.get('lat'), '12.9055');
    assert.equal(open.searchParams.get('lon'), '77.5455');
    assert.equal(open.searchParams.get('name'), 'Uttarahalli');
});

test('summaries load only for places whose analysis is cached', async () => {
    const { w, calls } = setup();
    await tick(120);
    const recCalls = calls.filter((c) => c.url === '/api/location-recommendations/');
    assert.equal(recCalls.length, 2, 'fresh + stale, not the never-analysed place');
    assert.deepEqual(recCalls.map((c) => JSON.parse(c.opts.body).location_name), ['Uttarahalli', 'Cafe Day']);
    const utt = w.document.querySelector('.fav-card[data-id="1"]');
    assert.match(utt.querySelector('.fav-summary').textContent, /Grocery Store/);
    assert.match(utt.querySelector('.fav-summary').textContent, /29,11,800/);
    assert.equal(w.document.querySelector('.fav-card[data-id="3"] .fav-summary'), null);
});

test('search filters saved locations; remove deletes server-side', async () => {
    const { w, rows } = setup();
    await tick(80);
    const search = w.document.getElementById('fav-search');
    assert.equal(search.closest('.fav-search-wrap').classList.contains('d-none'), false);
    search.value = 'kora';
    search.dispatchEvent(new w.Event('input'));
    assert.deepEqual([...w.document.querySelectorAll('#fav-list .fav-card h3')].map((h) => h.textContent), ['Koramangala']);
    search.value = 'zzz';
    search.dispatchEvent(new w.Event('input'));
    assert.match(w.document.getElementById('fav-list').textContent, /No saved locations match/);
    search.value = '';
    search.dispatchEvent(new w.Event('input'));
    w.document.querySelector('.fav-remove[data-id="3"]').click();
    await tick(80);
    assert.deepEqual(rows().map((r) => r.id), [1, 2]);
    assert.equal(w.document.querySelectorAll('#fav-list .fav-card').length, 2);
});

test('empty state and sign-in gate', async () => {
    const empty = setup({ favorites: [] });
    await tick(60);
    assert.match(empty.w.document.getElementById('fav-list').textContent, /You haven’t saved any locations yet/);
    const gated = setup({ signedIn: false });
    await tick(60);
    assert.equal(gated.w.document.getElementById('fav-gate').classList.contains('d-none'), false);
    assert.equal(gated.calls.length, 0, 'no favorites request without a session');
});
