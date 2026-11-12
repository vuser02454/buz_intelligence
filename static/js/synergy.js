/**
 * Business Synergy Intelligence – web views.
 *
 *  - cardBlock(synergy)        synergy summary inside a recommendation card (main.js createOpportunityCard)
 *  - comparisonStrip(cmp)      best by model / by synergy / overall, above the recommendation cards
 *  - SynergyIntel.show(ctx)    "Synergy Revenue Intelligence" panel in Business Analytics, below the 3D graph
 *
 * All numbers come from the server (business_intelligence/synergy): /api/location-recommendations/
 * for the cards and /api/synergy/ for the panel – the same function the PDF report uses. Nothing is
 * calculated here; the browser only formats. Every revenue figure is labelled as a projection.
 */
(function () {
    'use strict';

    const inrFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
    const inr = (v) => (Number.isFinite(Number(v)) ? inrFmt.format(Math.round(Number(v))) : '—');
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const km = (m) => (m == null ? '' : (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`));
    const levelClass = (level) => `syn-level-${String(level || 'weak').toLowerCase()}`;

    function scoreBar(score, level) {
        const s = Math.max(0, Math.min(100, Number(score) || 0));
        return `<div class="syn-score ${levelClass(level)}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${s}"
                     aria-label="Synergy potential score ${s.toFixed(1)} of 100">
                    <div class="syn-score-top"><span>Synergy potential</span><strong>${s.toFixed(1)}<small>/100</small></strong>
                        <em>${esc(level)}</em></div>
                    <div class="syn-bar"><i style="width:${s}%"></i></div>
                </div>`;
    }

    /** Compact synergy section for a recommendation card (rec.synergy from the server). */
    function cardBlock(syn) {
        if (!syn) return '';
        const sc = syn.scenarios || {};
        const mod = sc.moderate || {};
        const sources = (syn.sources || []).map((s) =>
            `<li><span>${esc(s.label)}</span><b>${Number(s.count) || 0}${s.nearest_m != null ? ` · ${km(s.nearest_m)}` : ''}</b></li>`).join('');
        const actions = (syn.actions || []).map((a) => `<li>${esc(a)}</li>`).join('');
        return `
            <div class="syn-card">
                ${scoreBar(syn.score, syn.level)}
                ${sources ? `<ul class="syn-sources" aria-label="Main synergy sources">${sources}</ul>` : ''}
                <div class="syn-rev">
                    <div><span>Base (engine)</span><strong>${inr(sc.base && sc.base.monthly)}</strong></div>
                    <div class="syn-rev-adj"><span>With synergy · moderate</span><strong>${inr(mod.monthly)}</strong>
                        <small>+${inr(mod.additional)} (+${Number(mod.uplift_pct || 0).toFixed(1)}%)</small></div>
                </div>
                <details class="syn-details">
                    <summary>Why this synergy?</summary>
                    <p>${esc(syn.why)}</p>
                    ${syn.main_risk ? `<p class="syn-risk"><i class="fas fa-triangle-exclamation me-1"></i>${esc(syn.main_risk)}</p>` : ''}
                    ${actions ? `<ol class="syn-actions">${actions}</ol>` : ''}
                    <p class="syn-fine">Projection from OpenStreetMap data · confidence ${esc(syn.confidence)} · not a measured result.</p>
                </details>
            </div>`;
    }

    /** Best by the existing model, by synergy and overall (response.comparison). */
    function comparisonStrip(cmp) {
        if (!cmp || !cmp.model) return '';
        const cell = (icon, title, pick, value) => `
            <div class="syn-pick">
                <span class="syn-pick-label"><i class="fas ${icon} me-1"></i>${title}</span>
                <strong>${esc(pick.name)}</strong>
                <small>${value}</small>
            </div>`;
        return `
            <div class="col-12 mb-3 syn-compare-row">
                <div class="syn-compare" role="group" aria-label="Recommendation comparison">
                    ${cell('fa-chart-line', 'Best by model', cmp.model, `Model score ${Number(cmp.model.model_score).toFixed(1)} · ${inr(cmp.model.monthly_revenue)}/mo`)}
                    ${cell('fa-link', 'Best synergy', cmp.synergy, `Synergy ${Number(cmp.synergy.synergy_score).toFixed(1)} · ${esc(cmp.synergy.synergy_level)}`)}
                    ${cell('fa-trophy', 'Best overall', cmp.overall, `Overall ${Number(cmp.overall.overall_score).toFixed(1)} · moderate ${inr(cmp.overall.moderate_monthly)}/mo`)}
                    <p class="syn-compare-note">${esc(cmp.method)} All revenue figures are model projections.</p>
                </div>
            </div>`;
    }

    // ------------------------------------------------------ Business Analytics panel ----
    const state = { root: null, ctx: null, options: [], business: '', seq: 0 };

    function build(root) {
        root.classList.add('syn-panel');
        root.innerHTML = `
            <div class="syn-head">
                <div>
                    <h3 class="syn-title"><i class="fas fa-link me-2"></i>Synergy Revenue Intelligence</h3>
                    <p class="syn-sub">How nearby businesses and surroundings could change the base projection for one business at
                        <span class="syn-area">—</span>. Separate from the area graph above.</p>
                </div>
                <label class="syn-select-wrap">
                    <span>Business</span>
                    <select class="form-select syn-select" aria-label="Business to analyse"></select>
                </label>
            </div>
            <div class="syn-body" aria-live="polite"></div>`;
        root.querySelector('.syn-select').addEventListener('change', (e) => { state.business = e.target.value; load(); });
    }

    function message(html) {
        state.root.querySelector('.syn-body').innerHTML = `<div class="syn-message">${html}</div>`;
    }

    function setOptions(options, selected) {
        state.options = options;
        const select = state.root.querySelector('.syn-select');
        select.innerHTML = options.length
            ? options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')
            : '<option value="">Waiting for recommendations…</option>';
        select.disabled = !options.length;
        if (selected) select.value = selected;
        state.business = select.value;
    }

    async function fetchSynergy(ctx, business) {
        const params = new URLSearchParams({ latitude: ctx.lat, longitude: ctx.lng, business_type: business, location_name: ctx.name || '' });
        const started = Date.now();
        while (true) {
            let res, data;
            try {
                res = await fetch(`/api/synergy/?${params.toString()}`);
                data = await res.json().catch(() => ({ error: `Server error (${res.status}).` }));
            } catch (_e) {
                return { ok: false, data: { error: 'Network error. Check your connection.' } };
            }
            if (res.status === 202 && data.pending && Date.now() - started < 120000) {
                await new Promise((r) => setTimeout(r, Math.max(1, Number(data.retry_after) || 4) * 1000));
                continue;
            }
            return { ok: res.ok && data.success !== false, data };
        }
    }

    async function load() {
        const ctx = state.ctx;
        if (!ctx || !state.business) return;
        const seq = ++state.seq;
        message('<div class="spinner-border spinner-border-sm text-info me-2" role="status"></div>Calculating synergy…');
        const res = await fetchSynergy(ctx, state.business);
        if (seq !== state.seq) return;
        if (!res.ok) { message(`<i class="fas fa-triangle-exclamation me-2"></i>${esc(res.data.error || 'Synergy could not be calculated.')}`); return; }
        render(res.data.synergy);
    }

    function render(r) {
        const rows = r.revenue.rows;
        const base = rows[0];
        const max = Math.max(...rows.map((x) => x.monthly), 1);
        const bars = rows.map((x) => `
            <div class="syn-sc ${x.scenario === 'base' ? 'syn-sc-base' : ''}">
                <span class="syn-sc-name">${esc(x.label)}</span>
                <div class="syn-sc-track"><i style="width:${(100 * x.monthly / max).toFixed(1)}%"></i></div>
                <span class="syn-sc-val">${inr(x.monthly)}${x.scenario === 'base' ? '' : ` <small>+${inr(x.additional)} · +${Number(x.uplift_pct).toFixed(1)}%</small>`}</span>
            </div>`).join('');
        const factors = r.factors.map((f) => `
            <li><span>${esc(f.label)} <small>(${Math.round(f.weight * 100)}%)</small></span>
                <div class="syn-bar syn-bar-thin"><i style="width:${f.score}%"></i></div><b>${Number(f.score).toFixed(0)}</b></li>`).join('');
        const supports = (r.explanation.supports || []).slice(0, 4).map((s) => `
            <li><strong>${esc(s.title)}</strong> <span class="syn-kind">${esc(s.kind)}</span>
                <div>${(s.examples || []).map((e) => `${esc(e.name)} (${km(e.distance_m)})`).join('; ')}</div></li>`).join('');
        state.root.querySelector('.syn-body').innerHTML = `
            <div class="syn-grid">
                <div class="syn-col">
                    ${scoreBar(r.score, r.level)}
                    <ul class="syn-factors" aria-label="Synergy factors">${factors}</ul>
                    <p class="syn-fine">Data confidence: ${esc(r.data.confidence)} · ${Number(r.data.mapped_places_1500m)} mapped places within 1.5 km ·
                        ${Number(r.competition.competitors_1km)} similar within 1 km.</p>
                </div>
                <div class="syn-col">
                    <div class="syn-kpis">
                        <div><span>Base projection</span><strong>${inr(base.monthly)}</strong><small>revenue engine, per month</small></div>
                        <div class="syn-kpi-adj"><span>Synergy-adjusted (moderate)</span><strong>${inr(rows[2].monthly)}</strong>
                            <small>+${inr(rows[2].additional)} per month</small></div>
                    </div>
                    <div class="syn-scenarios" aria-label="Revenue scenarios">${bars}</div>
                    <span class="syn-badge"><i class="fas fa-flask me-1"></i>Projected estimate – not measured sales</span>
                </div>
            </div>
            <details class="syn-details syn-details-wide">
                <summary>Why, what helps, risks and next steps</summary>
                <p>${esc(r.explanation.why)}</p>
                ${supports ? `<ul class="syn-supports">${supports}</ul>` : ''}
                <p>${esc(r.explanation.opportunity)}</p>
                <h4>Risks</h4><ul>${r.explanation.risks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
                <h4>Practical advice</h4><ol>${r.explanation.actions.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
                <p class="syn-fine">${esc(r.revenue.method)}</p>
            </details>`;
    }

    function businessOptions(recs, ctx) {
        const out = [];
        const add = (value, label) => { if (value && !out.some((o) => o.value === value)) out.push({ value, label }); };
        if (ctx && ctx.category) add(ctx.category, `${String(ctx.category).replace(/_/g, ' ')} (your business)`);
        (recs || []).forEach((r) => add(r.category, r.name));
        return out;
    }

    /** Business Analytics opened (or a new analysis finished): `ctx` from main.js getAnalysisContext(). */
    function show(ctx, root) {
        root = root || document.getElementById('synergy-revenue-intel');
        if (!root) return;
        if (state.root !== root) { state.root = root; build(root); }
        const changed = !state.ctx || !ctx || Number(state.ctx.lat) !== Number(ctx.lat) || Number(state.ctx.lng) !== Number(ctx.lng);
        state.ctx = ctx;
        root.querySelector('.syn-area').textContent = ctx ? (ctx.name || `${Number(ctx.lat).toFixed(4)}, ${Number(ctx.lng).toFixed(4)}`) : 'no area yet';
        if (!ctx) { state.seq += 1; setOptions([]); message('<i class="fas fa-map-location-dot me-2"></i>Analyse a location on the map to see its synergy.'); return; }
        if (!changed && state.options.length) return;
        const options = businessOptions([], ctx);
        setOptions(options);
        if (options.length) { load(); return; }
        message('Loading the recommended businesses for this area…');
        loadOwnRecommendations(ctx);
    }

    /** The recommendation list on the page may be for another spot: ask for this area's own. */
    async function loadOwnRecommendations(ctx) {
        if (typeof window.postAreaAnalysis !== 'function') return;
        const res = await window.postAreaAnalysis('/api/location-recommendations/',
            { latitude: ctx.lat, longitude: ctx.lng, location_name: ctx.name || '' });
        if (state.ctx !== ctx || state.options.length) return;
        if (!res.ok) { message(`<i class="fas fa-triangle-exclamation me-2"></i>${esc((res.data && res.data.error) || 'Recommendations unavailable.')}`); return; }
        setRecommendations(res.data.recommendations || [], res.data.comparison, ctx.lat, ctx.lng);
    }

    /** Recommendations for the area arrived (main.js): offer them, defaulting to the best overall. */
    function setRecommendations(recs, comparison, lat, lng) {
        if (!state.root || !state.ctx) return;
        if (Math.abs(Number(state.ctx.lat) - Number(lat)) > 1e-4 || Math.abs(Number(state.ctx.lng) - Number(lng)) > 1e-4) return;
        const previous = state.business;
        const options = businessOptions(recs, state.ctx);
        const preferred = previous || (state.ctx.category) || (comparison && comparison.overall && comparison.overall.category) || '';
        setOptions(options, preferred);
        if (state.business && state.business !== previous) load();
    }

    window.SynergyIntel = { show, setRecommendations, cardBlock, comparisonStrip, _state: state, _render: render };
})();
