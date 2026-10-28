# Bug-fix plan

Written after reading the code and reproducing what could be reproduced
locally. Line numbers refer to the code **before** any fix.

## Ground truth established before fixing

* `bug-reports/` does not exist in the repo; the 12 screenshots supplied in the
  request were used instead. There is no `.env` either, so the app falls back to
  the Supabase project defaults in `settings.py`.
* The README describes a `users/` app (2FA, sessions, CustomUser) that is **not
  in this repository**. Authentication is Supabase-in-the-browser only; Django
  never has a logged-in user. Plans below work with that architecture.
* Baseline test run (`./run.sh test`, fresh `.venv`, Python 3.14): **120 tests,
  3 failing** before any change, ~50 s because several tests call the live
  Overpass API:
  * `report_generator…test_invalid_payloads` – expects radius 5000 to be rejected, but 5000 is in `SUPPORTED_RADII_M`.
  * `report_generator…test_heatmap_matches_the_website_endpoint` and
    `…test_valid_location_analysis` – the report analyses **2 km** while the
    website heatmap analyses **5 km** (see bug 7).
* Live Overpass measurement for Uttarahalli (12.9066, 77.5468), cold cache, today:
  `overpass-api.de` and `z.overpass-api.de` answer **502 "server at capacity"**
  in 0.5 s, `maps.mail.ru` answers **504 after 48.7 s**. The view's 5 s timeout
  therefore always lands on the synthetic fallback: **100 "sensors",
  ₹8,40,000, `is_live=False`, 7.6 s**. `lz4.overpass-api.de` and `maps.mail.ru`
  do answer small queries (20–28 s while overloaded).

---

## A. Auth and login

### Bug 1 – "Supabase Project DB Connected" badge, inconsistent gate, no return-to-page

**Root causes**
* `templates/base.html:486-489` – the auth-gate modal prints "requires Supabase
  Authentication" and a "Supabase Project DB Connected" badge (pure
  infrastructure text). Same leak in `login.html:4` (title), `login.html:928`
  ("Connecting to Supabase project DB…") and `supabase-auth.js:253`
  ("Sign In with Supabase").
* `static/js/supabase-auth.js:286` `requireSupabaseAuth()` is **synchronous**
  and reads `currentUserSession`, which is only filled after the async
  `getSession()` in `setupAuthListeners` (`:385`). Any gate that runs right
  after page load (e.g. `main.js:5370` auto-open of `?auto_map=true`) sees
  "no session" and shows the modal to a signed-in user → inconsistent gating.
* The "Open full login page" link and the sidebar link pass only
  `location.pathname + search` as `next`; the *feature* the user wanted (map,
  recommendations, startup form) is lost. `login_view`
  (`business_intelligence/views.py:46`) also echoes `next` unvalidated (open
  redirect: `/login/?next=https://evil`).

**Fix**
* Remove the badge and all infrastructure wording from user-facing UI.
* Give `supabase-auth.js` a single `ready` promise (session verified with the
  server, see bug 3); `requireAuth()` awaits it before deciding.
* Map each gated feature to a deep link (`/dashboard/?auto_map=true`,
  `?ai=true`, `?form=startup`) and use it as `next` from the modal, sidebar and
  navbar; after modal login the pending callback still runs in place.
* Validate `next` server-side with `url_has_allowed_host_and_scheme` and pass
  it to the template via `json_script`.

**Verify** – unit test for `next` sanitising; grep shows no "Supabase" text in
user-facing templates; manual: signed-out → click Live Heatmap → modal → login
→ map opens; full-page login → returns to the map.

### Bug 2 – Confirmation e-mail goes to `localhost:3000`

**Root cause** – The code *does* send `emailRedirectTo`
(`login.html:963`, `:836`) but builds it from `window.location.origin +
'/login/?verified=true'`. Supabase only honours a redirect URL that is in the
project's **Redirect URLs allow-list**; otherwise it silently falls back to the
project **Site URL**, whose default is `http://localhost:3000`. Neither URL is
configured, and `SITE_URL` (used in `.env.example`) is never read by
`settings.py`. There is also no page that consumes the `#access_token=…` hash
and confirms verification.

**Fix**
* `settings.SITE_URL` (env, default `http://127.0.0.1:8000`) exposed to
  templates; signup / resend / password reset use
  `SITE_URL + /auth/callback/?next=…`.
* New view + template `/auth/callback/`: lets supabase-js read the hash (or
  PKCE `?code=`), verifies with `auth.getUser()`, handles `error_description`
  (expired/used link), then redirects to `next` (default dashboard) with
  "Email verified" — or to `/login/?verified=1` if no session was created.
* MANUAL_STEPS.md: Site URL + Redirect URLs for local and production.

**Verify** – test that `/auth/callback/` renders and that the signup page
contains the SITE_URL-based redirect; manual click-through of a confirmation
e-mail after the dashboard change.

### Bug 3 – Slow login; navbar shows the user before login succeeded

**Root causes**
* `login.html:538,546` loads `supabase-js` **and** `supabase-auth.js` a second
  time (already loaded by `base.html:90,97`): two GoTrueClient instances
  sharing one storage key/lock, two `onAuthStateChange` listeners, two
  `DOMContentLoaded` initialisers.
* `supabase-auth.js:397-404` registers an **async** `onAuthStateChange`
  callback that `await`s a PostgREST insert (`logSupabaseActivity`).
  supabase-js awaits subscriber callbacks inside `signInWithPassword`, and the
  insert needs the same auth lock – the documented dead-lock / delay pattern.
  The login page then awaits a **second** insert (`login.html:929`), each
  insert also POSTs `/api/log-activity/` which calls Supabase synchronously
  from Django, and finally waits 600 ms.
* `supabase-js@2` is unpinned (CDN redirect on every load).
* Navbar: `setupAuthListeners` renders the user from `getSession()`
  (`supabase-auth.js:389`), which only reads localStorage and is never checked
  with the server, so a stale/revoked session shows "raj demo"; the
  `SIGNED_IN` event also paints the navbar while the login page still shows
  "Authenticating…". Logout/failed login do not clear app state
  (`selectedLocation`, activity log cache).

**Fix** – load the SDK once (pinned version); `onAuthStateChange` callback made
synchronous, logging fire-and-forget via `setTimeout` and one beacon to the
server only; login page redirects as soon as `signInWithPassword` resolves;
navbar shows a neutral placeholder until `auth.getUser()` (server-verified)
succeeds; stale session → `signOut({scope:'local'})` + clear app state; same
clean-up on logout and on failed sign-in.

**Verify** – JS unit test (jsdom) that the navbar is not rendered from an
unverified session and is cleared on sign-out; manual timing in DevTools.

---

## B. Performance and crowd analysis

### Bug 4 – Popular Locations takes 2–5 min; heatmap sometimes missing

**Root causes**
1. `main.js:4443` – `updateCrowdIntensityDropdown()` **awaits**
   `updateBuildingOutlines()`, a browser → overpass-api.de query for every
   building within 1.5 km with `(._;>;); out body` and **no timeout**. It is
   awaited inside `findPopularPlaces` (`main.js:1637`), so the button stays on
   "Scanning…" until that finishes (minutes when Overpass queues; today it
   returns 406). It also spends the user's Overpass slot, so the server's own
   query from the same IP is more likely to be rejected.
2. `business_intelligence/views.py:351` – 5 s timeout per mirror, tried
   **sequentially**, on a query that needs 10–30 s → it almost always fails
   and falls back to fake data (bug 5). Other endpoints use 20–30 s × 3
   mirrors = up to 90 s.
3. `analysis.py:339-356` – 14 separate `around:` statements and
   `out center 350` (first 350 by OSM id), no `maxsize`, `[timeout:25]` –
   expensive to admit and spatially biased.
4. Cache is the per-process LocMem cache (no `CACHES` setting), 30 min; lost
   on restart; failures cached as fake data for 10 min.
5. Every map action fires several Overpass-backed requests one after another
   (`findPopularPlaces` → `/analyze-crowd-intensity/` → buildings →
   `/api/analyze-location/` 2 km query …), each with its own cache key.

**Fix**
* New fetch layer in `analysis.py`: one combined bbox query with
  `[timeout:25][maxsize:…]` and `out center qt`, healthy mirrors first
  (`lz4`, `z`, main, mail.ru, kumi, private.coffee), **hedged** requests (start
  next mirror after a few seconds), retry with backoff on 429/502/504.
* Persistent file cache (`CACHES['overpass']`) keyed by rounded lat/lng (3 dp ≈
  110 m) + radius: fresh 6 h, stale copy kept 7 days and served (labelled)
  when Overpass is down. In-flight de-duplication so concurrent requests share
  one fetch.
* Request budget ~18 s; if no data yet the fetch keeps running in a background
  thread and the endpoint returns `pending` + `retry_after`; the UI shows a
  progress indicator and retries automatically, then shows a clear error with a
  **Retry** button. No synthetic data.
* Building outlines: never awaited, 8 s abort, skipped while a scan runs.
* Crowd analysis reuses the same cached POIs (one network fetch per location).

**Verify** – `scratchpad/profile_popular.py` before/after; unit tests for
cache hit, stale fallback, pending, mirror failover (mocked HTTP).

### Bug 5 – Wrong radius, clustered markers, jump to Kerala, "100 sensors / ₹8,40,000"

**Root causes**
* **100 sensors** = `generate_fallback_spatial_pois` (`analysis.py:173-257`)
  always makes exactly 12×3+11×3+11+10+10 = 100 fake POIs; served whenever
  Overpass fails (`analysis.py:326`), i.e. nearly always (bug 4).
* **₹8,40,000** = `utils.predict_revenue(calculate_crowd_score(elements))` =
  `120000 + min(len(elements),100) × 7200` (`utils.py:122,128`) → any area with
  ≥100 features shows exactly ₹8,40,000.
* **Markers in one corner** – `enrich_places_with_revenue` takes the first 30
  named POIs in Overpass id order (`utils.py:174`), combined with
  `out center 350` → spatially biased subset; sectors drawn from it cover part
  of the circle only.
* **Jump to Kayamkulam** – the report and several flows read
  `localStorage.selectedLocation` (`report-generator.js:340`), which is only
  written by some flows: "Find My Location" (`main.js:630`) and the dashboard
  search box (`main.js:266 searchLocation`) never update it, so an old Kerala
  place clicked days ago is used; `ensureHeatmapFor` then runs the analysis for
  it and moves the map there. There is also no request sequencing in
  `updateCrowdIntensityDropdown`, so a late response for an older location can
  overwrite the current one.
* No `fitBounds` to the analysis radius; all circles are red
  (`main.js:4277…4417`) regardless of level; legend says green/yellow/red.

**Fix** – single `setAnalysisLocation()` used by search, autocomplete, map
click, GPS, deep links and the startup form; analyses carry a request token and
stale responses are dropped; draw the 5 km circle, `fitBounds` to it, colour
circles by level, place markers from a sector-balanced sample of real POIs;
sensor count = real POIs analysed; revenue = sum of the per-place engine
estimates, labelled "Est."; data source/age shown; no fake data.

**Verify** – tests: no response contains synthetic POIs; sensor count equals
analysed POIs; revenue not the legacy constant; sector-balanced sampling.

---

## C. Reports

### Bug 6 – "business_type contains unsupported characters"

**Root causes**
* `report-generator.js:395` sends `business_type: loc.type`, where
  `selectedLocation.type` is whatever the last writer stored (an OSM amenity,
  a chatbot phrase, a full address).
* `report_generator/validators.py:29` `_BUSINESS_RE` allows only ASCII letters,
  digits and ` _&'./-` → commas, Unicode (e.g. "ಕಾಫಿ", "Café") and legitimate
  names fail with a vague message.

**Fix** – frontend sends a category from the allowed list (`/api/business-types/`
+ engine categories) or nothing, and sends `address` separately;
`validate_business_type` normalises to a canonical category, accepts Unicode
letters/marks/digits and `,-&'./()`, rejects control characters, markup and
template/code characters (`<>{}[]\`$;|\\`) and over-long input with a precise
message; new `validate_address`.

**Verify** – new validator tests (Indian names, Unicode, injection strings).

### Bug 7 – "Heatmap capture failed: … did not complete"

**Root causes**
* Wrong location (stale `selectedLocation`, bug 5) → the report forces a new
  analysis for a different place while the map is busy with the current one.
* Race: `updateCrowdIntensityDropdown` has no request id; whichever response
  arrives last writes `window.lastHeatmapAnalysis`, so `heatmapMatches()`
  fails (`report-generator.js:154`).
* Radius mismatch: report requests 2 km (`report-generator.js:394`) while the
  heatmap is 5 km (`HEATMAP_RADIUS_M`) – the report's sector table never
  matched the screenshot (2 baseline test failures).
* Capture is attempted while tiles/circles are still being drawn; no retry,
  and the server-side fallback image is an abstract sector chart.

**Fix** – report uses the location whose analysis is on screen (or the current
analysis location, analysed first); `analyzeCrowd()` returns a promise for that
exact location; wait for analysis + tiles, capture, retry once, then send no
image and let the server render a static map of the same POIs/sectors
(`chart_generator.static_heatmap`); report radius = 5 km; server rejects a
screenshot from another location (existing check, kept).

**Verify** – updated data-collector tests (5 km), JS test for the stale-response
guard, report API test that a capture-less request produces the static map.

### Bug 8 – "Export failed" and "Request failed" on /favorites/

**Root causes**
* `favorites/views.py:173` imports `reportlab`, which is **not in
  requirements.txt** → `ImportError` → HTML 500 → `favorites.js:268` "Export
  failed". Even when installed, the export is a one-table summary (no analysis).
* `favorites.js:217` shows "Request failed" for any non-JSON response; the
  reports list endpoint returns Django's HTML 500 when the `report_generator`
  table is missing (migrations not applied) or any exception occurs.
  The PDF fallback in `pdf_generator.py:62` also depends on the missing
  `reportlab`.

**Fix** – add `reportlab` to requirements; favorites export becomes a report
job (`Report.kind='favorites'`): server fetches the user's favorites (RLS),
runs the full analysis per place (`collect_analysis`, cached POIs), builds a
multi-place PDF (per place: location, crowd density + static heatmap, popular
places, revenue, competitors, Go/No-Go with reasons, SWOT, risks; plus a
comparison table), WeasyPrint → ReportLab fallback, stored and listed under
"Generated Business Reports"; JSON errors everywhere (missing table → clear
503 message).

**Verify** – tests for favorites export job (mocked store + Overpass), ReportLab
fallback path, reports list JSON error handling.

---

## D. Business features

### Bug 9 – Static "Top 5 Business Recommendations"

**Root causes**
* `analysis.py:641-799` always returns the same five archetypes (cafe, gym,
  co-working, supermarket, restaurant) in the same order, revenue = fixed base
  × multipliers, target coordinates = fixed offsets (`:678`); the ML model and
  revenue engine are not used.
* Location dropdown is six hard-coded Bengaluru areas
  (`dashboard.html:600-605`); no category filter.
* `main.js:5358` reads `stored` before `const stored` (`:5393`) → a
  ReferenceError on every `/dashboard/` load without `?lat=` aborts the
  initialiser, so `initDashboardAIFromStorage()` never runs and `?ai=true`
  never auto-loads.
* The screenshot's "Urban Cafe ₹45,000" text no longer exists in the repo – the
  browser was serving an old cached `main.js` (fixed `?v=` query strings).

**Fix** – rank candidates from the ML model (primary + alternatives + CSV
choices for the dominant intensity) and engine categories with
`calculate_smart_revenue`, local competitor counts, setup cost → break-even,
crowd level; target point = the best real sector for that category; optional
`category` filter; dropdown = current searched location, recent searches,
saved favorites; clicking a card/location switches to the map and runs the
analysis there; bump static `?v=`.

**Verify** – recommendation API tests (differs by location, category filter,
fields present, uses engine numbers).

### Bug 10 – Startup form only says "Thank you"

**Root causes** – `submit_form` (`views.py:163`) never saves (`BusinessUser`
model unused) and returns no feasibility; the redirect depends on a second
call to `/api/find-matching-locations/` (5 km Overpass, 3×30 s) and silently
does nothing when it fails; `dashboard.html:485` and `:621` contain the whole
form twice (duplicate ids).

**Fix** – `submit_form` validates, saves `BusinessUser`, runs feasibility on
the cached POIs (`evaluate_feasibility` + sector match for the desired
intensity) and returns verdict + redirect target; the page switches to the map,
flies to the location, runs the crowd analysis, highlights sectors matching
the desired intensity, shows the verdict and a "Generate detailed report"
button (category + location pre-filled). Duplicate form removed.

**Verify** – tests: inquiry saved, verdict returned, validation errors, Overpass
failure still saves the inquiry and reports the problem.

---

## Order and process

A1 → A2 → A3 → B4 → B5 → C6 → C7 → C8 → D9 → D10, running `./run.sh test`
after each and adding tests as listed. Tests will no longer hit the network.
