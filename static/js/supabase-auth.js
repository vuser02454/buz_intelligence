/**
 * Supabase authentication, feature gating and activity logging.
 *
 * Auth state rules:
 *  - The UI shows a user only after the session has been verified with the
 *    Supabase server (auth.getUser()). The session copy in localStorage is never
 *    trusted on its own, so a stale or revoked session shows the signed-out UI.
 *  - `SupabaseAuth.ready` resolves once that check is done (to the user or null);
 *    feature gates wait for it, so a signed-in user is never shown the gate
 *    just because the page was still loading.
 *  - onAuthStateChange callbacks stay synchronous and never call other Supabase
 *    methods: supabase-js awaits these callbacks while it holds its auth lock,
 *    so awaiting a query there stalls (or dead-locks) signInWithPassword.
 *  - Activity logging is fire-and-forget through the server (sendBeacon) and is
 *    never awaited on the sign-in path.
 */

(function () {
    'use strict';

    const CONFIG = window.SUPABASE_CONFIG || {};
    const SUPABASE_URL = CONFIG.url || 'https://ijsfmdgysmwovaighumv.supabase.co';
    const SUPABASE_ANON_KEY = CONFIG.key || 'sb_publishable_EdW1JxXZSkEA1uV4Yl4eIg_F9dvq-2h';

    // App state that belongs to the signed-in user and must not survive a sign-out.
    const USER_STATE_KEYS = ['selectedLocation', 'recentLocations', 'supabase_activity_logs'];

    // Where each gated feature lives, so "sign in" can bring the user back to it.
    const FEATURE_ROUTES = {
        'Live Crowd Heatmap': '/dashboard/?auto_map=true',
        'Live Heatmap Tile': '/dashboard/?auto_map=true',
        'Popular Places Radar': '/dashboard/?auto_map=true',
        'Map': '/dashboard/?auto_map=true',
        'Detailed Report': '/dashboard/?auto_map=true',
        'AI Business Recommender': '/dashboard/?ai=true',
        'Business Recommendations': '/dashboard/?recs=true',
        'Business Analytics': '/dashboard/?ai=true',
        'Revenue Intelligence': '/dashboard/?ai=true',
        'Startup Form': '/dashboard/?form=startup',
        'Startup Form & Feasibility': '/dashboard/?form=startup',
        'Feasibility Engine': '/dashboard/?form=startup',
        'Favorites': '/favorites/',
    };

    let supabaseClient = null;
    let currentUserSession = null;
    let verifiedUser = null;
    let readySettled = false;
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    let pendingFeatureCallback = null;
    let pendingFeatureName = null;
    const changeListeners = [];

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function initSupabase() {
        if (supabaseClient) return supabaseClient;
        if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
            console.warn('[Auth] SDK not loaded yet.');
            return null;
        }
        try {
            supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
            });
        } catch (err) {
            console.error('[Auth] Initialization error:', err);
        }
        return supabaseClient;
    }

    function siteUrl() {
        return (CONFIG.siteUrl || window.location.origin).replace(/\/+$/, '');
    }

    /** Absolute URL Supabase e-mails should send the user to (must be in the Redirect URLs allow-list). */
    function emailRedirectUrl(next) {
        const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard/';
        return `${siteUrl()}/auth/callback/?next=${encodeURIComponent(target)}`;
    }

    function clearUserState() {
        USER_STATE_KEYS.forEach((k) => { try { localStorage.removeItem(k); } catch (_e) { /* storage blocked */ } });
        try { sessionStorage.clear(); } catch (_e) { /* storage blocked */ }
    }

    function setVerified(user, session) {
        verifiedUser = user || null;
        currentUserSession = user ? (session || currentUserSession) : null;
        updateAuthUI(verifiedUser);
        changeListeners.forEach((cb) => { try { cb(verifiedUser); } catch (e) { console.error(e); } });
    }

    function settle() {
        if (!readySettled) {
            readySettled = true;
            resolveReady(verifiedUser);
        }
    }

    /**
     * Check the stored session with the Supabase server. Returns the verified
     * user or null. An invalid session is removed locally; a network failure
     * leaves it in place but the UI stays signed-out until a later check succeeds.
     */
    async function verifySession() {
        const client = initSupabase();
        if (!client) return null;
        try {
            const { data } = await client.auth.getSession();   // refreshes an expired token if possible
            const session = data && data.session;
            if (!session) return null;
            const { data: userData, error } = await client.auth.getUser();
            if (error || !userData || !userData.user) {
                const status = error && error.status;
                if (status === 401 || status === 403 || (error && /jwt|token|session|not found/i.test(error.message || ''))) {
                    await client.auth.signOut({ scope: 'local' });
                    clearUserState();
                }
                return null;
            }
            currentUserSession = session;
            return userData.user;
        } catch (e) {
            console.warn('[Auth] Session check failed:', e);
            return null;
        }
    }

    async function refreshVerifiedUser() {
        const user = await verifySession();
        setVerified(user, currentUserSession);
        settle();
        return user;
    }

    /** Session for API calls (Bearer token). Only returned for a verified user. */
    async function getSession() {
        await ready;
        if (!verifiedUser) return null;
        const client = initSupabase();
        if (!client) return null;
        try {
            const { data } = await client.auth.getSession();  // picks up refreshed tokens
            currentUserSession = (data && data.session) || null;
        } catch (_e) { /* keep last session */ }
        return currentUserSession;
    }

    function isAuthenticated() {
        return !!verifiedUser;
    }

    // Fire-and-forget: the server writes the row; nothing on the sign-in path waits for it.
    function logSupabaseActivity(eventType, featureName, details) {
        const user = verifiedUser;
        const payload = JSON.stringify({
            event_type: eventType || 'action',
            feature_name: featureName || '',
            user_id: user ? user.id : null,
            user_email: user ? user.email : 'guest',
            details: details || {},
        });
        try {
            if (navigator.sendBeacon && navigator.sendBeacon('/api/log-activity/', new Blob([payload], { type: 'application/json' }))) {
                return Promise.resolve();
            }
        } catch (_e) { /* fall through to fetch */ }
        return fetch('/api/log-activity/', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true,
        }).then(() => undefined).catch(() => undefined);
    }

    function getInitials(name) {
        if (!name) return 'U';
        const parts = name.trim().split(/\s+/);
        if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
        return (name[0] || 'U').toUpperCase();
    }

    function getAvatarHtml(user, sizeClass = '') {
        const meta = (user && user.user_metadata) || {};
        const avatarUrl = meta.avatar_base64 || meta.avatar_url;
        const name = meta.full_name || meta.name || (user && user.email ? user.email.split('@')[0] : 'U');
        const initials = esc(getInitials(name));
        if (avatarUrl && /^(https:|data:image\/)/i.test(avatarUrl)) {
            return `<img src="${esc(avatarUrl)}" alt="${esc(name)}" class="${esc(sizeClass)}" onerror="this.onerror=null; this.parentElement.textContent='${initials}';">`;
        }
        return `<span>${initials}</span>`;
    }

    function loginUrl(featureName) {
        const next = FEATURE_ROUTES[featureName] || (window.location.pathname + window.location.search);
        return `/login/?next=${encodeURIComponent(next)}`;
    }

    function updateAuthUI(user) {
        const sidebarFooter = document.querySelector('.sidebar-footer');
        const navAuthContainer = document.getElementById('navbar-auth-section');
        const sidebarAvatarHolder = document.getElementById('sidebar-user-avatar-placeholder');
        const sidebarNameHolder = document.getElementById('sidebar-user-name-placeholder');

        ['sidebar-supabase-profile', 'sidebar-supabase-logout'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.remove();
        });

        if (user) {
            const meta = user.user_metadata || {};
            const displayName = meta.full_name || meta.name || (user.email || '').split('@')[0];
            const avatarHtml = getAvatarHtml(user);

            const oldLoginBtn = document.getElementById('sidebar-supabase-login');
            if (oldLoginBtn) oldLoginBtn.remove();
            if (sidebarAvatarHolder) sidebarAvatarHolder.innerHTML = avatarHtml;
            if (sidebarNameHolder) { sidebarNameHolder.textContent = displayName; sidebarNameHolder.title = user.email || ''; }
            const sidebarDropLogout = document.getElementById('sidebar-dropdown-logout');
            if (sidebarDropLogout && !sidebarDropLogout._wired) {
                sidebarDropLogout._wired = true;
                sidebarDropLogout.addEventListener('click', handleSignOut);
            }

            if (navAuthContainer) {
                navAuthContainer.innerHTML = `
                    <div class="dropdown nav-user-dropdown" id="nav-user-dropdown-container">
                        <button class="nav-user-btn" type="button" id="navUserMenuBtn" data-bs-toggle="dropdown" data-bs-auto-close="true" aria-expanded="false" title="${esc(displayName)} (${esc(user.email)})">
                            <div class="nav-user-avatar">${avatarHtml}</div>
                            <span class="nav-user-name">${esc(displayName)}</span>
                            <i class="fas fa-chevron-down nav-user-chevron"></i>
                        </button>
                        <div class="dropdown-menu dropdown-menu-end nav-user-menu" aria-labelledby="navUserMenuBtn">
                            <div class="nav-user-header">
                                <div class="nav-user-header-avatar">${avatarHtml}</div>
                                <div class="nav-user-header-info">
                                    <div class="nav-user-header-name">${esc(displayName)}</div>
                                    <div class="nav-user-header-email">${esc(user.email)}</div>
                                </div>
                            </div>
                            <a class="nav-user-item" href="/profile/">
                                <i class="fas fa-user-circle text-success" style="font-size: 1rem;"></i>
                                <span>Profile Settings</span>
                            </a>
                            <a class="nav-user-item" href="/dashboard/">
                                <i class="fas fa-th-large text-info" style="font-size: 1rem;"></i>
                                <span>Dashboard</span>
                            </a>
                            <a class="nav-user-item" href="/favorites/">
                                <i class="fas fa-heart text-danger" style="font-size: 1rem;"></i>
                                <span>My Favorites</span>
                            </a>
                            <hr class="nav-user-divider">
                            <button class="nav-user-item item-danger" id="nav-supabase-logout" type="button">
                                <i class="fas fa-sign-out-alt" style="font-size: 1rem;"></i>
                                <span>Sign Out</span>
                            </button>
                        </div>
                    </div>`;
                const navLogout = document.getElementById('nav-supabase-logout');
                if (navLogout) navLogout.addEventListener('click', handleSignOut);
            }
        } else {
            if (sidebarAvatarHolder) sidebarAvatarHolder.innerHTML = '<i class="fas fa-user" style="color:#94a3b8;"></i>';
            if (sidebarNameHolder) { sidebarNameHolder.textContent = 'Guest User'; sidebarNameHolder.title = ''; }

            let loginBtn = document.getElementById('sidebar-supabase-login');
            if (!loginBtn && sidebarFooter) {
                loginBtn = document.createElement('a');
                loginBtn.id = 'sidebar-supabase-login';
                loginBtn.className = 'btn btn-sm btn-outline-info w-100 mt-2';
                loginBtn.innerHTML = '<i class="fas fa-sign-in-alt me-1"></i>Sign In';
                sidebarFooter.appendChild(loginBtn);
            }
            if (loginBtn) loginBtn.href = `/login/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;

            if (navAuthContainer && !window.location.pathname.startsWith('/login')) {
                const next = encodeURIComponent(window.location.pathname + window.location.search);
                navAuthContainer.innerHTML = `
                    <a href="/login/?next=${next}" class="btn btn-outline-light btn-sm px-3">
                        <i class="fas fa-sign-in-alt me-1"></i>Sign In
                    </a>`;
            } else if (navAuthContainer) {
                navAuthContainer.innerHTML = '';
            }
        }
    }

    async function handleSignOut(e) {
        if (e) e.preventDefault();
        logSupabaseActivity('auth_logout', 'Dashboard', { action: 'User clicked Sign Out' });
        const client = initSupabase();
        try {
            if (client) await client.auth.signOut();
        } catch (err) {
            // Server unreachable: still drop the local session.
            try { if (client) await client.auth.signOut({ scope: 'local' }); } catch (_e) { /* ignore */ }
        }
        clearUserState();
        setVerified(null);
        showAuthNotification('Signed out successfully.', 'info');
        setTimeout(() => { window.location.href = '/dashboard/'; }, 400);
    }

    /**
     * Gate a feature behind sign-in. Runs `callback` when the user is verified,
     * otherwise opens the sign-in modal and runs it after a successful sign-in.
     * Waits for the initial session check, so it gives the same answer on every page.
     */
    function requireSupabaseAuth(featureName, callback) {
        const decide = () => {
            if (verifiedUser) {
                logSupabaseActivity('feature_accessed', featureName, { authorized: true });
                if (typeof callback === 'function') callback();
                return true;
            }
            logSupabaseActivity('feature_access_blocked', featureName, { authorized: false, reason: 'unauthenticated' });
            pendingFeatureCallback = callback;
            pendingFeatureName = featureName;
            openAuthGateModal(featureName);
            return false;
        };
        // Synchronous once the session check is done (keeps the user gesture for
        // things like the geolocation prompt); otherwise wait for it.
        return readySettled ? decide() : ready.then(decide);
    }

    function openAuthGateModal(featureName) {
        const modal = document.getElementById('supabase-auth-gate-modal');
        if (!modal) {
            window.location.href = loginUrl(featureName);
            return;
        }
        const featureNameSpan = document.getElementById('auth-gate-feature-name');
        if (featureNameSpan) featureNameSpan.textContent = featureName || 'this feature';
        const fullLoginBtn = document.getElementById('auth-gate-full-login-btn');
        if (fullLoginBtn) fullLoginBtn.href = loginUrl(featureName);
        const errorAlert = document.getElementById('modal-auth-error');
        if (errorAlert) errorAlert.classList.add('d-none');
        modal.classList.add('show');
        modal.style.display = 'flex';
        document.body.classList.add('modal-open');
    }

    function closeAuthGateModal() {
        const modal = document.getElementById('supabase-auth-gate-modal');
        if (modal) {
            modal.classList.remove('show');
            modal.style.display = 'none';
            document.body.classList.remove('modal-open');
        }
    }

    function showAuthNotification(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `alert alert-${type === 'error' ? 'danger' : type} position-fixed top-0 end-0 m-4 shadow-lg`;
        toast.style.zIndex = '99999';
        toast.style.minWidth = '280px';
        const icon = document.createElement('i');
        icon.className = `fas fa-${type === 'error' ? 'exclamation-circle' : 'check-circle'} me-2`;
        toast.appendChild(icon);
        toast.appendChild(document.createTextNode(message));
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.transition = 'opacity 0.4s';
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 400);
        }, 3500);
    }

    function executePendingAction() {
        const cb = pendingFeatureCallback;
        const feat = pendingFeatureName;
        pendingFeatureCallback = null;
        pendingFeatureName = null;
        closeAuthGateModal();
        if (typeof cb === 'function') {
            showAuthNotification(`Signed in. Opening ${feat || 'feature'}…`, 'success');
            setTimeout(cb, 150);
        }
    }

    function setupAuthListeners(client) {
        // Must stay synchronous (see header). Verification runs after the callback returns.
        client.auth.onAuthStateChange((event, newSession) => {
            if (event === 'SIGNED_OUT') {
                setVerified(null);
                return;
            }
            if (['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED'].includes(event) && newSession) {
                currentUserSession = newSession;
                if (!verifiedUser || verifiedUser.id !== newSession.user.id || event === 'USER_UPDATED') {
                    setTimeout(refreshVerifiedUser, 0);
                }
            }
        });
        setupModalListeners();
        refreshVerifiedUser();
    }

    function setupModalListeners() {
        const modal = document.getElementById('supabase-auth-gate-modal');
        if (!modal) return;
        const closeBtn = modal.querySelector('.btn-close-modal');
        if (closeBtn) closeBtn.addEventListener('click', closeAuthGateModal);
        modal.addEventListener('click', (e) => { if (e.target === modal) closeAuthGateModal(); });

        const quickForm = document.getElementById('modal-supabase-login-form');
        const errorAlert = document.getElementById('modal-auth-error');
        const submitBtn = document.getElementById('modal-login-btn');
        if (!quickForm) return;

        const showError = (msg) => {
            if (!errorAlert) return;
            errorAlert.textContent = msg;
            errorAlert.classList.remove('d-none');
        };
        const resetBtn = () => {
            if (!submitBtn) return;
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fas fa-sign-in-alt me-1"></i> Sign In & Continue';
        };

        quickForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('modal-auth-email').value.trim();
            const password = document.getElementById('modal-auth-password').value;
            if (!email || !password) { showError('Please provide both email and password.'); return; }

            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i>Signing In...';
            }
            if (errorAlert) errorAlert.classList.add('d-none');

            const client = initSupabase();
            if (!client) { showError('Sign-in is temporarily unavailable. Please reload the page.'); resetBtn(); return; }

            try {
                const { data, error } = await client.auth.signInWithPassword({ email, password });
                if (error || !data || !data.user) {
                    setVerified(null);
                    showError((error && error.message) || 'Invalid login credentials.');
                } else {
                    // signInWithPassword's user comes straight from the auth server.
                    setVerified(data.user, data.session);
                    settle();
                    logSupabaseActivity('auth_login', pendingFeatureName || 'Modal Quick Login', { email: data.user.email });
                    executePendingAction();
                }
            } catch (err) {
                setVerified(null);
                showError(err.message || 'Login failed. Please try again.');
            } finally {
                resetBtn();
            }
        });
    }

    function boot() {
        const client = initSupabase();
        if (client) { setupAuthListeners(client); return; }
        // SDK script failed or is late: retry briefly, then settle as signed-out.
        let tries = 0;
        const timer = setInterval(() => {
            tries += 1;
            const retry = initSupabase();
            if (retry) { clearInterval(timer); setupAuthListeners(retry); }
            else if (tries >= 10) { clearInterval(timer); setVerified(null); settle(); }
        }, 300);
    }

    // /auth/callback/ appends ?email_verified=1 to the page it redirects to.
    function announceEmailVerified() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('email_verified') !== '1') return;
        params.delete('email_verified');
        const qs = params.toString();
        window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
        ready.then((user) => {
            if (user) showAuthNotification('Email verified. Welcome aboard!', 'success');
        });
    }

    let started = false;
    function start() {
        if (started) return;  // one auth listener per page, however often DOMContentLoaded fires
        started = true;
        announceEmailVerified();
        boot();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();

    window.SupabaseAuth = {
        init: initSupabase,
        ready: ready,
        getSession: getSession,
        getUser: () => verifiedUser,
        refresh: refreshVerifiedUser,
        isAuthenticated: isAuthenticated,
        requireAuth: requireSupabaseAuth,
        onChange: (cb) => { changeListeners.push(cb); },
        logActivity: logSupabaseActivity,
        signOut: handleSignOut,
        clearUserState: clearUserState,
        emailRedirectUrl: emailRedirectUrl,
        loginUrl: loginUrl,
        openModal: openAuthGateModal,
        closeModal: closeAuthGateModal,
        showNotification: showAuthNotification,
        updateUI: updateAuthUI,
    };

    window.requireSupabaseAuth = requireSupabaseAuth;
    window.logSupabaseActivity = logSupabaseActivity;
})();
