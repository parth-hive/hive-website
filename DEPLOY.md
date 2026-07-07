# Deploying Hive to Vercel + Supabase

This app is a server-rendered Express + EJS site backed by Postgres. It runs on
Vercel as a single serverless function (`api/index.js`) with **Supabase** providing
the Postgres database and image storage.

---

## 1. Set up Supabase (no CLI required)

1. Create a project at https://supabase.com → **New project**.
2. **Database schema** — open **SQL Editor → New query**, paste the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and **Run**. This creates all
   tables and a default admin (`admin@hiveny.com` / `hiveny2026` — change it).
3. **Storage bucket** — go to **Storage → New bucket**, name it `listings`, and
   mark it **Public**. (Uploaded listing images are served from here.)
4. Collect these values (you'll paste them into Vercel in step 2):

   | Value | Where to find it |
   |-------|------------------|
   | `DATABASE_URL` | **Connect** button (top bar) → **Transaction pooler** URI (port `6543`). Replace `[YOUR-PASSWORD]` with your DB password. |
   | `SUPABASE_URL` | **Project Settings → API → Project URL** |
   | `SUPABASE_SERVICE_ROLE_KEY` | **Project Settings → API → `service_role` secret** (keep private) |

---

## 2. Deploy to Vercel

1. Go to https://vercel.com → **Add New → Project** → import
   `parthsrudakia/hive-website` from GitHub.
2. Framework preset: **Other** (no build command needed — `vercel.json` handles it).
3. Add **Environment Variables** (Settings → Environment Variables):

   | Name | Value |
   |------|-------|
   | `DATABASE_URL` | Supabase transaction-pooler URI from step 1 |
   | `SUPABASE_URL` | Supabase project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key |
   | `SUPABASE_STORAGE_BUCKET` | `listings` |
   | `SESSION_SECRET` | a long random string |
   | `NODE_ENV` | `production` |
   | `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | optional — form email notifications |
   | `GOOGLE_API_KEY` | optional — Drive bulk image import |
   | `GOOGLE_PLACES_API_KEY` / `GOOGLE_PLACE_ID` | optional — homepage reviews widget |
   | `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | optional — enables Cloudflare Turnstile CAPTCHA on public forms (free at dash.cloudflare.com → Turnstile) |
   | `FORM_TOKEN_SECRET` | optional — separate signing key for form anti-spam tokens (falls back to `SESSION_SECRET`) |

4. **Deploy.** Then visit `/admin/login` and sign in with the seeded admin.

---

## Notes

- **Uploads:** in production, admin image uploads go to the Supabase `listings`
  bucket. Locally (no Supabase env vars) they fall back to `public/uploads/`.
- **Connection pooling:** Vercel functions are short-lived, so use the Supabase
  **transaction pooler** (port 6543), not the direct connection.
- **Sessions** are stored in Postgres (`connect-pg-simple`), so they survive across
  serverless invocations. The `session` table is created automatically on first run.
- The local dev workflow is unchanged: `cp .env.example .env`, fill it in, `npm start`.
