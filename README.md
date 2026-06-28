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
