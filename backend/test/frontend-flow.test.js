// ============================================================
// Frontend + backend, end to end (Phase 4).
//
// Runs the REAL frontend/app.js (under a minimal fake DOM) against the
// REAL server, to verify the agent gate behaves correctly as a whole:
// normal use, an agent revoked mid-session, startup validation of a saved
// session, and tolerance of a flaky connection.
//
// This exists because of a real gap found during Phase 4: the gate used
// to be enforced ONLY in the browser, so revoking an agent didn't actually
// stop them. These tests pin down the fixed behaviour.
//
// Needs real `express` installed (like api.test.js) because it starts the
// actual server.
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mpi-fe-flow-')), 'test.db');
process.env.ADMIN_SECRET = 'test-secret';
process.env.LOG_REQUESTS = 'false';
process.env.PORT = '0';

// Capture the one-time code the server prints in SMS dev mode, exactly as
// a human tester would read it from the console.
const T_otpCodes = [];
const T_origLog = console.log;
console.log = (...args) => {
  const m = /verification code is (\d{6})/.exec(args.join(' '));
  if (m) T_otpCodes.push(m[1]);
  T_origLog.apply(console, args);
};

const T_origListen = http.Server.prototype.listen;
let T_server = null;
http.Server.prototype.listen = function (...a) { T_server = this; return T_origListen.apply(this, a); };
require('../server.js');
http.Server.prototype.listen = T_origListen;

const T_stub = require('./helpers/domstub.js');
const T_FE = path.join(__dirname, '..', '..', 'frontend');
const T_load = (f) => fs.readFileSync(path.join(T_FE, f), 'utf8');
const T_toVar = (s) => s.replace(/\bconst\b/g, 'var').replace(/\blet\b/g, 'var');

eval(T_toVar(T_load('config.js')));
eval(T_toVar(T_load('meta.js')));
eval(T_toVar(T_load('terms-content.js')));
eval(T_toVar(T_load('app.js').replace("document.addEventListener('DOMContentLoaded', init);", '')));

const T_sleep = (ms) => new Promise(r => setTimeout(r, ms));
const T_rootEl = () => document.getElementById('app-root');
const T_btn = (t) => T_rootEl().findAll(n => n.tagName === 'button' && n.textContent_().includes(t))[0];
const T_input = (ph) => T_rootEl().findAll(n => n.tagName === 'input' && n.attrs.placeholder === ph)[0];
let T_base;

async function T_verifyAgent(phone) {
  T_input('Full name').changeValue('Frontend Tester');
  T_input('e.g. 0712345678').changeValue(phone);
  T_rootEl().findAll(n => n.tagName === 'input' && n.attrs.type === 'checkbox')[0].toggle();
  render();
  await requestOtp();
  T_rootEl().findAll(n => n.tagName === 'input' && n.attrs.type === 'number')[0].changeValue(T_otpCodes[T_otpCodes.length - 1]);
  await verifyOtpAndProceed();
}
function T_fillJCare() {
  state.step = 1; render(); T_btn('JCare').click();
  const D = state.form;
  D.clientName = 'X'; D.principalAge = 40; D.hasSpouse = false; D.numChildren = 0; D.tierIdx = 0; D.outpatient = 'person';
}
function T_resetAppState() {
  state.gate.passed = false; state.agent = null; state.gate.screen = 'details'; state.gate.otpSent = false; state.gate.error = null;
}

test('frontend: server starts', async () => {
  await new Promise(r => (T_server.listening ? r() : T_server.once('listening', r)));
  T_base = 'http://127.0.0.1:' + T_server.address().port;
  API_BASE_URL = T_base; // tests resolve this absolute URL; a browser resolves '' against its own origin
  init();
  await T_sleep(150);
});

test('frontend: a verified agent can generate an illustration (token is sent and accepted)', async () => {
  await T_verifyAgent('0722000001');
  assert.equal(state.gate.passed, true);
  T_fillJCare();
  await tryGenerate();
  assert.equal(state.step, 3);
  assert.ok(state.results, 'results are shown');
});

test('frontend: an agent revoked MID-SESSION is refused and sent back to the gate', async () => {
  const revoke = await fetch(T_base + '/api/agents/revoke', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-secret', 'X-Forwarded-For': '40.0.0.1' },
    body: JSON.stringify({ phone: '0722000001' }),
  });
  assert.equal(revoke.status, 200);

  T_fillJCare();
  await tryGenerate();

  assert.equal(state.gate.passed, false, 'returned to the gate');
  assert.equal(T_stub._store['mpi_agent_session'], undefined, 'saved session cleared');
  assert.match(state.gate.error || '', /verify|removed|valid/i, 'told why');
  assert.ok(!state.results, 'no premium results shown to a revoked agent');
  assert.equal(state.gate.agreedToTerms, false, 'Terms box is NOT left pre-ticked — acceptance must be a fresh, deliberate act');
});

test('frontend: on startup, a saved session belonging to a REVOKED agent goes straight to the gate', async () => {
  T_stub._store['mpi_agent_session'] = JSON.stringify({ phone: '+254722000001', agentName: 'Frontend Tester', agentToken: 'revoked-or-bogus-token', termsVersion: TERMS_VERSION });
  T_resetAppState();
  init();
  await T_sleep(300);
  assert.equal(state.gate.passed, false);
  assert.equal(T_stub._store['mpi_agent_session'], undefined, 'stale session cleared');
});

test('frontend: on startup, a VALID saved session is kept', async () => {
  T_resetAppState();
  await T_verifyAgent('0722000002');
  const saved = T_stub._store['mpi_agent_session'];
  T_resetAppState();
  init();
  await T_sleep(300);
  assert.equal(state.gate.passed, true, 'valid agent is not bounced');
  assert.equal(T_stub._store['mpi_agent_session'], saved, 'session retained');
});

test('frontend: an unreachable backend must NOT lock a legitimate agent out', async () => {
  const real = API_BASE_URL;
  API_BASE_URL = 'http://localhost:9'; // nothing listening
  T_resetAppState();
  init();
  await T_sleep(400);
  assert.equal(state.gate.passed, true, 'flaky connection is not treated as "session invalid"');
  API_BASE_URL = real;
});

test('frontend: cleanup', () => {
  T_server.close();
  console.log = T_origLog;
});
