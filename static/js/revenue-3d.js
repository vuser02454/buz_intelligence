/**
 * Business Analytics – projected revenue as a 3D bar graph.
 *
 * X = time buckets, Z = business categories, Y = projected revenue (INR).
 * Data: POST /api/revenue-timeseries/ for the last *finished* map analysis
 * (main.js getAnalysisContext()); live values over ws/analytics/ with an 8 s
 * polling fallback. Everything shown is a model projection, labelled as such.
 *
 * Three.js r128 + OrbitControls are already loaded by base.html (dashboard globe).
 * Without WebGL a 2D canvas chart with the same data is drawn instead; a table
 * view is always available.
 */
(function () {
    'use strict';

    // ------------------------------------------------------------ formatting ----
    const inrFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

    /** ₹1,95,74,128 */
    function formatINR(value) {
        const n = Number(value);
        return Number.isFinite(n) ? inrFmt.format(Math.round(n)) : '—';
    }

    /** ₹1.9 Cr / ₹8.4 L / ₹45.2 K / ₹950 */
    function compactINR(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '—';
        const abs = Math.abs(n);
        const sign = n < 0 ? '-' : '';
        const fmt = (v, unit) => `${sign}₹${(Math.round(v * 10) / 10).toString().replace(/\.0$/, '')} ${unit}`;
        if (abs >= 1e7) return fmt(abs / 1e7, 'Cr');
        if (abs >= 1e5) return fmt(abs / 1e5, 'L');
        if (abs >= 1e3) return fmt(abs / 1e3, 'K');
        return `${sign}₹${Math.round(abs)}`;
    }

    function formatPct(value) {
        if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
        const n = Number(value);
        return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
    }

    /** Colour ramp cyan → violet → pink, t in [0, 1]. */
    function gradientColor(t) {
        const stops = [[34, 211, 238], [139, 92, 246], [236, 72, 153]];
        const x = Math.max(0, Math.min(1, t)) * 2;
        const i = Math.min(1, Math.floor(x));
        const f = x - i;
        const [a, b] = [stops[i], stops[i + 1]];
        return a.map((v, k) => Math.round(v + (b[k] - v) * f));
    }
    const rgbCss = (rgb) => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const VIEWS = [['live', 'Live'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']];
    const POLL_MS = 8000;
    const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ----------------------------------------------------------------- state ----
    const state = {
        root: null, context: null, data: null, view: 'daily', seq: 0,
        socket: null, pollTimer: null, visible: false, tableOpen: false,
        gl: null,   // three.js scene bundle, or null in 2D mode
    };

    // ------------------------------------------------------------------ DOM -----
    function build(root) {
        root.classList.add('r3d');
        root.innerHTML = `
            <div class="r3d-head">
                <div>
                    <h3 class="r3d-title"><i class="fas fa-cube me-2"></i>Projected revenue <span class="r3d-sub">within the analysis radius</span></h3>
                    <div class="r3d-area">
                        <span class="r3d-area-name">—</span>
                        <span class="r3d-chip r3d-radius">5 km radius</span>
                        <span class="r3d-chip r3d-badge" tabindex="0" aria-describedby="r3d-method">
                            <i class="fas fa-flask me-1"></i>Projected estimate <i class="fas fa-circle-info ms-1"></i>
                            <span class="r3d-tip" role="tooltip" id="r3d-method">A model projection from OpenStreetMap places, not sales data:
                                the revenue engine's daily estimate for each business found in the radius, spread over the day with the engine's
                                hourly pattern and over the week with fixed weekday/weekend multipliers.</span>
                        </span>
                    </div>
                </div>
                <div class="r3d-tabs" role="tablist" aria-label="Time view">
                    ${VIEWS.map(([k, label]) => `<button type="button" role="tab" class="r3d-tab" data-view="${k}" aria-selected="false">${label}</button>`).join('')}
                </div>
            </div>
            <div class="r3d-kpis" aria-live="polite">
                <div class="r3d-kpi"><span>Total projected</span><strong data-kpi="total">—</strong><small data-kpi="total-note"></small></div>
                <div class="r3d-kpi"><span>Peak period</span><strong data-kpi="peak">—</strong><small data-kpi="peak-note"></small></div>
                <div class="r3d-kpi"><span>Top category</span><strong data-kpi="top">—</strong><small data-kpi="top-note"></small></div>
                <div class="r3d-kpi"><span>Growth</span><strong data-kpi="growth">—</strong><small data-kpi="growth-note"></small></div>
            </div>
            <div class="r3d-note d-none" role="note"></div>
            <div class="r3d-stage" aria-label="3D bar chart of projected revenue" role="img">
                <div class="r3d-canvas-host"></div>
                <div class="r3d-tooltip d-none" role="status"></div>
                <div class="r3d-overlay r3d-skeleton d-none" aria-hidden="true"><div class="r3d-sk-bars">${'<i></i>'.repeat(14)}</div><p>Loading projection…</p></div>
                <div class="r3d-overlay r3d-message d-none"></div>
                <div class="r3d-hint">Drag to rotate · scroll or pinch to zoom · right-drag to pan</div>
            </div>
            <div class="r3d-legend"></div>
            <div class="r3d-foot">
                <span class="r3d-confidence"></span>
                <button type="button" class="r3d-table-toggle" aria-expanded="false" aria-controls="r3d-table">View as table</button>
            </div>
            <div class="r3d-table-wrap d-none" id="r3d-table"></div>`;
        root.querySelectorAll('.r3d-tab').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
        root.querySelector('.r3d-table-toggle').addEventListener('click', toggleTable);
        root.querySelector('.r3d-tabs').addEventListener('keydown', (e) => {
            if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
            const keys = VIEWS.map((v) => v[0]);
            const next = keys[(keys.indexOf(state.view) + (e.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length];
            setView(next);
            root.querySelector(`.r3d-tab[data-view="${next}"]`).focus();
        });
    }

    const $ = (sel) => state.root.querySelector(sel);

    function setOverlay(kind, html) {
        $('.r3d-skeleton').classList.toggle('d-none', kind !== 'loading');
        const msg = $('.r3d-message');
        msg.classList.toggle('d-none', !(kind === 'empty' || kind === 'error' || kind === 'pending'));
        if (html) msg.innerHTML = html;
    }

    // ---------------------------------------------------------------- data ------
    async function authHeaders() {
        const session = window.SupabaseAuth ? await window.SupabaseAuth.getSession() : null;
        if (!session) return null;
        const csrf = typeof getCookie === 'function' ? getCookie('csrftoken') : '';
        return { 'Authorization': 'Bearer ' + session.access_token, 'X-CSRFToken': csrf || '', 'Content-Type': 'application/json' };
    }

    async function fetchSeries(ctx, views) {
        const headers = await authHeaders();
        if (!headers) return { status: 401, data: { error: 'Please sign in to see the analytics.' } };
        const res = await fetch('/api/revenue-timeseries/', {
            method: 'POST', headers,
            body: JSON.stringify({ lat: ctx.lat, lng: ctx.lng, radius: ctx.radius || 5000, name: ctx.name,
                                   analysis_id: ctx.analysis_id, views }),
        });
        const data = await res.json().catch(() => ({ error: `Server error (${res.status}).` }));
        return { status: res.status, data };
    }

    async function load(ctx) {
        const seq = ++state.seq;
        stopLive();
        state.data = null;
        $('.r3d-area-name').textContent = ctx.name || `${Number(ctx.lat).toFixed(4)}, ${Number(ctx.lng).toFixed(4)}`;
        $('.r3d-radius').textContent = `${((ctx.radius || 5000) / 1000).toString()} km radius`;
        setOverlay('loading');
        clearChart();
        const started = Date.now();
        while (true) {
            let res;
            try {
                res = await fetchSeries(ctx);
            } catch (_e) {
                res = { status: 0, data: { error: 'Network error. Check your connection.' } };
            }
            if (seq !== state.seq) return;                       // a newer area replaced this one
            if (res.status === 202 && res.data.pending && Date.now() - started < 120000) {
                setOverlay('pending', `<i class="fas fa-satellite-dish fa-2x mb-2"></i><p>OpenStreetMap data for this area is still being fetched…</p>`);
                await new Promise((r) => setTimeout(r, (res.data.retry_after || 4) * 1000));
                if (seq !== state.seq) return;
                continue;
            }
            if (res.status !== 200 || !res.data.success) {
                showError(res.data.error || `Could not load the projection (${res.status}).`);
                return;
            }
            state.data = res.data;
            setOverlay(null);
            render(true);
            startLive(ctx);
            return;
        }
    }

    function showError(message) {
        setOverlay('error', `<i class="fas fa-triangle-exclamation fa-2x mb-2"></i><p>${esc(message)}</p>
            <button type="button" class="btn btn-sm btn-outline-light r3d-retry">Retry</button>`);
        $('.r3d-retry').addEventListener('click', () => state.context && load(state.context));
    }

    function showEmpty() {
        state.seq += 1;
        state.data = null;
        stopLive();
        clearChart();
        $('.r3d-area-name').textContent = 'No area analysed';
        ['total', 'peak', 'top', 'growth'].forEach((k) => { $(`[data-kpi="${k}"]`).textContent = '—'; $(`[data-kpi="${k}-note"]`).textContent = ''; });
        $('.r3d-legend').innerHTML = '';
        $('.r3d-confidence').textContent = '';
        $('.r3d-note').classList.add('d-none');
        setOverlay('empty', `<i class="fas fa-map-location-dot fa-2x mb-2"></i>
            <p><strong>No area analysed yet.</strong> Choose an area on the map and run Popular Locations.</p>
            <a href="/dashboard/?auto_map=true" class="r3d-link">Open the map</a>`);
    }

    // ------------------------------------------------------------- live ---------
    function onLive(live, analysisId) {
        if (!state.data || (analysisId && analysisId !== state.data.analysis_id)) return;
        state.data.views.live = live;
        if (state.view === 'live') render(false);
    }

    async function startLive(ctx) {
        stopLive();
        const seq = state.seq;
        const session = window.SupabaseAuth ? await window.SupabaseAuth.getSession() : null;
        if (!session || seq !== state.seq) return;
        let gotMessage = false;
        const fallback = () => {
            if (state.pollTimer || seq !== state.seq) return;
            state.pollTimer = setInterval(async () => {
                if (!state.visible || document.hidden) return;
                try {
                    const res = await fetchSeries(ctx, ['live']);
                    if (seq === state.seq && res.status === 200) onLive(res.data.views.live, res.data.analysis_id);
                } catch (_e) { /* keep polling */ }
            }, POLL_MS);
        };
        try {
            const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const ws = new WebSocket(`${proto}//${window.location.host}/ws/analytics/`);
            state.socket = ws;
            ws.onopen = () => ws.send(JSON.stringify({ action: 'subscribe', token: session.access_token,
                                                       lat: ctx.lat, lng: ctx.lng, radius: ctx.radius || 5000, name: ctx.name }));
            ws.onmessage = (e) => {
                let msg; try { msg = JSON.parse(e.data); } catch (_e) { return; }
                if (msg.type === 'live') { gotMessage = true; onLive(msg.live, msg.analysis_id); }
                else if (msg.type === 'error') { ws.close(); fallback(); }
            };
            ws.onerror = () => fallback();
            ws.onclose = () => { if (seq === state.seq && state.visible) fallback(); };
            setTimeout(() => { if (!gotMessage && seq === state.seq) fallback(); }, 6000);
        } catch (_e) {
            fallback();
        }
    }

    function stopLive() {
        if (state.socket) { try { state.socket.onclose = null; state.socket.close(); } catch (_e) { /* closed */ } }
        state.socket = null;
        clearInterval(state.pollTimer);
        state.pollTimer = null;
    }

    // ------------------------------------------------------------- render -------
    function setView(view) {
        state.view = view;
        state.root.querySelectorAll('.r3d-tab').forEach((b) => {
            const on = b.dataset.view === view;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
            b.tabIndex = on ? 0 : -1;
        });
        if (state.data) render(true);
    }

    function activeView() {
        return state.data && state.data.views[state.view];
    }

    function categoryColors() {
        const cats = state.data.categories;
        const map = {};
        cats.forEach((c, i) => { map[c.key] = gradientColor(cats.length > 1 ? i / (cats.length - 1) : 0); });
        return map;
    }

    function render(fresh) {
        const v = activeView();
        if (!v) return;
        renderKpis(v);
        renderLegend();
        renderMeta();
        if (state.tableOpen) renderTable();
        if (state.gl) updateBars(v, fresh); else draw2D(v);
    }

    function renderKpis(v) {
        const cats = Object.fromEntries(state.data.categories.map((c) => [c.key, c.label]));
        const set = (k, main, note) => { $(`[data-kpi="${k}"]`).textContent = main; $(`[data-kpi="${k}-note"]`).textContent = note || ''; };
        if (state.view === 'live') {
            set('total', formatINR(v.today_so_far), `today so far · now ≈ ${compactINR(v.now_rate_per_hour)}/hour (${v.now_label})`);
        } else {
            set('total', formatINR(v.total), { daily: 'today', weekly: 'this week', monthly: 'this month' }[state.view]);
        }
        set('peak', v.peak.label || '—', compactINR(v.peak.value));
        const topTotal = v.top_category ? v.series[v.top_category].reduce((a, b) => a + b, 0) : 0;
        set('top', cats[v.top_category] || '—', v.total ? `${((topTotal / v.total) * 100).toFixed(0)}% of total` : '');
        set('growth', formatPct(v.growth_pct), v.growth_label);
    }

    function renderLegend() {
        const colors = categoryColors();
        $('.r3d-legend').innerHTML = state.data.categories.map((c) =>
            `<span><i style="background:${rgbCss(colors[c.key])}"></i>${esc(c.label)} <small>(${c.places})</small></span>`).join('');
    }

    function renderMeta() {
        const d = state.data;
        const a = d.assumptions;
        $('.r3d-confidence').textContent =
            `Confidence: ${d.confidence.level} (${d.confidence.score}/100) · ${a.places_estimated} businesses estimated from ` +
            `${Number(a.mapped_places).toLocaleString('en-IN')} mapped places · crowd level ${a.crowd_level || '—'} · ` +
            `${(a.radius_m / 1000)} km radius · Asia/Kolkata time`;
        const note = $('.r3d-note');
        note.classList.toggle('d-none', d.confidence.level !== 'low');
        note.textContent = d.confidence.level === 'low' ? d.confidence.note : '';
    }

    function toggleTable() {
        state.tableOpen = !state.tableOpen;
        const btn = $('.r3d-table-toggle');
        btn.setAttribute('aria-expanded', String(state.tableOpen));
        btn.textContent = state.tableOpen ? 'Hide table' : 'View as table';
        $('.r3d-table-wrap').classList.toggle('d-none', !state.tableOpen);
        if (state.tableOpen) renderTable();
    }

    function renderTable() {
        const v = activeView();
        if (!v) return;
        const cats = state.data.categories;
        const label = VIEWS.find((x) => x[0] === state.view)[1];
        $('.r3d-table-wrap').innerHTML = `<table class="r3d-table">
            <caption>${esc(label)} projected revenue (INR) by business category – model estimate</caption>
            <thead><tr><th scope="col">Period</th>${cats.map((c) => `<th scope="col">${esc(c.label)}</th>`).join('')}<th scope="col">Total</th></tr></thead>
            <tbody>${v.buckets.map((b, i) => `<tr><th scope="row">${esc(b)}</th>${cats.map((c) => `<td>${formatINR(v.series[c.key][i])}</td>`).join('')}<td><strong>${formatINR(v.totals[i])}</strong></td></tr>`).join('')}</tbody>
            <tfoot><tr><th scope="row">Total</th>${cats.map((c) => `<td>${formatINR(v.series[c.key].reduce((a, b) => a + b, 0))}</td>`).join('')}<td><strong>${formatINR(v.total)}</strong></td></tr></tfoot>
        </table>`;
    }

    // ------------------------------------------------------------- 3D (three) ---
    function webglAvailable() {
        if (typeof THREE === 'undefined' || !THREE.WebGLRenderer) return false;
        try {
            const c = document.createElement('canvas');
            return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
        } catch (_e) {
            return false;
        }
    }

    function initGL() {
        const host = $('.r3d-canvas-host');
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        host.appendChild(renderer.domElement);
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
        const controls = THREE.OrbitControls ? new THREE.OrbitControls(camera, renderer.domElement) : null;
        if (controls) {
            controls.enableDamping = !reducedMotion();
            controls.dampingFactor = 0.08;
            controls.maxPolarAngle = Math.PI / 2.05;
            controls.autoRotate = false;
        }
        scene.add(new THREE.AmbientLight(0xb0b0b0, 0.55));
        const key = new THREE.DirectionalLight(0xffffff, 0.9);
        key.position.set(8, 16, 10);
        key.castShadow = true;
        key.shadow.mapSize.set(1024, 1024);
        scene.add(key);
        const rim = new THREE.PointLight(0xffffff, 0.35, 60);
        rim.position.set(-10, 8, -10);
        scene.add(rim);

        // One shared bar geometry: unit box standing on the floor, darker at the bottom (vertex colours).
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        geometry.translate(0, 0.5, 0);
        const pos = geometry.attributes.position;
        const shade = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
            const t = 0.35 + 0.65 * pos.getY(i);
            shade.set([t, t, t], i * 3);
        }
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(shade, 3));

        const gl = { renderer, scene, camera, controls, geometry, light: key, group: null, bars: [], disposables: [],
                     tweens: [], raycaster: new THREE.Raycaster(), pointer: new THREE.Vector2(), hovered: null, frame: null };
        renderer.domElement.addEventListener('pointermove', (e) => onPointer(e));
        renderer.domElement.addEventListener('pointerleave', () => hideTooltip());
        new ResizeObserver(() => resize()).observe(host);
        state.gl = gl;
        resize();
        return gl;
    }

    function resize() {
        const gl = state.gl;
        if (!gl) return;
        const host = $('.r3d-canvas-host');
        const w = host.clientWidth || 600;
        const h = host.clientHeight || 380;
        gl.renderer.setSize(w, h, false);
        const wasPortrait = (gl.camera.aspect || 1.6) < 1.6;
        gl.camera.aspect = w / h;
        gl.camera.updateProjectionMatrix();
        if (wasPortrait || gl.camera.aspect < 1.6) placeCamera();
    }

    function labelSprite(text, color = 'rgba(255,255,255,0.85)', size = 28) {
        const c = document.createElement('canvas');
        const ctx = c.getContext('2d');
        ctx.font = `600 ${size}px Inter, system-ui, sans-serif`;
        c.width = Math.ceil(ctx.measureText(text).width) + 16;
        c.height = size + 14;
        ctx.font = `600 ${size}px Inter, system-ui, sans-serif`;
        ctx.fillStyle = color;
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 8, c.height / 2);
        const tex = new THREE.CanvasTexture(c);
        const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
        const sprite = new THREE.Sprite(mat);
        const scale = LABEL_SCALE;
        sprite.scale.set(c.width * scale, c.height * scale, 1);
        state.gl.disposables.push(tex, mat);
        return sprite;
    }

    function disposeGroup() {
        const gl = state.gl;
        if (!gl || !gl.group) return;
        gl.scene.remove(gl.group);
        gl.disposables.forEach((d) => d.dispose && d.dispose());
        gl.disposables = [];
        gl.bars = [];
        gl.tweens = [];
        gl.group = null;
        gl.layoutKey = null;
    }

    function clearChart() {
        if (state.gl) disposeGroup();
        const c2 = $('.r3d-canvas-host canvas.r3d-2d');
        if (c2) c2.getContext('2d').clearRect(0, 0, c2.width, c2.height);
        hideTooltip();
    }

    const SPACE_X = 1.0, SPACE_Z = 1.25, BAR_W = 0.62, BAR_D = 0.7, MAX_H = 5.5, LABEL_SCALE = 0.022;

    function buildScene(v) {
        const gl = state.gl;
        disposeGroup();
        const cats = state.data.categories;
        const colors = categoryColors();
        const nx = v.buckets.length, nz = cats.length;
        // Few buckets (week, month): wider spacing so bars and labels don't crowd.
        const SX = nx <= 7 ? 2.2 : SPACE_X;
        const BW = nx <= 7 ? 1.3 : BAR_W;
        const group = new THREE.Group();
        const x0 = -((nx - 1) * SX) / 2, z0 = -((nz - 1) * SPACE_Z) / 2;
        const width = nx * SX + 2, depth = nz * SPACE_Z + 2;

        const floor = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), new THREE.ShadowMaterial({ opacity: 0.35 }));
        floor.rotation.x = -Math.PI / 2;
        floor.receiveShadow = true;
        group.add(floor);
        gl.disposables.push(floor.geometry, floor.material);
        const grid = new THREE.GridHelper(Math.max(width, depth), Math.max(nx, nz) + 2, 0x4a4a4a, 0x222222);
        grid.material.opacity = 0.45;
        grid.material.transparent = true;
        group.add(grid);
        gl.disposables.push(grid.geometry, grid.material);

        const materials = {};
        cats.forEach((c) => {
            const [r, g, b] = colors[c.key];
            const col = new THREE.Color(r / 255, g / 255, b / 255);
            materials[c.key] = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.18,
                                                                 roughness: 0.35, metalness: 0.25, vertexColors: true });
            gl.disposables.push(materials[c.key]);
        });
        cats.forEach((c, zi) => {
            for (let xi = 0; xi < nx; xi++) {
                const mat = materials[c.key].clone();      // per bar, for hover/pulse highlighting
                gl.disposables.push(mat);
                const bar = new THREE.Mesh(gl.geometry, mat);
                bar.position.set(x0 + xi * SX, 0, z0 + zi * SPACE_Z);
                bar.scale.set(BW, 0.001, BAR_D);
                bar.castShadow = true;
                bar.userData = { cat: c.key, label: c.label, i: xi, value: 0 };
                group.add(bar);
                gl.bars.push(bar);
            }
            // Category names just past the last time bucket (right edge of the grid).
            const s = labelSprite(c.label, rgbCss(colors[c.key]), 26);
            s.position.set(x0 + (nx - 1) * SX + 0.8 + s.scale.x / 2, 0.3, z0 + zi * SPACE_Z);
            group.add(s);
        });
        const step = nx > 12 ? 3 : 1;
        v.buckets.forEach((b, xi) => {
            if (xi % step) return;
            // Time labels in front of the first category row (front edge of the grid).
            const s = labelSprite(b, 'rgba(255,255,255,0.7)', 24);
            s.position.set(x0 + xi * SX, 0.2, z0 + (nz - 1) * SPACE_Z + 1.1);
            group.add(s);
        });
        gl.yLabels = [0.5, 1].map((f) => {
            const s = labelSprite('', 'rgba(255,255,255,0.55)', 22);
            s.position.set(x0 - 1.4, MAX_H * f, z0 - SPACE_Z);
            group.add(s);
            return { sprite: s, f };
        });
        gl.scene.add(group);
        gl.group = group;
        gl.layoutKey = `${state.view}:${nx}:${cats.map((c) => c.key).join(',')}`;

        // Frame the whole grid (incl. the front row and the labels) from its real size.
        gl.camDist = Math.max(width * 0.85, depth * 1.25, 10) + 4;
        placeCamera();
        if (gl.controls) { gl.controls.target.set(0, MAX_H * 0.3, 0); gl.controls.update(); }
        else gl.camera.lookAt(0, MAX_H * 0.3, 0);
        gl.light.shadow.camera.left = -width; gl.light.shadow.camera.right = width;
        gl.light.shadow.camera.top = depth; gl.light.shadow.camera.bottom = -depth;
        gl.light.shadow.camera.updateProjectionMatrix();
    }

    /** Camera at the framing distance, pulled back on narrow (portrait/mobile) canvases. */
    function placeCamera() {
        const gl = state.gl;
        if (!gl || !gl.camDist) return;
        const dist = gl.camDist * Math.max(1, 1.6 / (gl.camera.aspect || 1.6));
        gl.camera.position.set(dist * 0.35, dist * 0.55, dist * 0.85);
        if (gl.controls) gl.controls.update();
    }

    function setYLabels(maxValue) {
        (state.gl.yLabels || []).forEach(({ sprite, f }) => {
            const tex = sprite.material.map;
            const c = tex.image;
            const ctx = c.getContext('2d');
            const text = compactINR(maxValue * f);
            ctx.font = '600 22px Inter, system-ui, sans-serif';
            c.width = Math.ceil(ctx.measureText(text).width) + 16;
            ctx.font = '600 22px Inter, system-ui, sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.7)';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, 8, c.height / 2);
            tex.needsUpdate = true;
            sprite.scale.set(c.width * LABEL_SCALE, c.height * LABEL_SCALE, 1);
        });
    }

    function updateBars(v, fresh) {
        const gl = state.gl;
        const key = `${state.view}:${v.buckets.length}:${state.data.categories.map((c) => c.key).join(',')}`;
        const rebuild = !gl.group || gl.layoutKey !== key;
        if (rebuild) buildScene(v);
        const maxValue = Math.max(1, ...v.totals.length ? Object.values(v.series).flat() : [1]);
        setYLabels(maxValue);
        const animate = !reducedMotion();
        const now = performance.now();
        gl.tweens = [];
        gl.bars.forEach((bar) => {
            const value = v.series[bar.userData.cat][bar.userData.i] || 0;
            bar.userData.value = value;
            const target = Math.max(0.001, (value / maxValue) * MAX_H);
            if (!animate) { bar.scale.y = target; return; }
            gl.tweens.push({ bar, from: bar.scale.y, to: target, start: now + (rebuild || fresh ? bar.userData.i * 18 : 0), dur: rebuild ? 900 : 500 });
        });
        gl.nowIndex = state.view === 'live' ? v.now_index : -1;
        startLoop();
    }

    const easeOut = (t) => 1 - Math.pow(1 - t, 3);

    function startLoop() {
        const gl = state.gl;
        if (!gl || gl.frame || !state.visible || document.hidden) return;
        const tick = (t) => {
            gl.frame = null;
            if (!state.visible || document.hidden) return;   // paused; resumed by show()/visibilitychange
            gl.tweens = gl.tweens.filter((tw) => {
                const p = Math.min(1, Math.max(0, (t - tw.start) / tw.dur));
                tw.bar.scale.y = tw.from + (tw.to - tw.from) * easeOut(p);
                return p < 1;
            });
            const pulse = !reducedMotion() && gl.nowIndex >= 0;
            gl.bars.forEach((bar) => {
                const base = bar === gl.hovered ? 0.6 : 0.18;
                bar.material.emissiveIntensity = pulse && bar.userData.i === gl.nowIndex ? base + 0.35 + 0.35 * Math.sin(t / 220) : base;
            });
            if (gl.controls) gl.controls.update();
            gl.renderer.render(gl.scene, gl.camera);
            gl.frame = requestAnimationFrame(tick);
        };
        gl.frame = requestAnimationFrame(tick);
    }

    function onPointer(e) {
        const gl = state.gl;
        const v = activeView();
        if (!gl || !v) return;
        const rect = gl.renderer.domElement.getBoundingClientRect();
        gl.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        gl.raycaster.setFromCamera(gl.pointer, gl.camera);
        const hit = gl.raycaster.intersectObjects(gl.bars, false)[0];
        gl.hovered = hit ? hit.object : null;
        if (!hit) { hideTooltip(); return; }
        const d = hit.object.userData;
        showTooltip(e.clientX - rect.left, e.clientY - rect.top, d.label, v.buckets[d.i], d.value, v.total);
    }

    function showTooltip(x, y, cat, bucket, value, total) {
        const tip = $('.r3d-tooltip');
        tip.innerHTML = `<strong>${esc(cat)}</strong><span>${esc(bucket)}</span><b>${formatINR(value)}</b>
            <small>${total ? ((value / total) * 100).toFixed(1) : '0'}% of total · projected</small>`;
        tip.style.left = `${Math.min(x + 14, $('.r3d-stage').clientWidth - 190)}px`;
        tip.style.top = `${Math.max(8, y - 70)}px`;
        tip.classList.remove('d-none');
    }

    function hideTooltip() {
        if (state.root) $('.r3d-tooltip').classList.add('d-none');
        if (state.gl) state.gl.hovered = null;
    }

    // ---------------------------------------------------------- 2D fallback -----
    function draw2D(v) {
        const host = $('.r3d-canvas-host');
        let canvas = host.querySelector('canvas.r3d-2d');
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.className = 'r3d-2d';
            host.appendChild(canvas);
            canvas.addEventListener('mousemove', (e) => {
                const hit = (canvas._hits || []).find((h) => e.offsetX >= h.x && e.offsetX <= h.x + h.w && e.offsetY >= h.y && e.offsetY <= h.y + h.h);
                if (hit) showTooltip(e.offsetX, e.offsetY, hit.label, hit.bucket, hit.value, activeView().total); else hideTooltip();
            });
            canvas.addEventListener('mouseleave', hideTooltip);
        }
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const W = host.clientWidth || 600, H = host.clientHeight || 360;
        canvas.width = W * dpr; canvas.height = H * dpr;
        canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        const pad = { l: 64, r: 12, t: 12, b: 30 };
        const max = Math.max(1, ...v.totals);
        const n = v.buckets.length;
        const bw = (W - pad.l - pad.r) / n;
        const colors = categoryColors();
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        [0, 0.5, 1].forEach((f) => {
            const y = pad.t + (H - pad.t - pad.b) * (1 - f);
            ctx.fillText(compactINR(max * f), 4, y + 4);
            ctx.strokeStyle = 'rgba(255,255,255,0.15)';
            ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
        });
        const hits = [];
        v.buckets.forEach((b, i) => {
            let y = H - pad.b;
            state.data.categories.forEach((c) => {
                const value = v.series[c.key][i];
                const h = (value / max) * (H - pad.t - pad.b);
                ctx.fillStyle = rgbCss(colors[c.key]);
                ctx.fillRect(pad.l + i * bw + 2, y - h, Math.max(1, bw - 4), h);
                hits.push({ x: pad.l + i * bw, y: y - h, w: bw, h, label: c.label, bucket: b, value });
                y -= h;
            });
            if (n <= 12 || i % 3 === 0) {
                ctx.fillStyle = 'rgba(255,255,255,0.7)';
                ctx.fillText(b, pad.l + i * bw, H - 10);
            }
        });
        canvas._hits = hits;
    }

    // --------------------------------------------------------------- public -----
    function ensure(root) {
        if (state.root === root) return;
        state.root = root;
        build(root);
        setView(state.view);
        try {
            if (webglAvailable()) initGL();
        } catch (e) {
            console.warn('WebGL unavailable, using the 2D chart:', e);
            state.gl = null;
        }
        root.classList.toggle('r3d-2d-mode', !state.gl);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) startLoop(); });
        if ('IntersectionObserver' in window) {
            // Hidden by another dashboard view or scrolled away: no rendering, no live socket.
            new IntersectionObserver((entries) => {
                const visible = entries.some((en) => en.isIntersecting);
                if (visible === state.visible) return;
                state.visible = visible;
                if (!visible) { stopLive(); return; }
                startLoop();
                if (state.data && state.context && !state.socket && !state.pollTimer) startLive(state.context);
            }).observe(root);
        }
    }

    /** Show the graph for `context` (the last finished map analysis) or the empty state. */
    function show(context, root) {
        root = root || document.getElementById('revenue-analytics-3d');
        if (!root) return;
        ensure(root);
        state.visible = true;
        if (!context) { state.context = null; showEmpty(); return; }
        const same = state.context && state.data && state.context.analysis_id === context.analysis_id
            && Number(state.context.lat) === Number(context.lat) && Number(state.context.lng) === Number(context.lng);
        state.context = context;
        if (same) { render(true); startLive(context); return; }
        load(context);
    }

    /** Leaving the Business Analytics view: stop live updates and rendering. */
    function hide() {
        state.visible = false;
        stopLive();
    }

    window.RevenueAnalytics3D = { show, hide, formatINR, compactINR, formatPct, gradientColor, _state: state };
})();
