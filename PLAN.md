# Plan – Part 1 (map logic) and Part 2 (3D revenue analytics)

The detailed root-cause analysis of the first bug round (with file/line
references to the code *before* those fixes) is kept in **PLAN_ROUND1.md**.
Part 1 below says, for each item, what is already fixed, the remaining gap
found while re-reading the code, and how it is verified.

---

# PART 1 – Map logic

| Item | Root cause (original code) | Status after round 1 | Remaining gap → fix now | Verify |
|---|---|---|---|---|
| **1.1** One selected area | `localStorage.selectedLocation` written by only some flows (`main.js` search/GPS never wrote it); report read it blindly (`report-generator.js:340`); `analysisRadiusCircle` undeclared so search/GPS/map-click crashed before analysing; `business_type` = `loc.type` (any string) and regex `^[A-Za-z0-9 _&'./-]{1,60}$` (`validators.py:29`) | `setAnalysisLocation()` / `getCurrentAnalysisLocation()` used by every flow, request sequencing, 12 h max age, category-only `business_type`, Unicode-safe validator | State has no **radius** or **analysis_id**, and the *finished analysis* (what Business Analytics must read) is not stored. The category is not kept on the in-memory location, so the existing report button loses the startup-form category. → add `radius`, `analysis_id`, `category` to the state; on a finished Popular Locations run save an **analysis context** `{name, lat, lng, radius, ts, analysis_id}` in `sessionStorage` (+ server cache key = `analysis_id`) | JS unit tests for the state + context; existing validator tests |
| **1.2** Popular Locations speed | 14 `around:` statements, 5 s timeout × sequential mirrors, `out center 350`, unbounded browser building query awaited, no persistent cache | Combined bbox query, hedged mirrors + retry/backoff, persistent area cache, 18 s budget + background fetch + "pending" progress, no fake data | Requested TTL ≈ 10 min. With the current "fresh 6 h" a stale entry made the request wait for Overpass again. → **fresh TTL 10 min + stale-while-revalidate** (serve the cached copy instantly and refresh in the background; keep 7 days as the outage fallback) | test: stale entry returns instantly and schedules a refresh; timings re-measured |
| **1.3** 5 km radius / real numbers | fallback generated exactly 100 POIs; ₹8,40,000 = `120000+100×7200`; id-ordered sample | fixed (real circle + fitBounds, sector-balanced POIs, density levels, real counts, labelled estimate) | none | existing tests |
| **1.4** Heatmap capture | stale location, response race, 2 km vs 5 km | fixed (waits for the exact analysis, retry, server static map) | report must use the context's category → covered by 1.1 | JS report tests |
| **1.5** Dynamic recommendations | fixed archetypes/offsets, hard-coded dropdown | dynamic (ML + engine + competition), dropdown, category filter, click-to-map | must stay **below the graph** (it is below the panel that will hold the graph) | flow test |
| **1.6** Startup form → map | view didn't save; redirect depended on a failing second call | saves, verdict, map, crowd analysis | the round-1 verdict panel added its own "Generate detailed report" button → **remove it** (no new buttons) and make the **existing** "Generate Detailed Report" map button use the form's location + category | JS test |

---

# PART 2 – Real-time 3D revenue analytics

## Existing navigation that is connected (nothing new is added)

| Element | Where | What it does after the change |
|---|---|---|
| Sidebar link **"Business Analytics"** `#sidebar-ai-link` (`href="?ai=true"`) | `templates/heatmap_app/dashboard.html:28`, handler `static/js/main.js` (`sidebarAiLink`, ~l.4694) | gate "Business Analytics" → `openDashboardDataOnlyMode('ai')` → renders the graph |
| Dashboard hero button **"AI Recommender"** `#btn-show-ai-recommender` | `dashboard.html:91`, handler `main.js` ~l.4565 | same view |
| Tile **"AI Business Recommender" → Explore** `#btn-show-ai-recommender-2` | `dashboard.html:143`, handler `main.js` ~l.4635 | same view |
| Tile **"Revenue Intelligence" → View** `#btn-show-flashcards` | `dashboard.html:159`, handler `main.js` ~l.4580 | same view |
| Deep link `/dashboard/?ai=true` | `main.js` DOMContentLoaded (`triggerAi`, ~l.5202) | same view (login gate first) |

Bugs found in that path: `openDashboardDataOnlyMode` keeps `recs=true` in the URL (screenshot:
`?recs=true&ai=true`) and, for the AI tab, clicks `#dash-ai-tab`, which hides the `#dash-recs` pane
where the analytics block lives. The analytics block itself only showed hard-coded demo series and
threw `startRealTimeUpdates is not a function`. → the graph replaces that block, is always visible in
the Business Analytics view, the URL is normalised to `?ai=true`, and the active sidebar link is set.

Note: the "Business Recommendations" sidebar link / hero button / tile were added in the previous
session at your explicit request. They are kept; no other navigation is added.

## Data flow

```
Map: search / GPS / favorite / recommendation / startup form
   └─ setAnalysisLocation()  ─────────────►  selected area (memory + localStorage)
Popular Locations ─► POST /find-popular-places/ ─► compute_area_analysis()  (cached area POIs,
                                                    sector-balanced places + revenue engine)
   response: {…, analysis_id}
   └─ saveAnalysisContext({name, lat, lng, radius, ts, analysis_id}) ─► sessionStorage
Dashboard → existing Business Analytics button ─► openDashboardDataOnlyMode('ai')
   └─ RevenueAnalytics3D.show(context)
        ├─ POST /api/revenue-timeseries/ {lat, lng, radius, analysis_id}
        │      └─ revenue_timeseries.base_for_area()  → cache "ts_base:{lat3}:{lng3}:{r}" (10 min)
        │             (reuses compute_area_analysis → no Overpass call when the area is cached)
        │      └─ build_views(base, now)   (pure, deterministic)
        └─ ws/analytics/  {action: subscribe, token, lat, lng, radius}
               └─ every ANALYTICS_LIVE_INTERVAL s: {type: live, live: …}
               (fallback: re-POST every 8 s with views=["live"])
```

## Model (reuses the engine; one new documented assumption)

* **Per-category daily base** = sum of `revenue_data.estimated_daily_revenue` of the places that
  `enrich_places_with_revenue` (Extended Huff engine via `predict_site_revenue`) estimated for the
  area – the *same* places and figures as the Popular Places panel and the map footer.
  Category = OSM `amenity`/`shop`/`leisure`, grouped (cafe, restaurant, fast food, pharmacy,
  supermarket, convenience/grocery, school, gym, bank, other shops, other).
* **Hourly** = daily × `TEMPORAL_PATTERNS[h] / Σ TEMPORAL_PATTERNS` – exactly how the engine
  derives `hourly_revenue` (`prediction_engine/predictor.py:64-69`).
* **Weekday multipliers** (new, documented, mean exactly 1.0 so 7 days = engine weekly = 7 × daily):
  footfall-type groups (food, retail, leisure) Fri 1.05 · Sat 1.25 · Sun 1.20, Mon–Thu 0.875;
  weekday-type groups (school, office, bank) Mon–Fri 1.15 · Sat 0.75 · Sun 0.50; others flat.
* **LIVE**: today's hours 00:00 → now (current hour pro-rated to the minute) + **right now** rate
  (₹/hour) linearly interpolated between this hour's and the next hour's multiplier at the current
  second → changes every few seconds, deterministic for a timestamp, no random numbers.
* **DAILY**: 24 hours of today (= base × today's weekday multiplier).
* **WEEKLY**: Mon–Sun of the current week.
* **MONTHLY**: the Monday-based weeks of the current month (partial weeks clipped to the month).
* **Consistency**: today's daily total == today's bar in the weekly view; each weekly-view day is
  inside exactly one monthly bucket; monthly total == Σ days of the month. Tested.
* **Time zone**: Asia/Kolkata for hour/weekday/month.
* **Confidence**: mean engine `confidence_score` of the places; forced to "low" when < 10 places
  are estimated or < 100 mapped places are in the radius.

## JSON schema – `POST /api/revenue-timeseries/`

Request: `{lat, lng, radius?: int (100–5000, larger values clamped to 5000), analysis_id?, views?: ["live"|"daily"|"weekly"|"monthly"]}`
Auth: `Authorization: Bearer <Supabase token>` (same as reports); 60 requests/min/user.

```json
{
  "success": true, "is_estimate": true, "analysis_id": "a1b2c3d4e5f6",
  "area": {"name": "…", "lat": 12.9066, "lng": 77.5468, "radius_m": 5000},
  "generated_at": "2026-10-28T18:42:10+05:30", "timezone": "Asia/Kolkata",
  "confidence": {"level": "medium", "score": 72, "note": "…"},
  "assumptions": {"radius_m": 5000, "mapped_places": 4229, "places_estimated": 30,
                  "crowd_level": "medium", "density_per_km2": 53.8, "data_fetched_at": "…",
                  "method": "…", "weekday_multipliers": {…}},
  "categories": [{"key": "cafe", "label": "Cafe", "places": 4}],
  "views": {
    "live":    {"buckets": ["00:00", …, "18:00"], "series": {"cafe": [..], …}, "totals": [..],
                "total": 0, "now_index": 18, "now_rate_per_hour": 0, "today_so_far": 0,
                "peak": {"label": "…", "value": 0}, "top_category": "cafe",
                "growth_pct": 3.1, "growth_label": "vs previous hour"},
    "daily":   {… 24 buckets …, "growth_label": "vs yesterday"},
    "weekly":  {… Mon–Sun …, "today_index": 2, "growth_pct": null, "growth_label": "no trend data"},
    "monthly": {… "1–2 Nov", … …, "growth_label": "vs last month"}
  }
}
```
WebSocket `ws/analytics/`: client → `{"action":"subscribe","token":…,"lat":…,"lng":…,"radius":…}`;
server → `{"type":"live","analysis_id":…,"live":{…},"generated_at":…}` every 5 s;
errors `{"type":"error","code":"auth"|"rate_limited"|"not_analysed"|"invalid",…}`.

## Library choice: Three.js r128

Three.js r128 (`cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js`) and its OrbitControls
(`three@0.128.0`) are **already loaded on every page** for the dashboard globe, so the graph adds
no download. Plotly's 3D bundle is ~3.5 MB, its bar-3d support is mesh-based and slow to style,
and it does not give per-bar emissive pulse/gradients. Three.js gives full control over the
neon look, the pulse, animation and disposal.

## Files

Add: `business_intelligence/revenue_timeseries.py`, `business_intelligence/consumers_analytics.py`
(+ routing), `static/js/revenue-3d.js`, tests (`business_intelligence/test_revenue_timeseries.py`,
`test_analytics_ws.py`, `tests/js/revenue-3d.test.js`).
Change: `business_intelligence/views.py`, `urls.py`, `tracker/routing.py`, `analysis.py`
(stale-while-revalidate), `templates/heatmap_app/dashboard.html` (graph replaces the demo block),
`static/js/main.js` (context, Business Analytics wiring, chatbot knowledge, startup verdict panel),
`static/js/report-generator.js` (category), `report_generator/chart_generator.py`, `data_collector.py`,
`templates/reports/sections/revenue.html`, `static/js/analytics-dashboard.js` (removed – dead demo),
`crowd_heatmap_project/settings.py`.

## Verification

Unit: state/context (JS), validator, time series (deterministic, clamp, totals). API: auth 401,
validation 400, rate limit 429, pending 202, cached response < 50 ms. Consumer: subscribe → live
pushes; bad token → error. JS: INR/compact formatting, empty state, area switch discards old data.
Flow tests in jsdom; manual steps in CHANGELOG.md.
