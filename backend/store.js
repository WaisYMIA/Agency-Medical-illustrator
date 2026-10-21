// ============================================================
// Medical Premium Illustrator — Agent/OTP Store (SQLite-backed)
// ============================================================
//
// Same public functions as the earlier JSON-file version — nothing
// calling this module (server.js, tests) needed to change. Only the
// storage mechanism underneath changed: real SQLite (db.js) instead of
// hand-rolled JSON read/write.

const crypto = require('crypto');
const db = require('./db.js');

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const OTP_RATE_LIMIT_MAX = 3;
const OTP_MAX_ATTEMPTS = 5;

function normalizePhone(phone) {
  let p = String(phone || '').trim().replace(/[\s()-]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('0')) p = '254' + p.slice(1);
  else if (!p.startsWith('254')) p = '254' + p;
  return '+' + p;
}

function isValidKenyanPhone(phone) {
  if (!phone) return false;
  const normalized = normalizePhone(phone);
  return /^\+254[17]\d{8}$/.test(normalized);
}

function hashOtp(otp, salt) {
  return crypto.createHash('sha256').update(salt + ':' + otp).digest('hex');
}

// ---------------- OTP ----------------
function createOtp(phone) {
  const key = normalizePhone(phone);
  const now = Date.now();
  const windowStart = now - OTP_RATE_LIMIT_WINDOW_MS;

  const recentCount = db.prepare(
    'SELECT COUNT(*) AS n FROM otp_requests WHERE phone = ? AND requested_at > ?'
  ).get(key, windowStart).n;

  if (recentCount >= OTP_RATE_LIMIT_MAX) {
    return { rateLimited: true };
  }

  db.prepare('INSERT INTO otp_requests (phone, requested_at) VALUES (?, ?)').run(key, now);

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const salt = crypto.randomBytes(8).toString('hex');
  const hash = hashOtp(otp, salt);
  const expiresAt = now + OTP_TTL_MS;

  db.prepare(`
    INSERT INTO otps (phone, hash, salt, expires_at, attempts, max_attempts)
    VALUES (?, ?, ?, ?, 0, ?)
    ON CONFLICT(phone) DO UPDATE SET hash = excluded.hash, salt = excluded.salt,
      expires_at = excluded.expires_at, attempts = 0, max_attempts = excluded.max_attempts
  `).run(key, hash, salt, expiresAt, OTP_MAX_ATTEMPTS);

  return { rateLimited: false, otp };
}

function verifyOtp(phone, submittedOtp) {
  const key = normalizePhone(phone);
  const record = db.prepare('SELECT * FROM otps WHERE phone = ?').get(key);

  if (!record) return { ok: false, reason: 'No OTP was requested for this number.' };
  if (Date.now() > record.expires_at) return { ok: false, reason: 'This OTP has expired. Request a new one.' };
  if (record.attempts >= record.max_attempts) return { ok: false, reason: 'Too many incorrect attempts. Request a new OTP.' };

  db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE phone = ?').run(key);

  const submittedHash = hashOtp(String(submittedOtp || ''), record.salt);
  if (submittedHash !== record.hash) {
    return { ok: false, reason: 'Incorrect OTP.' };
  }

  db.prepare('DELETE FROM otps WHERE phone = ?').run(key); // single-use
  return { ok: true };
}

// ---------------- Agents ----------------
function mapAgentRow(row) {
  if (!row) return null;
  return {
    phone: row.phone,
    agentName: row.agent_name || '',
    agentToken: row.agent_token,
    firstVerifiedAt: row.first_verified_at,
    lastActiveAt: row.last_active_at,
  };
}

function upsertAgent(phone, agentName) {
  const key = normalizePhone(phone);
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM agents WHERE phone = ?').get(key);

  if (!existing) {
    const agentToken = crypto.randomUUID();
    db.prepare(`
      INSERT INTO agents (phone, agent_name, agent_token, first_verified_at, last_active_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(key, agentName || '', agentToken, now, now);
  } else {
    db.prepare(`
      UPDATE agents SET last_active_at = ?, agent_name = COALESCE(NULLIF(?, ''), agent_name)
      WHERE phone = ?
    `).run(now, agentName || '', key);
  }

  return mapAgentRow(db.prepare('SELECT * FROM agents WHERE phone = ?').get(key));
}

function getAgentByToken(agentToken) {
  return mapAgentRow(db.prepare('SELECT * FROM agents WHERE agent_token = ?').get(agentToken));
}

function getAgentByPhone(phone) {
  return mapAgentRow(db.prepare('SELECT * FROM agents WHERE phone = ?').get(normalizePhone(phone)));
}

// Lists every verified agent, newest first, each with a count of how
// many times they've accepted the Terms. Used by the agent management
// admin screen (Phase 4).
function listAgents() {
  const rows = db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM acceptances ac WHERE ac.phone = a.phone) AS acceptance_count,
           (SELECT MAX(ac.accepted_at) FROM acceptances ac WHERE ac.phone = a.phone) AS last_accepted_at
    FROM agents a
    ORDER BY a.first_verified_at DESC
  `).all();
  return rows.map(r => ({
    ...mapAgentRow(r),
    acceptanceCount: r.acceptance_count,
    lastAcceptedAt: r.last_accepted_at,
  }));
}

// Revokes an agent's access by deleting their agent record. Their saved
// session token stops working, so the app will put them back through
// the terms + OTP gate on next use.
//
// IMPORTANT: this deliberately does NOT delete their acceptance history.
// That audit trail is the evidence underpinning Sections 2/3 of
// TERMS.md — who agreed to what, and when — and must survive an agent
// being removed. Revoking access and erasing the record that they
// accepted responsibility are two very different things.
function revokeAgent(phone) {
  const key = normalizePhone(phone);
  const existing = db.prepare('SELECT * FROM agents WHERE phone = ?').get(key);
  if (!existing) return false;
  db.prepare('DELETE FROM agents WHERE phone = ?').run(key);
  db.prepare('DELETE FROM otps WHERE phone = ?').run(key); // clear any pending OTP too
  return true;
}

// ---------------- Terms acceptances (append-only audit log) ----------------
function recordAcceptance({ agentToken, phone, agentName, termsVersion, ip }) {
  const key = normalizePhone(phone);
  const acceptedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO acceptances (phone, agent_name, agent_token, terms_version, accepted_at, ip)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(key, agentName || '', agentToken, termsVersion, acceptedAt, ip || null);

  return { agentToken, phone: key, agentName: agentName || '', termsVersion, acceptedAt, ip: ip || null };
}

function getAcceptances(phone) {
  const key = normalizePhone(phone);
  const rows = db.prepare('SELECT * FROM acceptances WHERE phone = ? ORDER BY id ASC').all(key);
  return rows.map(r => ({
    agentToken: r.agent_token, phone: r.phone, agentName: r.agent_name,
    termsVersion: r.terms_version, acceptedAt: r.accepted_at, ip: r.ip,
  }));
}

module.exports = {
  normalizePhone,
  isValidKenyanPhone,
  createOtp,
  verifyOtp,
  upsertAgent,
  getAgentByToken,
  getAgentByPhone,
  listAgents,
  revokeAgent,
  recordAcceptance,
  getAcceptances,
};
