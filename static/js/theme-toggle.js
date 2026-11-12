/*
 * Dark mode toggle (styles: static/css/dark-mode.css).
 *
 * The toggle is the moon ⇄ sun animation. A click starts the icon first (html[data-dm]), then
 * the new palette spreads across the page from the button (html[data-theme]).
 * The choice is remembered in localStorage('bi-theme'); a tiny inline script in base.html
 * applies it before first paint so there is no flash.
 */
(function () {
    'use strict';
    const KEY = 'bi-theme';
    const root = document.documentElement;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let busy = false;

    const current = () => (root.dataset.theme === 'dark' ? 'dark' : 'light');
    const syncButtons = (mode) => {
        document.querySelectorAll('.dm-toggle').forEach((b) => {
            b.setAttribute('aria-checked', String(mode === 'dark'));
            b.title = mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
        });
    };

    /* ---- moon ⇄ sun icon (Lottie) ----
       The animation runs moon (frame 0) → sun (last frame). Going to light it plays forwards,
       going to dark it plays backwards. If lottie-web or the file is unavailable, the button
       keeps its built-in SVG icons. */
    const icons = [];
    function initIcons() {
        if (!window.lottie) return;
        document.querySelectorAll('.dm-toggle[data-lottie]').forEach((btn) => {
            const holder = btn.querySelector('.dm-lottie');
            if (!holder) return;
            let anim;
            try {
                anim = window.lottie.loadAnimation({
                    container: holder, renderer: 'svg', loop: false, autoplay: false, path: btn.dataset.lottie,
                    rendererSettings: { preserveAspectRatio: 'xMidYMid meet' },
                });
            } catch (e) { return; }
            anim.addEventListener('DOMLoaded', () => {
                anim.goToAndStop(current() === 'dark' ? 0 : anim.totalFrames - 1, true);
                btn.classList.add('dm-has-lottie');
                icons.push(anim);
            });
        });
    }
    function playIcons(mode) {
        icons.forEach((anim) => {
            if (reduceMotion) { anim.goToAndStop(mode === 'dark' ? 0 : anim.totalFrames - 1, true); return; }
            anim.setDirection(mode === 'dark' ? -1 : 1);
            anim.play();
        });
    }

    function applyPalette(mode) {
        root.dataset.theme = mode;
        try { localStorage.setItem(KEY, mode); } catch (e) { /* private mode: the choice lasts for this page only */ }
        window.dispatchEvent(new CustomEvent('bi:themechange', { detail: { theme: mode } }));
    }

    /** Spread the new palette out from the toggle; falls back to a colour fade. */
    function spreadFrom(btn, mode) {
        if (reduceMotion) { applyPalette(mode); return Promise.resolve(); }
        if (!document.startViewTransition) {
            root.classList.add('dm-fading');
            applyPalette(mode);
            return new Promise((r) => setTimeout(() => { root.classList.remove('dm-fading'); r(); }, 550));
        }
        const rect = btn.getBoundingClientRect();
        const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
        const vt = document.startViewTransition(() => applyPalette(mode));
        vt.ready.then(() => {
            root.animate(
                { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
                { duration: 750, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' }
            );
        }).catch(() => {});
        return vt.finished.catch(() => {});
    }

    function toggle(btn) {
        if (busy) return;
        busy = true;
        const next = current() === 'dark' ? 'light' : 'dark';
        // 1. the icon starts first: moon spins into sun, or sun back into moon
        root.dataset.dm = next;
        syncButtons(next);
        playIcons(next);
        // 2. then the interface follows, about when one icon has given way to the other
        setTimeout(() => {
            spreadFrom(btn, next).then(() => { busy = false; });
        }, reduceMotion ? 0 : 380);
    }

    function boot() {
        root.dataset.dm = current();
        syncButtons(current());
        initIcons();
        document.querySelectorAll('.dm-toggle').forEach((b) => b.addEventListener('click', () => toggle(b)));
        // another tab changed the theme
        window.addEventListener('storage', (e) => {
            if (e.key !== KEY || !e.newValue || e.newValue === current()) return;
            root.dataset.theme = root.dataset.dm = e.newValue === 'dark' ? 'dark' : 'light';
            syncButtons(current());
            icons.forEach((anim) => anim.goToAndStop(current() === 'dark' ? 0 : anim.totalFrames - 1, true));
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
