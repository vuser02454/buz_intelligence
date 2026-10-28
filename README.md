# Crowd Heatmap & Business Intelligence Platform

[![Python](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/)
[![Django](https://img.shields.io/badge/django-5.2%20%7C%206.0-green.svg)](https://www.djangoproject.com/)
[![Auth](https://img.shields.io/badge/auth-Supabase-3ECF8E.svg)](https://supabase.com/)
[![Map data](https://img.shields.io/badge/data-OpenStreetMap-7EBC6F.svg)](https://www.openstreetmap.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

A location-intelligence web app for India. Pick any area on the map and the platform analyses the
**5 km around it** using live OpenStreetMap data:

* a crowd-activity heatmap;
* the popular businesses nearby, with revenue estimates;
* Go/No-Go feasibility for a business type;
* the Top 5 businesses to open there;
* a **real-time 3D graph of projected revenue**;
* a downloadable 20–25 page **PDF report**.

All revenue figures are **model projections** from mapped places and the platform's Extended Huff
revenue engine. They are not measured sales, and the UI labels them that way.

![Business Analytics – projected revenue 3D graph](docs/screenshots/analytics-3d-daily.png)

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Supabase](#supabase)
- [Running tests](#running-tests)
- [API reference](#api-reference)
- [Data and models](#data-and-models)
- [Deployment](#deployment)
- [Limitations](#limitations)
- [Further documentation](#further-documentation)
- [License](#license)

---

## Features

### Live crowd heatmap
* Search any place in India, click the map, use **Find My Location**, or open a saved favorite.
  The map flies to the pin and draws the **5 km analysis circle**.
* The circle is split into **9 sectors** (3 rings × 3 compass wedges). Each is coloured by its
  density of mapped places:
  * red = High (≥ 60 places/km²)
  * amber = Medium (25–59)
  * green = Low (< 25)
* The footer shows the real number of mapped places in the circle and an estimated monthly revenue
  for the listed businesses. A tooltip explains how it is calculated.
* **Popular Locations** shows up to 30 named businesses spread across the whole circle (pins plus
  cards), each with revenue, health and potential scores.

### Business Analytics – real-time 3D revenue graph
* Opens from the Dashboard (**Business Analytics** in the sidebar, the **AI Recommender** button,
  or the **Revenue Intelligence** card). It shows the area you last analysed with Popular Locations.
* Interactive 3D bar chart: time on one axis, business category on another, projected ₹ revenue
  as height.
* **Live, Daily, Weekly and Monthly** views. Live updates every 5 seconds over a WebSocket and
  falls back to polling.
* KPI cards for total, peak period, top category and growth.
* A "Projected estimate" badge explains the method; confidence and assumptions are shown.
* Works on phones (touch rotate/zoom). Without WebGL it falls back to a 2D chart, and a table view
  is always available.

### Business recommendations
* The Top 5 businesses to open in the selected area. Candidates come from the ML model, which uses
  the crowd level and the kinds of places nearby, plus every category the revenue engine models.
* Each candidate is placed in the sector that suits it best and costed with the revenue engine.
* Each card shows estimated revenue, profit, break-even, crowd level and competition within 1 km.
* Choose the location (current area, recent searches, saved favorites) and filter by category.
  **View on Live Map** jumps to that spot.

### Business Synergy Intelligence
* For a business at a site, a **Synergy Potential Score (0–100)** says how much the surroundings
  could help it. It is calculated by fixed rules from real OpenStreetMap places within 1.5 km (no AI
  makes up the numbers). Five weighted factors: complementary businesses 30%, surrounding demand
  (transit, campuses, homes, tourism) 25%, matching customer groups 20%, competition-adjusted
  opportunity 15%, accessibility 10%.
* **Revenue scenarios** on top of the revenue engine's base estimate:
  `uplift = cap × score/100 × (0.5 + 0.5 × data coverage)`, with illustrative caps of 5 / 10 / 15%
  (conservative / moderate / optimistic). They are always labelled as projections.
* A plain-language explanation covers why the site fits, which named nearby places help and how,
  the opportunity in ₹, risks and practical next steps.
* **Where it appears:**
  * every Top 5 recommendation card (score, main sources, base vs synergy-adjusted revenue, and a
    "Why this synergy?" section);
  * a comparison of the best pick by model, by synergy and overall (0.6 × model + 0.4 × synergy);
  * the **Synergy Revenue Intelligence** panel in Business Analytics, below the 3D graph;
  * section 7 of the PDF report.
* Weights and caps can be set in settings (`SYNERGY_WEIGHTS`, `SYNERGY_UPLIFT_CAPS`). Code:
  `business_intelligence/synergy/`.

### Startup form and feasibility
* Enter a business type, the location and the crowd level you want. The inquiry is saved and the
  Go/No-Go rules run with reasons.
* You're then taken to the map, centred on the location, with the matching crowd sectors
  highlighted.
* **Generate Detailed Report** then reports on that location and business type.

### PDF reports
* **Single location:**
  * executive summary and KPIs;
  * the live heatmap screenshot, or a server-drawn map if capture fails;
  * sector analysis, competitors, revenue scenarios and the four-view revenue chart;
  * **Business Synergy Opportunity Analysis** (overview, helpful nearby businesses, environmental
    opportunities, calculations, revenue scenarios, risks, advice), with the same numbers as the website;
  * feasibility, roadmap, risks and a checklist.
* **Favorites comparison:** tick 3–6 saved places to get a full analysis per place (crowd,
  heatmap, popular places, revenue, competitors, Go/No-Go, SWOT, risks) plus a comparison table.
* Rendered with WeasyPrint, falling back to ReportLab automatically. Optional Gemini-written
  explanations are fact-checked against the data, with a template fallback.
* Reports are stored per user and listed under **Favorites → Generated Business Reports**.

### Favorites
* Save any place with the heart icon. Favorites are stored in Supabase with row-level security,
  so each user only sees their own.
* **Where you can save:**
  * the map's **save this location** control, which follows the selected spot (search, map click,
    GPS, startup form or an opened recommendation);
  * Popular Places cards;
  * Top 5 recommendation cards.
* **Duplicates:** a location is keyed by its coordinates (~11 m), so the same spot is never saved
  twice under different names.
* **Favorites page** (also in the dashboard sidebar): each card shows
  * the saved date and coordinates;
  * whether its 5 km analysis is cached (up to date / refreshes when opened / not analysed);
  * for cached areas, the top opportunity with projected revenue and synergy score.
* **Open location** jumps to the map, selects the spot, draws the 5 km circle and runs the existing
  analysis, reusing the cache when it is fresh.
* You can also search saved locations, remove them, or tick them for the comparison PDF.
* "Recommended for you" ranks places by what other users save, your own saves, and distance.

### Look and feel
* Signed-in pages follow the design system in `designs/DESIGN.md` (`static/css/theme-mono.css`).
* **Palette:** white `#FFFFFF` background with black `#000000` text and hairlines. The map and
  the 3D revenue graph stay dark. Red only for errors and destructive actions; heatmap sectors
  keep red / amber / green.
* **Type:** headlines in the style of signal-a.studio:
  * uppercase Instrument Serif (condensed light serif), with heavy Inter Tight 800 for emphasised
    words and card titles;
  * uppercase IBM Plex Mono for nav, labels, badges, buttons and figures;
  * Inter 300/400 for body text.
* **Shape:** radius 1 px or 10 px, no shadows, DESIGN.md spacing scale.
* **Heatmap:** keeps its original red / amber / green density colours. Pins are greyscale.
* **Base map:** dark satellite imagery with white road and building outlines.
* **Recommendation cards:** wide columns (minimum 440 px).
* **The sign-in page is excluded:** it loads none of this, and the Three.js globe background
  appears only there.

### AI assistant
* Floating chatbot: answers questions about the platform instantly from a built-in feature list,
  opens features ("show business analytics", "take me to the map"), and runs feasibility questions
  like "Is a pharmacy feasible in Koramangala?".
* Optional Gemini analysis with a Grok risk review when API keys are set.

### Accounts (Supabase)
* **Sign-up and e-mail:** sign-up with e-mail confirmation (with resend). Confirmation links return
  to `/auth/callback/`.
* **Sign-in:** e-mail/password sign-in, password reset by e-mail, sign-out, and automatic session
  refresh.
* **Profile page:** name, avatar and password, stored in Supabase user metadata.
* **Gating:** features are gated consistently. The session is verified with Supabase before the UI
  shows you as signed in, and after signing in you land back on the feature you asked for.

---

## How it works

```text
Browser (Leaflet map, dashboard, Three.js graph, chatbot)
  │  Supabase JS – sign-in; session verified with the auth server before the UI trusts it
  │
  ├─ HTTP ─► Django views
  │           ├─ fetch_area_pois()   one Overpass query per area (5 km), hedged across mirrors,
  │           │                      cached on disk (fresh 10 min, kept 7 days), never fake data
  │           ├─ compute_area_analysis()  sectors · popular places · ML prediction (cached)
  │           ├─ revenue engine (Extended Huff, 1.5 km catchment per site)
  │           ├─ revenue_timeseries  live / daily / weekly / monthly projection
  │           └─ report_generator    background PDF jobs (WeasyPrint → ReportLab)
  │
  ├─ WebSocket ─► ws/chat/       AI assistant
  │              ws/analytics/  live revenue pushes every 5 s
  │
  └─ Supabase
       ├─ Auth: sign-up / sign-in / reset / sessions; the server verifies tokens for
       │         reports, analytics and ws/analytics/
       └─ Postgres (RLS, user's own token): favorite_places · community_favorites() ·
                 profiles · user_history (+ views) · user_activity_logs
```

* **One selected area:** every way of choosing a place (search, pin, GPS, favorite,
  recommendation, startup form) writes the same "selected area". The heatmap, popular places,
  reports and analytics all read it. Late answers for an older place are discarded.
* **One fetch per place:** when Overpass is slow, requests answer "still fetching" within 18 s
  while the fetch continues in the background, and the page retries automatically. Cached areas
  answer in well under a second.

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Django 5.2 / 6.0, Django Channels + Daphne (ASGI, WebSockets) |
| Frontend | HTML, CSS, vanilla JavaScript; Bootstrap 5; Leaflet; Three.js r128 (3D graph) |
| Map data | OpenStreetMap: Nominatim (geocoding), Overpass API (places) |
| Models | Scikit-Learn decision tree (business type); Extended Huff gravity revenue engine |
| AI (optional) | Google Gemini (assistant + report text), xAI Grok (risk review) |
| Supabase | Auth (e-mail/password, confirmation, password reset, sessions, user metadata); Postgres with row-level security for profiles, favorites, user history and activity logs; SQL functions, views and triggers |
| Django database | SQLite (startup inquiries, contact messages, generated PDF reports) |
| PDF | WeasyPrint (needs Pango), ReportLab fallback, Matplotlib charts |
| Static files | WhiteNoise |

---

## Project structure

```text
├── crowd_heatmap_project/     settings, URLs, ASGI; ML training script, dataset and model (.pkl)
├── business_intelligence/     main app
│   ├── analysis.py            Overpass fetch + cache, sectors, ML prediction, feasibility, recommendations
│   ├── views.py               map/analysis APIs, startup form, recommendations, revenue time series
│   ├── revenue_timeseries.py  live / daily / weekly / monthly revenue projection
│   ├── consumers_analytics.py ws/analytics/ live revenue consumer
│   ├── utils.py               revenue engine wrappers (smart revenue, per-place enrichment)
│   └── prediction_engine/     Extended Huff revenue model
├── tracker/                   home/contact pages, AI assistant (tracker/ai/), ws/chat/ routing
├── favorites/                 favorites API (Supabase REST with the user's token) + recommender
├── report_generator/          PDF pipeline: data collection, charts, AI text, WeasyPrint/ReportLab,
│                              single-location and favorites-comparison reports
├── templates/                 base, dashboard, login, auth callback, favorites, profile, report templates
├── static/
│   ├── css/style.css
│   └── js/  main.js · supabase-auth.js · revenue-3d.js · report-generator.js · favorites.js · dashboard-form.js
├── supabase/                  SQL to run once in Supabase (favorites, history, security fixes)
├── tests/js/                  frontend tests (jsdom)
├── docs/                      extra guides and screenshots
├── run.sh · run.py · run.ps1 · run.bat · Makefile · Procfile · Dockerfile
└── requirements.txt · package.json
```

---

## Getting started

### Prerequisites
* Python 3.10+ (tested up to 3.14)
* For PDF reports with the full design: the Pango system library (otherwise the plain ReportLab
  fallback is used)
  ```bash
  brew install pango                                      # macOS
  sudo apt-get install libpango-1.0-0 libpangoft2-1.0-0   # Debian/Ubuntu
  ```
* Node.js 18+ (only for the frontend tests)

### Quick start

```bash
./run.sh setup     # creates .venv, installs requirements, migrates, trains the model if missing
./run.sh           # starts Django + Daphne (HTTP + WebSockets) on http://127.0.0.1:8000
```

The same commands are available as `python3 run.py setup|dev|test|…`, `make setup|dev|test`,
`npm run setup|dev|test`, and `run.ps1` / `run.bat` on Windows.

### Manual setup

```bash
python3 -m venv .venv && source .venv/bin/activate     # Windows: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
cp .env.example .env                                     # then edit it (see Configuration)
python manage.py migrate
python manage.py runserver                               # Daphne serves HTTP and WebSockets
```

Open <http://127.0.0.1:8000/dashboard/> and sign in. To see the analytics graph:
1. Search an area on the map and click **Popular Locations**.
2. Open **Business Analytics** from the sidebar.

---

## Configuration

Copy `.env.example` to `.env`. Every setting is optional for local development.

| Variable | Default | Purpose |
|---|---|---|
| `DEBUG` | `False` | Django debug mode |
| `SECRET_KEY` | insecure dev key | **Set in production** |
| `SITE_URL` | page origin | Base URL for links in Supabase e-mails (`<SITE_URL>/auth/callback/`) |
| `FRONTEND_URL` | – | Extra trusted origin for CSRF |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | demo project | Your Supabase project (public anon key only) |
| `GEMINI_API_KEY`, `GEMINI_MODEL_NAME` | –, `models/gemini-2.5-flash` | AI assistant and report explanations |
| `GROK_API_KEY`, `GROK_MODEL_NAME` | –, `grok-2-latest` | Optional risk review in the assistant |
| `OVERPASS_URLS` | public mirrors | Comma-separated Overpass endpoints; a private instance gives predictable speed |
| `OVERPASS_WAIT_SECONDS` | `18` | Time one request waits before answering "still fetching" |
| `OVERPASS_FRESH_SECONDS` | `600` | Area data is fresh this long; older copies are served while refreshing |
| `OVERPASS_CACHE_DIR` | `.cache/overpass` | Disk cache for area data (kept 7 days) |
| `ANALYTICS_LIVE_INTERVAL` | `5` | Seconds between live revenue pushes on `ws/analytics/` |
| `REPORT_RETENTION_HOURS` | `24` | How long generated PDFs are kept |
| `REPORT_MAX_PER_HOUR` | `10` | Reports per user per hour |
| `REPORT_MAX_CONCURRENT` | `2` | Reports generated at once |
| `REPORT_AI_ENABLED` | `True` | Use Gemini for report text (template text otherwise) |
| `REPORT_AI_TIMEOUT` | `25` | Seconds per Gemini report stage |

User accounts, profiles, favorites, history and activity logs live in **Supabase**
(see [Supabase](#supabase)). Django's own tables (startup inquiries, contact messages, generated
reports) are stored in **SQLite** (`db.sqlite3`).

---

## Supabase

The platform relies on Supabase for accounts and user data. The browser uses the public anon key
plus the signed-in user's token, so **row-level security** decides what each user can read or
change. The Django server never holds a service-role key: it forwards the user's token, or verifies
it with Supabase Auth (`/auth/v1/user`) for reports, the analytics endpoint and the
`ws/analytics/` WebSocket.

| Supabase feature | Used for | Where |
|---|---|---|
| **Auth** – sign-up, e-mail confirmation + resend, sign-in, password reset, sign-out, session refresh | Accounts | `static/js/supabase-auth.js`, `templates/heatmap_app/login.html`, `/auth/callback/` |
| **Auth user metadata** | Full name and avatar | `templates/heatmap_app/profile.html` |
| **Token verification** | Private reports, analytics API, live WebSocket | `report_generator/auth.py` |
| `profiles` table + sign-up trigger `handle_new_user` | One profile per user (own row only), `last_seen_at` | Supabase schema, `supabase/security_fixes.sql` |
| `favorite_places` table (RLS, 500-per-user cap) | Hearts, Favorites page, favorites PDF | `favorites/store.py`, `supabase/favorites.sql` |
| `community_favorites()` function (security definer) | "Recommended for you" (popular picks without exposing user ids) | `favorites/recommender.py`, `supabase/favorites.sql` |
| `user_history` table, `my_history_summary` / `my_recent_places` views, trim/last-seen trigger | Per-user timeline of searches, analyses, feasibility checks and startup inquiries | `supabase/user_history.sql` |
| `user_activity_logs` table | Sign-in, sign-out and feature-usage audit log (written off the request path) | `business_intelligence/supabase_service.py`, `/api/log-activity/` |

### Setup

1. Create a Supabase project and put its URL and anon key in `.env`.
2. In **SQL Editor**, run once: `supabase/favorites.sql`, then `supabase/user_history.sql` and
   `supabase/security_fixes.sql`. All are safe to re-run.
3. **Authentication → URL Configuration:**
   * set **Site URL** to `http://127.0.0.1:8000` (local) or your production URL;
   * add **Redirect URLs** `http://127.0.0.1:8000/auth/callback/**`,
     `http://localhost:8000/auth/callback/**` and `https://<your-domain>/auth/callback/**`.

   Without these, confirmation e-mails send users to Supabase's default `localhost:3000`.

Step-by-step details: [MANUAL_STEPS.md](MANUAL_STEPS.md).

---

## Running tests

```bash
./run.sh test        # Django: 181 tests (no network access needed)
npm install
npm run test:js      # Frontend (jsdom): 46 tests
```

The tests cover:
* Overpass fetching, caching and failover;
* sector analysis and recommendations;
* the revenue time series (deterministic, consistent totals) and the WebSocket consumer;
* auth pages, validators, report generation and favorites export;
* the startup form;
* map flows (selected area, stale responses, zoom to pin) and the 3D graph's states and formatting.

---

## API reference

Map and analysis APIs that create user data or reports require `Authorization: Bearer <Supabase
access token>`. Analysis endpoints answer `202 {"pending": true, "retry_after": n}` while
OpenStreetMap data for a new area is still being fetched.

| Method | Endpoint | Description |
|---|---|---|
| POST | `/search-location/`, `/autocomplete-location/` | Nominatim search (India) |
| POST | `/find-popular-places/` | Popular places, sector heatmap, estimates and recommendations for the 5 km circle; returns `analysis_id` |
| POST | `/analyze-crowd-intensity/` | Sector heatmap only (shares the same cached analysis) |
| POST | `/check-feasibility/` | Go/No-Go for a business type, with reasons |
| POST | `/api/analyze-location/` | Revenue engine forecast for one business type |
| GET/POST | `/api/location-recommendations/` | Top 5 businesses (`category`, `limit` optional), each with `synergy`, `model_score`, `overall_score`, plus a `comparison` (best by model / synergy / overall) |
| GET/POST | `/api/synergy/` | Synergy score, factors, nearby places, revenue scenarios and explanation for `business_type` at `latitude`/`longitude` (60 req/min/IP) |
| GET | `/api/business-types/` | Allowed business categories |
| POST | `/api/revenue-timeseries/` 🔒 | Live / daily / weekly / monthly projected revenue by category (60 req/min/user) |
| WS | `/ws/analytics/` 🔒 | Live revenue pushes (send `{"action":"subscribe","token":…,"lat":…,"lng":…}`) |
| WS | `/ws/chat/` · POST `/chat/` | AI assistant |
| POST | `/submit-form/` | Startup form: saves the inquiry, returns the verdict and map target |
| GET/POST | `/api/favorites/` 🔒 | List / add favorites |
| POST | `/api/favorites/toggle/` 🔒 · DELETE `/api/favorites/<id>/` 🔒 | Heart button / remove |
| GET | `/api/favorites/recommendations/` 🔒 | Community + personal picks |
| POST | `/api/reports/generate/` 🔒 | Start a single-location PDF report |
| POST | `/api/favorites/report/` 🔒 (alias `/api/reports/favorites/`) | Start a favorites-comparison PDF (`{"ids": […]}` optional) |
| GET | `/api/reports/` 🔒 · `/api/reports/<id>/status/` 🔒 · `/api/reports/<id>/download/` 🔒 | List, progress, download |
| GET | `/auth/callback/` | Landing page for Supabase e-mail links |

🔒 = Supabase bearer token required.

---

## Data and models

**Crowd heatmap.**
* Mapped businesses, services, offices, leisure and transit stops within 5 km; street furniture
  is excluded.
* Grouped into 9 sectors and classified by density per km², because outer sectors are 5× larger
  than inner ones.
* This measures how built-up and commercial an area is. It is not a people count.

**ML model.**
* `DecisionTreeClassifier` trained on `crowd_heatmap_project/business_dataset.csv` (crowd level,
  shop density, area type → business).
* Retrain with `./run.sh train`.

**Revenue engine** (`business_intelligence/prediction_engine/`).
* An Extended Huff gravity model: site attractiveness, distance decay, competition and
  per-category spend/conversion.
* Each site is evaluated on its **1.5 km catchment**.
* Details: [docs/REVENUE_STRUCTURE_REPORT.md](docs/REVENUE_STRUCTURE_REPORT.md).

**Revenue time series** (`business_intelligence/revenue_timeseries.py`).
* The engine's daily estimates for the area's businesses, spread over the day with the engine's
  hourly pattern.
* Spread over the week with fixed weekday/weekend multipliers, each averaging 1.0.
* Deterministic for a given area and time. Today's total fits the week, and the week fits the
  month.

---

## Deployment

* `Procfile`: `collectstatic` + `daphne -b 0.0.0.0 -p $PORT crowd_heatmap_project.asgi:application`.
  Daphne is required for the WebSockets. A `Dockerfile` and `render.yaml` are included.
* Set `DEBUG=False`, `SECRET_KEY`, `SITE_URL`, the Supabase keys and optionally the AI keys.
* Add your production `/auth/callback/**` URL in Supabase (see [Supabase](#supabase)).
* The area cache lives on disk (`OVERPASS_CACHE_DIR`). On ephemeral hosts it is simply rebuilt.

---

## Limitations

* **Speed:** the first analysis of a new area depends on the public Overpass servers. It typically
  takes 25–45 s, with progress shown, and repeats are near-instant. Use `OVERPASS_URLS` with a
  private instance for faster cold requests.
* **Estimates:** revenue figures are model estimates from mapped places. There is no access to
  real sales, rent or footfall data.
* **Synergy:** customer links between places are inferred from what is mapped, not observed. The
  uplift caps are assumptions, not values fitted to sales data, and unmapped places can be neither
  counted as help nor as competition.
* **Weekly trend:** weekly growth is not modelled (no historical data), so the graph shows "—".
* **Geography:** India only. Results depend on how well an area is mapped in OpenStreetMap.

---

## Further documentation

| Document | Contents |
|---|---|
| [MANUAL_STEPS.md](MANUAL_STEPS.md) | Supabase dashboard settings, install/migrate steps |
| [CHANGELOG.md](CHANGELOG.md) · [CHANGELOG_FIXES.md](CHANGELOG_FIXES.md) | Recent changes, timings, how to test manually |
| [PLAN.md](PLAN.md) · [PLAN_ROUND1.md](PLAN_ROUND1.md) | Design decisions and root-cause analyses |
| [docs/REPORT_GENERATION.md](docs/REPORT_GENERATION.md) | PDF report pipeline |
| [docs/REVENUE_STRUCTURE_REPORT.md](docs/REVENUE_STRUCTURE_REPORT.md) | Revenue engine equations |
| [docs/RUN_INSTRUCTIONS.md](docs/RUN_INSTRUCTIONS.md) | Running the project |
| [docs/GEOLOCATION_GUIDE.md](docs/GEOLOCATION_GUIDE.md) · [docs/MAP_DEBUG_CHECKLIST.md](docs/MAP_DEBUG_CHECKLIST.md) | Map and GPS troubleshooting |
| [docs/screenshots/](docs/screenshots/) | Analytics graph screenshots (desktop, mobile, 2D fallback) |

---

## License

Distributed under the **MIT License**.
