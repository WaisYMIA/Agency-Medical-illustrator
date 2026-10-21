// ============================================================
// Tests for security.js — headers, rate limiting, and the hardened
// admin secret check (Phase 4).
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');

function freshSecurity() {
  delete require.cache[require.resolve('../security.js')];
  return require('../security.js');
}

function mockReqRes({ headers = {}, ip = '1.2.3.4' } = {}) {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
  const req = { headers, socket: { remoteAddress: ip } };
  return { req, res };
}

// ---------------- safeCompare ----------------
test('safeCompare returns true only for identical strings', () => {
  const security = freshSecurity();
  assert.equal(security.safeCompare('secret123', 'secret123'), true);
  assert.equal(security.safeCompare('secret123', 'secret124'), false);
  assert.equal(security.safeCompare('secret123', 'secret1234'), false, 'different lengths');
  assert.equal(security.safeCompare('', ''), true);
  assert.equal(security.safeCompare(undefined, 'x'), false);
});

// ---------------- Security headers ----------------
test('securityHeaders sets the expected baseline headers', () => {
  const security = freshSecurity();
  const { req, res } = mockReqRes();
  let nextCalled = false;
  security.securityHeaders(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true, 'calls next()');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.ok(res.headers['referrer-policy']);
  assert.ok(res.headers['permissions-policy']);
  assert.ok(res.headers['content-security-policy'].includes("default-src 'self'"));
  assert.ok(res.headers['content-security-policy'].includes("frame-ancestors 'none'"));
});

test('HSTS is only set when the request arrived over HTTPS', () => {
  const security = freshSecurity();

  const plain = mockReqRes();
  security.securityHeaders(plain.req, plain.res, () => {});
  assert.equal(plain.res.headers['strict-transport-security'], undefined,
    'no HSTS on plain HTTP — it would be wrong on local development');

  const https = mockReqRes({ headers: { 'x-forwarded-proto': 'https' } });
  security.securityHeaders(https.req, https.res, () => {});
  assert.ok(https.res.headers['strict-transport-security'], 'HSTS set when behind HTTPS');
});

test('CSP allows cdnjs, which the rate-import admin page needs for SheetJS', () => {
  const security = freshSecurity();
  const { req, res } = mockReqRes();
  security.securityHeaders(req, res, () => {});
  assert.ok(res.headers['content-security-policy'].includes('https://cdnjs.cloudflare.com'));
});

// ---------------- Rate limiting ----------------
test('rate limiter allows requests up to the limit then blocks with 429', () => {
  const security = freshSecurity();
  const limiter = security.createRateLimiter({ windowMs: 60000, max: 3 });

  for (let i = 0; i < 3; i++) {
    const { req, res } = mockReqRes();
    let passed = false;
    limiter(req, res, () => { passed = true; });
    assert.equal(passed, true, `request ${i + 1} should pass`);
  }

  const { req, res } = mockReqRes();
  let passed = false;
  limiter(req, res, () => { passed = true; });
  assert.equal(passed, false, '4th request is blocked');
  assert.equal(res.statusCode, 429);
  assert.ok(res.headers['retry-after'], 'sets a Retry-After header');
});

test('rate limiting is per-IP, not global', () => {
  const security = freshSecurity();
  const limiter = security.createRateLimiter({ windowMs: 60000, max: 2 });

  for (let i = 0; i < 2; i++) {
    const { req, res } = mockReqRes({ ip: '1.1.1.1' });
    limiter(req, res, () => {});
  }
  const blocked = mockReqRes({ ip: '1.1.1.1' });
  limiter(blocked.req, blocked.res, () => {});
  assert.equal(blocked.res.statusCode, 429, 'first IP is limited');

  const other = mockReqRes({ ip: '2.2.2.2' });
  let passed = false;
  limiter(other.req, other.res, () => { passed = true; });
  assert.equal(passed, true, 'a different IP is unaffected');
});

test('rate limiter honours x-forwarded-for, so it works behind a proxy', () => {
  const security = freshSecurity();
  const limiter = security.createRateLimiter({ windowMs: 60000, max: 1 });

  const first = mockReqRes({ headers: { 'x-forwarded-for': '9.9.9.9' }, ip: '10.0.0.1' });
  limiter(first.req, first.res, () => {});

  // Same forwarded client IP, different socket address (as a proxy would present it)
  const second = mockReqRes({ headers: { 'x-forwarded-for': '9.9.9.9' }, ip: '10.0.0.2' });
  let passed = false;
  limiter(second.req, second.res, () => { passed = true; });
  assert.equal(passed, false, 'same real client is limited even via different proxy sockets');
  assert.equal(second.res.statusCode, 429);
});

// ---------------- Admin secret ----------------
test('requireAdminSecret rejects a missing or wrong secret', () => {
  const security = freshSecurity();
  process.env.ADMIN_SECRET = 'correct-horse';

  const missing = mockReqRes({ ip: '5.5.5.1' });
  assert.equal(security.requireAdminSecret(missing.req, missing.res), false);
  assert.equal(missing.res.statusCode, 401);

  const wrong = mockReqRes({ headers: { 'x-admin-secret': 'nope' }, ip: '5.5.5.2' });
  assert.equal(security.requireAdminSecret(wrong.req, wrong.res), false);
  assert.equal(wrong.res.statusCode, 401);
});

test('requireAdminSecret accepts the correct secret', () => {
  const security = freshSecurity();
  process.env.ADMIN_SECRET = 'correct-horse';
  const { req, res } = mockReqRes({ headers: { 'x-admin-secret': 'correct-horse' }, ip: '5.5.5.3' });
  assert.equal(security.requireAdminSecret(req, res), true);
});

test('repeated failed admin attempts from one IP trigger a lockout', () => {
  const security = freshSecurity();
  process.env.ADMIN_SECRET = 'correct-horse';
  const ip = '6.6.6.6';

  for (let i = 0; i < 10; i++) {
    const { req, res } = mockReqRes({ headers: { 'x-admin-secret': 'wrong' }, ip });
    security.requireAdminSecret(req, res);
  }

  // Even the CORRECT secret is now refused, because this IP is locked out.
  const { req, res } = mockReqRes({ headers: { 'x-admin-secret': 'correct-horse' }, ip });
  assert.equal(security.requireAdminSecret(req, res), false);
  assert.equal(res.statusCode, 429, 'locked out, not merely unauthorized');
});

test('admin lockout is per-IP — one attacker does not lock out a legitimate admin', () => {
  const security = freshSecurity();
  process.env.ADMIN_SECRET = 'correct-horse';

  for (let i = 0; i < 10; i++) {
    const { req, res } = mockReqRes({ headers: { 'x-admin-secret': 'wrong' }, ip: '7.7.7.7' });
    security.requireAdminSecret(req, res);
  }

  const legit = mockReqRes({ headers: { 'x-admin-secret': 'correct-horse' }, ip: '8.8.8.8' });
  assert.equal(security.requireAdminSecret(legit.req, legit.res), true,
    'a different IP with the right secret still works');
});

test('a successful admin auth clears that IP failure count', () => {
  const security = freshSecurity();
  process.env.ADMIN_SECRET = 'correct-horse';
  const ip = '9.9.9.1';

  // A few failures, but below the lockout threshold
  for (let i = 0; i < 5; i++) {
    const { req, res } = mockReqRes({ headers: { 'x-admin-secret': 'wrong' }, ip });
    security.requireAdminSecret(req, res);
  }
  const good = mockReqRes({ headers: { 'x-admin-secret': 'correct-horse' }, ip });
  assert.equal(security.requireAdminSecret(good.req, good.res), true);

  // Failure count reset, so another 5 failures still shouldn't lock out
  for (let i = 0; i < 5; i++) {
    const { req, res } = mockReqRes({ headers: { 'x-admin-secret': 'wrong' }, ip });
    security.requireAdminSecret(req, res);
  }
  const stillOk = mockReqRes({ headers: { 'x-admin-secret': 'correct-horse' }, ip });
  assert.equal(security.requireAdminSecret(stillOk.req, stillOk.res), true);
});

test('isUsingDefaultAdminSecret detects an unset or default secret', () => {
  const security = freshSecurity();

  delete process.env.ADMIN_SECRET;
  assert.equal(security.isUsingDefaultAdminSecret(), true, 'unset counts as default');

  process.env.ADMIN_SECRET = 'dev-only-change-me';
  assert.equal(security.isUsingDefaultAdminSecret(), true, 'the literal default value');

  process.env.ADMIN_SECRET = 'a-real-secret';
  assert.equal(security.isUsingDefaultAdminSecret(), false);
});
