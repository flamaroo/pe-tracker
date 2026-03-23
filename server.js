/**
 * PE Tracker — Backend Server
 * ===========================
 * Stack: Node.js + Express + PostgreSQL
 *
 * Setup:
 *   npm install express cors pg dotenv express-rate-limit morgan
 *
 * .env file:
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   DATABASE_URL=postgresql://user:pass@host:5432/dbname
 *   PORT=3000
 *   CACHE_TTL_DAYS=7
 *   NODE_ENV=production
 */

import express from 'express';
import cors from 'cors';
import pg from 'pg';
import { rateLimit } from 'express-rate-limit';
import morgan from 'morgan';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT          = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DATABASE_URL  = process.env.DATABASE_URL;
const CACHE_TTL     = parseInt(process.env.CACHE_TTL_DAYS || '7', 10);
const IS_PROD       = process.env.NODE_ENV === 'production';

if (!ANTHROPIC_KEY) throw new Error('Missing ANTHROPIC_API_KEY in environment');
if (!DATABASE_URL)  throw new Error('Missing DATABASE_URL in environment');

// ─── Database ─────────────────────────────────────────────────────────────────

const db = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: IS_PROD ? { rejectUnauthorized: false } : false,
  max: 10,                 // max connections in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

db.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

/**
 * Run all migrations to set up the schema.
 * Safe to call on every startup — uses IF NOT EXISTS.
 */
async function runMigrations() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS pe_lookups (
      id          SERIAL PRIMARY KEY,
      query       TEXT NOT NULL,
      mode        TEXT NOT NULL CHECK (mode IN ('company','industry','firm','recent')),
      results     JSONB NOT NULL,
      hit_count   INT NOT NULL DEFAULT 1,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id          SERIAL PRIMARY KEY,
      lookup_id   INT NOT NULL REFERENCES pe_lookups(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      sector      TEXT,
      pe_firm     TEXT,
      deal_value  TEXT,
      acquired    TEXT,
      confidence  TEXT CHECK (confidence IN ('High','Medium','Low')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS search_log (
      id          SERIAL PRIMARY KEY,
      query       TEXT NOT NULL,
      mode        TEXT NOT NULL,
      cache_hit   BOOLEAN NOT NULL DEFAULT FALSE,
      result_count INT,
      duration_ms INT,
      ip          TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Indexes for fast lookups
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_pe_lookups_query_mode
      ON pe_lookups (query, mode);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_companies_pe_firm
      ON companies (pe_firm);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_companies_name
      ON companies USING gin (to_tsvector('english', name));
  `);

  console.log('[DB] Migrations complete');
}

// ─── Anthropic Helpers ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a private equity research assistant with access to web search.
The user wants to know about PE firm ownership of companies.

Search the web thoroughly for accurate, up-to-date information.
Return ONLY a JSON object with this exact structure — no markdown, no preamble, no trailing text:

{
  "query": "the original query",
  "companies": [
    {
      "company": "Company Name",
      "sector": "Industry/Sector",
      "pe_firm": "PE Firm Name",
      "deal_value": "$X billion or Unknown",
      "acquired": "Year or Month Year or Unknown",
      "confidence": "High|Medium|Low"
    }
  ],
  "notes": "Any important caveats or research notes in 1-2 sentences."
}

Confidence levels:
- High: confirmed by multiple reliable sources (WSJ, Bloomberg, Reuters, SEC filings, press releases)
- Medium: reported by one credible source
- Low: inferred or from secondary/aggregator sources

Return ONLY valid JSON.`;

const MODE_PROMPTS = {
  company:  (q) => `Find private equity ownership information for the specific company: "${q}". Return which PE firm owns or has acquired it, the deal value, and acquisition date.`,
  industry: (q) => `List companies in the "${q}" industry or sector that are currently owned by private equity firms. Include deal values and acquisition dates.`,
  firm:     (q) => `List current portfolio companies owned by the PE firm "${q}". Include deal values and acquisition dates for each portfolio company.`,
  recent:   (q) => `Find notable private equity deals and acquisitions from ${q}. List the companies acquired, the acquiring PE firm, and the deal value.`,
};

/**
 * Call the Anthropic API with web search enabled.
 * Returns parsed JSON result.
 */
async function callAnthropic(query, mode) {
  const userPrompt = MODE_PROMPTS[mode]?.(query);
  if (!userPrompt) throw new Error(`Unknown search mode: ${mode}`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (response.status === 429) {
      if (attempt < 3) {
        const wait = attempt * 10000; // 10s, then 20s
        console.log(`[Anthropic] 429 rate limit, retrying in ${wait/1000}s...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw new Error('Rate limited by Anthropic — please try again in a minute');
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${body}`);
    }

    const data = await response.json();
    const textBlocks = data.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const jsonMatch = textBlocks.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object found in Claude response');

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      throw new Error('Failed to parse JSON from Claude response');
    }

    if (!Array.isArray(parsed.companies)) parsed.companies = [];
    return parsed;
  }
}

// ─── Cache Helpers ────────────────────────────────────────────────────────────

async function getCached(query, mode) {
  const { rows } = await db.query(
    `SELECT id, results
       FROM pe_lookups
      WHERE query = $1
        AND mode  = $2
        AND created_at > NOW() - INTERVAL '${CACHE_TTL} days'
      ORDER BY created_at DESC
      LIMIT 1`,
    [query.toLowerCase().trim(), mode]
  );
  return rows[0] || null;
}

async function saveToCache(query, mode, results) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Upsert the lookup row
    const { rows } = await client.query(
      `INSERT INTO pe_lookups (query, mode, results)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [query.toLowerCase().trim(), mode, results]
    );
    const lookupId = rows[0].id;

    // Insert individual company rows for richer querying later
    if (Array.isArray(results.companies) && results.companies.length > 0) {
      const companyValues = results.companies.map((c) => [
        lookupId,
        c.company   || null,
        c.sector    || null,
        c.pe_firm   || null,
        c.deal_value|| null,
        c.acquired  || null,
        c.confidence|| null,
      ]);

      for (const vals of companyValues) {
        await client.query(
          `INSERT INTO companies
             (lookup_id, name, sector, pe_firm, deal_value, acquired, confidence)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          vals
        );
      }
    }

    await client.query('COMMIT');
    return lookupId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function incrementHitCount(lookupId) {
  await db.query(
    `UPDATE pe_lookups
        SET hit_count = hit_count + 1,
            updated_at = NOW()
      WHERE id = $1`,
    [lookupId]
  );
}

async function logSearch({ query, mode, cacheHit, resultCount, durationMs, ip }) {
  await db.query(
    `INSERT INTO search_log (query, mode, cache_hit, result_count, duration_ms, ip)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [query, mode, cacheHit, resultCount, durationMs, ip]
  ).catch((err) => {
    // Non-fatal — don't let logging errors break the request
    console.warn('[DB] Failed to write search_log:', err.message);
  });
}

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();

// Logging
app.use(morgan(IS_PROD ? 'combined' : 'dev'));

// Body parsing
app.use(express.json({ limit: '16kb' }));

// CORS — tighten origins in production
app.use(cors({
  origin: IS_PROD
    ? process.env.ALLOWED_ORIGIN || true   // set ALLOWED_ORIGIN=https://yourdomain.com
    : true,
  methods: ['GET', 'POST'],
}));

// Rate limiting — 30 search requests per minute per IP
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please wait a minute and try again.' },
});

// Serve the frontend from /public
app.use(express.static(join(__dirname, 'public')));

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /api/search
 * Body: { query: string, mode: 'company'|'industry'|'firm'|'recent' }
 * Returns PE ownership data, hitting the cache if available.
 */
app.post('/api/search', searchLimiter, async (req, res) => {
  const start = Date.now();
  const { query, mode } = req.body;

  // Validate
  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return res.status(400).json({ error: 'query must be at least 2 characters' });
  }
  if (!['company', 'industry', 'firm', 'recent'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be one of: company, industry, firm, recent' });
  }

  const cleanQuery = query.trim();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  try {
    // 1 — Check cache
    const cached = await getCached(cleanQuery, mode);
    if (cached) {
      await incrementHitCount(cached.id);
      const duration = Date.now() - start;
      await logSearch({ query: cleanQuery, mode, cacheHit: true, resultCount: cached.results.companies?.length || 0, durationMs: duration, ip });
      return res.json({ ...cached.results, _cache: true, _duration_ms: duration });
    }

    // 2 — Call Anthropic
    const results = await callAnthropic(cleanQuery, mode);

    // 3 — Persist to DB (non-blocking for response speed)
    saveToCache(cleanQuery, mode, results).catch((err) =>
      console.error('[DB] Cache write failed:', err.message)
    );

    const duration = Date.now() - start;
    await logSearch({ query: cleanQuery, mode, cacheHit: false, resultCount: results.companies?.length || 0, durationMs: duration, ip });

    return res.json({ ...results, _cache: false, _duration_ms: duration });

  } catch (err) {
    console.error('[/api/search] Error:', err.message);
    const status = err.message.includes('Anthropic API error 429') ? 429 : 500;
    return res.status(status).json({ error: err.message });
  }
});

/**
 * GET /api/history?limit=20&offset=0
 * Returns the most recent search queries and result counts.
 */
app.get('/api/history', async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '20', 10), 100);
  const offset = parseInt(req.query.offset || '0', 10);

  try {
    const { rows } = await db.query(
      `SELECT
         id,
         query,
         mode,
         hit_count,
         jsonb_array_length(results->'companies') AS result_count,
         created_at
       FROM pe_lookups
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return res.json({ history: rows });
  } catch (err) {
    console.error('[/api/history] Error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch history' });
  }
});

/**
 * GET /api/company/:id
 * Returns a single cached lookup by its DB id.
 */
app.get('/api/company/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const { rows } = await db.query(
      `SELECT id, query, mode, results, hit_count, created_at
         FROM pe_lookups WHERE id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json(rows[0]);
  } catch (err) {
    console.error('[/api/company/:id] Error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch record' });
  }
});

/**
 * GET /api/firms
 * Returns all distinct PE firms seen in the DB, sorted by deal count.
 */
app.get('/api/firms', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT
         pe_firm,
         COUNT(*)        AS deal_count,
         MAX(created_at) AS last_seen
       FROM companies
       WHERE pe_firm IS NOT NULL
       GROUP BY pe_firm
       ORDER BY deal_count DESC
       LIMIT 100`
    );
    return res.json({ firms: rows });
  } catch (err) {
    console.error('[/api/firms] Error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch firms' });
  }
});

/**
 * GET /api/stats
 * High-level stats for a dashboard or health check.
 */
app.get('/api/stats', async (req, res) => {
  try {
    const [lookups, companies, searches, cacheRate] = await Promise.all([
      db.query('SELECT COUNT(*) FROM pe_lookups'),
      db.query('SELECT COUNT(*) FROM companies'),
      db.query('SELECT COUNT(*) FROM search_log'),
      db.query(
        `SELECT
           ROUND(100.0 * SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 1) AS rate
         FROM search_log
         WHERE created_at > NOW() - INTERVAL '24 hours'`
      ),
    ]);

    return res.json({
      total_lookups:    parseInt(lookups.rows[0].count,   10),
      total_companies:  parseInt(companies.rows[0].count, 10),
      total_searches:   parseInt(searches.rows[0].count,  10),
      cache_hit_rate_24h: parseFloat(cacheRate.rows[0].rate || '0'),
    });
  } catch (err) {
    console.error('[/api/stats] Error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

/**
 * DELETE /api/cache/:id
 * Manually bust a cached entry (useful when data goes stale).
 */
app.delete('/api/cache/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const { rowCount } = await db.query('DELETE FROM pe_lookups WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    return res.json({ deleted: true, id });
  } catch (err) {
    console.error('[/api/cache/:id] Error:', err.message);
    return res.status(500).json({ error: 'Failed to delete cache entry' });
  }
});

/**
 * GET /health
 * Simple health check for Railway / Render / uptime monitors.
 */
app.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    return res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch {
    return res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

// 404 fallback — serve index.html for client-side routing
app.use((_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('[Unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function start() {
  try {
    await runMigrations();
    app.listen(PORT, () => {
      console.log(`[server] PE Tracker running on http://localhost:${PORT}`);
      console.log(`[server] Environment: ${IS_PROD ? 'production' : 'development'}`);
      console.log(`[server] Cache TTL: ${CACHE_TTL} days`);
    });
  } catch (err) {
    console.error('[server] Failed to start:', err.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[server] SIGTERM received — shutting down gracefully');
  await db.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[server] SIGINT received — shutting down');
  await db.end();
  process.exit(0);
});

start();
