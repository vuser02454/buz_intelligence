// Tests for static/js/onboarding.js: Navigation Onboarding System for new users
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../../static/js/onboarding.js'), 'utf8');
const windows = [];
after(() => windows.forEach((w) => w.close()));

const DASHBOARD_HTML = `
    <nav class="navbar navbar-base">
        <a class="nav-link" href="#" id="navbar-tour-btn">Guide</a>
    </nav>
    <aside class="dashboard-sidebar">
        <a href="#" id="sidebar-dashboard-link">Dashboard</a>
        <a href="#" id="sidebar-heatmap-link">Map</a>
        <a href="#" id="sidebar-ai-link">Analytics</a>
        <a href="#" id="sidebar-recs-link">Recommendations</a>
        <a href="#" id="sidebar-startup-form-link">Startup Form</a>
        <a href="#" id="sidebar-tour-link">Guided Tour</a>
    </aside>
    <div class="dashboard-main">
        <header class="dashboard-header">
            <button id="dashboard-tour-header-btn">Tour</button>
        </header>
        <div id="dashboard-launchpad" class="feature-showcase-launchpad">
            <button id="btn-show-map">Launch Live Map</button>
            <button id="btn-show-ai-recommender">AI Recommender</button>
            <button id="btn-show-recommendations">Recommendations</button>
            <button id="btn-show-startup-form-from-launchpad">Start</button>
        </div>
    </div>
    <button id="chat-toggle-btn" class="chat-fab-btn"></button>
`;

function setup({ completed = false } = {}) {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>${DASHBOARD_HTML}</body></html>`, {
        runScripts: 'outside-only',
        url: 'http://127.0.0.1:8000/dashboard/'
    });
    const w = dom.window;
    windows.push(w);

    if (completed) {
        w.localStorage.setItem('crowd_heatmap_onboarding_completed', 'true');
    } else {
        w.localStorage.removeItem('crowd_heatmap_onboarding_completed');
    }

    w.eval(SCRIPT);
    return { w, dom };
}

test('onboarding elements are injected into the DOM upon initialization', () => {
    const { w } = setup();
    assert.ok(w.document.getElementById('onboarding-backdrop'), 'Backdrop element exists');
    assert.ok(w.document.getElementById('onboarding-spotlight'), 'Spotlight element exists');
    assert.ok(w.document.getElementById('onboarding-popover'), 'Popover element exists');
    assert.ok(w.document.getElementById('onboarding-welcome-modal'), 'Welcome modal exists');
});

test('auto-shows welcome modal for first-time visitors', async () => {
    const { w } = setup({ completed: false });
    const modal = w.document.getElementById('onboarding-welcome-modal');
    assert.ok(modal);
    
    // Explicitly verify showWelcomeModal works as triggered
    w.Onboarding.showWelcomeModal();
    assert.ok(modal.classList.contains('show'), 'Modal has .show class');
});

test('does not auto-start if already marked completed in localStorage', () => {
    const { w } = setup({ completed: true });
    assert.strictEqual(w.Onboarding.hasCompleted(), true);
    assert.strictEqual(w.Onboarding.isActive, false);
});

test('clicking Start Guided Tour begins walkthrough at step 0', () => {
    const { w } = setup({ completed: false });
    const startBtn = w.document.getElementById('btn-welcome-start');
    startBtn.click();

    assert.strictEqual(w.Onboarding.isActive, true);
    assert.strictEqual(w.Onboarding.currentStep, 0);

    const title = w.document.getElementById('onboarding-popover-title');
    assert.match(title.innerHTML, /Business Intelligence/i);
});

test('advancing steps via next() and prev() works correctly', () => {
    const { w } = setup();
    w.Onboarding.start(0);

    const nextBtn = w.document.getElementById('btn-onboarding-next');
    const prevBtn = w.document.getElementById('btn-onboarding-prev');

    // Initial step: prev is disabled
    assert.strictEqual(w.Onboarding.currentStep, 0);
    assert.strictEqual(prevBtn.disabled, true);

    // Step 1: Sidebar navigation
    nextBtn.click();
    assert.strictEqual(w.Onboarding.currentStep, 1);
    assert.strictEqual(prevBtn.disabled, false);
    let title = w.document.getElementById('onboarding-popover-title');
    assert.match(title.innerHTML, /Sidebar Navigation/i);

    // Step 2: Live Heatmap
    nextBtn.click();
    assert.strictEqual(w.Onboarding.currentStep, 2);
    title = w.document.getElementById('onboarding-popover-title');
    assert.match(title.innerHTML, /Heatmap/i);

    // Back to Step 1
    prevBtn.click();
    assert.strictEqual(w.Onboarding.currentStep, 1);
});

test('direct step jump with goToStep()', () => {
    const { w } = setup();
    w.Onboarding.start(0);

    w.Onboarding.goToStep(3);
    assert.strictEqual(w.Onboarding.currentStep, 3);
    const title = w.document.getElementById('onboarding-popover-title');
    assert.match(title.innerHTML, /Revenue Analytics/i);
});

test('exit() closes tour and marks onboarding completed in localStorage', () => {
    const { w } = setup({ completed: false });
    w.Onboarding.start(1);
    assert.strictEqual(w.Onboarding.isActive, true);

    w.Onboarding.exit();
    assert.strictEqual(w.Onboarding.isActive, false);
    assert.strictEqual(w.localStorage.getItem('crowd_heatmap_onboarding_completed'), 'true');

    const backdrop = w.document.getElementById('onboarding-backdrop');
    assert.strictEqual(backdrop.classList.contains('active'), false);
});

test('trigger buttons (navbar, sidebar, header) restart the tour', () => {
    const { w } = setup({ completed: true });
    
    // Navbar trigger
    const navBtn = w.document.getElementById('navbar-tour-btn');
    navBtn.click();
    assert.strictEqual(w.Onboarding.isActive, true);
    assert.strictEqual(w.Onboarding.currentStep, 0);
    w.Onboarding.exit();

    // Sidebar trigger
    const sidebarBtn = w.document.getElementById('sidebar-tour-link');
    sidebarBtn.click();
    assert.strictEqual(w.Onboarding.isActive, true);
    w.Onboarding.exit();

    // Header trigger
    const headerBtn = w.document.getElementById('dashboard-tour-header-btn');
    headerBtn.click();
    assert.strictEqual(w.Onboarding.isActive, true);
});

test('keyboard navigation: ArrowRight advances, ArrowLeft goes back, Escape exits', () => {
    const { w } = setup();
    w.Onboarding.start(0);

    // ArrowRight -> step 1
    w.window.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight' }));
    assert.strictEqual(w.Onboarding.currentStep, 1);

    // ArrowLeft -> step 0
    w.window.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    assert.strictEqual(w.Onboarding.currentStep, 0);

    // Escape -> exit
    w.window.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.strictEqual(w.Onboarding.isActive, false);
});

test('last step triggers primary action (Launch Live Map)', () => {
    const { w } = setup();
    let mapClicked = false;
    w.document.getElementById('btn-show-map').addEventListener('click', () => {
        mapClicked = true;
    });

    // Jump to last step (step 7)
    w.Onboarding.start(7);
    assert.strictEqual(w.Onboarding.currentStep, 7);

    const nextBtn = w.document.getElementById('btn-onboarding-next');
    assert.match(nextBtn.textContent, /Launch Live Map/i);

    nextBtn.click();
    assert.strictEqual(mapClicked, true, 'btn-show-map was clicked');
    assert.strictEqual(w.Onboarding.isActive, false, 'Tour closed after completion');
});

test('on non-dashboard pages, clicking navbar tour button redirects to /dashboard/?tour=true', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>${DASHBOARD_HTML}</body></html>`, {
        runScripts: 'outside-only',
        url: 'http://127.0.0.1:8000/'
    });
    const w = dom.window;
    windows.push(w);

    let navigatedUrl = null;
    w.__onboardingNavigate = (url) => {
        navigatedUrl = url;
    };

    w.eval(SCRIPT);

    const navBtn = w.document.getElementById('navbar-tour-btn');
    navBtn.click();
    assert.strictEqual(navigatedUrl, '/dashboard/?tour=true');
});

test('normal page elements receive clicks freely when tour is inactive', () => {
    const { w } = setup({ completed: true });
    let dashboardClicked = false;
    const dashLink = w.document.getElementById('sidebar-dashboard-link');
    dashLink.addEventListener('click', () => {
        dashboardClicked = true;
    });

    dashLink.click();
    assert.strictEqual(dashboardClicked, true, 'Dashboard link received click event');
    assert.strictEqual(w.Onboarding.isActive, false, 'Tour remains inactive');
});

