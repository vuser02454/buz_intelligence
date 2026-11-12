# Changelog – white theme and desktop layout fix

* **Palette:** white background, black text. Navbar, sidebar, pages, cards and panels are white
  with black hairlines; primary buttons are solid black. The map and the 3D revenue graph stay
  dark.
* **Desktop layout bug:** at larger browser zoom the content column grew wider than the screen,
  so the hero was cut off and the card grid ran off the right edge. Fixes:
  * `.dashboard-main` gets `min-width: 0`;
  * hero headings size to their container (`10cqi`, clamp 40–120px);
  * card-grid columns can't exceed the container;
  * the sidebar can't scroll sideways (which hid its icons);
  * the desktop navbar is 56px so the fixed sidebar no longer overlaps it.
  * Checked at 900–1920px: no horizontal overflow.
* **Sign-in page:** unchanged.

# Changelog – headline typography and heatmap colours

* **Typography (reference: signal-a.studio):**
  * uppercase display headings in Instrument Serif, with `<strong>` words in Inter Tight 800
    (dashboard "Business **Intelligence**", home "AI-based **business intelligence** using
    heatmaps");
  * card and tile titles in Inter Tight 800 uppercase;
  * nav, sidebar, labels, badges and buttons in uppercase IBM Plex Mono;
  * nav links sit on thin rules;
  * this overrides DESIGN.md's sentence-case / 300-400 rule for headings and labels only.
* **Heatmap:** original red / amber / green sector colours, legend, popups, PDF capture legend and
  Figure 3.1 caption restored (the colour test is back as before).
* **Sign-in page:** unchanged; it loads neither the theme nor its fonts.

# Changelog – designs/DESIGN.md design system

* **Theme:** `static/css/theme-mono.css` rewritten around the DESIGN.md tokens.
  * Colour, type scale, weights, spacing and radius tokens are defined.
  * The palette is limited to `#000000` / `#FFFFFF`, mixed as a black canvas with white cards.
  * Sentence case, no shadows, radius 1 / 10 px.
  * Every interactive element has hover, focus-visible, active and disabled states.
  * Rules live in `@layer theme-mono`, so its `!important` declarations take precedence over
    `style.css` and Bootstrap without selector escalation.
* **Fonts:** Inter + IBM Plex Mono (300/400) replace Oswald / Great Vibes.
* **Strict black-and-white data styling:**
  * heat sectors: `main.js CROWD_LEVEL_STYLE` encodes levels by fill, stroke weight, dash
    pattern and size;
  * the 5 km circle is white dashed;
  * recommendation markers are white with black outlines, and pins are greyscale;
  * AI-recommender zone colours and status hints are neutral;
  * the PDF capture legend and pins match the screen;
  * the 3D graph labels are white.
* **Copy:** home hero is now "AI-based business intelligence using heatmaps"; the PDF figure 3.1
  caption describes the black-and-white sector styles.
* **Sign-in page:** unchanged. Its HTML is identical apart from script `?v=` numbers; it loads
  neither the theme nor its fonts, and the globe still renders only there.
* **Tests:** 218 Django + 61 JS passing. The crowd-colour test now checks the black-and-white
  encoding.

# Changelog – Typography and spacing update

* **Fonts:**
  * titles and title-like UI (labels, buttons, badges, nav, key figures) use **Oswald**;
  * running text uses **Great Vibes**, enlarged with `font-size-adjust` so it stays readable;
  * form fields, tables and map content stay in **Inter**;
  * Archivo Black and the Restore Heavy slot were removed.
* **Recommendation cards:** grid minimum 440 px (three columns on a laptop instead of four),
  28 px gaps, roomier card padding, and headers that wrap instead of clipping the heart button.
* **Background:** the Three.js globe now renders only on the sign-in and auth-callback pages;
  signed-in pages use a plain black background (Three.js still loads for the 3D revenue graph).

# Changelog – Monochrome redesign and saved locations

* **Theme:**
  * new `static/css/theme-mono.css`, scoped to `body.theme-mono`;
  * `base.html` loads it (and Google Fonts Archivo Black + Inter) on every page except
    `login` and `auth_callback`, so the sign-in page's HTML is unchanged apart from the shared
    script `?v=` version numbers;
  * restyles the navbar, sidebar, dashboard tiles, buttons (white primary / dark-grey secondary),
    forms, recommendation cards, Business Analytics (3D graph palette is now a grey → white
    ramp), the synergy panel, Favorites, Profile, Contact, the chatbot and the footer;
  * deep red only for the active nav marker, saved hearts and alerts.
* **Map:**
  * `main.js addMonoBaseLayers()`: MapTiler `satellite-v2` (CSS `grayscale/brightness/contrast`)
    plus MapTiler `toner-v2` (inverted, `mix-blend-mode: screen`), giving white road and
    building outlines;
  * used by the dashboard map, the legacy `#map` and the theme toggle;
  * `report-generator.js captureMap` now draws each tile layer with its computed filter /
    blend / opacity, so the PDF screenshot matches the screen.
* **Saved locations:**
  * `Favorites.locationPayload()`, keyed by coordinates (name-independent);
  * a map control with a heart for the selected location;
  * hearts on recommendation cards;
  * a Favorites link in both dashboard sidebars;
  * a reworked Favorites page (saved date, coordinates, analysis status, top opportunity for
    cached areas, Open location, search, empty state).
* **API:**
  * `GET /api/favorites/` rows now include `analysis: {status: fresh|stale|none|unknown, …}`
    (additive, read-only cache lookup via `analysis.area_cache_status`; never fetches);
  * no new endpoint, table or migration.
* **Tests:**
  * `./run.sh test`: **218 passing** (5 new in `favorites/tests.py`);
  * `npm run test:js`: **61 passing** (new `tests/js/favorites.test.js` and 4 new map /
    heart / open-location cases in `map-analysis.test.js`; `revenue-3d.test.js` expects the
    new grey ramp).

# Changelog – Business Synergy Intelligence

* **Engine** (`business_intelligence/synergy/`): a deterministic Synergy Potential Score (0–100)
  from real OSM places within 1.5 km.
  * Distance weighting: full weight within 300 m, falling to 0.2 at 1.5 km.
  * 16 business groups mapped to complementary businesses and demand generators.
  * Customer-group fit.
  * Competition: pressure against demand-based capacity, with a cluster bonus and a saturation penalty.
  * Accessibility: the revenue engine's own score.
  * Configurable weights (30/25/20/15/10) and uplift caps (5/10/15%).
  * Revenue scenarios: `uplift = cap × score/100 × (0.5 + 0.5 × coverage)`.
  * Rule-based explanations that use only real place names.
  * Runs in under 10 ms per analysis on 9,800-place areas.
* **API:**
  * new `GET/POST /api/synergy/`;
  * `/api/location-recommendations/` now returns `synergy`, `model_score` and `overall_score` per
    card, plus a `comparison`. The ranking is unchanged.
* **Web:**
  * synergy block on each recommendation card;
  * best by model / synergy / overall strip;
  * **Synergy Revenue Intelligence** panel below the 3D graph (`static/js/synergy.js`). It adds no
    new buttons; it uses a `<select>` and `<details>`.
* **PDF:**
  * new section **7. Business Synergy Opportunity Analysis**, with 7 subsections, Figure 7.1 and a
    Top-5 comparison table; sections 8–11 renumbered;
  * included in the ReportLab fallback too, and required by `validate_pdf`.
  * The base is the Section 6 revenue, and a test checks the snapshot equals the `/api/synergy/` response.
* **Tests:**
  * `./run.sh test`: **213 passing**, with `business_intelligence/test_synergy.py` and new
    PDF/consistency cases.
  * `npm run test:js`: **51 passing** (was 46), with `tests/js/synergy.test.js`.
  * No live OpenStreetMap is used.

# Changelog – map logic (Part 1) and 3D revenue analytics (Part 2)

Plan and root causes: **PLAN.md** (this round) and **PLAN_ROUND1.md** (the first bug round).
Per-bug details of the first round: **CHANGELOG_FIXES.md**. Supabase/deploy settings: **MANUAL_STEPS.md**.

## Test status

| Suite | Before this round | After |
|---|---|---|
| `./run.sh test` | 160 passing | **181 passing** (~21 s, no network) |
| `npm run test:js` | 34 passing | **44 passing** |

New tests: `business_intelligence/test_revenue_timeseries.py` (model + API),
`business_intelligence/test_analytics_ws.py` (WebSocket consumer), `tests/js/revenue-3d.test.js`
(formatting + graph flow), extra cases in `test_area_analysis.py`, `report_generator/tests/test_pdf.py`
and `tests/js/map-analysis.test.js` (selected-area state, analysis context, Business Analytics entry,
startup form → existing report button).

Also checked in **real headless Chrome** (WebGL via SwiftShader) with live Uttarahalli data: the 3D
graph renders (216 bars, no errors) in all four views, at desktop width and 390 px, and the 2D
fallback renders with WebGL disabled. Screenshots: `docs/screenshots/`. The rendered dashboard pages
load all their real scripts without runtime errors.

## Timings (live public Overpass)

| | Original code | Now |
|---|---|---|
| Popular Locations, cold (Uttarahalli) | 7.6 s, then **synthetic data** ("100 sensors", ₹8,40,000); browser stuck on "Scanning…" for minutes | answer with progress at 18.4 s, real data at 45.4 s |
| Popular Locations, cold (Jayanagar, today) | same fallback path | answer with progress at 18.2 s, real data at **39.9 s** (9,823 places) |
| Popular Locations, cached | – | **0.03–1.0 s** |
| Business Analytics graph data (`/api/revenue-timeseries/`) after a scan | – | **0.007 s** (same `analysis_id` as the scan) |

**Not met: "under ~20 s cold".** Public Overpass queues requests (20–35 s even for a 500 m query
on the day of testing). The app answers within 18 s with "still fetching", keeps fetching in the
background and fills the map automatically. For a hard 20 s guarantee, point `OVERPASS_URLS` at a
private/paid Overpass instance.

---

## PART 1 – Map logic

Most of Part 1 was fixed in the first round (see CHANGELOG_FIXES.md). Re-reading the code against
this brief found these remaining gaps, now fixed:

**1.1 One selected area**
* The state now holds `{name, lat, lng, radius, category, ts, analysis_id}`. The name is shortened
  to its first three parts (the screenshot showed a full 11-part address).
* Re-selecting the same spot keeps its category. The startup flow used to lose the business type
  when the map focused on the location.
* **Analysis context:** when Popular Locations finishes, the context
  `{name, lat, lng, radius, ts, analysis_id}` is saved in `sessionStorage`. Business Analytics
  reads only this; with no context it shows the empty state, never a default.
* The server returns `analysis_id` with every area analysis; the graph endpoint returns the same id.
* `business_type` is still category-only and validated as in round 1 (Unicode, commas, hyphens and
  ampersands OK; markup and code characters rejected).

**1.2 Speed**
* Area cache TTL is now **10 minutes**, with **stale-while-revalidate**: older data is served
  instantly while it refreshes in the background, so nobody waits on Overpass for a cached area.
  The 7-day copy is kept as the outage fallback.
* The "by category" part of the cache key isn't needed: one fetch covers every category and the
  category filters run on the cached data.

**1.3 / 1.4 / 1.5:** done in round 1 and verified again. The recommendations section stays
**below** the graph.

**1.6 Startup form**
* Removed the "Generate detailed report" button that round 1 had added to the verdict panel (no new
  buttons). The panel now points to the **existing** "Generate Detailed Report" button above the
  map, which reports on the submitted location with the form's business type.

## PART 2 – Real-time 3D revenue analytics

**Existing navigation that was connected (nothing new added)**

| Element | Where |
|---|---|
| Sidebar link "Business Analytics" `#sidebar-ai-link` (`?ai=true`) | `templates/heatmap_app/dashboard.html:28`; handler in `static/js/main.js` (`sidebarAiLink`) |
| Hero button "AI Recommender" `#btn-show-ai-recommender` | `dashboard.html:91` |
| Tile "AI Business Recommender → Explore" `#btn-show-ai-recommender-2` | `dashboard.html` (feature grid) |
| Tile "Revenue Intelligence → View" `#btn-show-flashcards` | `dashboard.html` (feature grid) |
| Deep link `/dashboard/?ai=true` and the chatbot's "show business analytics" | `main.js` |

All of them go through the existing login gate to `openDashboardDataOnlyMode()`. That function
used to leave `recs=true` in the URL, highlighted the wrong sidebar link, and showed a panel whose
only content was hard-coded demo charts that crashed on load. It now normalises the URL to
`?ai=true`, highlights "Business Analytics", and shows the graph with the recommendations below.

The chatbot's "open analytics" action skipped the login gate; it now uses it.

The "Business Recommendations" sidebar link, hero button and tile from the previous session were
your explicit request and are kept. No other button, link or tile was added; this was compared
against the original `dashboard.html`. The controls inside the graph (Live/Daily/Weekly/Monthly
tabs, "View as table", Retry) are the ones the brief asks for.

**Backend**
* `business_intelligence/revenue_timeseries.py`:
  * **Base figures:** per-category daily revenue is the sum of the Extended Huff engine's daily
    estimates for the places the Popular Places analysis estimated. These are the same places and
    numbers the map shows.
  * **Hours:** split by the engine's own `TEMPORAL_PATTERNS`.
  * **Weekdays:** documented multipliers whose average is exactly 1.0, so a week is 7 × the
    engine's daily estimate.
  * **Views:** Live (today up to the second, plus the current ₹/hour), Daily (24 h), Weekly
    (Mon–Sun) and Monthly (weeks of the month).
  * **Determinism:** the output depends only on the inputs and the timestamp, with no randomness.
    Totals are consistent: today's day fits the week, and each week bucket fits the month.
* `POST /api/revenue-timeseries/` uses Supabase bearer auth (the same as reports) and a limit of
  60 requests/min per user. It validates lat/lng, clamps the radius to 500–5000 m, and answers
  `202 pending` while the area is still fetching. Results are cached for 10 minutes by rounded
  lat/lng + radius, and Overpass never runs again on refresh (tested).
* `ws/analytics/` (Django Channels) authenticates with a token in the first message, not the URL,
  and pushes the live view every 5 s. The page falls back to polling every 8 s automatically.
* **Report:** the PDF gains Figure 6.2, the four views as a Matplotlib chart for the report's own
  location, labelled as a model projection.

**Frontend** (`static/js/revenue-3d.js`, styles in `static/css/style.css`)
* Three.js r128 + OrbitControls, which were already loaded for the dashboard globe, so there's no
  extra download (rationale in PLAN.md).
* 3D bars: X = time, Z = category, Y = ₹.
  * **Look:** cyan → violet → magenta gradient, a soft shadow on the floor grid.
  * **Motion:** entrance and tab-switch animations, and a pulsing "now" bar in Live.
  * **Reading values:** hover tooltip with category, period, ₹ and % of total; compact axis
    labels (₹1.9 Cr, ₹8.4 L).
* KPI cards (total, peak, top category, growth), the area name, a "5 km radius" chip, and a
  "Projected estimate" badge whose tooltip explains the method. Confidence and assumptions are
  shown, with a warning when confidence is low.
* States: loading skeleton, "still fetching", error with Retry, and an empty state with a link to
  the map. A newly analysed area replaces the graph and old responses are ignored (tested).
* Performance: pixel ratio capped at 2; geometries and materials disposed on rebuild; rendering
  and the live socket stop when the tab is hidden or the graph is off screen.
  `prefers-reduced-motion` turns off animation and the pulse; there is no auto-rotate.
* Touch rotate and zoom; responsive down to 390 px, where the camera pulls back on narrow screens.
* Without WebGL: a 2D stacked-bar chart with the same data. An accessible table view is always
  available.

**Removed:** `static/js/analytics-dashboard.js` and its markup. It drew hard-coded demo revenue
series (₹45,000, ₹52,000…) and threw `startRealTimeUpdates is not a function` on every load.

## Files

Added: `business_intelligence/revenue_timeseries.py`, `business_intelligence/consumers_analytics.py`,
`static/js/revenue-3d.js`, the tests listed above, `PLAN_ROUND1.md` (moved from PLAN.md),
`docs/screenshots/*`.
Changed: `business_intelligence/{analysis,views,urls}.py`, `tracker/routing.py`,
`crowd_heatmap_project/settings.py`, `static/js/{main,dashboard-form,report-generator}.js`,
`static/css/style.css`, `templates/heatmap_app/dashboard.html`, `report_generator/{chart_generator,data_collector}.py`,
`templates/reports/sections/revenue.html`, `README.md`, `.env.example`, `MANUAL_STEPS.md`, `PLAN.md`.

## How to test manually

1. Run `./run.sh` and open `http://127.0.0.1:8000/dashboard/`; sign in.
2. Open **Business Analytics** from the sidebar before analysing anything. You should see "No area
   analysed yet… Choose an area on the map and run Popular Locations" and a link to the map.
3. **Map:** search "Uttarahalli". Popular Locations then shows progress, followed by the 5 km
   circle, three-colour circles and markers.
4. **Analytics:** go back to the Dashboard and click **Business Analytics** (or the "AI
   Recommender" button). The graph for Uttarahalli should appear within about 1 s.
   * Drag, scroll and pinch.
   * Switch Live / Daily / Weekly / Monthly.
   * Hover a bar for its tooltip.
   * Try "View as table".
   * On Live, watch the total and the "now ₹/hour" figure update every few seconds. DevTools →
     Network → WS should show `ws/analytics/` messages.
   * Check that the recommendations are below the graph.
5. **Switching area:** analyse another area (e.g. Jayanagar) and open Business Analytics again.
   The graph switches to it and never shows Uttarahalli's figures.
6. **Startup form:** submit the startup form. The map should centre on the submitted location and
   show the verdict. The existing **Generate Detailed Report** button then produces a report for
   that location and business type; its revenue section includes Figure 6.2.
7. **Fallbacks:**
   * Without WebGL (`chrome://settings` → System → turn off hardware acceleration, or launch with
     `--disable-webgl`), the 2D chart and table work.
   * With "Emulate CSS prefers-reduced-motion: reduce" in DevTools, there is no animation.

## Decisions and limitations

* **Weekday/weekend multipliers** are a documented assumption; the engine has no day-of-week
  model. Each profile averages exactly 1.0.
* **No week-over-week trend:** the model has no history, so weekly growth shows "—" with that
  explanation. Monthly growth reflects only the number of days and the weekday mix.
* **Categories** come from the businesses the engine estimated: the same 30 sector-balanced places
  as the Popular Places panel. Mapped places outside that sample are not in the totals.
  Categories with no estimated place (e.g. no gym in the sample) don't appear.
* **Cold speed:** a cold Popular Locations run depends on public Overpass (see Timings).
* **Unauthenticated POSTs** to the new endpoint are rejected by the CSRF check (403) before the auth
  check (401), the same as the existing report endpoints. The page sends both.
* **Favorites PDF:** the four-view chart is in the single-location PDF only, not the favorites
  comparison PDF.

## Follow-up: zoom to the pin

* **Choosing a place now flies the map in to its pin** at street level (zoom 15). This applies to a
  search result, a map click, a red search pin, Find My Location, a recommendation, a favorite and
  the startup form. The 5 km circle is still drawn; zoom out to see all of it.
  Implemented in `zoomToPin()` and `findPopularPlaces(…, { view })` in `static/js/main.js`.
* **Popular Locations** (button and chatbot) still shows the whole 5 km area (`view: 'area'`),
  because its point is the places spread over the circle.
* Clicking a popular-place pin or card flies to that place (zoom 16).
* **Startup form** (dashboard): after submitting, the page goes to the map and zooms to the
  submitted location.
* **Floating "Business Information" form** (opened from the chatbot): after a feasible result it
  now also goes to the map, zoomed to the business location. On non-dashboard pages it redirects
  to `/dashboard/?auto_map=true&lat=…`. Before, it only dropped markers wherever the map happened
  to be, and nothing on pages without a map.
* With reduced motion enabled the map jumps without the fly animation. It never zooms *out* if
  you're already closer.
* Tests: `tests/js/map-analysis.test.js` (pin zoom vs area view, startup form). JS 46 / Django 181
  passing.

## Follow-up: Business Recommendations view redesign (no functional change)

* **Header:** a glass panel with a gradient icon, title, a two-line clamped subtitle and a
  "5 km trading zone" chip, instead of the centred title floating over the globe.
* **Toolbar:** labelled Location (wide) and Category dropdowns plus a "Refresh" button on one row.
  It stacks on phones.
* **Cards:**
  * **Layout:** a responsive grid (3 per row on desktop, 1 on phones) instead of a single
    narrow column.
  * **Style:** neon top accent, gradient rank badge, hover lift.
  * **Readability:** ₹ figures stay on one line, and the blank band under each title (generic
    `.card` padding/gap) is removed.
* **Unchanged:** markup IDs, the JS and all behaviour (`dashboard-rec-location-select`,
  `dashboard-rec-category-select`, `btn-dashboard-refresh-recs`,
  `dashboard-recommendations-cards-container`, `recommendations-subtitle`). The styles are the
  `.recs-*` rules at the end of `static/css/style.css`, which is now at `?v=3.5`.
* Respects `prefers-reduced-motion`. JS 46 and Django 181 tests pass.
