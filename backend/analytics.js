// ============================================================
// Medical Premium Illustrator — Usage Analytics (Phase 4)
// ============================================================
//
// Answers "how many illustrations, for which product and tier, by which
// agent, over time" — and nothing more.
//
// PRIVACY, by design: an analytics event holds the product, the plan
// tier, the verified agent's token, and a timestamp. It deliberately
// holds NO client information — no name, no age, no family details, no
// premium amount. TERMS.md commits that client data isn't retained, and
// there is a test asserting that a client's details never reach this
// table.
//
// WHAT A "COUNT" MEANS: one event is recorded each time an agent
// generates an illustration. An agent who regenerates for the same client
// counts twice — this measures system usage, not number of distinct
// clients (which, by design, isn't knowable).

const db = require('./db.js');

// Kenya is UTC+3 all year (no daylight saving). Day buckets are computed
// in East Africa Time so "today" matches the agent's actual day, rather
// than rolling over at 3 a.m. local time as UTC would.
const TZ_OFFSET_HOURS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

function recordIllustration({ product, tierId, tierLabel, agentToken }) {
  db.prepare(`
    INSERT INTO illustration_events (product, tier_id, tier_label, agent_token, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(product, tierId || null, tierLabel || null, agentToken || null, new Date().toISOString());
}

function eatDateString(ms) {
  return new Date(ms + TZ_OFFSET_HOURS * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function clampDays(days) {
  const n = Math.floor(Number(days));
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.min(n, 365);
}

function getSummary({ days } = {}) {
  const windowDays = clampDays(days);
  const since = new Date(Date.now() - windowDays * DAY_MS).toISOString();

  const total = db.prepare('SELECT COUNT(*) AS n FROM illustration_events WHERE created_at >= ?').get(since).n;

  const byProduct = db.prepare(`
    SELECT product, COUNT(*) AS count FROM illustration_events
    WHERE created_at >= ? GROUP BY product ORDER BY count DESC, product ASC
  `).all(since).map(r => ({ product: r.product, count: r.count }));

  const byTier = db.prepare(`
    SELECT product, COALESCE(tier_label, '(not recorded)') AS tier_label, COUNT(*) AS count
    FROM illustration_events WHERE created_at >= ?
    GROUP BY product, tier_label ORDER BY count DESC, product ASC, tier_label ASC
  `).all(since).map(r => ({ product: r.product, tier: r.tier_label, count: r.count }));

  // Identity is resolved from the agents table, falling back to the
  // acceptance history. That fallback matters: when an agent is revoked
  // their agents row is deleted, but their past illustrations should
  // still be attributable to who they were.
  const byAgent = db.prepare(`
    SELECT e.agent_token AS token, COUNT(*) AS count,
      COALESCE(a.agent_name, (SELECT ac.agent_name FROM acceptances ac WHERE ac.agent_token = e.agent_token ORDER BY ac.id DESC LIMIT 1)) AS name,
      COALESCE(a.phone, (SELECT ac.phone FROM acceptances ac WHERE ac.agent_token = e.agent_token ORDER BY ac.id DESC LIMIT 1)) AS phone,
      CASE WHEN a.phone IS NULL THEN 0 ELSE 1 END AS active
    FROM illustration_events e
    LEFT JOIN agents a ON a.agent_token = e.agent_token
    WHERE e.created_at >= ?
    GROUP BY e.agent_token ORDER BY count DESC
  `).all(since).map(r => ({
    name: r.name || '(unknown agent)',
    phone: r.phone || null,
    active: !!r.active,
    count: r.count,
  }));

  // Per-day series in East Africa Time, zero-filled so quiet days show as
  // 0 instead of silently vanishing from a chart.
  const dayRows = db.prepare(`
    SELECT date(created_at, '+${TZ_OFFSET_HOURS} hours') AS day, COUNT(*) AS count
    FROM illustration_events WHERE created_at >= ? GROUP BY day
  `).all(since);
  const dayCounts = new Map(dayRows.map(r => [r.day, r.count]));
  const byDay = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const day = eatDateString(Date.now() - i * DAY_MS);
    byDay.push({ day, count: dayCounts.get(day) || 0 });
  }

  return { days: windowDays, total, byProduct, byTier, byAgent, byDay, timezone: 'Africa/Nairobi (UTC+3)' };
}

module.exports = { recordIllustration, getSummary, TZ_OFFSET_HOURS };
