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
const STATE_FILE = path.join(__dirname, 'state.json');

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
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(full);
    const mime = { '.html': 'text/html', '.js': 'text/javascript',
                   '.css': 'text/css' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  });
});

loadState();
poll();                              // poll immediately on boot
setInterval(poll, POLL_INTERVAL_MS); // then every 60s

// Start listening, automatically trying the next port if one is in use.
function start(port, attemptsLeft = 10) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.warn(`Port ${port} in use, trying ${port + 1}…`);
      start(port + 1, attemptsLeft - 1);
    } else {
      console.error('Server failed to start:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log('\n  ============================================');
    console.log('   ESA 24h incident tally is running');
    console.log(`   Open:  ${url}`);
    console.log('   Stop:  press Ctrl+C in this terminal');
    console.log('  ============================================\n');
  });
}
start(Number(PORT));
