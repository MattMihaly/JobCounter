/**
 * ESA ACT Incident Tally
 * ============================================================================
 * Polls the official ACT Emergency Services Agency GeoRSS feed and keeps a
 * rolling 24-hour tally of UNIQUE incidents, split into ambulance and fire.
 *
 * Single self-contained file: server + dashboard + API. No npm dependencies,
 * no separate public/ folder (the dashboard HTML is embedded below), so there
 * is nothing extra that can fail to deploy.
 *
 * Data source (CC BY 4.0 — attribute to ACT Emergency Services Agency):
 *   http://esa.act.gov.au/feeds/currentincidents.xml
 *   The ESA updates this feed every 60s straight from the CAD dispatch system.
 *
 * Endpoints:
 *   GET /            → the dashboard
 *   GET /api/tally   → JSON counts
 *   GET /healthz     → health check (used by the host)
 *
 * Hosting notes (lessons baked in):
 *   - Binds 0.0.0.0 on exactly process.env.PORT so the platform's routed port
 *     and the app's listening port always match (mismatch = "Not found").
 *   - Fails loudly if it can't bind — never silently moves to another port.
 *   - STATE_DIR (env) can point at a persistent volume so the 24h window
 *     survives redeploys; defaults to the app dir otherwise.
 * ============================================================================
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const FEED_URL = 'http://esa.act.gov.au/feeds/currentincidents.xml';
const POLL_INTERVAL_MS = 60 * 1000;        // match the feed's 60s cadence
const WINDOW_MS = 24 * 60 * 60 * 1000;     // rolling 24 hours
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const STATE_DIR = process.env.STATE_DIR || __dirname;
const STATE_FILE = path.join(STATE_DIR, 'state.json');

/**
 * seen: Map<cadid, { agency, type, firstSeen }>
 * Keyed on the CAD incident number so each real incident counts once, no
 * matter how many 60s polls it appears in. Pruned once older than 24h.
 */
let seen = new Map();
let lastPoll = null;
let lastError = null;

/**
 * dailyTotals: { [yyyy-mm-dd]: { ambulance, fire, other } }
 * Each NEW incident (first time its cadid is seen) increments the counter for
 * the Canberra calendar date on which it was first seen. This is a permanent
 * running history (not pruned), so the busiest day is the max across it.
 */
let dailyTotals = {};

/* Canberra-local YYYY-MM-DD for a given epoch ms, handling AEST/AEDT. */
function canberraDateKey(ms = Date.now()) {
  // en-CA gives ISO-style YYYY-MM-DD; timeZone handles daylight saving.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',  // ACT observes the same zone as NSW
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

function bucketOf(agency) {
  const a = (agency || '').toLowerCase();
  if (a.includes('ambulance')) return 'ambulance';
  if (a.includes('fire')) return 'fire';
  return 'other';
}

/* ---------- persistence (best-effort) ---------- */
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    seen = new Map(raw.seen);
    lastPoll = raw.lastPoll || null;
    dailyTotals = raw.dailyTotals || {};
    console.log(`Loaded ${seen.size} incidents and ${Object.keys(dailyTotals).length} day(s) of history.`);
  } catch {
    console.log('No prior state; starting fresh.');
  }
}
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      seen: [...seen], lastPoll, dailyTotals,
    }));
  } catch (e) {
    console.error('Could not save state:', e.message);
  }
}

/* ---------- feed fetch (no dependencies, follows redirects) ---------- */
function fetchFeed(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchFeed(res.headers.location));
      }
      if (res.statusCode !== 200) {
        res.resume();
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

/* ---------- parse the flat GeoRSS feed ---------- */
/* Parse an ESA date like "01 May 2013 06:51:26" (Canberra local) to an ISO
 * string. Returns null if absent/unparseable. */
function parseEsaDate(s) {
  if (!s) return null;
  const d = new Date(s + ' GMT+1000'); // ESA timestamps are ACT local
  return isNaN(d) ? null : d.toISOString();
}

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

    // Fields appear both as their own tags and inside <description>. Prefer the
    // dedicated tag, fall back to parsing the description text.
    const desc = pick('description');
    const fromDesc = (label) => {
      const r = new RegExp(label + ':\\s*(.*)', 'i');
      const x = r.exec(desc);
      return x ? x[1].replace(/&#xD;|\r/g, '').trim() : '';
    };

    // GeoRSS point: "<georss:point>-35.2 149.1</georss:point>" or geo:lat/long
    let lat = null, lon = null;
    const pt = /<georss:point>\s*([-\d.]+)\s+([-\d.]+)\s*<\/georss:point>/.exec(block);
    if (pt) { lat = parseFloat(pt[1]); lon = parseFloat(pt[2]); }
    else {
      const la = /<geo:lat>\s*([-\d.]+)\s*<\/geo:lat>/.exec(block);
      const lo = /<geo:long>\s*([-\d.]+)\s*<\/geo:long>/.exec(block);
      if (la) lat = parseFloat(la[1]);
      if (lo) lon = parseFloat(lo[1]);
    }

    const agency = pick('agency') || fromDesc('Agency');
    items.push({
      cadid,
      title:    pick('title'),
      type:     pick('type')   || fromDesc('Type'),
      agency,
      bucket:   bucketOf(agency),
      suburb:   fromDesc('Suburb'),
      location: fromDesc('Location'),
      status:   fromDesc('Status'),
      latitude:  lat,
      longitude: lon,
      timeOfCall: parseEsaDate(fromDesc('Time of Call')),
      updated:    parseEsaDate(fromDesc('Updated')),
    });
  }
  return items;
}

function prune() {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [id, rec] of seen) if (rec.firstSeen < cutoff) seen.delete(id);
}

async function poll() {
  try {
    const xml = await fetchFeed(FEED_URL);
    const items = parseItems(xml);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    let added = 0;
    for (const it of items) {
      if (!seen.has(it.cadid)) {
        seen.set(it.cadid, { agency: it.agency, type: it.type, firstSeen: now });
        added++;
        // Record against the Canberra calendar day for the busiest-day history.
        const day = canberraDateKey(now);
        if (!dailyTotals[day]) dailyTotals[day] = { ambulance: 0, fire: 0, other: 0 };
        dailyTotals[day][bucketOf(it.agency)]++;
      }
    }
    prune();
    lastPoll = nowIso;
    lastError = null;
    saveState();

    // Archive to Postgres (no-op if DB disabled/unreachable; never blocks counter).
    if (db.isReady()) {
      await db.recordBatch(items, nowIso);
      await db.markCleared(items.map((i) => i.cadid), nowIso);
    }

    console.log(`[${lastPoll}] ${items.length} live, +${added} new, ${seen.size} in window`);
  } catch (e) {
    lastError = e.message;
    console.error('Poll failed:', e.message);
  }
}

/* Find the busiest calendar day for a given bucket across all history.
 * Excludes today, since today is still accumulating and isn't a final total. */
function busiestDay(bucket) {
  const today = canberraDateKey();
  let best = null;
  for (const [day, totals] of Object.entries(dailyTotals)) {
    if (day === today) continue;          // don't crown an incomplete day
    const n = totals[bucket] || 0;
    if (n === 0) continue;
    if (!best || n > best.count) best = { date: day, count: n };
  }
  if (!best) return null;
  // Add a human weekday label in Canberra time, e.g. "Tuesday".
  const weekday = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney', weekday: 'long',
  }).format(new Date(best.date + 'T12:00:00Z'));
  return { date: best.date, weekday, count: best.count };
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
    windowHours: 24, ambulance, fire, other,
    total: ambulance + fire + other,
    byType, lastPoll, lastError,
    busiest: {
      ambulance: busiestDay('ambulance'),
      fire: busiestDay('fire'),
    },
    today: canberraDateKey(),
    generatedAt: new Date().toISOString(),
  };
}

/* ---------- HTTP server ---------- */
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok', lastPoll, tracked: seen.size, archiving: db.isReady(),
    }));
    return;
  }
  if (url === '/api/tally') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(buildTally()));
    return;
  }
  if (url === '/api/stats') {
    db.stats().then((s) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(s));
    }).catch((e) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }
  if (url === '/counter') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML);
    return;
  }
  if (url === '/' || url === '/index.html') {
    // Serve the campaign page from public/index.html. If it's missing for any
    // reason, fall back to the embedded counter dashboard so the site never 404s.
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(err ? DASHBOARD_HTML : data);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

/* ---------- the dashboard, embedded so nothing can fail to deploy ---------- */
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>ESA Incidents — 24h Tally</title>
<style>
  :root { --esa-blue:#2f5f96; --ink:#2b2b2b; --muted:#6b7280; --bg:#f4f6f9; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    background:var(--bg); color:var(--ink); display:flex; justify-content:center; padding:24px 12px; }
  .card { width:100%; max-width:460px; background:#fff; border-radius:14px; overflow:hidden;
    box-shadow:0 8px 30px rgba(0,0,0,.08); }
  .header { background:var(--esa-blue); color:#fff; padding:30px 24px; text-align:center; }
  .header h1 { margin:0; font-size:28px; line-height:1.15; font-weight:800; letter-spacing:-.5px; }
  .header p { margin:8px 0 0; font-size:13px; opacity:.85; font-weight:500; }
  .rows { padding:24px 24px 6px; }
  .row { display:flex; align-items:center; justify-content:center; gap:18px; padding:24px 0; }
  .row svg { width:62px; height:62px; flex:0 0 auto; fill:#1f1f1f; }
  .count { font-size:56px; font-weight:800; min-width:86px; text-align:left;
    font-variant-numeric:tabular-nums; transition:color .2s; }
  .label { text-align:center; color:var(--muted); font-size:16px; margin:-12px 0 0; }
  .divider { height:1px; background:#eef0f3; margin:0 12px; }
  .footer { padding:16px 22px 20px; text-align:center; font-size:11px; color:var(--muted); line-height:1.5; }
  .footer a { color:var(--esa-blue); text-decoration:none; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#16a34a;
    margin-right:5px; vertical-align:middle; }
  .dot.stale { background:#d97706; } .dot.err { background:#dc2626; }
  .flash { animation:flash .9s ease; }
  @keyframes flash { 0% { color:#16a34a; } 100% { color:var(--ink); } }
  .record { margin:8px 16px 4px; padding:16px 18px; background:#f7f9fc;
    border:1px solid #e7ecf3; border-radius:12px; }
  .record-title { font-size:12px; font-weight:700; letter-spacing:.04em;
    text-transform:uppercase; color:var(--esa-blue); margin-bottom:10px; }
  .record-row { display:flex; align-items:baseline; justify-content:space-between;
    padding:4px 0; }
  .record-svc { font-size:14px; color:var(--ink); }
  .record-val { font-size:15px; font-weight:700; font-variant-numeric:tabular-nums;
    color:var(--ink); }
  .record-note { margin-top:10px; font-size:10px; color:var(--muted); line-height:1.45; }
</style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>Emergency incidents<br>attended (last 24h)</h1>
      <p>ACT Emergency Services Agency · rolling tally</p>
    </div>
    <div class="rows">
      <div class="row">
        <svg viewBox="0 0 640 512" aria-hidden="true"><path d="M624 352h-16V243.9c0-12.7-5.1-24.9-14.1-33.9L494 110.1c-9-9-21.2-14.1-33.9-14.1H416V48c0-26.5-21.5-48-48-48H48C21.5 0 0 21.5 0 48v320c0 26.5 21.5 48 48 48h16c0 53 43 96 96 96s96-43 96-96h128c0 53 43 96 96 96s96-43 96-96h48c8.8 0 16-7.2 16-16v-32c0-8.8-7.2-16-16-16zM160 464c-26.5 0-48-21.5-48-48s21.5-48 48-48 48 21.5 48 48-21.5 48-48 48zm320 0c-26.5 0-48-21.5-48-48s21.5-48 48-48 48 21.5 48 48-21.5 48-48 48zM416 160h44.1l85.9 85.9V256H416v-96zM276 188c0 6.6-5.4 12-12 12h-40v40c0 6.6-5.4 12-12 12h-24c-6.6 0-12-5.4-12-12v-40h-40c-6.6 0-12-5.4-12-12v-24c0-6.6 5.4-12 12-12h40v-40c0-6.6 5.4-12 12-12h24c6.6 0 12 5.4 12 12v40h40c6.6 0 12 5.4 12 12v24z"/></svg>
        <div class="count" id="amb">–</div>
      </div>
      <p class="label">ambulance responses (ACTAS)</p>
      <div class="divider"></div>
      <div class="row">
        <svg viewBox="0 0 640 512" aria-hidden="true"><path d="M64 160h32v96H32v-96c0-17.7 14.3-32 32-32h0c0 17.7 0 32 0 32zm512-32c17.7 0 32 14.3 32 32v32h-64v-32c0-17.7 14.3-32 32-32zM48 96C21.5 96 0 117.5 0 144v224c0 8.8 7.2 16 16 16h32c0 53 43 96 96 96s96-43 96-96h128c0 53 43 96 96 96s96-43 96-96h32c8.8 0 16-7.2 16-16v-96c0-35.3-28.7-64-64-64h-32V96c0-17.7-14.3-32-32-32H272c-17.7 0-32 14.3-32 32v32H48zm96 304c-26.5 0-48-21.5-48-48s21.5-48 48-48 48 21.5 48 48-21.5 48-48 48zm320 0c-26.5 0-48-21.5-48-48s21.5-48 48-48 48 21.5 48 48-21.5 48-48 48z"/></svg>
        <div class="count" id="fire">–</div>
      </div>
      <p class="label">fire responses (ACTF&amp;R / RFS)</p>
    </div>
    <div class="record" id="record">
      <div class="record-title">Busiest day on record</div>
      <div class="record-row">
        <span class="record-svc">🚑 Ambulance</span>
        <span class="record-val" id="recAmb">—</span>
      </div>
      <div class="record-row">
        <span class="record-svc">🚒 Fire</span>
        <span class="record-val" id="recFire">—</span>
      </div>
      <div class="record-note" id="recNote"></div>
    </div>
    <div class="footer">
      <span id="status"><span class="dot"></span>connecting…</span><br>
      Source: <a href="https://esa.act.gov.au/?fullmap=true" target="_blank" rel="noopener">ACT ESA incidents feed</a> (CC BY 4.0).
      Counts unique incidents in a rolling 24h window.
    </div>
  </div>
<script>
  let pAmb=null,pFire=null;
  function flash(el){el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash');}
  function fmtRecord(r){
    if(!r) return '—';
    return r.count+' · '+r.weekday+' '+r.date;
  }
  async function refresh(){
    const s=document.getElementById('status');
    try{
      const d=await(await fetch('/api/tally',{cache:'no-store'})).json();
      const amb=document.getElementById('amb'),fire=document.getElementById('fire');
      amb.textContent=d.ambulance; fire.textContent=d.fire;
      if(pAmb!==null&&d.ambulance!==pAmb)flash(amb);
      if(pFire!==null&&d.fire!==pFire)flash(fire);
      pAmb=d.ambulance; pFire=d.fire;
      // busiest-day record
      const b=d.busiest||{};
      document.getElementById('recAmb').textContent=fmtRecord(b.ambulance);
      document.getElementById('recFire').textContent=fmtRecord(b.fire);
      const note=document.getElementById('recNote');
      if(!b.ambulance&&!b.fire){
        note.textContent='Record builds from full days observed since launch (today excluded while in progress).';
      } else { note.textContent='Highest single-day total per service since launch. Today excluded until complete.'; }
      let cls='dot',txt='live';
      if(d.lastError){cls+=' err';txt='feed error — last good data';}
      else if(d.lastPoll){const age=(Date.now()-new Date(d.lastPoll))/1000;
        if(age>180){cls+=' stale';txt='data stale';}}
      const t=d.lastPoll?new Date(d.lastPoll).toLocaleTimeString():'—';
      s.innerHTML='<span class="'+cls+'"></span>'+txt+' · updated '+t+' · '+d.total+' total';
    }catch(e){ s.innerHTML='<span class="dot err"></span>cannot reach server'; }
  }
  refresh(); setInterval(refresh,15000);
</script>
</body>
</html>`;

/* ---------- boot ---------- */
loadState();
// Initialise the database (optional). We don't await — if it connects, the
// next poll picks it up; if it doesn't, the counter runs regardless.
db.init().then((ok) => {
  if (ok) console.log('Archiving live incidents to PostgreSQL.');
});
poll();
setInterval(poll, POLL_INTERVAL_MS);

server.on('error', (err) => {
  console.error('Server failed to start:', err.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log('\n  ============================================');
  console.log('   ESA 24h incident tally is running');
  console.log(`   Listening on ${HOST}:${PORT}`);
  console.log('   Routes: /   /api/tally   /healthz');
  console.log('  ============================================\n');
});
