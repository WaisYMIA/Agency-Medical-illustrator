// ============================================================
// Medical Premium Illustrator — Logging & Error Reporting (Phase 4)
// ============================================================
//
// WHAT THIS GIVES YOU
//   - Structured (JSON-per-line) logs, which hosts like Render, Railway
//     and Fly.io can search and filter, instead of free-form text.
//   - Request logging: method, path, status, duration.
//   - A single place errors get reported, so a crash is never silent.
//   - Optional alerting: set ERROR_WEBHOOK_URL and unexpected errors are
//     POSTed there. It sends both `text` and `content` fields, so Slack
//     and Discord incoming-webhook URLs work as-is, and anything else that
//     accepts JSON can read the full payload.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//   Log or report request bodies, query strings, headers, or IP addresses.
//   Bodies hold client details (age, family size); query strings can hold
//   agent phone numbers; headers hold session tokens and the admin secret.
//   Only method + path + status + error message/stack are ever recorded,
//   consistent with the data-protection commitments in TERMS.md.
//
// NOT SENTRY: this is a webhook, not Sentry (which needs an account, a
// DSN and its SDK). If you later adopt Sentry, reportError() below is the
// single place to hook it in — nothing else in the app would change.

const SERVICE = 'medical-premium-illustrator';

function write(level, message, context) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, service: SERVICE, message, ...(context || {}) });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}

const log = {
  info: (message, context) => write('info', message, context),
  warn: (message, context) => write('warn', message, context),
  error: (message, context) => write('error', message, context),
};

// ---------------- Request logging ----------------
// Only /api/ traffic, and not the health probe (uptime monitors hit it
// constantly and it would drown out everything else).
function requestLogger(req, res, next) {
  if (process.env.LOG_REQUESTS === 'false') return next();
  const started = Date.now();
  res.on('finish', () => {
    const path = req.path || '';
    if (!path.startsWith('/api/') || path === '/api/health') return;
    log.info('request', { method: req.method, path, status: res.statusCode, ms: Date.now() - started });
  });
  next();
}

// ---------------- Error reporting ----------------
const WEBHOOK_MAX_PER_MINUTE = 5;
const DEDUPE_WINDOW_MS = 60 * 1000;
let webhookSentTimes = [];
const recentSignatures = new Map(); // message -> last-sent time

// Alerts must never become the problem: capped per minute, identical
// errors collapsed, never throws, never blocks the request.
function shouldSendWebhook(signature) {
  const now = Date.now();
  webhookSentTimes = webhookSentTimes.filter(t => now - t < 60 * 1000);
  if (webhookSentTimes.length >= WEBHOOK_MAX_PER_MINUTE) return false;
  const last = recentSignatures.get(signature);
  if (last && now - last < DEDUPE_WINDOW_MS) return false;
  recentSignatures.set(signature, now);
  if (recentSignatures.size > 200) recentSignatures.clear();
  webhookSentTimes.push(now);
  return true;
}

function sendWebhook(payload) {
  const url = process.env.ERROR_WEBHOOK_URL;
  if (!url) return Promise.resolve(false);
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  }).then(() => true).catch(() => false); // a dead webhook must not cause further errors
}

// The one place every unexpected error goes through.
function reportError(err, context) {
  const message = err && err.message ? err.message : String(err);
  const stack = err && err.stack ? String(err.stack) : undefined;
  log.error(message, { stack, ...(context || {}) });

  if (!process.env.ERROR_WEBHOOK_URL) return Promise.resolve(false);
  const where = context && context.route ? ` (${context.route})` : '';
  if (!shouldSendWebhook(message + where)) return Promise.resolve(false);
  const text = `[${SERVICE}] ${message}${where}`;
  return sendWebhook({
    text, content: text, level: 'error', service: SERVICE, message,
    route: context && context.route, stack, time: new Date().toISOString(),
  });
}

// Express error-handling middleware (4 arguments — Express identifies it by that).
function errorHandler(err, req, res, next) {
  reportError(err, { route: `${req.method} ${req.path}` });
  if (res.headersSent) { try { res.end(); } catch (e) { /* already closing */ } return; }
  // Never leak internals to the caller.
  res.status(500).json({ error: 'Something went wrong on the server. It has been logged.' });
}

// After an uncaught exception the process is in an unknown state, so the
// correct move is to log it and exit, letting the host restart a clean
// one. An unhandled promise rejection is reported but not fatal.
function installProcessHandlers() {
  process.on('uncaughtException', (err) => {
    reportError(err, { route: 'uncaughtException' }).finally(() => setTimeout(() => process.exit(1), 300));
  });
  process.on('unhandledRejection', (reason) => {
    reportError(reason instanceof Error ? reason : new Error(String(reason)), { route: 'unhandledRejection' });
  });
}

function _resetForTests() { webhookSentTimes = []; recentSignatures.clear(); }

module.exports = { log, requestLogger, reportError, errorHandler, installProcessHandlers, _resetForTests };
