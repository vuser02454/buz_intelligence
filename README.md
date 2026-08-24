# Crowd Heatmap & Business Intelligence Platform

[![Python](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/)
[![Django](https://img.shields.io/badge/django-6.0+-green.svg)](https://www.djangoproject.com/)
[![AI](https://img.shields.io/badge/AI-Google%20Gemini-orange.svg)](https://ai.google.dev/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An end-to-end **Business Intelligence (BI)** web platform that helps entrepreneurs and business owners evaluate where to open a business in India. The system combines **real-time crowd density mapping**, **machine-learning business recommendations**, an **Extended Huff Gravity Model & multi-factor revenue forecasting engine**, and an **AI assistant** powered by Google Gemini.

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [Technology Stack](#technology-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Running the Application](#running-the-application)
- [Running Tests](#running-tests)
- [API Endpoints](#api-endpoints)
- [Revenue & Feasibility Engines](#revenue--feasibility-engines)
- [Machine Learning Model](#machine-learning-model)
- [User Guide](#user-guide)
- [Deployment](#deployment)
- [Documentation](#documentation)
- [License](#license)

---

## Overview

The platform answers three core questions for any location in India:

1. **How crowded is this area?** — Sector-based heatmap using OpenStreetMap POI data.
2. **What business should I open here?** — Scikit-Learn decision tree + rule-based feasibility checks.
3. **How much revenue can I expect?** — Multi-factor simulation engine with time-of-day, customer quality, competition modifiers, and Huff spatial gravity modeling.

Data is sourced live from **OpenStreetMap** (Nominatim geocoding + Overpass API) within an analysis radius (2 km to 5 km).

---

## Key Features

### Real-Time Crowd Heatmap
- Search any location in India or use browser geolocation.
- Divides the area into a **3×3 sector grid** and classifies each sector as **High**, **Medium**, or **Low** intensity based on POI density.
- Thresholds: High ≥ 15 POIs/sector, Medium 5–14, Low < 5.

### AI-Powered Business Recommendations
- **Scikit-Learn DecisionTreeClassifier** trained on `business_dataset.csv` predicts the best business type from crowd intensity, shop density, and area type.
- **Google Gemini** chatbot ("Antigravity") provides conversational guidance, geocoding assistance, and triggers map actions.
- **Smart Relocation (AI Zones)**: Scans ~1.7 km offsets to rank alternative high-potential locations.

### Revenue & Feasibility Engine
- **Spatial Prediction Engine (Extended Huff Model)**: Calculates retail gravity, competitor attraction, market capture probability, and sales estimates.
- **Smart Revenue Forecast** (`calculate_smart_revenue`): Footfall × conversion × dynamic average spend, adjusted for competition, overload, and customer quality.
- **Per-POI Revenue Enrichment** (`enrich_places_with_revenue`): Estimates revenue for nearby businesses with high efficiency.
- **Feasibility Checker**: Evaluates Go/No-Go decisions using CSV intensity rules, ML prediction, and live POI density evidence.

### User Authentication
- Custom email-based user model (`users.CustomUser`) with roles: **Businessman** and **Customer**.
- Registration, login, logout, and password reset flows.

### Interactive Dashboard
- Analytics UI with live revenue animation, business intelligence panel, 4×4 popular places flashcard matrix, and feasibility evaluation.
- WebSocket-powered chatbot for real-time AI assistance across all pages.

---

## Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (Frontend)                       │
│  Leaflet Map │ Dashboard UI │ Chatbot │ Business Form           │
└──────────────┬──────────────────────────────┬───────────────────┘
               │ HTTP/REST                    │ WebSocket
               ▼                              ▼
┌──────────────────────────┐    ┌──────────────────────────────┐
│   Django Views (REST)    │    │  Django Channels (Daphne)    │
│ tracker & business_intel │    │  tracker/consumers.py        │
└──────────────┬───────────┘    └──────────────┬───────────────┘
               │                               │
               ▼                               ▼
┌──────────────────────────┐    ┌──────────────────────────────┐
│ Spatial Engine & Utils   │    │   Google Gemini API          │
│ prediction_engine/       │    │   (Generative AI Chatbot)    │
└──────────────┬───────────┘    └──────────────────────────────┘
               │
               ▼
┌──────────────────────────┐    ┌──────────────────────────────┐
│  business_model.pkl      │    │  OpenStreetMap APIs          │
│  (Scikit-Learn)          │    │  Nominatim + Overpass        │
└──────────────────────────┘    └──────────────────────────────┘
               │
               ▼
┌──────────────────────────┐
│  SQLite / PostgreSQL     │
│  (User & form data)      │
└──────────────────────────┘
```

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| Backend | Django 6.0+, Django Channels 4.1 |
| ASGI Server | Daphne 4.1 |
| Frontend | HTML5, CSS3, Vanilla JavaScript (ES6+), Leaflet.js |
| Machine Learning | Scikit-Learn, Pandas, NumPy |
| Spatial Modeling | Extended Huff Gravity Model |
| Generative AI | Google Generative AI (Gemini 2.0 Flash) |
| Geospatial Data | OpenStreetMap (Nominatim & Overpass API) |
| Database | SQLite (dev) / PostgreSQL via `dj-database-url` (prod) |
| Static Files | WhiteNoise 6.7 |
| Deployment | Render / Railway (Procfile included) |

---

## Project Structure

```text
Business_Intelligence-main/
├── crowd_heatmap_project/       # Django project configuration & ML training
│   ├── settings.py              # Settings, DB config, Channels, Auth
│   ├── urls.py                  # Root URL routing
│   ├── asgi.py                  # ASGI & WebSocket routing
│   ├── wsgi.py
│   ├── train_model.py           # ML model training script
│   ├── business_dataset.csv     # Training dataset (crowd, shops, area → business)
│   └── business_model.pkl       # Trained DecisionTreeClassifier
│
├── tracker/                     # Crowd tracking & geocoding app
│   ├── views.py                 # Location search, crowd intensity, contact views
│   ├── utils.py                 # Revenue enrichment & scoring utils
│   ├── consumers.py             # WebSocket chatbot consumer (Gemini)
│   ├── routing.py               # WebSocket URL routing
│   ├── prediction_engine/       # Spatial gravity & Huff revenue model
│   ├── models.py                # ContactMessage
│   ├── forms.py                 # ContactForm
│   ├── urls.py                  # App URL patterns
│   └── tests.py                 # Prediction engine & integration unit tests
│
├── business_intelligence/       # Analytics & recommendation app
│   ├── views.py                 # Dashboard, feasibility, AI recommendations
│   ├── utils.py                 # Smart revenue & candidate generation
│   ├── prediction_engine/       # Spatial revenue engine modules
│   ├── models.py                # BusinessUser
│   ├── forms.py                 # BusinessUserForm
│   ├── urls.py                  # BI URL patterns
│   └── tests.py                 # Prediction engine test suite
│
├── users/                       # Authentication app
│   ├── models.py                # CustomUser (email-based login)
│   ├── views.py                 # Register, login, logout, password reset
│   ├── forms.py
│   └── urls.py
│
├── templates/                   # HTML templates
│   ├── heatmap_app/             # Home, dashboard, contact pages
│   ├── users/                   # Authentication templates
│   └── base.html                # Global base layout & floating assistant
│
├── static/                      # Static assets
│   ├── css/style.css            # Styles & responsive design
│   └── js/                      # Frontend scripts (main.js, analytics, forms)
│
├── docs/                        # Extended documentation
│   ├── RUN_INSTRUCTIONS.md
│   ├── GEOLOCATION_GUIDE.md
│   ├── AUTH_STRUCTURE_SUMMARY.md
│   ├── REVENUE_STRUCTURE_REPORT.md
│   ├── MAP_DEBUG_CHECKLIST.md
│   └── STATIC_TESTING.md
│
├── requirements.txt
├── manage.py
├── Procfile                     # Production ASGI server command
└── .env                         # Environment variables (create locally)
```

---

## Getting Started

### Prerequisites

- **Python 3.10+** (Tested on Python 3.10 through 3.14)
- **pip**
- **Google AI Studio API Key** (optional, for chatbot) — [Get one here](https://aistudio.google.com/apikey)

### 1. One-Command Quick Start (Recommended)

Start both frontend and backend instantly from your terminal:

```bash
# macOS / Linux
./run.sh

# Cross-platform Python CLI
python3 run.py

# Make
make dev

# npm / Node.js
npm run dev

# Windows (PowerShell / Command Prompt)
.\run.ps1
# or: run.bat
```

Open your browser at: **[http://127.0.0.1:8000/](http://127.0.0.1:8000/)**

---

### Manual Setup & Execution

If you prefer to configure manually:

#### 1. Clone the Repository

```bash
git clone https://github.com/Rajan-4900/demo_business_intel.git
cd demo_business_intel
```

#### 2. Create a Virtual Environment

**macOS / Linux:**
```bash
python3 -m venv .venv
source .venv/bin/activate
```

**Windows (PowerShell):**
```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

#### 3. Install Dependencies

```bash
pip install -r requirements.txt
```

#### 4. Configure Environment Variables

Create a `.env` file in the project root:

```env
# Required for AI chatbot
GEMINI_API_KEY=your_google_api_key_here

# Optional: override default Gemini model
GEMINI_MODEL_NAME=gemini-2.5-flash

# Django settings
DEBUG=True
SECRET_KEY=your_django_secret_key_here
```

#### 5. Run Database Migrations

```bash
python manage.py migrate
```

#### 6. (Optional) Create Superuser

```bash
python manage.py createsuperuser
```

#### 7. (Optional) Retrain ML Model

If you update `crowd_heatmap_project/business_dataset.csv`, retrain the classifier:

```bash
python run.py train
# or: python crowd_heatmap_project/train_model.py
```

---

## Running Tests

Run the full Django test suite to verify the spatial prediction engine and revenue calculations:

```bash
./run.sh test
# or: python3 run.py test
# or: make test
```

---

## Running the Application

### Development Server (HTTP + WebSockets)

Daphne is configured as the ASGI application handler:

```bash
./run.sh
# or: python3 run.py dev --port 8000
# or: python manage.py runserver
```

Open your browser and navigate to: **[http://127.0.0.1:8000/](http://127.0.0.1:8000/)**

### Production Server (ASGI)

```bash
daphne -b 0.0.0.0 -p 8000 crowd_heatmap_project.asgi:application
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Home page with hero & quick navigation |
| GET | `/dashboard/` | Interactive analytics dashboard & map |
| POST | `/search-location/` | Geocode location name via Nominatim |
| POST | `/autocomplete-location/` | Location search suggestions (India) |
| POST | `/find-popular-places/` | Ranked POIs within 2 km + per-place revenue |
| POST | `/analyze-crowd-intensity/` | 3×3 sector heatmap & ML business prediction |
| POST | `/check-feasibility/` | Go/No-Go feasibility check for a business type |
| POST | `/api/analyze-location/` | Full smart revenue forecast |
| POST | `/api/generate-best-locations/` | Ranked AI candidate zones (top 3) |
| GET | `/api/business-types/` | Dynamic list of business categories |
| POST | `/api/find-matching-locations/` | Match locations by crowd intensity + business |
| POST | `/submit-form/` | Submit business inquiry / user profile |
| POST | `/contact/` | Contact message submission |
| WS | `/ws/chat/` | WebSocket chatbot (Gemini assistant) |

---

## Revenue & Feasibility Engines

The platform incorporates **three revenue calculation models**:

1. **Spatial Prediction Engine (Extended Huff Model)** (`tracker/prediction_engine/`):
   - Calculates site utility from square footage, accessibility, and amenity density.
   - Computes market share probability against competing POIs using distance decay exponents.
   - Outputs revenue ranges, confidence scores, and actionable recommendations.

2. **Smart Revenue Forecast** (`calculate_smart_revenue`):
   - Models footfall from live POI density, applies daypart multipliers, and computes monthly projections adjusted for Customer Quality Index (CQI) and overload risk.

3. **Per-POI Revenue Enrichment** (`enrich_places_with_revenue`):
   - Ranks and enriches local businesses with estimated monthly turnover, health metrics, and risk scores.

---

## Machine Learning Model

| Property | Value |
|----------|-------|
| Algorithm | DecisionTreeClassifier (Scikit-Learn) |
| Features | `crowd`, `shops`, `area` (one-hot encoded) |
| Target | `business` (recommended business category) |
| Training Script | `crowd_heatmap_project/train_model.py` |
| Dataset | `crowd_heatmap_project/business_dataset.csv` |
| Serialized Model | `crowd_heatmap_project/business_model.pkl` |

---

## User Guide

1. **Register & Log In**: Create an account at `/accounts/register/` and log in.
2. **Explore Map**: Search for any city or landmark in India, or click "Find My Location".
3. **Analyze Crowd Intensity**: View the 3×3 sector heatmap (High, Medium, Low intensity).
4. **Discover Popular Places**: Click "Popular Places" to generate the 4×4 business flashcard matrix and revenue estimates.
5. **Check Feasibility**: Ask the AI assistant or test a business type (e.g., `"open cafe in Indiranagar"`).
6. **Dashboard Intelligence**: Access `/dashboard/?ai=true` for full revenue projections, market breakdowns, and AI relocation zones.

---

## Deployment

The repository includes ready-to-use deployment configuration for **Render**, **Railway**, or any container/PaaS provider:

- `Procfile`: `web: daphne -b 0.0.0.0 -p $PORT crowd_heatmap_project.asgi:application`
- `whitenoise` handles static asset serving and caching.
- Configure `DATABASE_URL` for PostgreSQL connections.
- Set `DEBUG=False` and supply `SECRET_KEY` and `GEMINI_API_KEY` in environment variables.

---

## Documentation

| Document | Description |
|----------|-------------|
| [Run Instructions](docs/RUN_INSTRUCTIONS.md) | Step-by-step setup guide |
| [Geolocation Guide](docs/GEOLOCATION_GUIDE.md) | Map & GPS integration |
| [Auth Structure Summary](docs/AUTH_STRUCTURE_SUMMARY.md) | Authentication & user roles |
| [Revenue Structure Report](docs/REVENUE_STRUCTURE_REPORT.md) | In-depth revenue engine equations |
| [Map Debug Checklist](docs/MAP_DEBUG_CHECKLIST.md) | Troubleshooting map & Leaflet issues |
| [Static Testing](docs/STATIC_TESTING.md) | Static file testing guide |

---

## License

Distributed under the **MIT License**.
