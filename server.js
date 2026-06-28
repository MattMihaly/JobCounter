/**
 * ESA ACT Incident Tally Server
 * -------------------------------------------------------------
 * Polls the official ACT Emergency Services Agency GeoRSS feed
 * (updated every 60s from the CAD system) and maintains a rolling
 * 24-hour tally of UNIQUE incidents, split by agency.
 *
 * Data source (CC BY 4.0, attribute to ACT ESA):
 *   http://esa.act.gov.au/feeds/currentincidents.xml
 *
 * Why a server and not a browser-only app:
 *   - The feed has no CORS headers, so browser fetch() is blocked.
 *   - A 24h rolling window must survive page refreshes / closed tabs.
 * This process holds the state and exposes it via a tiny JSON API.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const FEED_URL = 'http://esa.act.gov.au/feeds/currentincidents.xml';
const POLL_INTERVAL_MS = 60 * 1000;        // feed updates every 60s
const WINDOW_MS = 24 * 60 * 60 * 1000;     // rolling 24 hours
const PORT = process.env.PORT || 3000;
// STATE_DIR lets you point at a mounted persistent disk on hosts where the
// app's own filesystem is ephemeral (wiped on redeploy/restart). On Render,
// set STATE_DIR to your disk mount path, e.g. /var/data. Falls back to the
// app dir, which still survives plain restarts on most platforms.
const STATE_DIR = process.env.STATE_DIR || __dirname;
const STATE_FILE = path.join(STATE_DIR, 'state.json');

/**
 * seen: Map<cadid, { agency, type, firstSeen, timeOfCall, suburb, title }>
 * We key on cadid (the CAD incident number) so each real incident is
 * counted exactly once, no matter how many polls it appears in.
 * Entries older than 24h (by firstSeen) are pruned.
 */
let seen = new Map();
let lastPoll = null;
let lastError = null;

// ---- persistence so a restart doesn't wipe the running tally ----
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    seen = new Map(raw.seen);
    lastPoll = raw.lastPoll || null;
    console.log(`Loaded ${seen.size} incidents from saved state.`);
  } catch {
    console.log('No prior state; starting fresh.');
  }
}
function saveState() {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ seen: [...seen], lastPoll }),
    );
  } catch (e) {
    console.error('Could not save state:', e.message);
  }
}

// ---- minimal dependency-free fetch ----
function fetchFeed(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchFeed(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// ---- tiny XML extraction (feed is flat & predictable) ----
function parseItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const pick = (tag) => {
      const r = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
      const x = r.exec(block);
      return x ? x[1].replace(/&#xD;|\r/g, '').trim() : '';
    };
    const cadid = pick('cadid') || pick('guid');
    if (!cadid) continue;
    const desc = pick('description');
    const suburb = (/Suburb:\s*(.*)/.exec(desc) || [])[1] || '';
    const timeOfCall = (/Time of Call:\s*(.*)/.exec(desc) || [])[1] || '';
    items.push({
      cadid,
      title: pick('title'),
      type: pick('type'),
      agency: pick('agency'),     // "Ambulance" or "Fire"
      suburb: suburb.trim(),
      timeOfCall: timeOfCall.trim(),
    });
  }
  return items;
}

function prune() {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [id, rec] of seen) {
    if (rec.firstSeen < cutoff) seen.delete(id);
  }
}

async function poll() {
  try {
    const xml = await fetchFeed(FEED_URL);
    const items = parseItems(xml);
    const now = Date.now();
    let added = 0;
    for (const it of items) {
      if (!seen.has(it.cadid)) {
        seen.set(it.cadid, {
          agency: it.agency,
          type: it.type,
          suburb: it.suburb,
          title: it.title,
          timeOfCall: it.timeOfCall,
          firstSeen: now,
        });
        added++;
      }
    }
    prune();
    lastPoll = new Date().toISOString();
    lastError = null;
    saveState();
    console.log(
      `[${lastPoll}] polled: ${items.length} live, +${added} new, ${seen.size} in 24h window`,
    );
  } catch (e) {
    lastError = e.message;
    console.error('Poll failed:', e.message);
  }
}

function buildTally() {
  prune();
  let ambulance = 0, fire = 0, other = 0;
  const byType = {};
  for (const rec of seen.values()) {
    const a = (rec.agency || '').toLowerCase();
    if (a.includes('ambulance')) ambulance++;
    else if (a.includes('fire')) fire++;
    else other++;
    byType[rec.type] = (byType[rec.type] || 0) + 1;
  }
  return {
    windowHours: 24,
    ambulance,
    fire,
    other,
    total: ambulance + fire + other,
    byType,
    lastPoll,
    lastError,
    generatedAt: new Date().toISOString(),
  };
}

// ---- HTTP server: static files + /api/tally ----
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', lastPoll, tracked: seen.size }));
    return;
  }
  if (req.url === '/api/tally') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(buildTally()));
    return;
  }
  let file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const full = path.join(__dirname, 'public', path.normalize(file));
  if (!full.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(full, (err, content) => {
    if (err) {
      // If the dashboard file isn't present in the deployed container
      // (e.g. the public/ folder didn't get included in the build), fall
      // back to a minimal embedded page for the root so the site still
      // works. The API still serves the real data either way.
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(FALLBACK_HTML);
        return;
      }
      res.writeHead(404);
      res.end('Not found: ' + file);
      return;
    }
    const ext = path.extname(full);
    const mime = { '.html': 'text/html', '.js': 'text/javascript',
                   '.css': 'text/css' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  });
});

// Minimal self-contained dashboard used only if public/index.html is absent.
const FALLBACK_HTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ESA Incidents — 24h Tally</title>
<style>
 body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
 background:#f4f6f9;color:#2b2b2b;display:flex;justify-content:center;padding:24px 12px}
 .card{width:100%;max-width:460px;background:#fff;border-radius:14px;overflow:hidden;
 box-shadow:0 8px 30px rgba(0,0,0,.08)}
 .header{background:#2f5f96;color:#fff;padding:30px 24px;text-align:center}
 .header h1{margin:0;font-size:26px;font-weight:800;line-height:1.15}
 .row{display:flex;align-items:center;justify-content:center;gap:16px;padding:26px 0}
 .count{font-size:54px;font-weight:800;min-width:84px;text-align:left;font-variant-numeric:tabular-nums}
 .label{text-align:center;color:#6b7280;font-size:16px;margin:-14px 0 0}
 .divider{height:1px;background:#eef0f3;margin:0 12px}
 .ico{font-size:42px}
 .footer{padding:16px 22px;text-align:center;font-size:11px;color:#6b7280}
</style></head><body>
<div class="card">
 <div class="header"><h1>Emergency incidents<br>attended (last 24h)</h1></div>
 <div class="row"><span class="ico">🚑</span><div class="count" id="amb">–</div></div>
 <p class="label">ambulance responses (ACTAS)</p>
 <div class="divider"></div>
 <div class="row"><span class="ico">🚒</span><div class="count" id="fire">–</div></div>
 <p class="label">fire responses (ACTF&amp;R / RFS)</p>
 <div class="footer" id="status">loading…</div>
</div>
<script>
async function r(){try{const d=await(await fetch('/api/tally',{cache:'no-store'})).json();
amb.textContent=d.ambulance;fire.textContent=d.fire;
const t=d.lastPoll?new Date(d.lastPoll).toLocaleTimeString():'—';
status.textContent=(d.lastError?'feed error':'live')+' · updated '+t+' · '+d.total+' total';
}catch(e){status.textContent='cannot reach server';}}
r();setInterval(r,15000);
</script></body></html>`;

loadState();
poll();                              // poll immediately on boot
setInterval(poll, POLL_INTERVAL_MS); // then every 60s

// Bind to 0.0.0.0 so the app is reachable from outside the container
// (hosts like Northflank route external traffic to the container's public
// interface, not localhost). We listen on EXACTLY process.env.PORT — in a
// hosted container the platform routes to that specific port, so if it's
// taken we must fail loudly rather than silently moving to another port
// (which would leave the platform routing to a port nothing is on, i.e.
// "Not found" on every path).
const HOST = '0.0.0.0';

server.on('error', (err) => {
  console.error('Server failed to start:', err.message);
  process.exit(1);
});

server.listen(Number(PORT), HOST, () => {
  const addr = server.address();
  console.log('\n  ============================================');
  console.log('   ESA 24h incident tally is running');
  console.log(`   Listening on ${HOST}:${addr.port}`);
  console.log(`   Local:  http://localhost:${addr.port}`);
  console.log('   Health: /healthz   API: /api/tally');
  console.log('  ============================================\n');
});
