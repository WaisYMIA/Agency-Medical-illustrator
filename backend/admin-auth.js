// ============================================================
// Medical Premium Illustrator — Admin Accounts (Phase 4)
// ============================================================
//
// Replaces "one shared secret, no record of who did what" with real
// per-person admin accounts: username + password (hashed with
// scrypt — Node's built-in, no bcrypt dependency needed), session
// tokens, and an audit log recording which admin performed which
// action.
//
// SCOPE, stated honestly: this is real authentication, not yet real
// authorization. Every admin account currently has full access — there
// is one role ('admin'), not a hierarchy of platform-admin vs.
// company-admin vs. agent. That hierarchy only becomes meaningful once
// Phase 3 (multi-tenancy) exists — "which company can this admin
// administer" has no answer while there's only one company. The
// `role` column on admin_users is there so that hierarchy can be added
// without a schema migration later.
//
// BOOTSTRAPPING: there's no sign-up flow (this isn't a public product).
// The first admin account is created automatically from the
// ADMIN_BOOTSTRAP_USERNAME / ADMIN_BOOTSTRAP_PASSWORD environment
// variables, the first time the server starts with no admin accounts
// yet. See backend/README.md.
//
// BACKWARD COMPATIBILITY: the original single ADMIN_SECRET still works
// as a fallback (checked in server.js), so existing deployments and
// scripts don't break. New setups should create real accounts instead.

const crypto = require('crypto');
const db = require('./db.js');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SCRYPT_KEYLEN = 64;

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, useSalt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt: useSalt };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function countAdmins() {
  return db.prepare('SELECT COUNT(*) AS n FROM admin_users').get().n;
}

function createAdmin(username, password, role) {
  if (!username || !String(username).trim()) throw new Error('Username is required.');
  if (!password || String(password).length < 8) throw new Error('Password must be at least 8 characters.');
  const { hash, salt } = hashPassword(password);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO admin_users (username, password_hash, password_salt, role, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(String(username).trim(), hash, salt, role || 'admin', now);
  return { username: String(username).trim(), role: role || 'admin', createdAt: now };
}

// Creates the first admin account from environment variables, but only
// if no admin accounts exist yet — never overwrites an existing one.
function bootstrapAdminIfNeeded() {
  if (countAdmins() > 0) return { created: false };
  const username = process.env.ADMIN_BOOTSTRAP_USERNAME;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!username || !password) return { created: false, missingEnvVars: true };
  createAdmin(username, password, 'admin');
  return { created: true, username };
}

function login(username, password) {
  const row = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(String(username || '').trim());
  if (!row) return { ok: false, reason: 'Invalid username or password.' };
  if (!verifyPassword(password || '', row.password_salt, row.password_hash)) {
    return { ok: false, reason: 'Invalid username or password.' };
  }

  const token = crypto.randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO admin_sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, row.username, now, now + SESSION_TTL_MS);
  db.prepare('UPDATE admin_users SET last_login_at = ? WHERE username = ?')
    .run(new Date().toISOString(), row.username);

  return { ok: true, token, username: row.username, role: row.role, expiresAt: now + SESSION_TTL_MS };
}

function logout(token) {
  const result = db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
  return result.changes > 0;
}

// Returns the admin's username if the session token is valid and not
// expired, otherwise null. Expired sessions are cleaned up lazily here.
function verifySession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM admin_sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (Date.now() > row.expires_at) {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
    return null;
  }
  return { username: row.username };
}

// Changes a password and signs that admin out everywhere: any session
// opened with the OLD password is deleted, so a stolen or shared session
// stops working the moment the password is reset.
function setPassword(username, password) {
  if (!password || String(password).length < 8) throw new Error('Password must be at least 8 characters.');
  const name = String(username || '').trim();
  if (!db.prepare('SELECT 1 FROM admin_users WHERE username = ?').get(name)) {
    throw new Error('No admin account named "' + name + '".');
  }
  const { hash, salt } = hashPassword(password);
  db.prepare('UPDATE admin_users SET password_hash = ?, password_salt = ? WHERE username = ?').run(hash, salt, name);
  db.prepare('DELETE FROM admin_sessions WHERE username = ?').run(name);
  return true;
}

// Removes an admin (e.g. someone who has left) and ends their sessions.
// Refuses to remove the LAST admin, which would lock everyone out. Their
// past actions stay in the audit log under their name.
function removeAdmin(username) {
  const name = String(username || '').trim();
  if (!db.prepare('SELECT 1 FROM admin_users WHERE username = ?').get(name)) {
    throw new Error('No admin account named "' + name + '".');
  }
  if (countAdmins() <= 1) throw new Error('Cannot remove the only admin account — that would lock everyone out.');
  db.prepare('DELETE FROM admin_sessions WHERE username = ?').run(name);
  db.prepare('DELETE FROM admin_users WHERE username = ?').run(name);
  return true;
}

function listAdmins() {
  const rows = db.prepare('SELECT username, role, created_at, last_login_at FROM admin_users ORDER BY created_at ASC').all();
  return rows.map(r => ({ username: r.username, role: r.role, createdAt: r.created_at, lastLoginAt: r.last_login_at }));
}

// Records who did what, for accountability — this is the specific gap
// that motivated moving off a single shared secret in the first place.
function recordAuditLog({ username, action, detail, ip }) {
  db.prepare('INSERT INTO admin_audit_log (username, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(username || 'unknown', action, detail ? String(detail) : null, ip || null, new Date().toISOString());
}

function getAuditLog(limit) {
  const rows = db.prepare('SELECT * FROM admin_audit_log ORDER BY id DESC LIMIT ?').all(limit || 100);
  return rows.map(r => ({ username: r.username, action: r.action, detail: r.detail, ip: r.ip, createdAt: r.created_at }));
}

module.exports = {
  createAdmin,
  countAdmins,
  bootstrapAdminIfNeeded,
  login,
  logout,
  verifySession,
  listAdmins,
  setPassword,
  removeAdmin,
  recordAuditLog,
  getAuditLog,
};
