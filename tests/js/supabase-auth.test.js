// Frontend tests for static/js/supabase-auth.js (run: npm run test:js).
// A fake supabase-js client lets each test decide what the auth server says.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../../static/js/supabase-auth.js'), 'utf8');
const USER = { id: 'u-1', email: 'raj@example.com', user_metadata: { full_name: 'raj demo' } };
const SESSION = { access_token: 't'.repeat(40), user: USER };

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

function setup({ session = SESSION, getUser = async () => ({ data: { user: USER }, error: null }), path: urlPath = '/dashboard/', siteUrl = '' } = {}) {
    const dom = new JSDOM(`<!DOCTYPE html><body>
        <div id="navbar-auth-section"><a href="/login/">Sign In</a></div>
        <div class="sidebar-footer"><div id="sidebar-user-name-placeholder">Guest User</div></div>
        <div id="supabase-auth-gate-modal" style="display:none"><span id="auth-gate-feature-name"></span>
          <a id="auth-gate-full-login-btn" href="/login/"></a><div id="modal-auth-error" class="d-none"></div></div>
        </body>`, { runScripts: 'outside-only', url: 'http://127.0.0.1:8000' + urlPath });
    const w = dom.window;
    const calls = { signOut: [], listeners: [] };
    w.navigator.sendBeacon = () => true;
    w.fetch = async () => ({ ok: true, json: async () => ({}) });
    w.SUPABASE_CONFIG = { url: 'https://x.supabase.co', key: 'anon', siteUrl };
    w.supabase = {
        createClient: () => ({
            auth: {
                getSession: async () => ({ data: { session } }),
                getUser,
                signOut: async (opts) => { calls.signOut.push(opts || {}); return { error: null }; },
                onAuthStateChange: (cb) => { calls.listeners.push(cb); return { data: { subscription: {} } }; },
                signInWithPassword: async () => ({ data: { user: USER, session: SESSION }, error: null }),
            },
        }),
    };
    w.localStorage.setItem('selectedLocation', JSON.stringify({ lat: 9.17, lng: 76.5, name: 'Kayamkulam' }));
    w.eval(SCRIPT);
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    const nav = () => w.document.getElementById('navbar-auth-section').textContent;
    return { w, calls, nav };
}

test('navbar never shows the user before the server has verified the session', async () => {
    const pending = deferred();
    const { w, nav } = setup({ getUser: () => pending.promise });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(!nav().includes('raj demo'), 'user rendered from unverified localStorage session');
    pending.resolve({ data: { user: USER }, error: null });
    const user = await w.SupabaseAuth.ready;
    assert.equal(user.id, 'u-1');
    assert.ok(nav().includes('raj demo'));
    assert.equal(w.SupabaseAuth.isAuthenticated(), true);
});

test('stale/revoked session: signed-out UI, local session dropped, user state cleared', async () => {
    const { w, calls, nav } = setup({ getUser: async () => ({ data: { user: null }, error: { status: 401, message: 'invalid JWT' } }) });
    const user = await w.SupabaseAuth.ready;
    assert.equal(user, null);
    assert.ok(nav().includes('Sign In'));
    assert.ok(!nav().includes('raj demo'));
    assert.equal(JSON.stringify(calls.signOut), JSON.stringify([{ scope: 'local' }]));
    assert.equal(w.localStorage.getItem('selectedLocation'), null);
    assert.equal(await w.SupabaseAuth.getSession(), null, 'API callers must not get an unverified token');
});

test('network failure keeps the stored session but shows signed-out UI', async () => {
    const { w, calls, nav } = setup({ getUser: async () => { throw new Error('offline'); } });
    assert.equal(await w.SupabaseAuth.ready, null);
    assert.ok(nav().includes('Sign In'));
    assert.equal(calls.signOut.length, 0);
});

test('feature gate waits for the session check instead of showing the modal to a signed-in user', async () => {
    const pending = deferred();
    const { w } = setup({ getUser: () => pending.promise });
    let ran = false;
    const result = w.requireSupabaseAuth('Live Crowd Heatmap', () => { ran = true; });
    assert.equal(w.document.getElementById('supabase-auth-gate-modal').style.display, 'none');
    pending.resolve({ data: { user: USER }, error: null });
    await result;
    assert.equal(ran, true);
    assert.equal(w.document.getElementById('supabase-auth-gate-modal').style.display, 'none');
});

test('signed-out gate opens the modal with a login link back to the feature', async () => {
    const { w } = setup({ session: null });
    await w.SupabaseAuth.ready;
    let ran = false;
    w.requireSupabaseAuth('Live Crowd Heatmap', () => { ran = true; });
    assert.equal(ran, false);
    assert.equal(w.document.getElementById('supabase-auth-gate-modal').style.display, 'flex');
    assert.equal(w.document.getElementById('auth-gate-full-login-btn').getAttribute('href'),
        '/login/?next=' + encodeURIComponent('/dashboard/?auto_map=true'));
    assert.ok(!w.document.body.textContent.includes('Supabase'), 'infrastructure text in the gate');
});

test('onAuthStateChange callback is synchronous (no awaited Supabase calls inside the auth lock)', async () => {
    const { w, calls } = setup();
    await w.SupabaseAuth.ready;
    assert.equal(calls.listeners.length, 1);
    const ret = calls.listeners[0]('SIGNED_IN', SESSION);
    assert.equal(ret, undefined);
});

test('sign-out clears per-user state and the navbar', async () => {
    const { w, nav } = setup();
    await w.SupabaseAuth.ready;
    w.localStorage.setItem('selectedLocation', '{"lat":1,"lng":2}');
    w.localStorage.setItem('recentLocations', '[]');
    await w.SupabaseAuth.signOut();
    assert.equal(w.localStorage.getItem('selectedLocation'), null);
    assert.equal(w.localStorage.getItem('recentLocations'), null);
    assert.ok(nav().includes('Sign In'));
});

test('e-mail links point at SITE_URL/auth/callback/ with a safe next', async () => {
    const { w } = setup({ siteUrl: 'http://127.0.0.1:8000/' });
    assert.equal(w.SupabaseAuth.emailRedirectUrl('/dashboard/?auto_map=true'),
        'http://127.0.0.1:8000/auth/callback/?next=' + encodeURIComponent('/dashboard/?auto_map=true'));
    assert.equal(w.SupabaseAuth.emailRedirectUrl('//evil.example'),
        'http://127.0.0.1:8000/auth/callback/?next=' + encodeURIComponent('/dashboard/'));
});

test('display names are HTML-escaped in the navbar', async () => {
    const evil = { ...USER, user_metadata: { full_name: '<img src=x onerror=alert(1)>' } };
    const { w } = setup({ getUser: async () => ({ data: { user: evil }, error: null }) });
    await w.SupabaseAuth.ready;
    assert.equal(w.document.querySelector('#navbar-auth-section img[src="x"]'), null);
});
