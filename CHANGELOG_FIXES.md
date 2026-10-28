# Changelog – bug fixes 1–10

Root-cause analysis for every bug is in **PLAN.md**; Supabase dashboard steps
are in **MANUAL_STEPS.md**.

## Test status

| Suite | Before | After |
|---|---|---|
| `./run.sh test` (Django) | 120 tests, **3 failing**, ~50 s, several tests called live Overpass/Nominatim | **160 tests, all passing**, ~19 s, no network |
| `npm run test:js` (jsdom) | 10 tests, **1 failing** | **32 tests, all passing** |

New test files: `business_intelligence/test_auth_pages.py`, `test_area_analysis.py`,
`test_recommendations.py`, `test_startup_form.py`, `report_generator/tests/test_favorites_report.py`,
`tests/js/supabase-auth.test.js`, `tests/js/map-analysis.test.js`; validator tests added to
`report_generator/tests/test_validators.py`.

Also checked: every page (`/`, `/dashboard/`, `?ai=true`, `?auto_map=true`, `/login/`,
`/auth/callback/`, `/favorites/`, `/profile/`, `/contact/`) returns 200 on a dev server, and
the rendered dashboard/favorites/login pages load all their real scripts in jsdom with no
runtime errors. I could not drive a real browser here; the manual checks below are still worth doing.

## Popular Locations timings (bug 4)

Measured against the **public** Overpass servers on 28 Oct 2026, cold cache, same machine.
`overpass-api.de` answered "server at capacity" (502) for the whole session, and even a
500 m query took 20–28 s on the mirrors that did work.

| | Before | After |
|---|---|---|
| Uttarahalli, cold | 7.6 s, then **synthetic data** (all mirrors failed at the 5 s timeout: "100 sensors", ₹8,40,000, `is_live=false`). In the browser the button stayed on "Scanning…" until the unbounded building-outline query finished: the reported 2–5 min. | First answer at **18.4 s** ("still fetching", with a progress counter); **real data at 45.4 s** (4,229 mapped places, 30 popular places) |
| Kayamkulam, cold | same fallback path | first answer 18.0 s, **real data at 27.3 s** (1,545 places) |
| Repeat (warm) | 0.01 s (of the synthetic data) | **0.03–0.08 s**; 0.19 s after a server restart (persistent cache) |
| Crowd analysis after a scan | separate Overpass request | 0.002–0.007 s (same data) |

**Not met:** "under ~20 s on a cold request". With public Overpass this busy, the queueing
alone exceeds 20 s; no query change fixes that. What the code does instead: it answers
within the 18 s budget, keeps fetching in the background, shows progress, and picks up the
result automatically. It serves a labelled cached copy when Overpass is down, and never
shows invented data. To reach the target reliably, set `OVERPASS_URLS` to a private or paid
Overpass instance.

---

## A1. Login gate badge, inconsistent gating, return-to-page

**Changed**
* Removed the "Supabase Project DB Connected" badge and the other infrastructure wording
  ("requires Supabase Authentication", "Connecting to Supabase project DB…",
  "Sign In with Supabase", the login page title, the chatbot text).
* Feature gates now wait for the session check (`SupabaseAuth.ready`). They used to decide
  before the session had loaded and showed the modal to signed-in users.
* Each gated feature has a deep link (`/dashboard/?auto_map=true`, `?ai=true`,
  `?form=startup`, `/favorites/`) used as `next`, so after a full-page login the user lands
  on the feature they wanted. Quick login in the modal still runs the action in place.
* `next` is validated on the server (`safe_next_url`): no open redirect to other sites.
* Fixed a ReferenceError (`stored` read before declaration) that aborted the dashboard
  start-up on every plain `/dashboard/` load. This broke `?auto_map`, `?ai` and
  post-login deep links.

**Files:** `templates/base.html`, `templates/heatmap_app/login.html`, `static/js/supabase-auth.js`,
`static/js/main.js`, `business_intelligence/views.py`, `business_intelligence/urls.py`

**Test manually:** sign out → Dashboard → "Launch Map": the modal shows no infrastructure
badge → "Open Full Login" → sign in → you land on the live map. `/login/?next=https://example.com`
redirects to the dashboard after sign-in.

## A2. E-mail confirmation went to localhost:3000

**Changed**
* `SITE_URL` setting (env); signup, resend and password-reset links point to
  `<SITE_URL>/auth/callback/?next=…` (falling back to the page origin when `SITE_URL` is empty).
* New page `/auth/callback/`. supabase-js reads `#access_token=…`; the page verifies the
  user with the server, removes the tokens from the address bar, and redirects to `next`.
  The destination then shows "Email verified". It handles expired or used links (message
  and link to sign-in), password-recovery links (→ new-password form), and confirmation
  without a session (→ sign-in with a notice).
* The signup "waiting for verification" poller no longer signs the user out after
  detecting confirmation. That global sign-out revoked the session the callback tab had
  just created.

**Files:** `crowd_heatmap_project/settings.py`, `business_intelligence/context_processors.py`,
`business_intelligence/views.py`, `business_intelligence/urls.py`, `templates/heatmap_app/auth_callback.html`,
`templates/heatmap_app/login.html`, `static/js/supabase-auth.js`, `.env.example`

**Needs you:** MANUAL_STEPS.md §1 (Site URL + Redirect URLs). Without it, Supabase keeps
sending users to `localhost:3000`.

**Test manually:** after the dashboard change, register a new e-mail → click the link →
"Email verified" → dashboard, signed in.

## A3. Slow login; navbar showed the user before login succeeded

**Root causes:**
* `supabase-js` and `supabase-auth.js` were loaded twice on the login page (and twice on
  the profile page), giving two auth clients and duplicate listeners.
* The async `onAuthStateChange` callback awaited a database insert while supabase-js held
  its auth lock.
* The login page awaited a second insert, then waited 600 ms more.
* The navbar was drawn from the unverified localStorage session.

**Changed**
* SDK loaded once, pinned (`@supabase/supabase-js@2.45.4`).
* The auth callback is synchronous; activity logging is fire-and-forget (`sendBeacon` →
  `/api/log-activity/` → Supabase write on a background thread). Nothing on the sign-in
  path waits for logging.
* Login redirects as soon as `signInWithPassword` succeeds.
* The navbar shows a user only after `auth.getUser()` (server-verified). A revoked or stale
  session is removed locally and per-user state (`selectedLocation`, recent searches) is
  cleared. The same clean-up runs on sign-out and on failed sign-in.
* Display names are HTML-escaped in the navbar (stored-XSS fix).

**Files:** `static/js/supabase-auth.js`, `templates/heatmap_app/login.html`,
`templates/heatmap_app/profile.html`, `templates/base.html`, `business_intelligence/views.py`,
`business_intelligence/supabase_service.py`

**Test manually:** DevTools → Network: sign-in is one `token` request followed by a
redirect, with no awaited `user_activity_logs` insert. Delete the user in Supabase while
signed in → reload → the navbar shows "Sign In".

## B4. Popular Locations too slow; heatmap sometimes missing

**Changed**
* **One combined bbox Overpass query** instead of 14 `around:` statements. It uses a small
  `[timeout]`/`[maxsize]` (admitted sooner by busy servers), `out center tags qt`, and no
  `350` cap.
* **Mirror handling:** mirrors are tried in order with hedging; a slow mirror gets a
  parallel request to the next one after 4 s, and capacity errors (429/502/503/504) move
  on immediately. Rounds are retried with backoff.
* **Partial results** (`remark: runtime error`) are rejected.
* **Persistent area cache** (`CACHES['overpass']`, file-based) keyed by lat/lng rounded to
  ~110 m plus the radius. Data is fresh for 6 h and kept 7 days as a labelled fallback.
  Concurrent requests for the same area share one fetch.
* **Bounded wait:** after 18 s the endpoint answers `202 {pending, retry_after}` while the
  fetch continues in the background. The UI shows "OpenStreetMap is busy – still fetching
  (25 s)…", retries automatically, and on failure shows a clear message with a **Retry**
  button.
* **Synthetic fallback removed:** `generate_fallback_spatial_pois` no longer exists.
* **One fetch per location:** Popular Places, crowd analysis, feasibility,
  location-intelligence, matching locations, the chatbot and the reports all use the same
  cached area data.
* **Building outlines** are no longer awaited by the analysis. They are drawn only at
  street zoom (≥16), with an 8 s abort.
* A newer scan supersedes an older one; previously it was rejected with "Analysis already
  in progress".

**Files:** `business_intelligence/analysis.py`, `business_intelligence/views.py`,
`crowd_heatmap_project/settings.py`, `static/js/main.js`, `tracker/ai/orchestrator.py`,
`.gitignore`, `.env.example`, `README.md`

## B5. Wrong radius, clustered markers, jump to Kerala, "100 sensors / ₹8,40,000"

**Root causes:**
* **"100 sensors":** the synthetic fallback always generated exactly 100 POIs.
* **₹8,40,000:** this was `120000 + min(n,100) × 7200`, a legacy formula.
* **Clustered markers:** the first 30 places in Overpass id order were used, from the
  id-sorted 350-element cap.
* **Jump to Kerala:** the report and other flows used a days-old
  `localStorage.selectedLocation`.
* **`analysisRadiusCircle` was never declared**, so "Find My Location", search selection,
  map click and opportunity focus all threw a ReferenceError before drawing the circle or
  starting the analysis.
* **Route fitting:** search results drew a route from wherever the map was and re-fitted
  the map to that route.

**Changed**
* `setAnalysisLocation()` is the single source of truth, used by search, suggestions,
  map click, GPS, deep links, recommendations and the startup form.
* Analyses carry a sequence number, and answers for older places are dropped. The server
  echoes `center` and the client checks it.
* Stored locations are reused only if under 12 h old. There is no silent fallback to a
  default city.
* The real 5 km circle is drawn and the map is fitted to it.
* Popular-place markers come from a sector-balanced sample across the whole circle.
* Sector levels use **density** (High ≥ 60, Medium ≥ 25 mapped places per km²). With full
  data, raw counts made every sector "High".
* Circles are coloured red, amber and green by level.
* **Footer:** "Mapped Places (5 km)" shows the real count; "Est. Monthly Revenue*" is the
  sum of the engine's estimates for the listed places, with a tooltip saying so. The
  business-intelligence panel no longer overwrites the footer.
* Routes are drawn only from a marker within 25 km and never re-fit the map.
* The search box now analyses the top match.
* Mojibake (`ðŸš—`, `â€“`) in user-facing strings repaired.
* **Related engine fix:** `calculate_smart_revenue` now uses a 1.5 km catchment around the
  site, the same as per-place estimates. Fed a whole 5 km city area, its competition term
  `exp(-γ·n)` drove cafe, restaurant and pharmacy revenue to ₹0.

**Files:** `static/js/main.js`, `business_intelligence/analysis.py`, `business_intelligence/utils.py`,
`business_intelligence/views.py`, `templates/heatmap_app/dashboard.html`

**Test manually (B4 + B5):** Map → search "Uttarahalli" → the circle is drawn and fitted
→ Popular Locations → the status counts seconds, then shows "Analysis ready: 30 popular
places, 4,2xx mapped places…" → markers spread over the circle, circles in three colours.
Click again → instant. Kerala never appears unless you choose it.

## C6. "business_type contains unsupported characters"

**Changed**
* **Frontend:** the report sends a category from `/api/business-types/` (or none, and the
  ML recommendation is used), with the address in `location.address`.
* **Validator** (`validate_business_type`):
  * accepts letters, marks and digits in any script plus `, - & ' . / ( ) _`
    (e.g. "Café", "ಕಾಫಿ ಅಂಗಡಿ", "Pharmacy (24x7)"), with NFKC and whitespace normalisation;
  * rejects markup, template and code characters and links, and says exactly which
    characters failed;
  * gives addresses sent as a category a specific error ("put the address in
    location.address").
* New `validate_address`.
* `Report.address` is stored and shown on the cover.

**Files:** `report_generator/validators.py`, `report_generator/models.py`,
`report_generator/migrations/0002_report_kind_address_places.py`, `report_generator/services.py`,
`static/js/report-generator.js`, `templates/reports/report.html`

## C7. "Heatmap capture failed: … did not complete"

**Root causes:**
* The report used a stale location and re-ran the analysis for it while the map was busy
  with another place.
* `lastHeatmapAnalysis` was overwritten by whichever response came last.
* The report analysed 2 km while the map showed 5 km (which also caused 2 of the 3
  baseline test failures).

**Changed**
* **Location:** the report uses the location whose analysis is on screen (else the current
  location).
* **Wait for the analysis:** it waits for that exact analysis (`updateCrowdIntensityDropdown`
  now returns a result for that place) and retries the analysis once.
* **Capture:** it fits the 5 km circle, captures, and retries the capture once. If it still
  fails, no image is sent and the server draws a static map of the same analysis (every
  mapped place plus the sector circles).
* **Radius:** the report radius is fixed at 5 km, matching the website. The report and the
  map use the same cached area data, and the server rejects screenshots taken of another
  location (existing check, kept).
* Report text updated to the 5 km radius and the density thresholds.

**Files:** `static/js/report-generator.js`, `report_generator/data_collector.py`, `report_generator/chart_generator.py`,
`report_generator/content.py`, `report_generator/flowchart_generator.py`, `report_generator/services.py`,
`report_generator/validators.py`, `templates/reports/sections/*.html`

**Test manually:** analyse a place → Generate Detailed Report → the PDF shows the
screenshot of that place. To test the fallback, block `api.maptiler.com` in DevTools →
the PDF says the screenshot is unavailable and shows the server-drawn map of the same
place.

## C8. "Export failed" / "Request failed" on Favorites

**Root causes:**
* The export imported `reportlab`, which was missing from `requirements.txt`, giving an
  HTML 500.
* Any non-JSON error showed as "Request failed".
* The export itself was only a one-table summary.

**Changed**
* `reportlab` added to requirements.
* **Stored job:** `POST /api/favorites/report/` (and `/api/reports/favorites/`) queues a
  stored report (`Report.kind='favorites'`). The server reads the user's favorites with
  their own token (RLS); ticked places only, or the latest 6.
* **Per place it includes:** location, crowd density and server-drawn heatmap, popular
  places with revenue estimates, engine revenue estimate, competitor list, Go/No-Go with
  reasons, SWOT, and key risks.
* **Comparison table** ranking all places.
* Rendered with WeasyPrint, falling back to ReportLab (DejaVu font, so ₹ renders).
* Appears under "Generated Business Reports".
* **Frontend:** checkboxes to choose places, progress in the button, automatic download.
* **Errors:** all are JSON with clear messages; a missing migration says "run python
  manage.py migrate".
* The old GET export view was removed.

**Files:** `report_generator/favorites_report.py` (new), `templates/reports/favorites_report.html` (new),
`report_generator/views.py`, `report_generator/urls.py`, `report_generator/services.py`,
`report_generator/models.py`, `favorites/urls.py`, `favorites/views.py`, `static/js/favorites.js`,
`templates/heatmap_app/favorites.html`, `requirements.txt`

**Test manually:** Favorites → tick 3–4 places → "Download Report for N Selected" → stage
labels appear in the button → the PDF downloads and is listed under Generated Business
Reports.

## D9. Static "Top 5 Business Recommendations"

**Changed**
* **Candidates:** the ML model's primary pick, its alternatives and the categories for
  the area's crowd level, plus every category the revenue engine models.
* **Placement:** each candidate goes in the sector that suits it (its crowd level, fewest
  same-category places within 1 km).
* **Revenue:** from the engine at that spot, with profit, set-up cost and break-even from
  labelled planning assumptions. Competition and crowd level come from real places.
* Results differ by location (tested). There is a `category` filter, and pending/error
  states are handled.
* **Dropdown:** current searched location, recent searches, and saved favorites, replacing
  six hard-coded Bengaluru areas. A category filter was added, and there is no MG Road
  default.
* **Cards** show estimated revenue, profit, break-even, crowd level and competition. "View
  on Live Map" switches to the map on the same page and runs the analysis there.
* **Demo charts:** the hard-coded "analytics" charts (₹45,000/₹52,000… demo series), which
  also threw `startRealTimeUpdates is not a function` on every dashboard load, are no
  longer shown.

**Files:** `business_intelligence/analysis.py`, `business_intelligence/views.py`, `static/js/main.js`,
`static/js/analytics-dashboard.js`, `templates/heatmap_app/dashboard.html`

## D10. Startup Form only said "Thank you"

**Changed**
* `/submit-form/` validates the input, **saves** the inquiry (`BusinessUser`, which was
  never saved before) and runs the feasibility rules. It also compares the area's sectors
  with the desired crowd level.
* It returns the Go/No-Go verdict with reasons and the map target. The inquiry is saved
  even when OpenStreetMap is slow.
* **Page flow:** after submitting, the page shows the verdict, switches to the map,
  centres on the location, runs the crowd analysis, and outlines the sectors with the
  desired crowd level. A verdict panel offers **Generate detailed report** for that
  location and business type.
* The location must be picked from the suggestions; editing the text clears stale
  coordinates.
* Removed the duplicate copy of the whole form in `dashboard.html` (duplicate ids), and
  fixed listeners being added on every form open (which caused multiple submissions).

**Files:** `business_intelligence/views.py`, `static/js/dashboard-form.js`, `static/js/main.js`,
`templates/heatmap_app/dashboard.html`

---

## Decisions I made (correct me if you disagree)

* **Report radius is always 5 km** (the map's radius); `radius_m: 2000` is now rejected.
* **Sector levels are density-based** (60 / 25 per km²). On real data the old count rule
  made every sector "High".
* **Synthetic POIs removed entirely.** When Overpass is down you get a clear error and a
  Retry button, or a cached copy labelled as such.
* **Favorites reports use template text, not Gemini**, and cover at most 6 places to keep
  generation time and Overpass load reasonable.
* `/api/favorites/report/` changed from GET to POST (only the app's own page used it).

## Left unfixed / out of scope

* **Cold Popular Locations under 20 s** is not guaranteed on public Overpass (see the
  timings above).
* **README vs code:** the README describes a `users/` app (CustomUser, 2FA, session
  manager) that is not in this repository. I did not touch the README's feature claims
  apart from the environment table.
* **Dead code:** `tracker/views.py` still contains old, unrouted copies of several views
  and its own Overpass helper. They are dead code; the chatbot no longer uses them.
* **Planning assumptions:** set-up costs and operating-cost shares in the recommendations
  are planning assumptions (labelled on the cards), not data.
* **Gemini SDK:** `google.generativeai` prints a deprecation warning; the SDK migration was
  not part of these bugs.
* **Browser testing:** I could not test in a real browser in this environment. The flows
  are covered by jsdom tests and server smoke tests, so please run through the "Test
  manually" steps once.
