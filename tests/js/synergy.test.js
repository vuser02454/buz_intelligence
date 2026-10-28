// Tests for static/js/synergy.js: recommendation-card block, comparison strip and the
// Business Analytics "Synergy Revenue Intelligence" panel (fetch is stubbed; no network).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../../static/js/synergy.js'), 'utf8');
const windows = [];
after(() => windows.forEach((w) => w.close()));

function setup(respond) {
    const dom = new JSDOM('<!DOCTYPE html><body><section id="synergy-revenue-intel"></section></body>',
        { runScripts: 'outside-only', url: 'http://127.0.0.1:8000/dashboard/' });
    const w = dom.window;
    windows.push(w);
    const calls = [];
    w.fetch = async (url, opts) => {
        calls.push({ url, opts });
        const r = await respond(url, opts, calls.length);
        return { ok: r.status === 200, status: r.status, json: async () => r.data };
    };
    w.eval(SCRIPT);
    return { w, calls };
}

const summary = {
    score: 72.4, level: 'Strong', confidence: 'medium',
    sources: [{ label: 'offices', count: 6, nearest_m: 187, kind: 'business', points: 5.4 },
              { label: 'bus stops', count: 3, nearest_m: 1200, kind: 'environment', points: 2.1 }],
    scenarios: { base: { monthly: 100000, additional: 0, uplift_pct: 0 },
                 conservative: { monthly: 103000, additional: 3000, uplift_pct: 3 },
                 moderate: { monthly: 106000, additional: 6000, uplift_pct: 6 },
                 optimistic: { monthly: 109000, additional: 9000, uplift_pct: 9 } },
    competitors_1km: 2, why: 'Close to <b>offices</b>.', main_risk: 'Competition nearby.', actions: ['Open early.'],
};

function full(business) {
    return {
        business, business_key: business.toLowerCase(), score: 64.2, level: 'Moderate',
        factors: [{ key: 'business', label: 'Nearby complementary businesses', score: 70, weight: 0.3, points: 21 },
                  { key: 'environment', label: 'Surrounding demand', score: 60, weight: 0.25, points: 15 },
                  { key: 'customer', label: 'Matching customer groups', score: 50, weight: 0.2, points: 10 },
                  { key: 'competition', label: 'Competition-adjusted opportunity', score: 80, weight: 0.15, points: 12 },
                  { key: 'accessibility', label: 'Accessibility', score: 62, weight: 0.1, points: 6.2 }],
        data: { confidence: 'high', mapped_places_1500m: 210, coverage: 1 },
        competition: { competitors_1km: 1 },
        revenue: { method: 'Uplift = cap × score.', rows: [
            { scenario: 'base', label: 'Base (revenue engine)', monthly: 200000, additional: 0, uplift_pct: 0 },
            { scenario: 'conservative', label: 'Conservative', monthly: 206420, additional: 6420, uplift_pct: 3.21 },
            { scenario: 'moderate', label: 'Moderate', monthly: 212840, additional: 12840, uplift_pct: 6.42 },
            { scenario: 'optimistic', label: 'Optimistic', monthly: 219260, additional: 19260, uplift_pct: 9.63 }] },
        explanation: { why: 'Why text.', opportunity: 'Projection text.', risks: ['Risk one.'], actions: ['Act one.'],
                       supports: [{ title: 'Offices', kind: 'Nearby business', examples: [{ name: 'Acme Ltd', distance_m: 120 }] }] },
    };
}

test('card block shows score, sources, base vs adjusted revenue and escapes text', () => {
    const { w } = setup(async () => ({ status: 200, data: {} }));
    const html = w.SynergyIntel.cardBlock(summary);
    const div = w.document.createElement('div');
    div.innerHTML = html;
    assert.match(div.querySelector('.syn-score-top strong').textContent, /72\.4/);
    assert.equal(div.querySelector('.syn-score').classList.contains('syn-level-strong'), true);
    assert.equal(div.querySelectorAll('.syn-sources li').length, 2);
    assert.match(div.querySelector('.syn-sources').textContent, /1\.2 km/);
    assert.match(div.querySelector('.syn-rev-adj').textContent, /1,06,000/);
    assert.match(div.querySelector('.syn-rev').textContent, /1,00,000/);
    assert.equal(div.querySelector('.syn-details b'), null, 'server text is escaped');
    assert.match(div.querySelector('.syn-details').textContent, /not a measured result/);
    assert.equal(div.querySelectorAll('button').length, 0, 'no new buttons');
    assert.equal(w.SynergyIntel.cardBlock(null), '');
});

test('comparison strip names the best by model, synergy and overall', () => {
    const { w } = setup(async () => ({ status: 200, data: {} }));
    const pick = (name, extra) => ({ name, category: name.toLowerCase(), model_score: 72, synergy_score: 80, synergy_level: 'Strong',
                                     overall_score: 75.2, monthly_revenue: 300000, moderate_monthly: 318000, ...extra });
    const div = w.document.createElement('div');
    div.innerHTML = w.SynergyIntel.comparisonStrip({ model: pick('Grocery'), synergy: pick('Laundry'), overall: pick('Pharmacy'),
                                                     method: 'Overall score = 0.6 × model + 0.4 × synergy.' });
    const names = [...div.querySelectorAll('.syn-pick strong')].map((e) => e.textContent);
    assert.deepEqual(names, ['Grocery', 'Laundry', 'Pharmacy']);
    assert.match(div.textContent, /model projections/);
    assert.equal(w.SynergyIntel.comparisonStrip(null), '');
});

test('panel: empty state, then loads the user business and renders base vs adjusted', async () => {
    const { w, calls } = setup(async (url) => {
        const business = new URL(url, 'http://x').searchParams.get('business_type');
        return { status: 200, data: { success: true, synergy: full(business) } };
    });
    const root = w.document.getElementById('synergy-revenue-intel');
    w.SynergyIntel.show(null);
    assert.match(root.querySelector('.syn-body').textContent, /Analyse a location/);
    assert.equal(calls.length, 0);

    w.SynergyIntel.show({ lat: 12.97, lng: 77.59, name: 'MG Road', category: 'cafe' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.length, 1);
    const q = new URL(calls[0].url, 'http://x').searchParams;
    assert.equal(q.get('business_type'), 'cafe');
    assert.equal(q.get('latitude'), '12.97');
    assert.match(root.querySelector('.syn-kpis').textContent, /2,00,000/);
    assert.match(root.querySelector('.syn-kpi-adj').textContent, /2,12,840/);
    assert.equal(root.querySelectorAll('.syn-sc').length, 4);
    assert.ok(root.querySelector('.syn-sc-base'), 'base scenario is styled differently');
    assert.equal(root.querySelectorAll('.syn-factors li').length, 5);
    assert.match(root.querySelector('.syn-badge').textContent, /not measured sales/);
    assert.equal(root.querySelectorAll('button').length, 0, 'no new buttons');

    // Recommendations arrive: options are added, the user's business stays selected.
    w.SynergyIntel.setRecommendations([{ category: 'pharmacy', name: 'Pharmacy' }],
        { overall: { category: 'pharmacy' } }, 12.97, 77.59);
    const select = root.querySelector('.syn-select');
    assert.deepEqual([...select.options].map((o) => o.value), ['cafe', 'pharmacy']);
    assert.equal(select.value, 'cafe');

    select.value = 'pharmacy';
    select.dispatchEvent(new w.Event('change'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(new URL(calls.at(-1).url, 'http://x').searchParams.get('business_type'), 'pharmacy');
});

test('panel defaults to the best overall recommendation and shows server errors', async () => {
    const { w, calls } = setup(async () => ({ status: 400, data: { success: false, error: 'business_type is required' } }));
    const root = w.document.getElementById('synergy-revenue-intel');
    w.postAreaAnalysis = async () => ({ ok: true, data: { recommendations: [{ category: 'grocery', name: 'Grocery' },
        { category: 'laundry', name: 'Laundry' }], comparison: { overall: { category: 'laundry' } } } });
    w.SynergyIntel.show({ lat: 1, lng: 2, name: 'Spot' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(root.querySelector('.syn-select').value, 'laundry');
    assert.equal(new URL(calls[0].url, 'http://x').searchParams.get('business_type'), 'laundry');
    assert.match(root.querySelector('.syn-body').textContent, /business_type is required/);
});

test('panel waits for a pending (202) area fetch', async () => {
    const { w, calls } = setup(async (_url, _o, n) => (n === 1
        ? { status: 202, data: { pending: true, retry_after: 0.001 } }
        : { status: 200, data: { success: true, synergy: full('Cafe') } }));
    w.SynergyIntel.show({ lat: 1, lng: 2, name: 'Spot', category: 'cafe' });
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(calls.length, 2);
    assert.ok(w.document.querySelector('.syn-kpis'));
});
