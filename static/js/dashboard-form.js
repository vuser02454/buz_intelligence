// ========== Dashboard Startup Form Functionality ==========
//
// Submit = save the inquiry + feasibility check on the server (/submit-form/),
// then switch to the map centred on the submitted location, run the crowd
// analysis there and highlight the sectors with the desired crowd level. The
// existing "Generate Detailed Report" map button then reports on this location
// and business type (the category is kept in the selected-area state).

let _startupFormWired = false;

function initDashboardStartupForm() {
    // Called every time the form is opened: wire the listeners only once
    // (repeated wiring used to submit the form several times per click).
    if (_startupFormWired) return;
    _startupFormWired = true;

    const formLocInput = document.getElementById('dashboard-form-location-search');
    const formLocSuggestions = document.getElementById('dashboard-form-location-suggestions');
    const latInput = document.getElementById('dashboard-id_latitude');
    const lonInput = document.getElementById('dashboard-id_longitude');

    if (formLocInput && formLocSuggestions) {
        let formLocTimer = null;
        formLocInput.addEventListener('input', function () {
            // Typing invalidates a previously chosen suggestion.
            if (latInput) latInput.value = '';
            if (lonInput) lonInput.value = '';
            clearTimeout(formLocTimer);
            const q = this.value.trim();
            if (q.length < 3) {
                formLocSuggestions.innerHTML = '';
                formLocSuggestions.style.display = 'none';
                return;
            }
            formLocTimer = setTimeout(async () => {
                try {
                    const response = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&addressdetails=1&countrycodes=in`);
                    const results = await response.json();

                    formLocSuggestions.innerHTML = '';
                    if (!results || results.length === 0) {
                        formLocSuggestions.innerHTML = '<div class="list-group-item text-muted">No results found</div>';
                        formLocSuggestions.style.display = 'block';
                        return;
                    }
                    results.forEach(result => {
                        const item = document.createElement('div');
                        item.className = 'list-group-item list-group-item-action';
                        item.style.cursor = 'pointer';
                        const displayName = result.display_name || result.name;
                        item.textContent = displayName;
                        item.addEventListener('click', () => {
                            formLocInput.value = displayName;
                            formLocSuggestions.innerHTML = '';
                            formLocSuggestions.style.display = 'none';
                            const lat = parseFloat(result.lat);
                            const lon = parseFloat(result.lon);
                            latInput.value = lat;
                            lonInput.value = lon;
                            loadBusinessTypesForLocation(lat, lon);
                        });
                        formLocSuggestions.appendChild(item);
                    });
                    formLocSuggestions.style.display = 'block';
                } catch (error) {
                    console.error('Location search failed:', error);
                }
            }, 300);
        });

        document.addEventListener('click', function (e) {
            if (!formLocInput.contains(e.target) && !formLocSuggestions.contains(e.target)) {
                formLocSuggestions.style.display = 'none';
            }
        });
    }

    const form = document.getElementById('dashboard-business-form');
    if (form) {
        form.addEventListener('submit', async function (e) {
            e.preventDefault();
            const submitBtn = document.getElementById('dashboard-submit-business-form-btn');
            const messageDiv = document.getElementById('dashboard-form-message');
            const resultBanner = document.getElementById('dashboard-feasibility-result-banner');
            const resetBtnState = () => {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="fas fa-check-circle me-2"></i>Check Feasibility & Submit';
            };

            messageDiv.innerHTML = '';
            resultBanner.classList.add('d-none');
            if (!latInput.value || !lonInput.value) {
                messageDiv.innerHTML = '<div class="alert alert-warning"><i class="fas fa-map-marker-alt me-2"></i>Choose the business location from the suggestions list.</div>';
                formLocInput?.focus();
                return;
            }

            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i>Saving & checking feasibility...';
            const formData = new FormData(form);
            let data;
            try {
                const response = await fetch('/submit-form/', {
                    method: 'POST',
                    body: formData,
                    headers: { 'X-CSRFToken': formData.get('csrfmiddlewaretoken') }
                });
                data = await response.json().catch(() => ({ success: false, message: `Server error (${response.status}).` }));
            } catch (error) {
                console.error('Form submission error:', error);
                messageDiv.innerHTML = '<div class="alert alert-danger"><i class="fas fa-exclamation-triangle me-2"></i>Network error. Please try again.</div>';
                resetBtnState();
                return;
            }
            resetBtnState();

            if (!data.success) {
                messageDiv.innerHTML = `<div class="alert alert-danger"><i class="fas fa-exclamation-triangle me-2"></i>${escapeHtml(data.message || 'Submission failed. Please try again.')}</div>`;
                return;
            }

            messageDiv.innerHTML = `<div class="alert alert-success"><i class="fas fa-check-circle me-2"></i>${escapeHtml(data.message)} Opening the map…</div>`;
            renderFeasibilityBanner(resultBanner, data.feasibility);
            if (window.logSupabaseActivity) {
                window.logSupabaseActivity('startup_form_submitted', 'Startup Form', {
                    business_type: data.redirect.business_type, crowd_intensity: data.redirect.crowd_intensity,
                    verdict: data.feasibility && data.feasibility.verdict,
                });
            }
            setTimeout(() => openStartupResultOnMap(data), 1200);
        });
    }

    const resetBtn = document.getElementById('dashboard-reset-business-form-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', function () {
            if (!form) return;
            form.reset();
            document.getElementById('dashboard-id_business_type_dropdown').innerHTML = '<option value="">-- Search a location first --</option>';
            document.getElementById('dashboard-form-message').innerHTML = '';
            document.getElementById('dashboard-feasibility-result-banner').classList.add('d-none');
            latInput.value = '';
            lonInput.value = '';
        });
    }
}

function feasibilityHtml(f) {
    if (!f || f.status !== 'ok') {
        const why = f && f.error ? escapeHtml(f.error) : 'The map data for this area is still being fetched.';
        return `<strong>Feasibility:</strong> pending – ${why} The map analysis will finish it.`;
    }
    const reasons = (f.reasons || []).map(r => `<li>${escapeHtml(r)}</li>`).join('');
    return `<strong>Feasibility: ${f.feasible ? '✅ Go' : '❌ No-Go'}</strong> – ${escapeHtml(f.message || '')}
        <ul class="mb-1 mt-2 small">${reasons}</ul>
        <div class="small"><i class="fas fa-users me-1"></i>${escapeHtml(f.intensity_note || '')}</div>`;
}

function renderFeasibilityBanner(banner, f) {
    if (!banner) return;
    banner.className = `alert ${f && f.status === 'ok' ? (f.feasible ? 'alert-success' : 'alert-warning') : 'alert-info'} mb-3`;
    banner.innerHTML = feasibilityHtml(f);
    banner.classList.remove('d-none');
}

let startupZoneMarkers = [];

function highlightDesiredIntensity(level) {
    const m = activeMapInstance();
    if (!m || typeof L === 'undefined') return 0;
    startupZoneMarkers.forEach(x => { try { m.removeLayer(x); } catch (_e) {} });
    startupZoneMarkers = [];
    const areas = getCrowdAreas(level);
    areas.forEach(area => {
        const ring = L.circle([area.latitude, area.longitude], {
            radius: 900, color: '#7c3aed', weight: 3, dashArray: '4, 6', fill: false,
        }).addTo(m).bindPopup(`<b>Matches your desired ${escapeHtml(level)} crowd</b><br>${Number(area.count)} mapped places in this sector`);
        startupZoneMarkers.push(ring);
    });
    return areas.length;
}

function showStartupVerdictPanel(result, feasibility) {
    let panel = document.getElementById('startup-verdict-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'startup-verdict-panel';
        panel.className = 'report-progress-panel';
        panel.setAttribute('role', 'status');
        document.body.appendChild(panel);
    }
    const r = result.redirect;
    panel.innerHTML = `
        <div class="report-progress-head">
            <span><i class="fas fa-clipboard-check me-2"></i>${escapeHtml(String(r.business_type).replace(/_/g, ' '))}</span>
            <button type="button" class="report-progress-close" aria-label="Close">&times;</button>
        </div>
        <div class="report-progress-location">${escapeHtml(r.name)}</div>
        <div class="report-progress-message">${feasibilityHtml(feasibility)}</div>
        <div class="report-progress-message small">
            <i class="fas fa-file-pdf me-1"></i>Use <strong>Generate Detailed Report</strong> above the map for a full
            report on this location and business type.
        </div>`;
    panel.classList.remove('d-none');
    panel.querySelector('.report-progress-close').addEventListener('click', () => panel.classList.add('d-none'));
}

/** After a successful submission: map view, centred on the location, crowd analysis, verdict + report button. */
async function openStartupResultOnMap(result) {
    const r = result.redirect;
    document.getElementById('dashboard-startup-form-section')?.classList.add('d-none');
    document.getElementById('dashboard-analytics-section')?.classList.add('d-none');
    const form = document.getElementById('dashboard-business-form');
    if (form) form.reset();
    document.getElementById('dashboard-form-message').innerHTML = '';
    document.getElementById('dashboard-feasibility-result-banner').classList.add('d-none');

    setAnalysisLocation(r.latitude, r.longitude, r.name, { category: r.business_type });
    document.getElementById('btn-show-map')?.click();
    if (typeof initDynamicDashboardMap === 'function') initDynamicDashboardMap();
    await new Promise(res => setTimeout(res, 350));

    let feasibility = result.feasibility;
    showStartupVerdictPanel(result, feasibility);
    const analysis = await focusMapOnOpportunityOrLocation(r.latitude, r.longitude, r.name);
    if (analysis && analysis.success) {
        const n = highlightDesiredIntensity(r.crowd_intensity);
        if (!feasibility || feasibility.status !== 'ok') {
            // The area data is cached now, so the check answers immediately.
            const check = await postAreaAnalysis('/check-feasibility/', {
                latitude: r.latitude, longitude: r.longitude, business_type: r.business_type,
            });
            if (check.ok) {
                feasibility = {
                    status: 'ok', feasible: check.data.feasible, verdict: check.data.feasible ? 'Go' : 'No-Go',
                    message: check.data.message, reasons: check.data.reasons,
                    intensity_note: n ? `${n} sector(s) match the ${r.crowd_intensity} crowd level you want.`
                                      : `No sector within 5 km has a ${r.crowd_intensity} crowd level.`,
                };
            }
        }
        showStartupVerdictPanel(result, feasibility);
    }
}

// Load business types based on location
async function loadBusinessTypesForLocation(lat, lon) {
    const dropdown = document.getElementById('dashboard-id_business_type_dropdown');
    const hint = document.getElementById('dashboard-form-flow-hint');

    if (!dropdown) return;

    try {
        const response = await fetch(`/api/business-types/?lat=${lat}&lon=${lon}`);
        const data = await response.json();

        if (data.business_types && data.business_types.length > 0) {
            dropdown.innerHTML = '<option value="">-- Select business type --</option>';
            data.business_types.forEach(type => {
                const option = document.createElement('option');
                option.value = type.value || type;
                option.textContent = type.label || type;
                dropdown.appendChild(option);
            });

            if (hint) {
                hint.innerHTML = '<i class="fas fa-check-circle me-1 text-success"></i>Business types loaded for this location.';
            }
        } else {
            dropdown.innerHTML = '<option value="">-- No business types available --</option>';
        }
    } catch (error) {
        console.error('Failed to load business types:', error);
        dropdown.innerHTML = '<option value="">-- Failed to load business types --</option>';
    }
}
