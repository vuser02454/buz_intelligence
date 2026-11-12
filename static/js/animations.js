/*
 * Site-wide motion layer (styles in static/css/animations.css).
 *
 * - Scroll reveals for cards/panels on every page
 * - Dashboard scrollytelling: a sticky radar that changes per chapter as you scroll,
 *   a scroll progress bar and a hero that drifts back
 * - Search bar intro: circle → pill → full width → typed placeholder (replays every time
 *   the map opens), plus a typewriter placeholder on the assistant input
 * - window.BIAnim.storyLoader(text): narrated loading state used instead of spinners
 *
 * Purely additive: no existing ids or handlers are changed.
 */
(function () {
    'use strict';

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.documentElement.classList.add('js-anim');

    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /* ------------------------------------------------------------ story loader */
    const LOADER_STEPS = [
        'Mapping places within 5 km',
        'Reading crowd density',
        'Scoring with the ML model',
        'Projecting revenue',
        'Ranking the top opportunities',
    ];

    /** HTML for a narrated loading state. `caption` may contain trusted inline HTML. */
    function storyLoader(caption, steps) {
        const items = (steps || LOADER_STEPS)
            .map((s, i) => `<li style="--i:${i}">${escapeHtml(s)}</li>`).join('');
        return `<div class="bi-story-loader col-12" role="status" aria-live="polite">
            <div class="bi-loader-orb" aria-hidden="true"><span></span><span></span><span></span></div>
            <ol class="bi-loader-steps">${items}</ol>
            <p class="bi-loader-caption">${caption || ''}</p>
        </div>`;
    }

    /** Show the loader in `el`, or only update its caption if it is already showing
     *  (so the step animation keeps running instead of restarting on every progress tick). */
    function setStoryLoader(el, caption, steps) {
        if (!el) return;
        const existing = el.querySelector(':scope > .bi-story-loader .bi-loader-caption');
        if (existing) { existing.innerHTML = caption || ''; return; }
        el.innerHTML = storyLoader(caption, steps);
    }

    window.BIAnim = { storyLoader, setStoryLoader };

    /* ------------------------------------------------------------ scroll reveals */
    const REVEAL_SELECTORS = [
        '.fav-card', '.profile-card', '.contact-card', '.business-opportunity-card',
        '.recs-panel', '.dashboard-analytics-panel', '.dashboard-form-panel', '.syn-panel',
        '.hero-subtitle', '.home-hero .hero-cta', '.feature-hero-sub', '.feature-cta-row', '.feature-hero-badge',
        '.bi-emerge-head h2', '.bi-emerge-head .bi-step-num',
    ].join(',');

    let revealObserver = null;
    function observeReveals(root) {
        if (reduceMotion || !('IntersectionObserver' in window)) return;
        if (!revealObserver) {
            revealObserver = new IntersectionObserver((entries) => {
                entries.forEach((e) => {
                    if (!e.isIntersecting) return;
                    e.target.classList.add('is-revealed');
                    revealObserver.unobserve(e.target);
                });
            }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
        }
        const nodes = (root.matches && root.matches(REVEAL_SELECTORS) ? [root] : [])
            .concat(Array.from(root.querySelectorAll ? root.querySelectorAll(REVEAL_SELECTORS) : []));
        nodes.forEach((el) => {
            if (el.dataset.reveal !== undefined) return;
            el.dataset.reveal = el.matches('.business-opportunity-card, .fav-card') ? 'scale' : '';
            // stagger siblings in the same grid
            const siblings = el.parentElement ? Array.from(el.parentElement.children).filter((c) => c.matches(REVEAL_SELECTORS)) : [];
            const idx = Math.max(0, siblings.indexOf(el));
            el.style.setProperty('--reveal-delay', `${Math.min(idx, 6) * 80}ms`);
            revealObserver.observe(el);
        });
    }

    // cards rendered later by main.js (recommendations, favorites…) reveal too
    function watchNewContent() {
        if (reduceMotion || !('MutationObserver' in window)) return;
        const mo = new MutationObserver((muts) => {
            muts.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) observeReveals(n); }));
        });
        const main = document.querySelector('.main-content') || document.body;
        mo.observe(main, { childList: true, subtree: true });
    }

    /* ------------------------------------------------------------ hero words */
    function splitWords(el) {
        if (!el || reduceMotion || el.dataset.split) return;
        el.dataset.split = '1';
        let i = 0;
        const walk = (node) => {
            Array.from(node.childNodes).forEach((child) => {
                if (child.nodeType === 3) {
                    const frag = document.createDocumentFragment();
                    child.textContent.split(/(\s+)/).forEach((part) => {
                        if (!part) return;
                        if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
                        const w = document.createElement('span');
                        w.className = 'bi-word';
                        const inner = document.createElement('span');
                        inner.style.setProperty('--i', i++);
                        inner.textContent = part;
                        w.appendChild(inner);
                        frag.appendChild(w);
                    });
                    child.replaceWith(frag);
                } else if (child.nodeType === 1) {
                    walk(child);
                }
            });
        };
        walk(el);
    }

    /* ------------------------------------------------------------ dashboard scrollytelling */
    function initScrollytelling() {
        const launchpad = document.getElementById('dashboard-launchpad');
        const story = document.querySelector('.bi-story');
        if (!launchpad) return;

        const hero = launchpad.querySelector('.feature-hero');
        const bar = document.createElement('div');
        bar.className = 'bi-scroll-progress';
        bar.setAttribute('aria-hidden', 'true');
        document.body.appendChild(bar);
        if (hero && !reduceMotion) hero.classList.add('bi-hero-scroll');

        /* The real tiles emerge out of the story: each tile's --e runs 0 → 1 as it scrolls into
           the lower part of the viewport, starting pulled toward the grid's centre (where the
           pinned radar was), small and blurred. */
        const grid = launchpad.querySelector('.feature-grid');
        const arrow = launchpad.querySelector('.bi-emerge-arrow');
        const tiles = grid ? Array.from(grid.querySelectorAll('.feature-tile')) : [];
        const emergeOn = !reduceMotion && tiles.length > 0 && !!story;
        let tileLayout = [];
        const measureTiles = () => {
            if (!emergeOn) return;
            const cx = grid.offsetWidth / 2;
            tileLayout = tiles.map((t) => {
                const left = t.offsetLeft - grid.offsetLeft, top = t.offsetTop - grid.offsetTop;
                t.style.setProperty('--dx', `${((cx - (left + t.offsetWidth / 2)) * 0.45).toFixed(1)}px`);
                t.style.setProperty('--dy', `${(-70 - top * 0.18).toFixed(1)}px`);
                return { top, col: Math.round(left / Math.max(1, t.offsetWidth)) };
            });
        };
        if (emergeOn) { grid.classList.add('bi-emerge'); measureTiles(); }
        const clamp01 = (v) => Math.min(1, Math.max(0, v));
        const easeOut = (v) => 1 - Math.pow(1 - v, 3);
        const updateEmerge = () => {
            if (!emergeOn) return;
            const vh = window.innerHeight;
            const gridTop = grid.getBoundingClientRect().top;
            const remaining = document.documentElement.scrollHeight - vh - window.scrollY;
            tiles.forEach((t, i) => {
                const L = tileLayout[i]; if (!L) return;
                const raw = (vh * 0.96 - (gridTop + L.top)) / (vh * 0.55) - L.col * 0.12;
                // tiles near the end of the page must still finish: complete them as the scroll runs out
                t.style.setProperty('--e', easeOut(clamp01(Math.max(raw, 1 - remaining / (vh * 0.25)))).toFixed(3));
            });
            if (arrow) arrow.style.setProperty('--e', clamp01((vh * 0.9 - arrow.getBoundingClientRect().top) / (vh * 0.3)).toFixed(3));
        };

        let ticking = false;
        const update = () => {
            ticking = false;
            const visible = !launchpad.classList.contains('d-none');
            bar.hidden = !visible;
            if (!visible) return;
            const doc = document.documentElement;
            const max = Math.max(1, doc.scrollHeight - window.innerHeight);
            bar.style.setProperty('--bi-progress', Math.min(1, window.scrollY / max).toFixed(4));
            if (hero) {
                const h = Math.max(1, hero.offsetHeight);
                hero.style.setProperty('--bi-hero', Math.min(1, Math.max(0, window.scrollY / h)).toFixed(3));
            }
            updateEmerge();
        };
        const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } };
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', () => { measureTiles(); onScroll(); });
        new MutationObserver(onScroll).observe(launchpad, { attributes: true, attributeFilter: ['class'] });
        update();

        if (!story) return;
        const stage = story.querySelector('.bi-stage');
        const caption = story.querySelector('.bi-stage-caption');
        const steps = Array.from(story.querySelectorAll('.bi-step'));
        // figures count up each time their chapter becomes active
        const countUp = (el) => {
            const target = Number(el.dataset.count);
            if (!Number.isFinite(target) || reduceMotion) return;
            const pre = el.dataset.prefix || '', suf = el.dataset.suffix || '';
            const t0 = performance.now(), dur = 900;
            const frame = (now) => {
                const k = Math.min(1, (now - t0) / dur);
                el.textContent = pre + Math.round(target * (1 - Math.pow(1 - k, 3))) + suf;
                if (k < 1 && el.isConnected) requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
        };
        let current = -1;
        const setStep = (idx) => {
            if (idx === current) return;
            current = idx;
            if (steps[idx]) steps[idx].querySelectorAll('[data-count]').forEach(countUp);
            steps.forEach((s, i) => s.classList.toggle('is-active', i === idx));
            if (stage) stage.dataset.step = String(idx);
            if (caption && steps[idx]) caption.textContent = steps[idx].dataset.caption || '';
        };

        if (reduceMotion || !('IntersectionObserver' in window)) { setStep(steps.length - 1); return; }
        // a chapter becomes active when it crosses the middle band of the viewport
        const io = new IntersectionObserver((entries) => {
            entries.forEach((e) => { if (e.isIntersecting) setStep(steps.indexOf(e.target)); });
        }, { rootMargin: '-45% 0px -45% 0px', threshold: 0 });
        steps.forEach((s) => io.observe(s));
    }

    /* ------------------------------------------------------------ typewriter placeholder */
    function typewriter(input, phrases, opts) {
        if (!input || input.dataset.typewriter) return null;
        input.dataset.typewriter = '1';
        const original = input.getAttribute('placeholder') || '';
        if (reduceMotion) return { restart() {} };
        const o = Object.assign({ type: 55, erase: 25, hold: 1600, startDelay: 0 }, opts);
        let timer = null, phrase = 0, pos = 0, erasing = false, running = false;

        const stop = () => { clearTimeout(timer); running = false; input.classList.remove('bi-typing'); input.setAttribute('placeholder', original); };
        const tick = () => {
            if (!running) return;
            const text = phrases[phrase % phrases.length];
            if (!erasing) {
                pos++;
                input.setAttribute('placeholder', text.slice(0, pos) + (pos < text.length ? '|' : ''));
                if (pos >= text.length) { erasing = true; timer = setTimeout(tick, o.hold); return; }
                timer = setTimeout(tick, o.type + Math.random() * 40);
            } else {
                pos--;
                input.setAttribute('placeholder', text.slice(0, pos));
                if (pos <= 0) { erasing = false; phrase++; timer = setTimeout(tick, 350); return; }
                timer = setTimeout(tick, o.erase);
            }
        };
        const start = (delay) => {
            if (document.activeElement === input || input.value) return;
            clearTimeout(timer);
            running = true; pos = 0; erasing = false;
            input.classList.add('bi-typing');
            input.setAttribute('placeholder', '');
            timer = setTimeout(tick, delay || 0);
        };

        input.addEventListener('focus', stop);
        input.addEventListener('blur', () => { if (!input.value) start(600); });
        start(o.startDelay);
        return { restart: start, stop };
    }

    /* ------------------------------------------------------------ search intro */
    function initSearchIntro() {
        const wrap = document.querySelector('.map-top-bar-search');
        const input = document.getElementById('dashboard-location-search');
        const container = document.getElementById('dynamic-map-container');
        if (!wrap || !input) return;

        if (!wrap.querySelector('.bi-search-icon')) {
            const icon = document.createElement('i');
            icon.className = 'fas fa-search bi-search-icon';
            icon.setAttribute('aria-hidden', 'true');
            wrap.prepend(icon);
            wrap.classList.add('bi-has-icon');
        }

        const tw = typewriter(input, [
            'Search Koramangala',
            'Best area for a café',
            'Try Indiranagar',
            'Search any area…',
        ], { startDelay: 1300 });

        const play = () => {
            if (reduceMotion) return;
            wrap.classList.remove('bi-search-intro');
            void wrap.offsetWidth; // restart the CSS animation
            wrap.classList.add('bi-search-intro');
            if (tw) tw.restart(1300);
        };
        wrap.addEventListener('animationend', (e) => {
            if (e.target === wrap && e.animationName === 'bi-search-shape') wrap.classList.remove('bi-search-intro');
        });

        if (container) {
            let wasHidden = container.classList.contains('d-none');
            if (!wasHidden) play();
            new MutationObserver(() => {
                const hidden = container.classList.contains('d-none');
                if (wasHidden && !hidden) play();
                wasHidden = hidden;
            }).observe(container, { attributes: true, attributeFilter: ['class'] });
        } else {
            play();
        }
    }

    function initAssistantTypewriter() {
        typewriter(document.getElementById('chatbot-input'), [
            'Search features or ask…',
            'Open the live map',
            'Show business analytics',
            'Generate a report',
        ], { startDelay: 800 });
    }

    /* ------------------------------------------------------------ self-playing radar (sign-in page) */
    function initAutoStage() {
        const stage = document.querySelector('.bi-stage[data-autoplay]');
        if (!stage) return;
        const caption = stage.parentElement.querySelector('.bi-stage-caption');
        const chapters = ['5 km radar scan', 'Live crowd intensity', '16 popular places', 'Projected revenue', 'Top 5 opportunities'];
        let i = reduceMotion ? chapters.length - 1 : 0;
        const show = () => { stage.dataset.step = String(i); if (caption) caption.textContent = chapters[i]; };
        setTimeout(() => {
            show();
            if (reduceMotion) return;
            setInterval(() => { if (document.hidden) return; i = (i + 1) % chapters.length; show(); }, 3200);
        }, 700);
    }

    /* ------------------------------------------------------------ boot */
    function boot() {
        splitWords(document.querySelector('.feature-hero-title'));
        splitWords(document.querySelector('.home-hero .hero-title'));
        observeReveals(document.body);
        watchNewContent();
        initScrollytelling();
        initSearchIntro();
        initAssistantTypewriter();
        initAutoStage();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
