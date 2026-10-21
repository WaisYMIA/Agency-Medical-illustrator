// ============================================================
// HTTP integration tests for server.js.
//
// Unlike the other test files, this one needs the real 'express' and
// 'cors' packages installed (`npm install` in backend/) to run, since
// it exercises the actual HTTP layer rather than pure functions. If
// you see "Cannot find module 'express'" running this file directly,
// that's why — `npm test` handles this by running npm install first
// in CI (see .github/workflows/test.yml at the repo root).
//
// Starts a real instance of the app on an ephemeral port for the
// duration of these tests, pointed at a temp DB_PATH so nothing
// touches real data.
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mpi-api-test-')), 'test.db');
process.env.PORT = '0'; // let the OS pick a free port
process.env.ADMIN_SECRET = 'test-secret';
process.env.LOG_REQUESTS = 'false'; // keep test output readable

delete require.cache[require.resolve('../server.js')];
// server.js calls app.listen() itself at module load — capture the
// server instance it creates so we can find out which port got picked
// and close it cleanly when done.
const http = require('node:http');
const originalListen = http.Server.prototype.listen;
let capturedServer = null;
http.Server.prototype.listen = function (...args) {
  capturedServer = this;
  return originalListen.apply(this, args);
};
require('../server.js');
http.Server.prototype.listen = originalListen;

let baseUrl;

// A verified agent, created directly via the store (the OTP flow itself is
// covered separately). /api/calculate now requires this agent's token.
let agentToken;
function agentHeaders(extra) {
  return { 'Content-Type': 'application/json', 'X-Agent-Token': agentToken, ...(extra || {}) };
}

test('server starts and exposes a port', async () => {
  await new Promise(resolve => {
    if (capturedServer.listening) return resolve();
    capturedServer.once('listening', resolve);
  });
  const address = capturedServer.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  assert.ok(baseUrl);
  const store = require('../store.js');
  agentToken = store.upsertAgent('0700000001', 'Test Agent').agentToken;
});

test('GET /api/health responds ok and confirms the database is reachable', async () => {
  const res = await fetch(baseUrl + '/api/health');
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.status, 'ok');
  assert.equal(data.database, 'ok');
  assert.equal(typeof data.uptimeSeconds, 'number');
});

test('single-host mode: GET / serves the actual frontend index.html', async () => {
  const res = await fetch(baseUrl + '/');
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.ok(html.includes('<div id="app-root">'), 'serves the real frontend markup, not a placeholder');
});

test('single-host mode: static frontend assets are served alongside the API', async () => {
  const cssRes = await fetch(baseUrl + '/styles.css');
  assert.equal(cssRes.status, 200);
  const jsRes = await fetch(baseUrl + '/app.js');
  assert.equal(jsRes.status, 200);
  const jsText = await jsRes.text();
  assert.ok(jsText.includes('function render()'), 'serves the real app.js, not an empty or wrong file');
});

test('single-host mode: unknown paths still 404 rather than falling through to the frontend or API', async () => {
  const res = await fetch(baseUrl + '/this-path-does-not-exist.xyz');
  assert.equal(res.status, 404);
});

test('POST /api/calculate for JCare returns the known-good reference total', async () => {
  const res = await fetch(baseUrl + '/api/calculate', {
    method: 'POST', headers: agentHeaders(),
    body: JSON.stringify({
      product: 'JCARE',
      input: { principalAge: 42, hasSpouse: true, spouseAge: 38, numChildren: 2, outpatient: 'shared', maternity: true, dental: true, lastExpense: true, personalAccident: true, covid: true, covidLimit: 1000000 },
    }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.results[4].totalPremium, 391669.39);
});

test('agent gate is enforced SERVER-SIDE: /api/calculate refuses a request with no agent token', async () => {
  const res = await fetch(baseUrl + '/api/calculate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product: 'JCARE', input: { principalAge: 30, hasSpouse: false, spouseAge: 0, numChildren: 0, outpatient: 'person' } }),
  });
  const data = await res.json();
  assert.equal(res.status, 401);
  assert.equal(data.code, 'AGENT_SESSION_INVALID');
  assert.equal(data.results, undefined, 'no premium data leaks to an unverified caller');
});

test('agent gate: a made-up agent token is refused', async () => {
  const res = await fetch(baseUrl + '/api/calculate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Token': 'not-a-real-token' },
    body: JSON.stringify({ product: 'JCARE', input: { principalAge: 30 } }),
  });
  assert.equal(res.status, 401);
});

test('REVOCATION ACTUALLY WORKS: a revoked agent can no longer calculate', async () => {
  // This is the behaviour that was previously only claimed, not true:
  // revoking deleted the database record, but nothing re-checked it.
  const store = require('../store.js');
  const victim = store.upsertAgent('0700000002', 'About To Be Revoked');
  const body = JSON.stringify({ product: 'JCARE', input: { principalAge: 30, hasSpouse: false, spouseAge: 0, numChildren: 0, outpatient: 'person' } });
  const headers = { 'Content-Type': 'application/json', 'X-Agent-Token': victim.agentToken };

  const before = await fetch(baseUrl + '/api/calculate', { method: 'POST', headers, body });
  assert.equal(before.status, 200, 'works while verified');

  const revoke = await fetch(baseUrl + '/api/agents/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-secret', 'X-Forwarded-For': '30.0.0.1' },
    body: JSON.stringify({ phone: '0700000002' }),
  });
  assert.equal(revoke.status, 200);

  const after = await fetch(baseUrl + '/api/calculate', { method: 'POST', headers, body });
  assert.equal(after.status, 401, 'the very next request after revocation is refused');
});

test('analytics: a calculation is recorded with product, tier and agent — and NO client details', async () => {
  const db = require('../db.js');
  const before = db.prepare('SELECT COUNT(*) AS n FROM illustration_events').get().n;

  const res = await fetch(baseUrl + '/api/calculate', {
    method: 'POST', headers: agentHeaders(),
    body: JSON.stringify({
      product: 'JCARE', chosenTierIndex: 4,
      // Client details deliberately included in the request body. They are
      // needed to compute the quote, but must never be stored.
      input: { clientName: 'SECRET-CLIENT-NAME-XYZ', principalAge: 41, hasSpouse: false, spouseAge: 0, numChildren: 0, outpatient: 'person' },
    }),
  });
  assert.equal(res.status, 200);

  const rows = db.prepare('SELECT * FROM illustration_events ORDER BY id DESC').all();
  assert.equal(rows.length, before + 1, 'exactly one event recorded');
  const row = rows[0];
  assert.equal(row.product, 'JCARE');
  assert.equal(row.tier_label, 'Royal', 'tier resolved server-side from the chosen index');
  assert.equal(row.agent_token, agentToken, 'attributed to the verified agent');

  const everything = JSON.stringify(db.prepare('SELECT * FROM illustration_events').all());
  assert.ok(!everything.includes('SECRET-CLIENT-NAME-XYZ'), 'the client name never reaches the analytics table');
  assert.ok(!/principalAge|spouseAge|numChildren|clientName/.test(everything), 'no client fields of any kind are stored');
});

test('analytics: a refused or failed calculation records nothing', async () => {
  const db = require('../db.js');
  const before = db.prepare('SELECT COUNT(*) AS n FROM illustration_events').get().n;
  await fetch(baseUrl + '/api/calculate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ product: 'JCARE', input: {} }) }); // no agent
  await fetch(baseUrl + '/api/calculate', { method: 'POST', headers: agentHeaders(), body: JSON.stringify({ product: 'NOPE', input: {} }) });      // unknown product
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM illustration_events').get().n, before);
});

test('analytics: GET /api/admin/analytics requires admin auth and returns the summary', async () => {
  const noAuth = await fetch(baseUrl + '/api/admin/analytics', { headers: { 'X-Forwarded-For': '50.0.0.1' } });
  assert.equal(noAuth.status, 401);

  const res = await fetch(baseUrl + '/api/admin/analytics?days=7', { headers: { 'X-Admin-Secret': 'test-secret', 'X-Forwarded-For': '50.0.0.2' } });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.days, 7);
  assert.ok(data.total >= 1, 'includes the illustration recorded above');
  assert.ok(Array.isArray(data.byDay) && data.byDay.length === 7);
  const serialised = JSON.stringify(data);
  assert.ok(!serialised.includes(agentToken), 'raw agent tokens are never exposed through the analytics API');
});

test('POST /api/calculate rejects an unknown product', async () => {
  const res = await fetch(baseUrl + '/api/calculate', {
    method: 'POST', headers: agentHeaders(),
    body: JSON.stringify({ product: 'NOPE', input: {} }),
  });
  assert.equal(res.status, 400);
});

test('agent gate: wrong OTP is rejected over real HTTP', async () => {
  const phone = '0712345671';
  const reqRes = await fetch(baseUrl + '/api/agent/request-otp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }),
  });
  const reqData = await reqRes.json();
  assert.equal(reqRes.status, 200);
  assert.equal(reqData.devMode, true, 'no SMS provider configured in test env, so dev mode is expected');

  const wrongVerify = await fetch(baseUrl + '/api/agent/verify-otp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, otp: '000000', agentName: 'Test Agent' }),
  });
  assert.equal(wrongVerify.status, 400, 'wrong OTP is rejected');
});

test('PUT /api/branding requires the admin secret', async () => {
  const res = await fetch(baseUrl + '/api/branding', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ companyName: 'Should Not Save' }),
  });
  assert.equal(res.status, 401);
});

test('PUT /api/branding succeeds with the correct admin secret and GET reflects it', async () => {
  const putRes = await fetch(baseUrl + '/api/branding', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-secret' },
    body: JSON.stringify({ companyName: 'Acme Test Co' }),
  });
  assert.equal(putRes.status, 200);
  const getRes = await fetch(baseUrl + '/api/branding');
  const getData = await getRes.json();
  assert.equal(getData.branding.companyName, 'Acme Test Co');
});

test('a full guided-import cycle works over real HTTP: draft, preview, publish, live calculate', async () => {
  const schema = {
    id: 'HTTPTESTCO', name: 'HTTP Test Co',
    roles: ['principal'],
    roleEligibility: { principal: { min: 18, max: 60 } },
    tiers: [{ id: 'basic', label: 'Basic', limit: 500000 }],
    levyRate: 0.0045, stampDuty: 40,
    benefits: { inpatient: { label: 'Inpatient', mandatory: true, includeRoles: ['principal'], rate: { type: 'flatPerTier', values: [10000] } } },
  };

  const draftRes = await fetch(baseUrl + '/api/products/HTTPTESTCO/draft', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-secret' },
    body: JSON.stringify(schema),
  });
  assert.equal(draftRes.status, 200);

  const beforePublish = await fetch(baseUrl + '/api/calculate', {
    method: 'POST', headers: agentHeaders(),
    body: JSON.stringify({ product: 'HTTPTESTCO', input: { principalAge: 30 } }),
  });
  assert.equal(beforePublish.status, 400, 'unpublished product cannot be calculated live yet');

  const previewRes = await fetch(baseUrl + '/api/products/HTTPTESTCO/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-secret' },
    body: JSON.stringify({ input: { principalAge: 30 } }),
  });
  const previewData = await previewRes.json();
  assert.equal(previewData.results[0].basicPremium, 10000);

  const publishRes = await fetch(baseUrl + '/api/products/HTTPTESTCO/publish', {
    method: 'POST', headers: { 'X-Admin-Secret': 'test-secret' },
  });
  assert.equal(publishRes.status, 200);

  const afterPublish = await fetch(baseUrl + '/api/calculate', {
    method: 'POST', headers: agentHeaders(),
    body: JSON.stringify({ product: 'HTTPTESTCO', input: { principalAge: 30 } }),
  });
  const afterData = await afterPublish.json();
  assert.equal(afterPublish.status, 200);
  assert.equal(afterData.results[0].basicPremium, 10000);
});

test('GET /api/agents requires the admin secret', async () => {
  const res = await fetch(baseUrl + '/api/agents');
  assert.equal(res.status, 401);
});

test('agent management: list and revoke over real HTTP', async () => {
  // Create an agent directly via the store, then exercise the admin API.
  const store = require('../store.js');
  const agent = store.upsertAgent('0733111222', 'HTTP Test Agent');
  store.recordAcceptance({ agentToken: agent.agentToken, phone: '0733111222', agentName: 'HTTP Test Agent', termsVersion: '1.0-test', ip: '127.0.0.1' });

  const listRes = await fetch(baseUrl + '/api/agents', { headers: { 'X-Admin-Secret': 'test-secret' } });
  const listData = await listRes.json();
  assert.equal(listRes.status, 200);
  const found = listData.agents.find(a => a.phone === '+254733111222');
  assert.ok(found, 'the agent appears in the admin listing');
  assert.equal(found.acceptanceCount, 1);

  const revokeRes = await fetch(baseUrl + '/api/agents/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-secret' },
    body: JSON.stringify({ phone: '0733111222' }),
  });
  assert.equal(revokeRes.status, 200);

  // Their session token must no longer resolve.
  const sessionRes = await fetch(baseUrl + '/api/agent/session?agentToken=' + encodeURIComponent(agent.agentToken));
  assert.equal(sessionRes.status, 404, 'revoked agent session is rejected');

  // But the acceptance audit trail is still queryable.
  const histRes = await fetch(baseUrl + '/api/agent/acceptances?phone=' + encodeURIComponent('0733111222'), {
    headers: { 'X-Admin-Secret': 'test-secret' },
  });
  const histData = await histRes.json();
  assert.equal(histData.acceptances.length, 1, 'audit trail survives revocation');
});

test('revoking an unknown agent returns 404', async () => {
  const res = await fetch(baseUrl + '/api/agents/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-secret' },
    body: JSON.stringify({ phone: '0700000000' }),
  });
  assert.equal(res.status, 404);
});

test('security headers are present on API responses', async () => {
  const res = await fetch(baseUrl + '/api/health');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.ok(res.headers.get('content-security-policy'), 'CSP header present');
  assert.ok(res.headers.get('referrer-policy'), 'Referrer-Policy present');
});

test('security headers are present on static frontend responses too', async () => {
  const res = await fetch(baseUrl + '/');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('content-security-policy'));
});

test('admin endpoints return 429 after sustained wrong-secret attempts', async () => {
  // The admin lockout threshold is 10 failures from one IP. All requests
  // here come from 127.0.0.1, so this exercises the real lockout path.
  let sawLockout = false;
  for (let i = 0; i < 14; i++) {
    const res = await fetch(baseUrl + '/api/branding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'definitely-wrong' },
      body: JSON.stringify({ companyName: 'Nope' }),
    });
    if (res.status === 429) { sawLockout = true; break; }
  }
  assert.equal(sawLockout, true, 'repeated bad admin secrets eventually get locked out, not just 401d forever');
});

// NOTE: each test below uses its own synthetic X-Forwarded-For IP.
// adminLimiter and the admin-secret lockout are deliberately per-IP
// (see security.test.js) — sharing one real IP across this many
// sequential admin requests in one test run would otherwise exhaust a
// real client's rate-limit budget purely as a test-ordering artifact,
// not because of anything actually wrong. Distinct synthetic IPs keep
// each test independent, which is also just better test hygiene.

test('admin login: wrong username/password is rejected', async () => {
  const res = await fetch(baseUrl + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '20.0.0.1' },
    body: JSON.stringify({ username: 'nobody', password: 'wrong' }),
  });
  assert.equal(res.status, 401);
});

test('admin login, session-based auth on a protected route, then logout', async () => {
  const ip = { 'X-Forwarded-For': '20.0.0.2' };
  const adminAuth = require('../admin-auth.js');
  adminAuth.createAdmin('httptestadmin', 'a-real-password-123');

  const loginRes = await fetch(baseUrl + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ip },
    body: JSON.stringify({ username: 'httptestadmin', password: 'a-real-password-123' }),
  });
  const loginData = await loginRes.json();
  assert.equal(loginRes.status, 200);
  assert.ok(loginData.token);
  assert.equal(loginData.username, 'httptestadmin');

  const whoamiRes = await fetch(baseUrl + '/api/admin/whoami', {
    headers: { 'X-Admin-Session': loginData.token, ...ip },
  });
  const whoamiData = await whoamiRes.json();
  assert.equal(whoamiRes.status, 200);
  assert.equal(whoamiData.username, 'httptestadmin');

  const badSessionRes = await fetch(baseUrl + '/api/admin/whoami', {
    headers: { 'X-Admin-Session': 'not-a-real-token', ...ip },
  });
  assert.equal(badSessionRes.status, 401);

  const logoutRes = await fetch(baseUrl + '/api/admin/logout', {
    method: 'POST', headers: { 'X-Admin-Session': loginData.token, ...ip },
  });
  assert.equal(logoutRes.status, 200);

  const afterLogoutRes = await fetch(baseUrl + '/api/admin/whoami', {
    headers: { 'X-Admin-Session': loginData.token, ...ip },
  });
  assert.equal(afterLogoutRes.status, 401, 'session is dead after logout');
});

test('branding changes made via a real admin session are attributed in the audit log', async () => {
  const ip = { 'X-Forwarded-For': '20.0.0.3' };
  const adminAuth = require('../admin-auth.js');
  adminAuth.createAdmin('audittest', 'a-real-password-123');
  const loginRes = await fetch(baseUrl + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ip },
    body: JSON.stringify({ username: 'audittest', password: 'a-real-password-123' }),
  });
  const { token } = await loginRes.json();

  await fetch(baseUrl + '/api/branding', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Session': token, ...ip },
    body: JSON.stringify({ companyName: 'Audited Co' }),
  });

  const auditRes = await fetch(baseUrl + '/api/admin/audit-log', { headers: { 'X-Admin-Session': token, ...ip } });
  const auditData = await auditRes.json();
  const entry = auditData.entries.find(e => e.action === 'branding.save' && e.username === 'audittest');
  assert.ok(entry, 'the audit log records WHICH admin made the branding change — the whole point of this feature');
});

test('actions via the legacy secret are attributed as legacy-secret, not silently unattributed', async () => {
  const ip = { 'X-Forwarded-For': '20.0.0.4' };
  await fetch(baseUrl + '/api/branding', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-secret', ...ip },
    body: JSON.stringify({ companyName: 'Legacy Path Co' }),
  });
  const adminAuth = require('../admin-auth.js');
  adminAuth.createAdmin('audittest2', 'a-real-password-123');
  const loginRes = await fetch(baseUrl + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ip },
    body: JSON.stringify({ username: 'audittest2', password: 'a-real-password-123' }),
  });
  const { token } = await loginRes.json();
  const auditRes = await fetch(baseUrl + '/api/admin/audit-log', { headers: { 'X-Admin-Session': token, ...ip } });
  const auditData = await auditRes.json();
  const entry = auditData.entries.find(e => e.detail && e.detail.includes('companyName') && e.username === 'legacy-secret');
  assert.ok(entry, 'legacy-secret actions are still logged, just without a real identity');
});

// MUST stay the last test before cleanup: it closes the database.
test('when the database becomes unreachable: health reports 503 and unexpected errors are a SAFE generic 500', async () => {
  const db = require('../db.js');
  db.close();

  const health = await fetch(baseUrl + '/api/health');
  const healthData = await health.json();
  assert.equal(health.status, 503, 'uptime monitors see a failure, not a misleading "ok"');
  assert.equal(healthData.status, 'degraded');
  assert.equal(healthData.database, 'unreachable');

  // requireAgent now throws (no database). That unexpected failure must
  // come back as a generic 500 that leaks nothing about the internals.
  const res = await fetch(baseUrl + '/api/calculate', {
    method: 'POST', headers: agentHeaders(),
    body: JSON.stringify({ product: 'JCARE', input: { principalAge: 30 } }),
  });
  const body = await res.text();
  assert.equal(res.status, 500);
  assert.ok(!/sqlite|database is not open|stack|at .*\.js/i.test(body), 'no internal detail in the response: ' + body);
});

test('cleanup: close the server', () => {
  capturedServer.close();
});
