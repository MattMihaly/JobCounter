# Deploying the Ambos ACT site + live counter on Northflank

This one service runs everything:

- **`/`** — the Ambos ACT campaign website
- **`/counter`** — the plain live counter dashboard
- **`/api/tally`** — JSON the campaign page reads for the live numbers
- **`/api/stats`** — analytics from the incident archive (top suburbs, by hour, by type)
- **`/healthz`** — health check Northflank uses

There are **two stores**, each for the job it's good at:

1. **A persistent volume (`/data`)** holds the live 24-hour tally and the
   busiest-day record — a small file, written every 60s, that survives
   redeploys.
2. **A PostgreSQL database** archives every individual incident (suburb,
   type, agency, coordinates, time of call, status changes over time) so you
   can interrogate the data later — common suburbs, time-of-day patterns,
   incident-type trends, how long incidents stay open, and so on.

The database is **optional and non-blocking**: if it's ever unreachable the
counter and website keep working, and archiving resumes automatically when
the database is back. So the site's uptime never depends on the database.

---

## What's in this repo

```
.
├── server.js          ← the app: poller + API + serves the site
├── db.js               ← PostgreSQL archiving (optional, non-blocking)
├── package.json
├── Dockerfile          ← pins port 3000, installs deps, copies the site in
├── .dockerignore
├── .gitignore
└── public/
    └── index.html      ← the campaign website (served at /)
```

Put **all of these at the root** of a GitHub repo (don't nest them in a
subfolder — Northflank looks at the repo root).

---

## Step 1 — Put the code on GitHub

1. Create a new GitHub repository (e.g. `ambos-act`).
2. Upload these files, keeping the structure above (so `public/index.html`
   stays inside a `public` folder). Either drag-and-drop in GitHub's web
   uploader or, with git installed:

   ```bash
   git init
   git add .
   git commit -m "Ambos ACT site + live counter"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/ambos-act.git
   git push -u origin main
   ```

---

## Step 2 — Create the service on Northflank

1. Sign in at <https://northflank.com> and open (or create) a project.
2. Click **Create new → Service → Combined service**
   (this both builds the image and runs it).
3. **Connect your GitHub account** if you haven't, then pick the
   `ambos-act` repo and the `main` branch.

---

## Step 3 — Build settings (this is the part that matters most)

1. Under **Build**, choose **Dockerfile** — NOT Buildpack.
   - Dockerfile path: `/Dockerfile`
   - This is the single most important setting. Using the Dockerfile pins
     the port so Northflank routes traffic to the right place. (A wrong
     build type here is the usual cause of a "Not found" page.)
2. Leave build context as the repo root (`/`).

---

## Step 4 — Networking / port

1. Under **Ports / Networking**, Northflank should auto-detect **port 3000**
   from the Dockerfile's `EXPOSE 3000`.
2. Make sure that port is set to **Public** and **HTTP**.
3. If it wasn't auto-added, add a port manually: number `3000`, public, HTTP.

---

## Step 5 — Add the persistent volume (this is what keeps the counts)

This is the step that makes the tally and busiest-day record survive
redeploys and website edits.

1. In the service config, find **Volumes** (sometimes under **Advanced** or
   **Storage**).
2. **Add a persistent volume:**
   - **Mount path:** `/data`
   - **Size:** 1 GB is plenty (the state file is tiny)
3. Save.

That's all — `server.js` already reads `STATE_DIR=/data` (set in the
Dockerfile), so it automatically writes `state.json` to this volume. Because
the volume lives outside the container image, redeploying new code or editing
the website never touches it.

> If you skip this step the site still works, but the 24-hour tally and
> busiest-day record reset to zero every time you redeploy.

---

## Step 5b — Add the PostgreSQL database (for the incident archive)

This is what stores every incident long-term so you can query suburbs,
time-of-day, types, and trends.

1. In your Northflank **project** (not the service), click
   **Create new → Addon → PostgreSQL**.
2. Pick the smallest plan to start (you can resize later — the data is small
   and grows slowly). Give it a name like `esa-db` and create it.
3. Wait for it to provision (a minute or two), then open the addon and find
   its **connection details**. Northflank exposes a connection string and
   usually a ready-made environment variable for it.
4. Back in your **service**, go to **Environment** (or **Secrets**) and add
   a variable:
   - **Name:** `DATABASE_URL`
   - **Value:** the PostgreSQL connection string from the addon
     (looks like `postgres://user:pass@host:5432/dbname`).
   - The easiest path: Northflank lets you **link the addon** to the service,
     which injects its connection variables automatically — if you do that,
     make sure the variable the app reads is named `DATABASE_URL` (add an
     alias/mapping if Northflank's default name differs).
5. Save. On the next deploy the app will detect `DATABASE_URL`, create its
   tables automatically on first connect, and start archiving.

**SSL note:** managed Postgres normally requires SSL, which the app enables
by default. Only if you run a local Postgres without SSL would you set
`PGSSL=disable` — leave it unset on Northflank.

**No database yet?** Totally fine — deploy without `DATABASE_URL` and the
counter/website run normally; add the database whenever you're ready and
redeploy. Archiving simply begins from that point (it can't backfill history
from before it was connected).

---

## Step 6 — Deploy

1. Click **Create / Deploy**.
2. Northflank builds the image and starts the service (≈1–2 minutes).
3. When it's running you'll get a public URL like
   `https://YOUR-SERVICE--xxxx.code.run`.

---

## Step 7 — Verify it worked

Open these in a browser (replace with your real URL):

| URL | Expected |
|-----|----------|
| `https://…code.run/healthz` | `{"status":"ok", ..., "archiving":true}` |
| `https://…code.run/` | the Ambos ACT campaign site |
| `https://…code.run/counter` | the plain counter dashboard |
| `https://…code.run/api/tally` | JSON with `ambulance`, `fire`, `busiest` |
| `https://…code.run/api/stats` | archive analytics (empty until incidents accrue) |

`"archiving":true` in `/healthz` confirms the database connected. If it says
`false`, the database isn't linked yet — check `DATABASE_URL` (Step 5b).

The campaign page's live numbers fill in within a few seconds (the counter
polls the ESA feed every 60s, so it needs a moment after first boot to
populate; the busiest-day record builds up over the following days).

---

## Updating the website later (counts stay intact)

1. Edit `public/index.html` (or anything else) and push to GitHub:
   ```bash
   git add . && git commit -m "Update campaign copy" && git push
   ```
2. Northflank auto-redeploys (if CD is on) or click **Redeploy**.
3. The new site goes live; **the tally and busiest-day record are untouched**
   because they live on the `/data` volume, not in the code.

---

## Interrogating the archive

Once incidents are accruing, there are two ways to explore them.

**Quick analytics, no SQL:** open `/api/stats` in a browser. It returns
ready-made summaries — total archived, top 10 suburbs, counts by hour of day,
top incident types, and the ambulance/fire/other split.

**Full queries:** connect to the database directly with any SQL client (e.g.
`psql`, TablePlus, DBeaver) using the connection string from the addon. The
schema is two tables:

- **`incidents`** — one row per unique incident, with `cadid`, `title`,
  `type`, `agency`, `agency_bucket`, `suburb`, `location`, `latitude`,
  `longitude`, `time_of_call`, `first_seen`, `last_seen`, `last_status`,
  `last_updated`, `cleared_at`.
- **`incident_status_log`** — one row each time an incident's status changed,
  with `cadid`, `status`, `observed_at` (lets you see progression and dwell
  time).

Example questions you can now answer:

```sql
-- Busiest suburbs for ambulance call-outs
SELECT suburb, COUNT(*) FROM incidents
WHERE agency_bucket = 'ambulance' AND suburb <> ''
GROUP BY suburb ORDER BY COUNT(*) DESC LIMIT 20;

-- Call volume by hour of day (when is it busiest?)
SELECT EXTRACT(HOUR FROM time_of_call) AS hour, COUNT(*)
FROM incidents WHERE time_of_call IS NOT NULL
GROUP BY hour ORDER BY hour;

-- Roughly how long incidents stayed on the feed (open duration)
SELECT type, AVG(cleared_at - first_seen) AS avg_open
FROM incidents WHERE cleared_at IS NOT NULL
GROUP BY type ORDER BY avg_open DESC;

-- Monthly trend in ambulance call-outs
SELECT date_trunc('month', time_of_call) AS month, COUNT(*)
FROM incidents WHERE agency_bucket = 'ambulance'
GROUP BY month ORDER BY month;
```

> Data note: the archive captures what's on the public feed, sampled every
> 60s. An incident that opens and closes within a single 60s gap won't be
> recorded, and `time_of_call` comes from the feed itself. It's a rich
> indicative dataset, not an official CAD export.

- **Page says "Not found" on every URL, including `/healthz`.**
  Traffic isn't reaching the app — it's a port issue, not the code. Check
  Build = **Dockerfile** and the public port = **3000**.

- **Site loads but live numbers show "—" or "cannot reach server".**
  Give it 60–90 seconds after first boot. If it persists, open
  `/api/tally` directly: if that returns JSON, the page is fine and just
  needs a refresh; if it errors, check the service logs.

- **Counts reset after a redeploy.**
  The `/data` volume isn't mounted (or the mount path isn't exactly
  `/data`). Re-check Step 5.

- **"upstream connect error… connection refused" right after deploy.**
  The container is running but nothing is listening on the port — the app
  crashed on startup. The usual cause is a stale Docker build cache that
  skipped installing `pg` after it was added. Fix: in Northflank, trigger a
  **rebuild without cache** (or push any commit to bust the cache). The
  Dockerfile now verifies `pg` at build time, so a broken install fails the
  build loudly instead of shipping a crashing image; and the app is now
  hardened to bind the port even if the database module can't load at all.

- **`/healthz` shows `"archiving":false`.**
  The database isn't connected. Check that `DATABASE_URL` is set on the
  service (Step 5b) and points at the Postgres addon, and that the addon is
  running. The site and counter work regardless — only archiving pauses.

- **Free tier note.** Northflank's free tier doesn't force-sleep, which is
  why the counter keeps polling 24/7. If you ever see the service paused or
  restarting under load, the `/data` volume means the counts recover rather
  than reset.

---

## Attribution / before you publish

- Replace the Facebook handle (`facebook.com/AmbosACT`) and any placeholder
  links in `public/index.html` with the campaign's real channels.
- Update the footer authorisation line to the correct legal wording before
  any political distribution.
- Live incident figures come from the ESA public feed (CC BY 4.0); the RoGS
  chart figures are attributed inline on the page.
