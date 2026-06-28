/**
 * db.js — optional PostgreSQL archiving for the ESA incident tracker.
 *
 * Captures every unique incident as a row, plus a log of status changes over
 * time, so the data can be interrogated later (common suburbs, time of day,
 * incident type trends, how long incidents stay open, etc.).
 *
 * Designed to be OPTIONAL and NON-BLOCKING: if DATABASE_URL is unset or the
 * database is unreachable, the app logs a warning and keeps running — the live
 * counter and busiest-day record (file-backed) are unaffected. Archiving simply
 * pauses until the database is back.
 *
 * Data source: ACT ESA current-incidents GeoRSS feed (CC BY 4.0).
 */

'use strict';

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://_920f994124055248:_44fcf46755715bfecbf6ae6c6b86ca@primary.esa-count-rss--y8slbvbfd25z.addon.code.run:5432/_4d2f49ccf797?sslmode=require';
let pool = null;
let ready = false;

/* Northflank/managed Postgres usually requires SSL. Allow opting out locally
 * with PGSSL=disable. */
function sslConfig() {
  if (process.env.PGSSL === 'disable') return false;
  return { rejectUnauthorized: false };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS incidents (
  cadid         TEXT PRIMARY KEY,
  title         TEXT,
  type          TEXT,
  agency        TEXT,
  agency_bucket TEXT,            -- 'ambulance' | 'fire' | 'other'
  suburb        TEXT,
  location      TEXT,
  latitude      DOUBLE PRECISION,
  longitude     DOUBLE PRECISION,
  time_of_call  TIMESTAMPTZ,     -- when the call came in (from feed)
  first_seen    TIMESTAMPTZ NOT NULL,  -- when our poller first saw it
  last_seen     TIMESTAMPTZ NOT NULL,  -- most recent poll it appeared in
  last_status   TEXT,
  last_updated  TIMESTAMPTZ,     -- feed's own "Updated" timestamp
  cleared_at    TIMESTAMPTZ      -- first time it dropped off the live feed
);

CREATE INDEX IF NOT EXISTS idx_incidents_suburb       ON incidents (suburb);
CREATE INDEX IF NOT EXISTS idx_incidents_agency_bucket ON incidents (agency_bucket);
CREATE INDEX IF NOT EXISTS idx_incidents_type         ON incidents (type);
CREATE INDEX IF NOT EXISTS idx_incidents_time_of_call ON incidents (time_of_call);
CREATE INDEX IF NOT EXISTS idx_incidents_first_seen   ON incidents (first_seen);

CREATE TABLE IF NOT EXISTS incident_status_log (
  id          BIGSERIAL PRIMARY KEY,
  cadid       TEXT NOT NULL,
  status      TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_status_log_cadid ON incident_status_log (cadid);
`;

async function init() {
  if (!DATABASE_URL) {
    console.log('No DATABASE_URL set — incident archiving disabled (counter still works).');
    return false;
  }
  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: sslConfig(),
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000,
    });
    pool.on('error', (e) => console.error('PG pool error:', e.message));
    await pool.query(SCHEMA);
    ready = true;
    console.log('PostgreSQL connected — incident archiving enabled.');
    return true;
  } catch (e) {
    console.error('PostgreSQL init failed (archiving disabled):', e.message);
    ready = false;
    return false;
  }
}

function isReady() { return ready; }

/**
 * Upsert one batch of incidents currently on the feed.
 * `items` is an array of normalised incident objects (see normaliseItem in
 * server.js). `nowIso` is the poll time. Inserts new incidents, updates
 * last_seen/status on existing ones, and logs status changes.
 */
async function recordBatch(items, nowIso) {
  if (!ready || !pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const it of items) {
      // Has the status changed since we last saw it? (for the status log)
      const prev = await client.query(
        'SELECT last_status FROM incidents WHERE cadid = $1', [it.cadid]
      );
      const prevStatus = prev.rows[0] ? prev.rows[0].last_status : null;

      await client.query(
        `INSERT INTO incidents
           (cadid, title, type, agency, agency_bucket, suburb, location,
            latitude, longitude, time_of_call, first_seen, last_seen,
            last_status, last_updated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13)
         ON CONFLICT (cadid) DO UPDATE SET
           last_seen    = EXCLUDED.last_seen,
           last_status  = EXCLUDED.last_status,
           last_updated = EXCLUDED.last_updated,
           -- backfill any fields that were empty on first insert
           suburb       = COALESCE(incidents.suburb, EXCLUDED.suburb),
           location     = COALESCE(incidents.location, EXCLUDED.location),
           latitude     = COALESCE(incidents.latitude, EXCLUDED.latitude),
           longitude    = COALESCE(incidents.longitude, EXCLUDED.longitude),
           time_of_call = COALESCE(incidents.time_of_call, EXCLUDED.time_of_call)`,
        [it.cadid, it.title, it.type, it.agency, it.bucket, it.suburb,
         it.location, it.latitude, it.longitude, it.timeOfCall, nowIso,
         it.status, it.updated]
      );

      if (it.status && it.status !== prevStatus) {
        await client.query(
          'INSERT INTO incident_status_log (cadid, status, observed_at) VALUES ($1,$2,$3)',
          [it.cadid, it.status, nowIso]
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('recordBatch failed:', e.message);
  } finally {
    client.release();
  }
}

/**
 * Mark incidents as cleared once they drop off the live feed.
 * `liveCadids` is the set of cadids currently on the feed; any incident not in
 * that set, still without a cleared_at, gets stamped now.
 */
async function markCleared(liveCadids, nowIso) {
  if (!ready || !pool) return;
  try {
    if (liveCadids.length === 0) {
      await pool.query(
        'UPDATE incidents SET cleared_at = $1 WHERE cleared_at IS NULL', [nowIso]
      );
    } else {
      await pool.query(
        `UPDATE incidents SET cleared_at = $1
           WHERE cleared_at IS NULL AND cadid <> ALL($2::text[])`,
        [nowIso, liveCadids]
      );
    }
  } catch (e) {
    console.error('markCleared failed:', e.message);
  }
}

/* A few ready-made analytics queries, exposed via /api/stats. */
async function stats() {
  if (!ready || !pool) return { enabled: false };
  const out = { enabled: true };
  try {
    const total = await pool.query('SELECT COUNT(*)::int AS n FROM incidents');
    out.totalArchived = total.rows[0].n;

    const suburbs = await pool.query(
      `SELECT suburb, COUNT(*)::int AS n FROM incidents
        WHERE suburb IS NOT NULL AND suburb <> ''
        GROUP BY suburb ORDER BY n DESC LIMIT 10`
    );
    out.topSuburbs = suburbs.rows;

    const byHour = await pool.query(
      `SELECT EXTRACT(HOUR FROM time_of_call)::int AS hour, COUNT(*)::int AS n
         FROM incidents WHERE time_of_call IS NOT NULL
        GROUP BY hour ORDER BY hour`
    );
    out.byHour = byHour.rows;

    const byType = await pool.query(
      `SELECT type, COUNT(*)::int AS n FROM incidents
        WHERE type IS NOT NULL AND type <> ''
        GROUP BY type ORDER BY n DESC LIMIT 15`
    );
    out.topTypes = byType.rows;

    const byBucket = await pool.query(
      `SELECT agency_bucket, COUNT(*)::int AS n FROM incidents
        GROUP BY agency_bucket ORDER BY n DESC`
    );
    out.byAgency = byBucket.rows;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

module.exports = { init, isReady, recordBatch, markCleared, stats };
