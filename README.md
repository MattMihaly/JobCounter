# ESA ACT Incident Tally

A rolling 24-hour counter of ACT emergency incidents, split into **ambulance**
(ACTAS) and **fire** (ACTF&R / RFS) responses, styled like the ESA
"incidents attended today" graphic.

It polls the official ACT ESA GeoRSS feed every 60 seconds and counts each
incident once by its CAD number, over a rolling 24h window. Everything —
server, dashboard, and API — is in a single `server.js` with **no npm
dependencies and no separate folders**, so there is nothing extra that can
fail to deploy.

Data source: `http://esa.act.gov.au/feeds/currentincidents.xml`
(CC BY 4.0 — attribute to the ACT Emergency Services Agency).

## Files in this repo

| File | Purpose |
|------|---------|
| `server.js` | The whole app: poller + dashboard + API. |
| `package.json` | Name, `start` script, Node engine. |
| `Dockerfile` | Pins port 3000 for clean container deploys. |
| `.dockerignore` / `.gitignore` | Keep build context and repo tidy. |
| `README.md` | This file. |

Put all of these at the **root** of the repo (not in a subfolder).

## Run locally

Requires Node 18+.

```bash
npm start            # or: node server.js
```

Open <http://localhost:3000>.

## Deploy on Northflank (free tier, no sleep)

1. Push these files to a GitHub repo (everything at the root).
2. Northflank → **Create new → Service → Combined service**; connect the repo
   and pick your branch.
3. **Build options → Dockerfile** (NOT Buildpack). Dockerfile path: `/Dockerfile`.
4. **Networking / Ports**: confirm a **public HTTP port 3000** (auto-detected
   from the Dockerfile's `EXPOSE 3000`). Add it manually if missing.
5. *(Optional, for a tally that survives redeploys)* **Advanced → Volumes**:
   add a persistent volume mounted at **`/data`**.
6. Deploy. You get a `*.code.run` HTTPS URL in ~2 minutes.

### Verify

- `https://your-url.code.run/healthz` → `{"status":"ok", ...}`
- `https://your-url.code.run/` → the dashboard
- `https://your-url.code.run/api/tally` → JSON counts

If `/healthz` returns "Not found", traffic isn't reaching the app — that's a
**port mismatch**, not a code issue. Check that Build option is **Dockerfile**
and the **public port is 3000**. Those two cover virtually every failed Node
deploy.

## Caveat

The public feed is a live "currently active" snapshot. An incident that opens
and closes entirely within the 60-second gap between polls is missed, so this
is a close **lower bound**, not an audited count — the ESA's own CAD-derived
figure will run slightly higher.
