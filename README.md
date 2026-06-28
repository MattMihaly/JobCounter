# ESA ACT Incident Tally

A rolling 24-hour counter of ACT emergency incidents, split into
**ambulance** (ACTAS) and **fire** (ACTF&R / RFS) responses, styled like
the ESA "incidents attended today" graphic.

## What it does

- Polls the official **ACT ESA GeoRSS feed** every 60 seconds
  (`http://esa.act.gov.au/feeds/currentincidents.xml`), which the ESA
  updates every 60s straight from the CAD dispatch system.
- Counts each incident **once** using its CAD incident number (`cadid`),
  so an incident that stays open for hours isn't double-counted.
- Keeps a **rolling 24-hour window** — incidents drop off 24h after they
  were first seen.
- Serves a live dashboard at `http://localhost:3000`.

## Why it needs to run as a small server (not just a webpage)

1. The ESA feed sends **no CORS headers**, so a browser page on another
   origin can't fetch it directly. The Node process fetches it server-side.
2. A *true* 24-hour rolling tally has to keep running even when no browser
   tab is open. The server holds that state (and saves it to `state.json`,
   so a restart doesn't lose the count).

## Run it in VS Code (one click)

This is a **Node server**, not a static site, so **VS Code Live Server will
not run it** — Live Server only serves static files to the browser and has
no way to execute `server.js`. Use one of these instead:

**Easiest — press `F5`.** With this folder open in VS Code, hit `F5`
(Run → Start Debugging). The included `.vscode/launch.json` boots the
server in the integrated terminal. The terminal prints the URL to open
(e.g. `http://localhost:3000`).

**Or the terminal.** Open a terminal in this folder (`` Ctrl+` ``) and run:

```bash
npm start
```

(equivalent to `node server.js`).

**Or the task menu.** `Ctrl+Shift+P` → *Tasks: Run Task* →
*Start ESA tally server*.

Then open the printed URL in your browser. To stop, press `Ctrl+C` in the
terminal (or the stop button if you started with `F5`).

> If port 3000 is busy the server now automatically moves to 3001, 3002, …
> and prints whichever port it actually used — always open the URL shown in
> the terminal.

Requires Node.js installed (any recent version — tested on v22). Check with
`node -v`; if it's missing, install from <https://nodejs.org>.

To keep it running unattended 24/7, use a process manager, e.g.:

```bash
npx pm2 start server.js --name esa-tally
```

## Deploying to an always-on host (true 24/7 tally)

**GitHub Pages cannot run this** — Pages serves static files only and never
runs Node, so there's no process to poll the feed when no browser is open.
You need a host that runs a Node process continuously.

The catch in 2026: most "free" tiers **sleep after ~15 minutes idle**, and a
sleeping process stops polling — which freezes the 24h tally. So:

- **Best (≈US$7/mo): Render Starter or Railway Hobby.** Never sleeps, just
  runs. A `render.yaml` blueprint is included — in Render, choose
  *New + → Blueprint* and point it at your repo. It provisions a persistent
  disk (`/var/data`) so the rolling window survives restarts.
- **Free but doesn't sleep: Northflank's free tier** is the one mainstream
  free option without forced sleep. See the step-by-step below.

### Deploying to Northflank (free, no sleep)

A `Dockerfile` is included specifically to make this deploy cleanly on
Northflank. Using the Dockerfile (rather than buildpack auto-detection)
removes the most common cause of failed deploys: a mismatch between the
port the platform routes to and the port the app actually listens on. The
Dockerfile pins both to **3000**.

Steps:

1. Push this folder to a GitHub repo.
2. In Northflank: **Create new → Service → Combined service** (build +
   deploy from the same repo).
3. Connect your GitHub repo and pick the branch.
4. Under **Build options**, choose **Dockerfile** (not Buildpack). Leave the
   Dockerfile path as `/Dockerfile`.
5. Under **Networking / Ports**, Northflank should auto-detect **port 3000**
   from the Dockerfile's `EXPOSE 3000` and mark it **public** (HTTP). If it
   doesn't, add a public HTTP port `3000` manually.
6. **(For the persistent 24h tally)** Under **Advanced → Volumes**, add a
   persistent volume mounted at **`/data`**. The Dockerfile already sets
   `STATE_DIR=/data`, so the rolling window survives redeploys. Skip this
   and the tally simply resets on each redeploy (it still works otherwise).
7. Deploy. Northflank builds the image and gives you a `*.code.run` HTTPS
   URL in a couple of minutes. Open it; `/healthz` should return
   `{"status":"ok"}`.

If a deploy ever fails, the two things to check first are: build option is
set to **Dockerfile**, and the **public port is 3000**. Those two cover the
overwhelming majority of Node deploy failures on any container host.
- **Free with a workaround: Render Free** ($0) sleeps after 15 min. Change
  `plan: starter` to `plan: free` in `render.yaml`, then run an external
  uptime pinger (e.g. UptimeRobot) hitting `/healthz` every ~10 min to keep
  it awake. Functional but fragile, and a gap during sleep loses incidents.

All of these read `process.env.PORT` automatically (the server already
honours it) and the `/healthz` endpoint is provided for platform health
checks.

### Persistence note

On hosts with **ephemeral disks** (most free tiers), the local `state.json`
is wiped on every redeploy, so a deploy resets the tally. Set the
`STATE_DIR` env var to a mounted persistent disk to avoid this (the included
`render.yaml` does this for you). Without a persistent disk the tally still
survives ordinary restarts on most platforms, just not redeploys.

## API

`GET /api/tally` returns:

```json
{
  "windowHours": 24,
  "ambulance": 12,
  "fire": 3,
  "other": 0,
  "total": 15,
  "byType": { "AMBULANCE RESPONSE": 12, "HAZARD REDUCTION BURN": 2 },
  "lastPoll": "2026-06-28T07:43:00.000Z"
}
```

## Important caveats (clinical-grade honesty)

- This counts incidents **present on the public feed**, which is a live
  "currently active" snapshot. An incident that opens *and closes* entirely
  within the 60s gap between two polls would be missed. For a busy ambulance
  service this means the tally is a **close lower-bound**, not an audited
  count. The ESA's own "attended today" figure comes from CAD directly and
  is authoritative; this app approximates it from the public feed.
- The feed is licensed **CC BY 4.0** — attribute to the ACT Emergency
  Services Agency (already shown in the dashboard footer).
- "Fire" in the feed's `agency` field covers ACTF&R and RFS responses and
  includes hazard reduction burns; adjust the bucketing in `buildTally()`
  if you want to exclude planned burns.
