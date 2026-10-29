/**
 * ==============================================================================
 * Crowd Heatmap & Business Intelligence - Navigation Onboarding System
 * Interactive step-by-step walkthrough for new users with spotlight navigation.
 * Adheres to designs/DESIGN.md.
 * ==============================================================================
 */

(function () {
    'use strict';

    const STORAGE_KEY = 'crowd_heatmap_onboarding_completed';
    const AUTO_START_DELAY_MS = 800;

    const STEPS = [
        {
            id: 'welcome',
            title: 'Welcome to <strong>Business Intelligence</strong>',
            subtitle: 'Interactive Platform Navigation Tour',
            badge: 'Start',
            body: 'Discover how to navigate live crowd heatmaps, explore 3D revenue analytics, find top business recommendations, and generate comprehensive PDF intelligence reports.',
            tip: 'Use Arrow keys (Left / Right) to navigate and Esc to exit anytime.',
            target: '#dashboard-launchpad',
            fallbackTarget: '.feature-hero',
            placement: 'center',
            showArrow: false
        },
        {
            id: 'navigation',
            title: 'Primary <strong>Sidebar Navigation</strong>',
            subtitle: 'Unified Command & Access Center',
            badge: 'Navigation',
            body: 'Use the sidebar to effortlessly navigate between the Dashboard Launchpad, Live Heatmap, Business Analytics, AI Recommendations, Startup Feasibility Form, and Saved Favorites.',
            tip: 'On mobile, open the sidebar using the hamburger icon in the top bar.',
            target: '.dashboard-sidebar',
            fallbackTarget: '.navbar-base',
            placement: 'right'
        },
        {
            id: 'heatmap',
            title: 'Live <strong>Crowd Heatmap & Search</strong>',
            subtitle: '5 km Radius Spatial Analysis',
            badge: 'Live Map',
            body: 'Search any locality in India or click "Find My Location". The platform scans 5 km around the pin using live OpenStreetMap data, split into 9 sectors color-coded by crowd density (High, Medium, Low).',
            tip: 'All area scans are cached locally for lightning-fast repeated queries.',
            target: '#btn-show-map',
            fallbackTarget: '#sidebar-heatmap-link',
            placement: 'bottom'
        },
        {
            id: 'analytics',
            title: '3D Projected <strong>Revenue Analytics</strong>',
            subtitle: 'Extended Huff Model & Live Projections',
            badge: '3D Graph',
            body: 'Explore real-time projected revenue in an interactive 3D bar chart across Live (5-second WebSockets), Daily, Weekly, and Monthly views, paired with surrounding commercial synergy scores.',
            tip: 'Drag with your mouse or finger to rotate the 3D space, or scroll to zoom.',
            target: '#btn-show-ai-recommender',
            fallbackTarget: '#sidebar-ai-link',
            placement: 'bottom'
        },
        {
            id: 'recommendations',
            title: 'Top 5 Business <strong>Recommendations</strong>',
            subtitle: 'Machine Learning Opportunity Engine',
            badge: 'AI Engine',
            body: 'Our trained decision-tree model and revenue engine identify the Top 5 most viable businesses to open in the area, providing projected revenue, profit, break-even timelines, and local competition analysis.',
            tip: 'Filter by category or click "View on Live Map" to pinpoint optimal sectors.',
            target: '#btn-show-recommendations',
            fallbackTarget: '#sidebar-recs-link',
            placement: 'top'
        },
        {
            id: 'startup_form',
            title: 'Startup <strong>Feasibility Check</strong>',
            subtitle: 'Validate Concepts Before Investing',
            badge: 'Feasibility',
            body: 'Test your own business concept! Enter your planned business type and desired footfall intensity to receive an immediate Go/No-Go feasibility verdict and targeted orange marker placement.',
            tip: 'Get scientific validation based on actual neighborhood density and competition.',
            target: '#sidebar-startup-form-link',
            fallbackTarget: '#btn-show-startup-form-from-launchpad',
            placement: 'right'
        },
        {
            id: 'assistant_reports',
            title: 'AI Assistant & <strong>PDF Dossiers</strong>',
            subtitle: 'On-Demand Intelligence & Export',
            badge: 'AI & PDF',
            body: 'Ask our floating AI Assistant questions about any area or feature. When you are ready, click "Generate Detailed Report" to produce an exhaustive 20–25 page PDF location intelligence dossier.',
            tip: 'Reports run asynchronously in the background and can be saved or printed.',
            target: '#chat-toggle-btn',
            placement: 'left'
        },
        {
            id: 'complete',
            title: "You're <strong>Ready to Begin!</strong>",
            subtitle: 'Navigation Walkthrough Complete',
            badge: 'Complete',
            body: "You're all set! Search a neighborhood or launch the live heatmap to start uncovering location insights. You can restart this tour anytime using the 'Guide' or 'Tour' button in the navigation.",
            tip: 'Click "Launch Live Map" below to start exploring now.',
            target: null,
            placement: 'center',
            showArrow: false,
            primaryActionText: 'Launch Live Map',
            onPrimaryAction: function () {
                const mapBtn = document.getElementById('btn-show-map') || document.getElementById('sidebar-heatmap-link');
                if (mapBtn) {
                    mapBtn.click();
                }
            }
        }
    ];

    class OnboardingManager {
        constructor() {
            this.currentStep = 0;
            this.isActive = false;
            this.backdropEl = null;
            this.spotlightEl = null;
            this.popoverEl = null;
            this.welcomeModalEl = null;
            this.boundKeyHandler = this._handleKeyDown.bind(this);
            this.boundResizeHandler = this._handleResize.bind(this);
        }

        init() {
            if (typeof document === 'undefined') return;

            this._createElements();
            this._bindTriggers();

            const isDashboard = typeof window !== 'undefined' && 
                (window.location.pathname.includes('/dashboard') || window.location.pathname === '/dashboard/');

            // Check if ?tour=true is in URL (e.g. redirected from Guide on another page)
            const urlParams = (typeof window !== 'undefined' && window.location.search)
                ? new URLSearchParams(window.location.search)
                : null;
            const forceTour = urlParams && urlParams.get('tour') === 'true';

            if (forceTour) {
                setTimeout(() => {
                    this.start(0);
                }, 300);
                return;
            }

            // Only auto-show welcome modal on the Dashboard for first-time visitors
            if (isDashboard && !this.hasCompleted()) {
                setTimeout(() => {
                    this.showWelcomeModal();
                }, AUTO_START_DELAY_MS);
            }
        }

        hasCompleted() {
            try {
                return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === 'true';
            } catch (e) {
                return false;
            }
        }

        markCompleted() {
            try {
                if (typeof localStorage !== 'undefined') {
                    localStorage.setItem(STORAGE_KEY, 'true');
                }
            } catch (e) {
                // Storage unavailable
            }
        }

        reset() {
            try {
                if (typeof localStorage !== 'undefined') {
                    localStorage.removeItem(STORAGE_KEY);
                }
            } catch (e) {
                // Storage unavailable
            }
            this.start(0);
        }

        _createElements() {
            if (!document.body) return;

            if (document.getElementById('onboarding-backdrop')) {
                this.backdropEl = document.getElementById('onboarding-backdrop');
                this.spotlightEl = document.getElementById('onboarding-spotlight');
                this.popoverEl = document.getElementById('onboarding-popover');
                this.welcomeModalEl = document.getElementById('onboarding-welcome-modal');
                return;
            }

            // 1. Backdrop
            this.backdropEl = document.createElement('div');
            this.backdropEl.id = 'onboarding-backdrop';
            this.backdropEl.className = 'onboarding-backdrop';
            this.backdropEl.addEventListener('click', () => this.exit());
            document.body.appendChild(this.backdropEl);

            // 2. Spotlight
            this.spotlightEl = document.createElement('div');
            this.spotlightEl.id = 'onboarding-spotlight';
            this.spotlightEl.className = 'onboarding-spotlight';
            document.body.appendChild(this.spotlightEl);

            // 3. Popover
            this.popoverEl = document.createElement('div');
            this.popoverEl.id = 'onboarding-popover';
            this.popoverEl.className = 'onboarding-popover';
            this.popoverEl.setAttribute('role', 'dialog');
            this.popoverEl.setAttribute('aria-modal', 'true');
            this.popoverEl.setAttribute('aria-labelledby', 'onboarding-popover-title');
            this.popoverEl.innerHTML = `
                <div class="onboarding-arrow" id="onboarding-arrow"></div>
                <div class="onboarding-header">
                    <span class="onboarding-badge" id="onboarding-step-badge">STEP 1</span>
                    <div style="display:flex; align-items:center;">
                        <span class="onboarding-step-counter" id="onboarding-step-counter">1 of 8</span>
                        <button type="button" class="onboarding-close-btn" id="onboarding-close-btn" aria-label="Close Tour">&times;</button>
                    </div>
                </div>
                <h3 class="onboarding-title" id="onboarding-popover-title"></h3>
                <div class="onboarding-subtitle" id="onboarding-popover-subtitle"></div>
                <div class="onboarding-body" id="onboarding-popover-body"></div>
                <div class="onboarding-footer">
                    <div class="onboarding-dots" id="onboarding-dots" aria-label="Tour progress"></div>
                    <div class="onboarding-actions">
                        <button type="button" class="btn-onboarding-skip" id="btn-onboarding-skip">Skip</button>
                        <button type="button" class="btn-onboarding-prev" id="btn-onboarding-prev">Back</button>
                        <button type="button" class="btn-onboarding-next" id="btn-onboarding-next">Next</button>
                    </div>
                </div>
            `;
            document.body.appendChild(this.popoverEl);

            // Popover inner button events
            this.popoverEl.querySelector('#onboarding-close-btn').addEventListener('click', () => this.exit());
            this.popoverEl.querySelector('#btn-onboarding-skip').addEventListener('click', () => this.exit());
            this.popoverEl.querySelector('#btn-onboarding-prev').addEventListener('click', () => this.prev());
            this.popoverEl.querySelector('#btn-onboarding-next').addEventListener('click', () => this.next());

            // 4. Welcome Modal
            this.welcomeModalEl = document.createElement('div');
            this.welcomeModalEl.id = 'onboarding-welcome-modal';
            this.welcomeModalEl.className = 'onboarding-welcome-modal';
            this.welcomeModalEl.innerHTML = `
                <div class="onboarding-welcome-card" role="dialog" aria-modal="true" aria-labelledby="welcome-modal-title">
                    <button type="button" class="onboarding-close-btn" id="welcome-modal-close" style="position:absolute;top:16px;right:18px;" aria-label="Close">&times;</button>
                    <div class="onboarding-welcome-icon">
                        <i class="fas fa-compass"></i>
                    </div>
                    <h2 id="welcome-modal-title">Welcome to <strong>Business Intelligence</strong></h2>
                    <div class="welcome-sub">Location Analytics &amp; Crowd Intelligence</div>
                    <p>
                        Analyze any location in India within a 5 km radius using live OpenStreetMap data, footfall heatmaps, 3D revenue modeling, and AI business feasibility.
                    </p>
                    <ul class="onboarding-highlights-list">
                        <li><i class="fas fa-check"></i> Live crowd heatmap &amp; sectors</li>
                        <li><i class="fas fa-check"></i> Real-time 3D revenue graph</li>
                        <li><i class="fas fa-check"></i> Top 5 ML business picks</li>
                        <li><i class="fas fa-check"></i> 20+ page PDF intelligence reports</li>
                    </ul>
                    <div class="onboarding-welcome-actions">
                        <button type="button" class="btn-welcome-skip" id="btn-welcome-skip">Skip for Now</button>
                        <button type="button" class="btn-welcome-start" id="btn-welcome-start">
                            <i class="fas fa-play me-1"></i> Start Guided Tour
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(this.welcomeModalEl);

            this.welcomeModalEl.querySelector('#welcome-modal-close').addEventListener('click', () => this.hideWelcomeModal());
            this.welcomeModalEl.querySelector('#btn-welcome-skip').addEventListener('click', () => {
                this.markCompleted();
                this.hideWelcomeModal();
            });
            this.welcomeModalEl.querySelector('#btn-welcome-start').addEventListener('click', () => {
                this.hideWelcomeModal();
                this.start(0);
            });
        }

        _bindTriggers() {
            // Bind any elements that trigger the tour
            const triggers = document.querySelectorAll('#navbar-tour-btn, #sidebar-tour-link, #dashboard-tour-header-btn, [data-tour-trigger]');
            triggers.forEach(el => {
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    const isDashboard = typeof window !== 'undefined' &&
                        (window.location.pathname.includes('/dashboard') || window.location.pathname === '/dashboard/');
                    if (!isDashboard) {
                        if (typeof window.__onboardingNavigate === 'function') {
                            window.__onboardingNavigate('/dashboard/?tour=true');
                        } else if (window.location) {
                            window.location.href = '/dashboard/?tour=true';
                        }
                        return;
                    }
                    this.start(0);
                });
            });
        }

        showWelcomeModal() {
            if (!this.welcomeModalEl) return;
            this.welcomeModalEl.classList.add('show');
        }

        hideWelcomeModal() {
            if (!this.welcomeModalEl) return;
            this.welcomeModalEl.classList.remove('show');
        }

        start(stepIndex = 0) {
            this.hideWelcomeModal();
            this.isActive = true;
            this.currentStep = Math.max(0, Math.min(stepIndex, STEPS.length - 1));

            if (this.backdropEl) this.backdropEl.classList.add('active');
            if (this.popoverEl) this.popoverEl.classList.add('active');

            window.addEventListener('keydown', this.boundKeyHandler);
            window.addEventListener('resize', this.boundResizeHandler);

            this._renderStep();
        }

        exit() {
            this.isActive = false;
            if (this.backdropEl) this.backdropEl.classList.remove('active');
            if (this.spotlightEl) this.spotlightEl.classList.remove('active');
            if (this.popoverEl) this.popoverEl.classList.remove('active');
            if (this.welcomeModalEl) this.welcomeModalEl.classList.remove('show');

            window.removeEventListener('keydown', this.boundKeyHandler);
            window.removeEventListener('resize', this.boundResizeHandler);

            this.markCompleted();

            try {
                window.dispatchEvent(new CustomEvent('onboarding:exit', { detail: { step: this.currentStep } }));
            } catch (e) {}
        }

        next() {
            const step = STEPS[this.currentStep];
            if (this.currentStep >= STEPS.length - 1) {
                if (step && typeof step.onPrimaryAction === 'function') {
                    step.onPrimaryAction();
                }
                this.exit();
                return;
            }
            this.currentStep++;
            this._renderStep();
        }

        prev() {
            if (this.currentStep <= 0) return;
            this.currentStep--;
            this._renderStep();
        }

        goToStep(index) {
            if (index < 0 || index >= STEPS.length) return;
            this.currentStep = index;
            this._renderStep();
        }

        _renderStep() {
            const step = STEPS[this.currentStep];
            if (!step || !this.popoverEl) return;

            // Target element resolution
            let targetEl = null;
            if (step.target) {
                targetEl = document.querySelector(step.target);
            }
            if (!targetEl && step.fallbackTarget) {
                targetEl = document.querySelector(step.fallbackTarget);
            }

            // Update contents
            const badgeEl = this.popoverEl.querySelector('#onboarding-step-badge');
            const counterEl = this.popoverEl.querySelector('#onboarding-step-counter');
            const titleEl = this.popoverEl.querySelector('#onboarding-popover-title');
            const subtitleEl = this.popoverEl.querySelector('#onboarding-popover-subtitle');
            const bodyEl = this.popoverEl.querySelector('#onboarding-popover-body');
            const prevBtn = this.popoverEl.querySelector('#btn-onboarding-prev');
            const nextBtn = this.popoverEl.querySelector('#btn-onboarding-next');
            const dotsContainer = this.popoverEl.querySelector('#onboarding-dots');

            badgeEl.textContent = step.badge || `STEP ${this.currentStep + 1}`;
            counterEl.textContent = `${this.currentStep + 1} of ${STEPS.length}`;
            titleEl.innerHTML = step.title;
            subtitleEl.textContent = step.subtitle || '';

            let bodyHtml = `<p style="margin:0;">${step.body}</p>`;
            if (step.tip) {
                bodyHtml += `
                    <div class="onboarding-tip">
                        <i class="fas fa-lightbulb"></i>
                        <span>${step.tip}</span>
                    </div>
                `;
            }
            bodyEl.innerHTML = bodyHtml;

            // Update action buttons
            prevBtn.disabled = this.currentStep === 0;
            if (this.currentStep === STEPS.length - 1) {
                nextBtn.innerHTML = `${step.primaryActionText || 'Finish'} <i class="fas fa-check ms-1"></i>`;
            } else {
                nextBtn.innerHTML = `Next <i class="fas fa-arrow-right ms-1"></i>`;
            }

            // Render progress dots
            dotsContainer.innerHTML = '';
            STEPS.forEach((s, idx) => {
                const dot = document.createElement('button');
                dot.type = 'button';
                dot.className = `onboarding-dot ${idx === this.currentStep ? 'active' : ''}`;
                dot.setAttribute('aria-label', `Go to step ${idx + 1}`);
                dot.addEventListener('click', () => this.goToStep(idx));
                dotsContainer.appendChild(dot);
            });

            // Position spotlight & popover
            this._positionTour(targetEl, step.placement, step.showArrow !== false);

            try {
                window.dispatchEvent(new CustomEvent('onboarding:step_change', {
                    detail: { step: this.currentStep, stepId: step.id }
                }));
            } catch (e) {}
        }

        _positionTour(targetEl, preferredPlacement, showArrow) {
            const arrowEl = this.popoverEl.querySelector('#onboarding-arrow');
            if (arrowEl) {
                arrowEl.style.display = showArrow ? 'block' : 'none';
            }

            // If no target element or placement is 'center', position in center of screen
            if (!targetEl || preferredPlacement === 'center') {
                if (this.spotlightEl) {
                    this.spotlightEl.classList.remove('active');
                }
                this.popoverEl.removeAttribute('data-popper-placement');
                this.popoverEl.style.top = '50%';
                this.popoverEl.style.left = '50%';
                this.popoverEl.style.transform = 'translate(-50%, -50%)';
                return;
            }

            // Scroll target into view if outside
            try {
                targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
            } catch (e) {}

            // Calculate rect of target
            const rect = (typeof targetEl.getBoundingClientRect === 'function')
                ? targetEl.getBoundingClientRect()
                : { top: 100, left: 100, width: 200, height: 50, bottom: 150, right: 300 };
            const pad = 6;

            // Highlight target with spotlight
            if (this.spotlightEl) {
                this.spotlightEl.style.top = `${Math.max(0, rect.top - pad)}px`;
                this.spotlightEl.style.left = `${Math.max(0, rect.left - pad)}px`;
                this.spotlightEl.style.width = `${rect.width + pad * 2}px`;
                this.spotlightEl.style.height = `${rect.height + pad * 2}px`;
                this.spotlightEl.classList.add('active');
            }

            // Popover dimensions & positioning
            const popoverWidth = this.popoverEl.offsetWidth || 380;
            const popoverHeight = this.popoverEl.offsetHeight || 260;
            const viewportWidth = (typeof window !== 'undefined' ? window.innerWidth : 1200) || 1200;
            const viewportHeight = (typeof window !== 'undefined' ? window.innerHeight : 800) || 800;
            const margin = 14;

            let placement = preferredPlacement || 'bottom';
            let top = 0;
            let left = 0;

            // Determine optimal placement based on screen boundary limits
            if (placement === 'bottom') {
                top = rect.bottom + margin;
                left = rect.left + (rect.width / 2) - (popoverWidth / 2);
                if (top + popoverHeight > viewportHeight - margin && rect.top - popoverHeight - margin > margin) {
                    placement = 'top';
                    top = rect.top - popoverHeight - margin;
                }
            } else if (placement === 'top') {
                top = rect.top - popoverHeight - margin;
                left = rect.left + (rect.width / 2) - (popoverWidth / 2);
                if (top < margin && rect.bottom + popoverHeight + margin < viewportHeight - margin) {
                    placement = 'bottom';
                    top = rect.bottom + margin;
                }
            } else if (placement === 'right') {
                left = rect.right + margin;
                top = rect.top + (rect.height / 2) - (popoverHeight / 2);
                if (left + popoverWidth > viewportWidth - margin && rect.left - popoverWidth - margin > margin) {
                    placement = 'left';
                    left = rect.left - popoverWidth - margin;
                }
            } else if (placement === 'left') {
                left = rect.left - popoverWidth - margin;
                top = rect.top + (rect.height / 2) - (popoverHeight / 2);
                if (left < margin && rect.right + popoverWidth + margin < viewportWidth - margin) {
                    placement = 'right';
                    left = rect.right + margin;
                }
            }

            // Clamp inside viewport
            left = Math.max(margin, Math.min(left, viewportWidth - popoverWidth - margin));
            top = Math.max(margin, Math.min(top, viewportHeight - popoverHeight - margin));

            this.popoverEl.setAttribute('data-popper-placement', placement);
            this.popoverEl.style.top = `${top}px`;
            this.popoverEl.style.left = `${left}px`;
            this.popoverEl.style.transform = 'none';
        }

        _handleKeyDown(e) {
            if (!this.isActive) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                this.exit();
            } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
                e.preventDefault();
                this.next();
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                this.prev();
            }
        }

        _handleResize() {
            if (!this.isActive) return;
            this._renderStep();
        }
    }

    const instance = new OnboardingManager();

    if (typeof window !== 'undefined') {
        window.Onboarding = instance;
    }

    if (typeof document !== 'undefined') {
        if (document.body) {
            instance.init();
        } else if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => instance.init());
        } else {
            instance.init();
        }
    }
})();
