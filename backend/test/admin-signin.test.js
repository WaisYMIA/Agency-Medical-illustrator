// ============================================================
// Admin sign-in, end to end (Phase 4): the REAL shared sign-in panel
// (admin/admin-session.js, under a fake DOM) against the REAL backend.
//
// Covers: signing in with a personal account, using that session on a
// protected endpoint, being attributed by name, signing out, the legacy
// secret fallback, and what happens when the server has killed a saved
// session. Needs real `express` (it starts the actual server).
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mpi-admin-signin-')), 'test.db');
process.env.ADMIN_SECRET = 'test-secret';
process.env.LOG_REQUESTS = 'false';
process.env.PORT = '0';

const T_origListen = http.Server.prototype.listen;
let T_server = null;
http.Server.prototype.listen = function (...a) { T_server = this; return T_origListen.apply(this, a); };
require('../server.js');
http.Server.prototype.listen = T_origListen;

const T_stub = require('./helpers/domstub.js');
const T_session = require('../../admin/admin-session.js');
const T_adminAuth = require('../admin-auth.js');
const T_sleep = (ms) => new Promise(r => setTimeout(r, ms));
let T_base;

function T_panel() {
  const container = document.createElement('div');
  T_session.renderAdminAuthPanel(container, () => T_base);
  return container;
}
const T_inputs = (c) => c.findAll(n => n.tagName === 'input');
const T_button = (c, label) => c.findAll(n => n.tagName === 'button' && n.textContent_().includes(label))[0];
const T_text = (c) => c.textContent_();

test('admin sign-in: server starts and an admin account exists', async () => {
  await new Promise(r => (T_server.listening ? r() : T_server.once('listening', r)));
  T_base = 'http://127.0.0.1:' + T_server.address().port;
  T_adminAuth.createAdmin('walter', 'correct-horse-battery');
});

test('signed out: the panel offers username + password and a legacy-secret fallback', () => {
  const c = T_panel();
  assert.equal(T_inputs(c).length, 3, 'username, password, and the legacy secret box');
  assert.ok(T_button(c, 'Sign in'));
  assert.ok(!T_text(c).includes('Signed in as'));
});

test('a wrong password is refused with a message, and nothing is saved', async () => {
  const c = T_panel();
  const [user, pass] = T_inputs(c);
  user.changeValue('walter'); pass.changeValue('not-the-password');
  T_button(c, 'Sign in').click();
  await T_sleep(250);
  assert.equal(T_stub._store[T_session.ADMIN_SESSION_KEY], undefined);
  assert.ok(!T_text(c).includes('Signed in as'));
});

test('signing in switches the panel to "Signed in as …" and saves a session', async () => {
  const c = T_panel();
  const [user, pass] = T_inputs(c);
  user.changeValue('walter'); pass.changeValue('correct-horse-battery');
  T_button(c, 'Sign in').click();
  await T_sleep(400);
  assert.match(T_text(c), /Signed in as\s*walter/);
  assert.ok(T_stub._store[T_session.ADMIN_SESSION_KEY], 'session stored');
  assert.ok(T_button(c, 'Sign out'));
});

test('the saved session works on a protected endpoint, and the server knows WHO you are', async () => {
  const res = await fetch(T_base + '/api/admin/whoami', { headers: { ...T_session.adminAuthHeaders(), 'X-Forwarded-For': '60.0.0.1' } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).username, 'walter');
});

test('a branding change made from the signed-in page is attributed to that person', async () => {
  const headers = { 'Content-Type': 'application/json', ...T_session.adminAuthHeaders(), 'X-Forwarded-For': '60.0.0.2' };
  await fetch(T_base + '/api/branding', { method: 'PUT', headers, body: JSON.stringify({ tagline: 'Signed in change' }) });
  const audit = await (await fetch(T_base + '/api/admin/audit-log', { headers: { ...T_session.adminAuthHeaders(), 'X-Forwarded-For': '60.0.0.2' } })).json();
  assert.ok(audit.entries.find(e => e.action === 'branding.save' && e.username === 'walter'));
});

test('signing out clears the session locally AND invalidates it on the server', async () => {
  const token = T_session.getAdminSession().token;
  const c = T_panel();
  T_button(c, 'Sign out').click();
  await T_sleep(300);
  assert.equal(T_stub._store[T_session.ADMIN_SESSION_KEY], undefined);

  const res = await fetch(T_base + '/api/admin/whoami', { headers: { 'X-Admin-Session': token, 'X-Forwarded-For': '60.0.0.3' } });
  assert.equal(res.status, 401, 'the old token is dead on the server, not merely forgotten by the browser');
});

test('the legacy secret still works as a fallback, attributed as legacy-secret', async () => {
  T_session.setLegacySecret('test-secret');
  const res = await fetch(T_base + '/api/admin/whoami', { headers: { ...T_session.adminAuthHeaders(), 'X-Forwarded-For': '60.0.0.4' } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).username, 'legacy-secret');
  T_session.setLegacySecret('');
});

test('a saved session the SERVER has killed is dropped, and the sign-in form returns', async () => {
  const login = await T_session.adminLogin(T_base, 'walter', 'correct-horse-battery');
  assert.equal(login.ok, true);
  const token = T_session.getAdminSession().token;

  // Kill it server-side (as would happen after a database reset or expiry).
  await fetch(T_base + '/api/admin/logout', { method: 'POST', headers: { 'X-Admin-Session': token, 'X-Forwarded-For': '60.0.0.5' } });

  const res = await fetch(T_base + '/api/admin/whoami', { headers: { ...T_session.adminAuthHeaders(), 'X-Forwarded-For': '60.0.0.5' } });
  assert.equal(res.status, 401);
  assert.equal(T_session.handleAdminAuthFailure(res), true, 'the page notices and drops the dead session');
  assert.equal(T_session.getAdminSession(), null);
  assert.equal(T_inputs(T_panel()).length, 3, 'so the sign-in form is shown again rather than failing mysteriously');
});

test('admin sign-in: cleanup', () => { T_server.close(); });
