// ============================================================
// Tests for analytics.js — usage analytics (Phase 4).
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpi-analytics-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  for (const m of ['../db.js', '../store.js', '../analytics.js']) delete require.cache[require.resolve(m)];
  return { db: require('../db.js'), store: require('../store.js'), analytics: require('../analytics.js') };
}

test('an empty database yields a zeroed, well-formed summary', () => {
  const { analytics } = fresh();
  const s = analytics.getSummary({ days: 7 });
  assert.equal(s.total, 0);
  assert.deepEqual(s.byProduct, []);
  assert.deepEqual(s.byAgent, []);
  assert.equal(s.byDay.length, 7, 'every day in the window is present');
  assert.ok(s.byDay.every(d => d.count === 0));
});

test('counts are grouped by product, by tier and by agent', () => {
  const { store, analytics } = fresh();
  const a = store.upsertAgent('0724888057', 'Walter Jungah');
  const b = store.upsertAgent('0712345678', 'Jane Test');
  analytics.recordIllustration({ product: 'JCARE', tierId: 'royal', tierLabel: 'Royal', agentToken: a.agentToken });
  analytics.recordIllustration({ product: 'JCARE', tierId: 'royal', tierLabel: 'Royal', agentToken: a.agentToken });
  analytics.recordIllustration({ product: 'JCARE', tierId: 'classic', tierLabel: 'Classic', agentToken: b.agentToken });
  analytics.recordIllustration({ product: 'JUNIOR', tierId: 'basic', tierLabel: 'Basic', agentToken: b.agentToken });

  const s = analytics.getSummary({ days: 30 });
  assert.equal(s.total, 4);
  assert.deepEqual(s.byProduct, [{ product: 'JCARE', count: 3 }, { product: 'JUNIOR', count: 1 }]);
  assert.equal(s.byTier.find(t => t.product === 'JCARE' && t.tier === 'Royal').count, 2);
  assert.equal(s.byAgent.find(x => x.name === 'Walter Jungah').count, 2);
  assert.equal(s.byAgent.find(x => x.name === 'Jane Test').count, 2);
});

test('a missing tier is reported as "(not recorded)", not silently dropped', () => {
  const { store, analytics } = fresh();
  const a = store.upsertAgent('0724888057', 'Walter Jungah');
  analytics.recordIllustration({ product: 'JCARE', agentToken: a.agentToken });
  assert.equal(analytics.getSummary({ days: 7 }).byTier[0].tier, '(not recorded)');
});

test('events outside the window are excluded', () => {
  const { db, store, analytics } = fresh();
  const a = store.upsertAgent('0724888057', 'Walter Jungah');
  analytics.recordIllustration({ product: 'JCARE', tierLabel: 'Royal', agentToken: a.agentToken });
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  db.prepare("INSERT INTO illustration_events (product, tier_label, agent_token, created_at) VALUES ('JCARE','Royal',?,?)").run(a.agentToken, old);

  assert.equal(analytics.getSummary({ days: 30 }).total, 1, '40-day-old event is outside a 30-day window');
  assert.equal(analytics.getSummary({ days: 60 }).total, 2, 'and inside a 60-day window');
});

test('past illustrations stay attributed to an agent AFTER they are revoked', () => {
  const { store, analytics } = fresh();
  const a = store.upsertAgent('0724888057', 'Walter Jungah');
  store.recordAcceptance({ agentToken: a.agentToken, phone: '0724888057', agentName: 'Walter Jungah', termsVersion: '1', ip: '1.1.1.1' });
  analytics.recordIllustration({ product: 'JCARE', tierLabel: 'Royal', agentToken: a.agentToken });
  store.revokeAgent('0724888057');

  const row = analytics.getSummary({ days: 7 }).byAgent[0];
  assert.equal(row.name, 'Walter Jungah', 'identity recovered from acceptance history');
  assert.equal(row.active, false, 'and flagged as no longer active');
  assert.equal(row.count, 1);
});

test('the daily series is zero-filled, in order, ending today (East Africa Time)', () => {
  const { store, analytics } = fresh();
  const a = store.upsertAgent('0724888057', 'Walter Jungah');
  analytics.recordIllustration({ product: 'JCARE', tierLabel: 'Royal', agentToken: a.agentToken });
  const s = analytics.getSummary({ days: 5 });
  assert.equal(s.byDay.length, 5);
  const days = s.byDay.map(d => d.day);
  assert.deepEqual(days, [...days].sort(), 'chronological');
  const today = new Date(Date.now() + analytics.TZ_OFFSET_HOURS * 3600000).toISOString().slice(0, 10);
  assert.equal(days[4], today);
  assert.equal(s.byDay[4].count, 1);
  assert.equal(s.byDay[0].count, 0);
});

test('the days parameter is clamped to something sane', () => {
  const { analytics } = fresh();
  assert.equal(analytics.getSummary({ days: 99999 }).days, 365);
  assert.equal(analytics.getSummary({ days: 0 }).days, 30);
  assert.equal(analytics.getSummary({ days: -5 }).days, 30);
  assert.equal(analytics.getSummary({ days: 'abc' }).days, 30);
  assert.equal(analytics.getSummary({}).days, 30);
});

test('the analytics table has no column that could hold client data', () => {
  // Structural guarantee, so a future edit can't quietly start storing
  // client details: if someone adds a column, this test forces them to
  // look at it and justify it against the privacy commitment in TERMS.md.
  const { db } = fresh();
  const cols = db.prepare('PRAGMA table_info(illustration_events)').all().map(c => c.name).sort();
  assert.deepEqual(cols, ['agent_token', 'created_at', 'id', 'product', 'tier_id', 'tier_label']);
});
