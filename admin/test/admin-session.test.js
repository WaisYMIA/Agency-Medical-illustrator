// ============================================================
// Tests for admin-session.js — the sign-in logic shared by all admin
// pages. Uses a fake fetch and fake localStorage, so no backend needed.
// (A test against the REAL backend lives in backend/test/.)
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');

function freshSession() {
  const store = {};
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  delete require.cache[require.resolve('../admin-session.js')];
  return { mod: require('../admin-session.js'), store };
}

function fakeFetch(handler) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const r = handler(url, opts);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  return calls;
}

test('with no session and no secret, no auth headers are sent', () => {
  const { mod } = freshSession();
  assert.deepEqual(mod.adminAuthHeaders(), {});
});

test('the legacy secret is sent as X-Admin-Secret, and held in memory only', () => {
  const { mod, store } = freshSession();
  mod.setLegacySecret('hunter2-secret');
  assert.deepEqual(mod.adminAuthHeaders(), { 'X-Admin-Secret': 'hunter2-secret' });
  assert.deepEqual(store, {}, 'the secret is never written to browser storage');
});

test('a successful login stores the session and switches headers to X-Admin-Session', async () => {
  const { mod, store } = freshSession();
  const calls = fakeFetch(() => ({ status: 200, body: { ok: true, token: 'tok-123', username: 'walter', role: 'admin', expiresAt: Date.now() + 3600000 } }));

  const result = await mod.adminLogin('http://backend', 'walter', 'correct-horse');
  assert.deepEqual(result, { ok: true, username: 'walter' });
  assert.equal(calls[0].url, 'http://backend/api/admin/login');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { username: 'walter', password: 'correct-horse' });
  assert.ok(store[mod.ADMIN_SESSION_KEY], 'session saved');
  assert.deepEqual(mod.adminAuthHeaders(), { 'X-Admin-Session': 'tok-123' });
});

test('a real session takes priority over the legacy secret', async () => {
  const { mod } = freshSession();
  fakeFetch(() => ({ status: 200, body: { token: 'tok-abc', username: 'walter', role: 'admin', expiresAt: Date.now() + 3600000 } }));
  mod.setLegacySecret('old-secret');
  await mod.adminLogin('http://b', 'walter', 'pw-pw-pw-pw');
  assert.deepEqual(mod.adminAuthHeaders(), { 'X-Admin-Session': 'tok-abc' });
});

test('a failed login saves nothing and surfaces the server message', async () => {
  const { mod, store } = freshSession();
  fakeFetch(() => ({ status: 401, body: { error: 'Invalid username or password.' } }));
  const result = await mod.adminLogin('http://b', 'walter', 'wrong');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Invalid username or password.');
  assert.deepEqual(store, {});
});

test('an unreachable backend gives a helpful message instead of throwing', async () => {
  const { mod } = freshSession();
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const result = await mod.adminLogin('http://nowhere', 'walter', 'pw');
  assert.equal(result.ok, false);
  assert.match(result.error, /Backend URL/);
});

test('an expired saved session is discarded rather than used', () => {
  const { mod, store } = freshSession();
  mod.saveAdminSession({ token: 'old', username: 'walter', expiresAt: Date.now() - 1000 });
  assert.equal(mod.getAdminSession(), null);
  assert.deepEqual(mod.adminAuthHeaders(), {});
  assert.equal(store[mod.ADMIN_SESSION_KEY], undefined, 'and removed from storage');
});

test('corrupt stored data is ignored, not a crash', () => {
  const { mod, store } = freshSession();
  store[mod.ADMIN_SESSION_KEY] = '{not valid json';
  assert.equal(mod.getAdminSession(), null);
});

test('logout tells the server and forgets the session', async () => {
  const { mod, store } = freshSession();
  mod.saveAdminSession({ token: 'tok-9', username: 'walter', expiresAt: Date.now() + 3600000 });
  const calls = fakeFetch(() => ({ status: 200, body: { ok: true } }));
  await mod.adminLogout('http://b');
  assert.equal(calls[0].url, 'http://b/api/admin/logout');
  assert.equal(calls[0].opts.headers['X-Admin-Session'], 'tok-9');
  assert.equal(store[mod.ADMIN_SESSION_KEY], undefined);
});

test('logout still forgets the session locally even if the server is unreachable', async () => {
  const { mod, store } = freshSession();
  mod.saveAdminSession({ token: 'tok-9', username: 'walter', expiresAt: Date.now() + 3600000 });
  global.fetch = async () => { throw new Error('offline'); };
  await mod.adminLogout('http://b');
  assert.equal(store[mod.ADMIN_SESSION_KEY], undefined);
});

test('handleAdminAuthFailure drops a rejected session, and reports it', () => {
  const { mod, store } = freshSession();
  mod.saveAdminSession({ token: 'stale', username: 'walter', expiresAt: Date.now() + 3600000 });
  assert.equal(mod.handleAdminAuthFailure({ status: 401 }), true);
  assert.equal(store[mod.ADMIN_SESSION_KEY], undefined);
});

test('handleAdminAuthFailure leaves things alone for non-401s, or when not signed in', () => {
  const { mod } = freshSession();
  mod.saveAdminSession({ token: 'ok', username: 'walter', expiresAt: Date.now() + 3600000 });
  assert.equal(mod.handleAdminAuthFailure({ status: 500 }), false);
  assert.ok(mod.getAdminSession(), 'session untouched by a server error');

  mod.clearAdminSession();
  assert.equal(mod.handleAdminAuthFailure({ status: 401 }), false, 'nothing to drop');
});
