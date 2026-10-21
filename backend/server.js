// ============================================================
// Medical Premium Illustrator — Backend API
//
// Two responsibilities:
//  1. Calculation engine — holds all rate tables and pricing logic.
//     Nothing here is ever sent to the browser; only computed premium
//     numbers are returned, via /api/calculate.
//  2. Agent gate — OTP-verifies an agent's phone number and records
//     their acceptance of the Terms of Use, so both are backed by a
//     real server-side audit trail rather than only a client-side flag.
// ============================================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const { calcJCare, calcJunior, calcSenior } = require('./engine.js');
const store = require('./store.js');
const { sendOtpSms } = require('./sms.js');
const branding = require('./branding-store.js');
const products = require('./products-store.js');
const { calcFromSchema } = require('./generic-engine.js');
const security = require('./security.js');
const adminAuth = require('./admin-auth.js');
const analytics = require('./analytics.js');
const logger = require('./logger.js');
const db = require('./db.js');

const app = express();
const PORT = process.env.PORT || 3001;

// CORS. In single-host mode (recommended) the frontend is served by this
// same server, so CORS never comes into play at all. It matters only for
// split hosting, where the frontend lives on a different origin.
//
// Set ALLOWED_ORIGIN to lock this down to your actual frontend URL
// (e.g. https://your-username.github.io). Left unset it allows any
// origin, which keeps split-mode setup easy but is worth tightening
// once you know your final URL.
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json({ limit: '1mb' })); // cap body size; nothing here legitimately needs more
app.use(security.securityHeaders);
app.use(logger.requestLogger);

// ---------------- Rate limiting ----------------
// Previously ONLY OTP requests were rate-limited; everything else was
// wide open. These cover the rest.
const generalLimiter = security.createRateLimiter({
  windowMs: 60 * 1000,
  max: 120, // generous for normal use; stops sustained hammering
  message: 'Too many requests. Please slow down and try again shortly.',
});
const calculateLimiter = security.createRateLimiter({
  windowMs: 60 * 1000,
  max: 60, // an agent generating illustrations won't come close to this
  message: 'Too many calculation requests. Please slow down and try again shortly.',
});
const adminLimiter = security.createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: 'Too many admin requests. Please slow down and try again shortly.',
});

app.use('/api/', generalLimiter);

// Admin authentication. The implementation (timing-safe comparison plus
// brute-force lockout) lives in security.js — see Phase 4 notes in
// ROADMAP.md. This is still a single shared secret, NOT per-person
// accounts; that remains a genuine gap, documented as such.
// ---------------- Admin authentication ----------------
// Two ways in, checked in order:
//   1. A real per-person session (X-Admin-Session header) — issued by
//      POST /api/admin/login. This is the path that lets audit entries
//      say WHICH admin did something, closing the biggest Phase 4 gap.
//   2. The legacy shared secret (X-Admin-Secret header) — kept working
//      for backward compatibility with existing deployments/scripts.
//      Attributed in the audit log as 'legacy-secret' since there's no
//      way to know which person that was.
// Sets req.adminUsername so route handlers can record who did what.
function requireAdmin(req, res) {
  const sessionToken = req.headers['x-admin-session'];
  if (sessionToken) {
    const session = adminAuth.verifySession(sessionToken);
    if (session) {
      req.adminUsername = session.username;
      return true;
    }
    res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
    return false;
  }

  if (security.requireAdminSecret(req, res)) {
    req.adminUsername = 'legacy-secret';
    return true;
  }
  return false;
}

// ---------------- Agent verification (server-side enforcement) ----------------
// The terms + OTP gate used to exist ONLY in the browser: the frontend
// showed a gate screen, but the API itself never checked that the caller
// was a verified agent. That meant (a) anyone could call /api/calculate
// directly with no verification at all, and (b) revoking an agent did
// nothing to stop them, since nothing ever re-checked their session.
//
// Now /api/calculate requires an X-Agent-Token header that resolves to a
// currently-verified agent. Revoking an agent deletes their record, so
// their token stops resolving and their very next request is refused.
function requireAgent(req, res) {
  const token = req.headers['x-agent-token'];
  const agent = token ? store.getAgentByToken(String(token)) : null;
  if (!agent) {
    res.status(401).json({
      error: 'Your agent session is no longer valid. Please verify your phone number again.',
      code: 'AGENT_SESSION_INVALID',
    });
    return null;
  }
  req.agent = agent;
  return agent;
}

// ============================================================
// Single-host mode: serve the frontend from this same server.
//
// This is now the RECOMMENDED deployment path — one Node service (this
// one) hosts both the API and the app itself, so there's no separate
// static host, no CORS configuration to get right, and no keeping two
// deployments in sync. Deploy this whole repo (or at least backend/ and
// frontend/ as siblings, exactly as they are here) to any Node host —
// Render, Railway, Fly.io, a plain VPS — and the deployed URL serves
// the full app directly.
//
// Split hosting (frontend on GitHub Pages, backend elsewhere) still
// works too — see README.md — this line is simply unused in that case
// since nothing ever requests these paths from a different origin.
app.use(express.static(path.join(__dirname, '../frontend')));

// Health check for uptime monitors (UptimeRobot, Render's health checks,
// etc.). Reports 'ok' only if the database is actually reachable — a
// server that is up but can't read its data is not healthy, and a bare
// "ok" would hide that. Returns 503 when degraded so monitors alert.
app.get('/api/health', (req, res) => {
  let dbStatus = 'ok';
  try { db.prepare('SELECT 1').get(); } catch (e) { dbStatus = 'unreachable'; }
  const healthy = dbStatus === 'ok';
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    database: dbStatus,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// ============================================================
// Calculation API (unchanged from before)
// ============================================================

// POST /api/calculate
// body: { product: 'JCARE'|'JUNIOR'|'JSENIOR'|<imported product id>, input: {...} }
// returns: { results: [...] }  — one entry per plan tier
//
// JCare/J-Junior/JSenior always use the original hand-written engine
// (calcJCare/calcJunior/calcSenior) — these are the individually
// validated reference products and are never routed through the
// generic schema engine, even if someone created a same-named draft.
// Any other product id is looked up as a PUBLISHED generic schema.
app.post('/api/calculate', calculateLimiter, (req, res) => {
  if (!requireAgent(req, res)) return;
  try {
    const { product, input } = req.body || {};
    if (!product || !input) {
      return res.status(400).json({ error: 'Missing product or input.' });
    }

    let results;
    if (product === 'JCARE') {
      results = calcJCare(input);
    } else if (product === 'JUNIOR') {
      results = calcJunior(input);
    } else if (product === 'JSENIOR') {
      results = calcSenior(input);
    } else {
      const schema = products.getPublished(product);
      if (!schema) {
        return res.status(400).json({ error: 'Unknown or unpublished product: ' + product });
      }
      results = calcFromSchema(schema, input);
    }

    // Usage analytics: product, plan tier, and WHICH verified agent — never
    // anything about the client. Secondary to the calculation itself, so a
    // failure here must never stop the agent getting their illustration.
    try {
      const idx = Number.isInteger(req.body.chosenTierIndex) ? req.body.chosenTierIndex : null;
      const chosen = idx !== null && results[idx] ? results[idx].tier : null;
      analytics.recordIllustration({
        product,
        tierId: chosen && chosen.id,
        tierLabel: chosen && chosen.label,
        agentToken: req.agent.agentToken,
      });
    } catch (analyticsErr) {
      logger.log.warn('Analytics recording failed (calculation unaffected)', { error: analyticsErr.message });
    }

    res.json({ results });
  } catch (err) {
    logger.reportError(err, { route: 'POST /api/calculate' });
    res.status(500).json({ error: 'Calculation failed on the server.' });
  }
});

// ============================================================
// Agent verification & terms acceptance API
// ============================================================

// POST /api/agent/request-otp
// body: { phone }
// Generates and "sends" (see sms.js) a 6-digit OTP. Never returns the
// OTP itself in the response.
app.post('/api/agent/request-otp', async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone || !store.isValidKenyanPhone(phone)) {
      return res.status(400).json({ error: 'Enter a valid phone number, e.g. 07XXXXXXXX.' });
    }

    const result = store.createOtp(phone);
    if (result.rateLimited) {
      const minutes = Math.ceil(result.retryAfterMs / 60000);
      return res.status(429).json({ error: `Too many requests for this number. Try again in about ${minutes} minute(s).` });
    }

    const smsResult = await sendOtpSms(store.normalizePhone(phone), result.otp);
    res.json({
      ok: true,
      message: smsResult.devMode
        ? 'Dev mode: no SMS provider configured — the code was logged to the server console instead of texted.'
        : 'OTP sent.',
      devMode: smsResult.devMode,
    });
  } catch (err) {
    logger.reportError(err, { route: 'POST /api/agent/request-otp' });
    res.status(500).json({ error: 'Could not process the OTP request.' });
  }
});

// POST /api/agent/verify-otp
// body: { phone, otp, agentName }
// On success, creates/updates the agent record and returns an agentToken
// the frontend can store locally to skip re-verification on this device.
app.post('/api/agent/verify-otp', (req, res) => {
  try {
    const { phone, otp, agentName } = req.body || {};
    if (!phone || !otp) {
      return res.status(400).json({ error: 'Missing phone or OTP.' });
    }

    const result = store.verifyOtp(phone, otp);
    if (!result.ok) {
      return res.status(400).json({ error: result.reason });
    }

    const agent = store.upsertAgent(phone, agentName);
    res.json({ ok: true, agent: { phone: agent.phone, agentName: agent.agentName, agentToken: agent.agentToken, firstVerifiedAt: agent.firstVerifiedAt } });
  } catch (err) {
    logger.reportError(err, { route: 'POST /api/agent/verify-otp' });
    res.status(500).json({ error: 'Could not verify the OTP.' });
  }
});

// POST /api/agent/accept-terms
// body: { agentToken, phone, agentName, termsVersion }
// Records acceptance in an append-only audit log. Requires a phone that
// has already been OTP-verified (i.e. has an agent record).
app.post('/api/agent/accept-terms', (req, res) => {
  try {
    const { agentToken, phone, agentName, termsVersion } = req.body || {};
    if (!phone || !termsVersion) {
      return res.status(400).json({ error: 'Missing phone or termsVersion.' });
    }
    const agent = store.getAgentByPhone(phone);
    if (!agent || agent.agentToken !== agentToken) {
      return res.status(403).json({ error: 'Phone number has not been OTP-verified yet.' });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    const entry = store.recordAcceptance({ agentToken, phone, agentName, termsVersion, ip });
    res.json({ ok: true, acceptance: entry });
  } catch (err) {
    logger.reportError(err, { route: 'POST /api/agent/accept-terms' });
    res.status(500).json({ error: 'Could not record acceptance.' });
  }
});

// GET /api/agent/session?agentToken=...
// Lets the frontend silently confirm a locally-stored token still
// corresponds to a known, verified agent (e.g. on app reopen).
app.get('/api/agent/session', (req, res) => {
  const token = req.query.agentToken;
  if (!token) return res.status(400).json({ error: 'Missing agentToken.' });
  const agent = store.getAgentByToken(token);
  if (!agent) return res.status(404).json({ error: 'Unknown or expired session.' });
  res.json({ ok: true, agent: { phone: agent.phone, agentName: agent.agentName, agentToken: agent.agentToken, firstVerifiedAt: agent.firstVerifiedAt } });
});

// GET /api/agent/acceptances?phone=... — admin-only audit lookup: what
// did this agent accept, and when. Added because the acceptance log was
// previously write-only from the application's side (recorded but never
// queryable) — the whole point of Section 2/3 of TERMS.md relies on this
// actually being retrievable if it's ever needed.
app.get('/api/agent/acceptances', adminLimiter, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: 'Missing phone.' });
  res.json({ acceptances: store.getAcceptances(phone) });
});

// GET /api/agents — admin-only: every verified agent, for the agent
// management screen (admin/agents.html).
app.get('/api/agents', adminLimiter, (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ agents: store.listAgents() });
});

// POST /api/agents/revoke — admin-only: revoke one agent's access.
// Their stored session stops working and they're put back through the
// terms + OTP gate. Their acceptance history is deliberately retained —
// see the note on revokeAgent() in store.js for why.
app.post('/api/agents/revoke', adminLimiter, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const phone = req.body && req.body.phone;
  if (!phone) return res.status(400).json({ error: 'Missing phone.' });
  const revoked = store.revokeAgent(phone);
  if (!revoked) return res.status(404).json({ error: 'No agent found with that phone number.' });
  adminAuth.recordAuditLog({ username: req.adminUsername, action: 'agent.revoke', detail: store.normalizePhone(phone), ip: security.clientIp(req) });
  res.json({ ok: true, revoked: store.normalizePhone(phone) });
});

// ============================================================
// Branding API (Phase 1 prototype — see ROADMAP.md)
// ============================================================

// GET /api/branding — public. The frontend fetches this on load to
// theme itself (colors, product/company name, contact details).
app.get('/api/branding', (req, res) => {
  res.json({ branding: branding.getBranding() });
});

// PUT /api/branding — protected by a shared secret only (ADMIN_SECRET
// env var). This is a placeholder, not real authentication — there is
// no concept of "which company is this admin" yet, because this
// prototype has exactly one branding config. Phase 3 (true
// multi-tenancy) replaces this with real per-company admin accounts.
app.put('/api/branding', adminLimiter, (req, res) => {
  if (!requireAdmin(req, res)) return;

  const errors = branding.validateBranding(req.body);
  if (errors.length) {
    return res.status(400).json({ error: errors.join(' ') });
  }

  const saved = branding.saveBranding(req.body);
  adminAuth.recordAuditLog({ username: req.adminUsername, action: 'branding.save', detail: JSON.stringify(Object.keys(req.body || {})), ip: security.clientIp(req) });
  res.json({ ok: true, branding: saved });
});

// ============================================================
// Guided Rate Import API (Phase 2 prototype — see ROADMAP.md)
// ============================================================
//
// The actual Excel reading happens in the browser (admin/rate-import.html,
// using SheetJS) — this API only ever receives already-extracted JSON
// (cell ranges the admin has confirmed), never a raw workbook. Nothing
// here "guesses" a mapping; validateSchema() only catches structurally
// broken input (missing tiers, mismatched array lengths, etc.), not
// whether the RATES THEMSELVES are correct — that's what the preview
// endpoint and the admin's own judgement are for.

// GET /api/products — list every imported product and its draft/published status.
app.get('/api/products', (req, res) => {
  res.json({ products: products.listProducts() });
});

// GET /api/products/:id/draft — fetch the current draft (if any) for editing.
app.get('/api/products/:id/draft', (req, res) => {
  const draft = products.getDraft(req.params.id);
  res.json({ draft: draft || null });
});

// POST /api/products/:id/draft — save (create or overwrite) a draft schema.
app.post('/api/products/:id/draft', adminLimiter, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = req.params.id;
  const schema = req.body;
  if (!schema || schema.id !== id) {
    return res.status(400).json({ error: 'Schema id must match the product id in the URL.' });
  }
  const errors = products.validateSchema(schema);
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  const saved = products.saveDraft(id, schema);
  adminAuth.recordAuditLog({ username: req.adminUsername, action: 'product.draft-save', detail: id, ip: security.clientIp(req) });
  res.json({ ok: true, draft: saved });
});

// POST /api/products/:id/preview — compute a sample illustration from the
// DRAFT schema (not the published one), so an admin can sanity-check
// numbers before publishing.
app.post('/api/products/:id/preview', adminLimiter, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = req.params.id;
  const draft = products.getDraft(id);
  if (!draft) return res.status(404).json({ error: 'No draft found for this product.' });
  try {
    const results = calcFromSchema(draft, req.body.input || {});
    res.json({ results });
  } catch (err) {
    logger.reportError(err, { route: 'POST /api/products/:id/preview' });
    res.status(500).json({ error: 'Could not calculate a preview from this draft: ' + err.message });
  }
});

// POST /api/products/:id/publish — promote the current draft to published,
// making it live for /api/calculate.
app.post('/api/products/:id/publish', adminLimiter, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = req.params.id;
  const published = products.publish(id);
  if (!published) return res.status(404).json({ error: 'No draft to publish for this product.' });
  adminAuth.recordAuditLog({ username: req.adminUsername, action: 'product.publish', detail: id, ip: security.clientIp(req) });
  res.json({ ok: true, published });
});

// ============================================================
// Admin accounts (Phase 4) — real per-person login
// ============================================================

// POST /api/admin/login { username, password } -> { token, username, role, expiresAt }
// Send the returned token as an X-Admin-Session header on later admin requests.
app.post('/api/admin/login', adminLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const result = adminAuth.login(username, password);
  if (!result.ok) {
    adminAuth.recordAuditLog({ username: String(username), action: 'login.failed', detail: null, ip: security.clientIp(req) });
    return res.status(401).json({ error: result.reason });
  }
  adminAuth.recordAuditLog({ username: result.username, action: 'login.success', detail: null, ip: security.clientIp(req) });
  res.json({ ok: true, token: result.token, username: result.username, role: result.role, expiresAt: result.expiresAt });
});

// POST /api/admin/logout — ends the session identified by X-Admin-Session.
app.post('/api/admin/logout', adminLimiter, (req, res) => {
  const token = req.headers['x-admin-session'];
  if (!token) return res.status(400).json({ error: 'No session to log out of.' });
  const session = adminAuth.verifySession(token);
  adminAuth.logout(token);
  if (session) adminAuth.recordAuditLog({ username: session.username, action: 'logout', detail: null, ip: security.clientIp(req) });
  res.json({ ok: true });
});

// GET /api/admin/whoami — lets an admin page confirm its session is still valid.
app.get('/api/admin/whoami', adminLimiter, (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, username: req.adminUsername });
});

// GET /api/admin/audit-log — who did what, newest first.
app.get('/api/admin/audit-log', adminLimiter, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ entries: adminAuth.getAuditLog(limit) });
});

// GET /api/admin/analytics?days=30 — usage summary: illustrations by product,
// tier, agent, and day. Contains no client data (see analytics.js).
app.get('/api/admin/analytics', adminLimiter, (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(analytics.getSummary({ days: req.query.days }));
});

// GET /api/admin/users — the list of admin accounts (never includes password data).
app.get('/api/admin/users', adminLimiter, (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ admins: adminAuth.listAdmins() });
});

// Catch-all for anything a route throws that it didn't handle itself.
// Must be registered AFTER every route.
app.use(logger.errorHandler);

// Only when started directly (`node server.js` / `npm start`). When this
// file is merely required — as the test suite does — we must not install
// process-wide handlers that would swallow a failing test's exceptions.
if (require.main === module) logger.installProcessHandlers();

app.listen(PORT, () => {
  console.log(`Medical Premium Illustrator API listening on port ${PORT}`);

  // Bootstrap the first real admin account, if none exists yet.
  const bootstrap = adminAuth.bootstrapAdminIfNeeded();
  if (bootstrap.created) {
    console.log(`  ✓ Created admin account "${bootstrap.username}" from ADMIN_BOOTSTRAP_USERNAME/PASSWORD.`);
  } else if (bootstrap.missingEnvVars) {
    console.warn('\n  ℹ  No admin accounts exist yet, and ADMIN_BOOTSTRAP_USERNAME/PASSWORD are not set.');
    console.warn('     The admin tools still work via the legacy ADMIN_SECRET in the meantime.');
    console.warn('     Set those two env vars and restart to create a real admin account.\n');
  }

  // Startup warnings. These are easy to miss in documentation, so they
  // are surfaced loudly at the moment the server actually starts.
  if (security.isUsingDefaultAdminSecret()) {
    console.warn('\n  ⚠  ADMIN_SECRET is not set — using the built-in default.');
    console.warn('     Anyone who knows the default can change branding and publish rates.');
    console.warn('     Set a real ADMIN_SECRET before any deployment reachable by others,');
    console.warn('     or better yet, set up a real admin account (see above).\n');
  }
  if (process.env.SMS_PROVIDER_CONFIGURED !== 'true') {
    console.warn('  ℹ  SMS is in dev mode — OTPs are printed to this console, not texted.');
    console.warn('     See backend/README.md to wire up a real SMS provider.\n');
  }
});
