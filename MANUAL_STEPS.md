# Manual steps

Things the code cannot do for you. Nothing in your Supabase project (settings
or data) was changed while fixing the bugs.

## 1. Supabase: confirmation e-mails must come back to this app (bug 2)

The app now asks Supabase to send users to `<SITE_URL>/auth/callback/`.
Supabase only honours that if the URL is allow-listed; otherwise it silently
falls back to the **Site URL**, whose default is `http://localhost:3000`, which
is what caused the "This site can't be reached" page.

1. Open <https://supabase.com/dashboard> and select your project.
2. Left sidebar: **Authentication** → **URL Configuration**.
3. **Site URL**
   * Local development: `http://127.0.0.1:8000`
   * Production: your public URL, e.g. `https://crowd-heatmap.onrender.com`
   * Click **Save**.
4. **Redirect URLs** → **Add URL**, one per line, then **Save URLs**:
   * `http://127.0.0.1:8000/auth/callback/**`
   * `http://localhost:8000/auth/callback/**`
   * `https://<your-production-domain>/auth/callback/**` (e.g. `https://crowd-heatmap.onrender.com/auth/callback/**`)

   The trailing `**` is needed because the app appends `?next=…` (the page to
   return to after confirming).
5. **Authentication** → **Emails** (Email Templates) → **Confirm signup**: the
   link must use `{{ .ConfirmationURL }}` (the default). If someone customised
   the template to `{{ .SiteURL }}`, change it back to `{{ .ConfirmationURL }}`.
   Do the same check for **Reset Password** and **Magic Link**.

### Users who already received a broken `localhost:3000` link
Links are valid for 24 hours by default. Either ask them to use **Resend
verification e-mail** on the sign-in page (after step 4), or edit the link in
the address bar: replace `http://localhost:3000/` with
`http://127.0.0.1:8000/auth/callback/` and keep everything from `#access_token=`
onwards.

## 2. Environment (`.env`)

```env
# Local
SITE_URL=http://127.0.0.1:8000
# Production (Render/Railway): set it in the service's environment variables
# SITE_URL=https://<your-production-domain>
```

Optional, for predictable Popular Locations speed (see CHANGELOG_FIXES.md, bug 4):

```env
OVERPASS_URLS=https://<your-private-overpass>/api/interpreter
```

## 3. Install and migrate (once, after pulling these changes)

```bash
.venv/bin/pip install -r requirements.txt   # adds reportlab (PDF fallback; it was missing)
.venv/bin/python manage.py migrate          # report_generator 0002: report kind/address/places
```

If `migrate` is skipped, the Favorites page now says so ("run python manage.py
migrate") instead of "Request failed".

## 4. Supabase tables (only if not done before)

* `supabase/favorites.sql` – favorites (needed for the favorites report).
* `supabase/security_fixes.sql`, `supabase/user_history.sql` – unchanged by these fixes.

Run them in **SQL Editor** → **New query** → paste → **Run**. Safe to re-run.

## 5. Browser

After deploying, users should reload once with a hard refresh (Ctrl+Shift+R /
Cmd+Shift+R). Script URLs now carry new `?v=` versions, so this is only needed
if a proxy cached the HTML page itself. (The "Urban Cafe ₹45,000" cards in the
bug screenshot came from an old cached `main.js`.)

## 6. Business Analytics graph (Part 2) – nothing to configure

* Live updates use the WebSocket `ws/analytics/`. Locally `./run.sh` already serves it
  (Daphne via `runserver`); in production keep the existing `Procfile`
  (`daphne … crowd_heatmap_project.asgi:application`). If a proxy blocks WebSockets the
  page falls back to polling every 8 s automatically.
* Optional settings: `ANALYTICS_LIVE_INTERVAL` (default 5 s), `OVERPASS_FRESH_SECONDS`
  (default 600 s). No new Supabase settings or tables are needed.

## 7. Fonts (optional upgrade)

`designs/DESIGN.md` names GT America Mono and Neue Haas Grotesk Text Pro, which are commercial
and not in this repository. Until you add licensed files, the site uses free look-alikes from
Google Fonts: **IBM Plex Mono** and **Inter**.

To use the licensed fonts:

1. Put the files in `static/fonts/`.
2. Add `@font-face` rules for `'GT America Mono'` and `'Neue Haas Grotesk Text Pro'` at the top of
   `static/css/theme-mono.css`. Both names are already second in `--font-mono` /
   `--font-grotesk`; move them first.
3. Bump `theme-mono.css?v=` in `templates/base.html`.

The sign-in page never loads these fonts.

## 8. Favorites – nothing to configure

Saved locations use the existing `favorite_places` table and its RLS policies
(`supabase/favorites.sql`). No new table, column or policy was added, and no Supabase data was changed.
