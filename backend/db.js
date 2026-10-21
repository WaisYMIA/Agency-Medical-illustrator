// ============================================================
// Medical Premium Illustrator — Database (SQLite via node:sqlite)
// ============================================================
//
// Replaces the earlier JSON-file storage (store.js / branding-store.js /
// products-store.js previously read/wrote backend/records/*.json).
// This is a real database: atomic writes, proper querying, no risk of
// a half-written JSON file from a crashed process mid-write.
//
// Uses Node's BUILT-IN SQLite module (node:sqlite) — no npm install, no
// external database server to run or configure. This means:
//   - Works identically whether deployed live or run on a local
//     server, with zero setup beyond the file itself existing.
//   - The whole database is a single file on disk (see DB_PATH below).
//     Back it up by copying that one file (and its -wal/-shm siblings,
//     if present, while the process is stopped).
//
// IMPORTANT — node:sqlite is an EXPERIMENTAL Node API as of the Node
// version this was built against (Node prints a warning about this on
// startup). It has been tested here and works correctly, and is used
// deliberately for its zero-dependency simplicity. If a future Node
// release changes or removes it, this file is the only place that
// would need to change — everything else in the app talks to
// store.js / branding-store.js / products-store.js's plain functions,
// never to SQLite directly.
//
// DURABILITY — a database file still needs to live on a disk that
// actually persists. On a local server, that's automatic. On a hosted
// platform, this still requires a persistent disk/volume (Render,
// Railway, Fly.io etc. all support attaching one) — a database engine
// does not, by itself, make an ephemeral filesystem non-ephemeral.
// See backend/README.md for exactly how to attach one on your host.

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  // Fail with a plain-English explanation rather than a cryptic stack
  // trace — this is the single most likely deployment mistake.
  console.error(
    '\nThis app needs Node.js 22.13 or newer (it uses Node\'s built-in SQLite database).\n' +
    'You are running Node ' + process.version + '.\n' +
    'On Render/Railway, set the Node version to 22 (see backend/README.md).\n'
  );
  throw e;
}
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');

const dir = path.dirname(DB_PATH);
if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    phone TEXT PRIMARY KEY,
    agent_name TEXT,
    agent_token TEXT UNIQUE,
    first_verified_at TEXT,
    last_active_at TEXT
  );

  CREATE TABLE IF NOT EXISTS otps (
    phone TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5
  );

  CREATE TABLE IF NOT EXISTS otp_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    requested_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_otp_requests_phone ON otp_requests(phone);

  CREATE TABLE IF NOT EXISTS acceptances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    agent_name TEXT,
    agent_token TEXT,
    terms_version TEXT,
    accepted_at TEXT NOT NULL,
    ip TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_acceptances_phone ON acceptances(phone);

  CREATE TABLE IF NOT EXISTS branding (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    company_name TEXT,
    product_name TEXT,
    tagline TEXT,
    logo_initial TEXT,
    color_primary TEXT,
    color_primary_dark TEXT,
    color_accent TEXT,
    contact_phone TEXT,
    contact_email TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    draft_json TEXT,
    draft_saved_at TEXT,
    published_json TEXT,
    published_at TEXT
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_admin_sessions_username ON admin_sessions(username);

  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    ip TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_admin_audit_log_username ON admin_audit_log(username);

  -- Analytics (Phase 4): one row per generated illustration. Deliberately
  -- holds NO client personal data (no name, no age, no family details) —
  -- only what's needed to answer "how many illustrations, for which
  -- product/tier, by which agent" — consistent with the commitment in
  -- TERMS.md that client data isn't retained.
  CREATE TABLE IF NOT EXISTS illustration_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product TEXT NOT NULL,
    tier_id TEXT,
    tier_label TEXT,
    agent_token TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_illustration_events_product ON illustration_events(product);
  CREATE INDEX IF NOT EXISTS idx_illustration_events_created_at ON illustration_events(created_at);
`);

module.exports = db;
