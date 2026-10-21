// ============================================================
// Tests for admin-auth.js — real per-person admin accounts (Phase 4):
// password hashing, login, sessions, bootstrap, and the audit log.
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshAuth() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpi-adminauth-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  delete process.env.ADMIN_BOOTSTRAP_USERNAME;
  delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
  delete require.cache[require.resolve('../db.js')];
  delete require.cache[require.resolve('../admin-auth.js')];
  const db = require('../db.js');
  const auth = require('../admin-auth.js');
  return { auth, db };
}

// ---------------- createAdmin ----------------
test('createAdmin stores a hashed password, never the plaintext', () => {
  const { auth, db } = freshAuth();
  auth.createAdmin('walter', 'correct-horse-battery');
  const row = db.prepare('SELECT * FROM admin_users WHERE username = ?').get('walter');
  assert.notEqual(row.password_hash, 'correct-horse-battery');
  assert.ok(!row.password_hash.includes('correct-horse'), 'plaintext not embedded in the hash');
  assert.ok(row.password_hash.length >= 64, 'a real hash, not something trivially short');
  assert.ok(row.password_salt.length > 0);
});

test('createAdmin uses a different salt per account, so identical passwords hash differently', () => {
  const { auth, db } = freshAuth();
  auth.createAdmin('alice', 'same-password-123');
  auth.createAdmin('bob', 'same-password-123');
  const a = db.prepare('SELECT * FROM admin_users WHERE username = ?').get('alice');
  const b = db.prepare('SELECT * FROM admin_users WHERE username = ?').get('bob');
  assert.notEqual(a.password_salt, b.password_salt);
  assert.notEqual(a.password_hash, b.password_hash, 'same password, different hash — defeats precomputed-table attacks');
});

test('createAdmin rejects short passwords and blank usernames', () => {
  const { auth } = freshAuth();
  assert.throws(() => auth.createAdmin('walter', 'short'), /at least 8/);
  assert.throws(() => auth.createAdmin('', 'long-enough-password'), /Username is required/);
  assert.throws(() => auth.createAdmin('   ', 'long-enough-password'), /Username is required/);
});

test('createAdmin rejects a duplicate username', () => {
  const { auth } = freshAuth();
  auth.createAdmin('walter', 'correct-horse-battery');
  assert.throws(() => auth.createAdmin('walter', 'another-password-1'));
});

// ---------------- login ----------------
test('login succeeds with the correct password and returns a session token', () => {
  const { auth } = freshAuth();
  auth.createAdmin('walter', 'correct-horse-battery');
  const result = auth.login('walter', 'correct-horse-battery');
  assert.equal(result.ok, true);
  assert.ok(result.token);
  assert.equal(result.username, 'walter');
  assert.equal(result.role, 'admin');
});

test('login fails with a wrong password', () => {
  const { auth } = freshAuth();
  auth.createAdmin('walter', 'correct-horse-battery');
  const result = auth.login('walter', 'wrong-password');
  assert.equal(result.ok, false);
  assert.equal(result.token, undefined);
});

test('login gives the SAME error for a wrong username and a wrong password', () => {
  // Distinct messages would let an attacker discover which usernames
  // exist. Both failure modes must be indistinguishable.
  const { auth } = freshAuth();
  auth.createAdmin('walter', 'correct-horse-battery');
  const wrongPassword = auth.login('walter', 'nope-nope-nope');
  const wrongUser = auth.login('nobody', 'nope-nope-nope');
  assert.equal(wrongPassword.reason, wrongUser.reason);
});

test('login updates last_login_at', () => {
  const { auth } = freshAuth();
  auth.createAdmin('walter', 'correct-horse-battery');
  assert.equal(auth.listAdmins()[0].lastLoginAt, null);
  auth.login('walter', 'correct-horse-battery');
  assert.ok(auth.listAdmins()[0].lastLoginAt);
});

test('each login issues a distinct session token', () => {
  const { auth } = freshAuth();
  auth.createAdmin('walter', 'correct-horse-battery');
  const a = auth.login('walter', 'correct-horse-battery');
  const b = auth.login('walter', 'correct-horse-battery');
  assert.notEqual(a.token, b.token);
});

// ---------------- sessions ----------------
test('verifySession accepts a valid token and rejects an unknown one', () => {
  const { auth } = freshAuth();
  auth.createAdmin('walter', 'correct-horse-battery');
  const { token } = auth.login('walter', 'correct-horse-battery');
  assert.deepEqual(auth.verifySession(token), { username: 'walter' });
  assert.equal(auth.verifySession('not-a-real-token'), null);
  assert.equal(auth.verifySession(''), null);
  assert.equal(auth.verifySession(undefined), null);
});

test('logout invalidates the session', () => {
  const { auth } = freshAuth();
  auth.createAdmin('walter', 'correct-horse-battery');
  const { token } = auth.login('walter', 'correct-horse-battery');
  assert.equal(auth.logout(token), true);
  assert.equal(auth.verifySession(token), null);
});

test('an expired session is rejected and cleaned up', () => {
  const { auth, db } = freshAuth();
  auth.createAdmin('walter', 'correct-horse-battery');
  const { token } = auth.login('walter', 'correct-horse-battery');

  // Force the session into the past.
  db.prepare('UPDATE admin_sessions SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, token);

  assert.equal(auth.verifySession(token), null, 'expired token is rejected');
  const stillThere = db.prepare('SELECT * FROM admin_sessions WHERE token = ?').get(token);
  assert.equal(stillThere, undefined, 'and the expired row is removed, not left to accumulate');
});

// ---------------- bootstrap ----------------
test('bootstrap creates the first admin from environment variables', () => {
  const { auth } = freshAuth();
  process.env.ADMIN_BOOTSTRAP_USERNAME = 'walter';
  process.env.ADMIN_BOOTSTRAP_PASSWORD = 'correct-horse-battery';
  const result = auth.bootstrapAdminIfNeeded();
  assert.equal(result.created, true);
  assert.equal(auth.login('walter', 'correct-horse-battery').ok, true);
});

test('bootstrap does nothing when the env vars are missing', () => {
  const { auth } = freshAuth();
  const result = auth.bootstrapAdminIfNeeded();
  assert.equal(result.created, false);
  assert.equal(result.missingEnvVars, true);
  assert.equal(auth.countAdmins(), 0);
});

test('bootstrap never overwrites or duplicates once an admin exists', () => {
  const { auth } = freshAuth();
  auth.createAdmin('existing', 'existing-password-1');
  process.env.ADMIN_BOOTSTRAP_USERNAME = 'intruder';
  process.env.ADMIN_BOOTSTRAP_PASSWORD = 'intruder-password-1';
  const result = auth.bootstrapAdminIfNeeded();
  assert.equal(result.created, false);
  assert.equal(auth.countAdmins(), 1);
  assert.equal(auth.login('intruder', 'intruder-password-1').ok, false,
    'a leftover env var cannot add a second admin on a later restart');
});

// ---------------- listAdmins ----------------
test('listAdmins never exposes password data', () => {
  const { auth } = freshAuth();
  auth.createAdmin('walter', 'correct-horse-battery');
  const admins = auth.listAdmins();
  assert.equal(admins.length, 1);
  const serialised = JSON.stringify(admins);
  assert.ok(!serialised.includes('hash'));
  assert.ok(!serialised.includes('salt'));
  assert.ok(!serialised.includes('correct-horse'));
});

// ---------------- audit log ----------------
test('audit log records who did what, newest first', () => {
  const { auth } = freshAuth();
  auth.recordAuditLog({ username: 'walter', action: 'branding.save', detail: 'first', ip: '1.1.1.1' });
  auth.recordAuditLog({ username: 'jane', action: 'product.publish', detail: 'second', ip: '2.2.2.2' });

  const log = auth.getAuditLog();
  assert.equal(log.length, 2);
  assert.equal(log[0].username, 'jane', 'newest entry first');
  assert.equal(log[0].action, 'product.publish');
  assert.equal(log[1].username, 'walter');
  assert.ok(log[0].createdAt);
});

test('audit log respects the limit', () => {
  const { auth } = freshAuth();
  for (let i = 0; i < 5; i++) auth.recordAuditLog({ username: 'walter', action: 'x', detail: String(i) });
  assert.equal(auth.getAuditLog(3).length, 3);
});

// ---------------- setPassword / removeAdmin ----------------
test('setPassword changes the password: the old one stops working, the new one works', () => {
  const { auth } = freshAuth();
  auth.createAdmin('walter', 'old-password-123');
  auth.setPassword('walter', 'new-password-456');
  assert.equal(auth.login('walter', 'old-password-123').ok, false);
  assert.equal(auth.login('walter', 'new-password-456').ok, true);
});

test('setPassword signs that admin out EVERYWHERE', () => {
  const { auth } = freshAuth();
  auth.createAdmin('walter', 'old-password-123');
  const a = auth.login('walter', 'old-password-123');
  const b = auth.login('walter', 'old-password-123'); // a second device
  auth.setPassword('walter', 'new-password-456');
  assert.equal(auth.verifySession(a.token), null);
  assert.equal(auth.verifySession(b.token), null, 'every session opened with the old password is dead');
});

test('setPassword does not sign OTHER admins out', () => {
  const { auth } = freshAuth();
  auth.createAdmin('walter', 'walter-password-1');
  auth.createAdmin('jane', 'jane-password-12');
  const janeSession = auth.login('jane', 'jane-password-12');
  auth.setPassword('walter', 'brand-new-password');
  assert.deepEqual(auth.verifySession(janeSession.token), { username: 'jane' });
});

test('setPassword rejects short passwords and unknown accounts', () => {
  const { auth } = freshAuth();
  auth.createAdmin('walter', 'old-password-123');
  assert.throws(() => auth.setPassword('walter', 'short'), /at least 8/);
  assert.throws(() => auth.setPassword('nobody', 'long-enough-password'), /No admin account/);
});

test('removeAdmin deletes the account and ends their sessions', () => {
  const { auth } = freshAuth();
  auth.createAdmin('walter', 'walter-password-1');
  auth.createAdmin('leaver', 'leaver-password-1');
  const session = auth.login('leaver', 'leaver-password-1');
  auth.removeAdmin('leaver');
  assert.equal(auth.verifySession(session.token), null);
  assert.equal(auth.login('leaver', 'leaver-password-1').ok, false);
  assert.equal(auth.countAdmins(), 1);
});

test('removeAdmin refuses to remove the ONLY admin (would lock everyone out)', () => {
  const { auth } = freshAuth();
  auth.createAdmin('walter', 'walter-password-1');
  assert.throws(() => auth.removeAdmin('walter'), /only admin/);
  assert.equal(auth.countAdmins(), 1);
});

test('a removed admin\'s past actions remain in the audit log', () => {
  const { auth } = freshAuth();
  auth.createAdmin('walter', 'walter-password-1');
  auth.createAdmin('leaver', 'leaver-password-1');
  auth.recordAuditLog({ username: 'leaver', action: 'product.publish', detail: 'X' });
  auth.removeAdmin('leaver');
  assert.ok(auth.getAuditLog().find(e => e.username === 'leaver'), 'history is not erased');
});
