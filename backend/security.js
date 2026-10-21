// ============================================================
// Medical Premium Illustrator — Security Hardening (Phase 4)
// ============================================================
//
// Three things live here, all previously missing:
//
//  1. Security headers on every response.
//  2. General-purpose rate limiting — previously ONLY OTP requests were
//     rate-limited. /api/calculate and the admin endpoints had no
//     throttling at all, so anyone could hammer them.
//  3. A timing-safe admin secret check, plus brute-force lockout on
//     repeated failed admin attempts.
//
// Deliberately dependency-free (no helmet/express-rate-limit) to keep
// the "npm install runs two packages" property of this project intact.

const crypto = require('crypto');

// ---------------- Security headers ----------------
// Applied to every response. These are the widely-recommended baseline
// for an app like this; notes explain the non-obvious choices.
function securityHeaders(req, res, next) {
  // Stop browsers MIME-sniffing a response into something executable.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Disallow being framed by another site (clickjacking protection).
  res.setHeader('X-Frame-Options', 'DENY');

  // Don't leak the full URL (which can contain query params) to
  // third-party sites in the Referer header.
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // This app needs no camera/microphone/geolocation; deny them outright.
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');

  // Content Security Policy.
  //   'unsafe-inline' for scripts/styles is required because the admin
  //   pages and the frontend deliberately use inline <script>/<style>
  //   blocks (the whole project is built to run with no build step).
  //   Tightening this would mean extracting every inline block to its
  //   own file — worth doing eventually, noted in ROADMAP.md.
  //   cdnjs is allowed because admin/rate-import.html loads SheetJS
  //   from there to parse uploaded workbooks in the browser.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));

  // HSTS only makes sense over HTTPS, and setting it on plain HTTP
  // (e.g. local development on http://localhost) would be wrong.
  // Hosts like Render/Railway terminate TLS and set x-forwarded-proto.
  if (req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}

// ---------------- Generic rate limiting ----------------
// In-memory sliding window. Deliberately simple and dependency-free.
//
// LIMITATION, stated plainly: this is per-process memory. If you ever
// run more than one instance of this server behind a load balancer,
// each instance keeps its own counts, so effective limits multiply by
// the instance count. For a single-instance deployment (which is what
// this project targets) it works correctly. Moving to multi-instance
// would mean backing this with the database or a shared cache.
function createRateLimiter({ windowMs, max, keyFn, message }) {
  const hits = new Map(); // key -> array of timestamps

  // Periodically drop stale entries so this map can't grow unboundedly
  // on a long-running server.
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, times] of hits) {
      const kept = times.filter(t => t > cutoff);
      if (kept.length === 0) hits.delete(key);
      else hits.set(key, kept);
    }
  }, windowMs);
  if (sweeper.unref) sweeper.unref(); // don't keep the process alive just for this

  function middleware(req, res, next) {
    const key = keyFn ? keyFn(req) : clientIp(req);
    const now = Date.now();
    const cutoff = now - windowMs;
    const times = (hits.get(key) || []).filter(t => t > cutoff);

    if (times.length >= max) {
      const retryAfterSec = Math.ceil((times[0] + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({ error: message || 'Too many requests. Please slow down and try again shortly.' });
      return;
    }

    times.push(now);
    hits.set(key, times);
    next();
  }

  middleware._hits = hits; // exposed for tests
  return middleware;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ---------------- Admin secret: timing-safe + lockout ----------------
const adminFailures = new Map(); // ip -> { count, firstFailureAt, lockedUntil }
const ADMIN_LOCKOUT_THRESHOLD = 10;
const ADMIN_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOCKOUT_DURATION_MS = 15 * 60 * 1000;

// Constant-time comparison. A plain `a !== b` leaks information through
// how long the comparison takes, which can in principle be used to
// recover a secret byte by byte.
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) {
    // Still do a comparison so the failure path takes similar time.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function isUsingDefaultAdminSecret() {
  return !process.env.ADMIN_SECRET || process.env.ADMIN_SECRET === 'dev-only-change-me';
}

function requireAdminSecret(req, res) {
  const ip = clientIp(req);
  const now = Date.now();
  const record = adminFailures.get(ip);

  if (record && record.lockedUntil && now < record.lockedUntil) {
    const mins = Math.ceil((record.lockedUntil - now) / 60000);
    res.status(429).json({ error: `Too many failed admin attempts. Try again in about ${mins} minute(s).` });
    return false;
  }

  const provided = req.headers['x-admin-secret'];
  const expected = process.env.ADMIN_SECRET || 'dev-only-change-me';

  if (!provided || !safeCompare(provided, expected)) {
    const existing = (record && record.firstFailureAt && (now - record.firstFailureAt) < ADMIN_LOCKOUT_WINDOW_MS)
      ? record
      : { count: 0, firstFailureAt: now };
    existing.count += 1;
    if (existing.count >= ADMIN_LOCKOUT_THRESHOLD) {
      existing.lockedUntil = now + ADMIN_LOCKOUT_DURATION_MS;
    }
    adminFailures.set(ip, existing);
    res.status(401).json({ error: 'Invalid or missing admin secret.' });
    return false;
  }

  adminFailures.delete(ip); // successful auth clears the failure record
  return true;
}

module.exports = {
  securityHeaders,
  createRateLimiter,
  requireAdminSecret,
  isUsingDefaultAdminSecret,
  safeCompare,
  clientIp,
  _adminFailures: adminFailures, // exposed for tests
};
