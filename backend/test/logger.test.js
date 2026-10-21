// ============================================================
// Tests for logger.js — structured logging and error reporting (Phase 4).
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

function freshLogger() {
  delete require.cache[require.resolve('../logger.js')];
  delete process.env.LOG_REQUESTS;
  delete process.env.ERROR_WEBHOOK_URL;
  const logger = require('../logger.js');
  logger._resetForTests();
  return logger;
}

// Synchronously captures whatever `fn` writes to a stream. The override is
// held only for the duration of the synchronous call, so it can't
// interfere with the test runner's own output.
function capture(stream, fn) {
  const lines = [];
  const original = process[stream].write;
  process[stream].write = (chunk) => { lines.push(String(chunk)); return true; };
  let result;
  try { result = fn(); } finally { process[stream].write = original; }
  return { result, lines, json: lines.filter(l => l.trim()).map(l => JSON.parse(l)) };
}

function mockRes(overrides) {
  const handlers = {};
  return {
    statusCode: 200, headersSent: false, body: null,
    on(evt, fn) { handlers[evt] = fn; },
    finish() { if (handlers.finish) handlers.finish(); },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { this.ended = true; },
    ...(overrides || {}),
  };
}

function startWebhookReceiver() {
  return new Promise((resolve) => {
    const received = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => { received.push(JSON.parse(body)); res.end('ok'); });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, received, url: `http://127.0.0.1:${server.address().port}/hook` }));
  });
}

// ---------------- Structured logging ----------------
test('log lines are single-line JSON with time, level and message', () => {
  const logger = freshLogger();
  const { json } = capture('stdout', () => logger.log.info('hello', { extra: 42 }));
  assert.equal(json.length, 1);
  assert.equal(json[0].level, 'info');
  assert.equal(json[0].message, 'hello');
  assert.equal(json[0].extra, 42);
  assert.ok(!Number.isNaN(Date.parse(json[0].time)));
});

test('errors go to stderr; info and warnings go to stdout', () => {
  const logger = freshLogger();
  assert.equal(capture('stderr', () => logger.log.error('bad')).json.length, 1);
  assert.equal(capture('stdout', () => logger.log.warn('careful')).json.length, 1);
  assert.equal(capture('stderr', () => logger.log.info('fine')).json.length, 0);
});

// ---------------- Request logging ----------------
test('request logging records method, path, status and duration', () => {
  const logger = freshLogger();
  const res = mockRes({ statusCode: 201 });
  const { json } = capture('stdout', () => {
    logger.requestLogger({ method: 'POST', path: '/api/calculate' }, res, () => {});
    res.finish();
  });
  assert.equal(json[0].message, 'request');
  assert.equal(json[0].method, 'POST');
  assert.equal(json[0].path, '/api/calculate');
  assert.equal(json[0].status, 201);
  assert.equal(typeof json[0].ms, 'number');
});

test('request logging NEVER records query strings, bodies, headers or IPs', () => {
  const logger = freshLogger();
  const res = mockRes();
  const req = {
    method: 'GET', path: '/api/agent/acceptances',
    url: '/api/agent/acceptances?phone=0724888057',
    query: { phone: '0724888057' },
    body: { clientName: 'SECRET-CLIENT' },
    headers: { 'x-admin-secret': 'SECRET-ADMIN', 'x-agent-token': 'SECRET-TOKEN' },
    socket: { remoteAddress: '203.0.113.7' },
  };
  const { lines } = capture('stdout', () => { logger.requestLogger(req, res, () => {}); res.finish(); });
  const out = lines.join('');
  for (const secret of ['0724888057', 'SECRET-CLIENT', 'SECRET-ADMIN', 'SECRET-TOKEN', '203.0.113.7']) {
    assert.ok(!out.includes(secret), `log must not contain ${secret}`);
  }
});

test('request logging skips non-API paths and the health probe', () => {
  const logger = freshLogger();
  for (const p of ['/', '/app.js', '/api/health']) {
    const res = mockRes();
    const { lines } = capture('stdout', () => { logger.requestLogger({ method: 'GET', path: p }, res, () => {}); res.finish(); });
    assert.equal(lines.length, 0, `${p} should not be logged`);
  }
});

test('request logging can be switched off with LOG_REQUESTS=false', () => {
  const logger = freshLogger();
  process.env.LOG_REQUESTS = 'false';
  const res = mockRes();
  let nextCalled = false;
  const { lines } = capture('stdout', () => { logger.requestLogger({ method: 'GET', path: '/api/x' }, res, () => { nextCalled = true; }); res.finish(); });
  assert.equal(lines.length, 0);
  assert.equal(nextCalled, true, 'still passes the request along');
  delete process.env.LOG_REQUESTS;
});

// ---------------- Error reporting ----------------
test('reportError logs the message and stack to stderr', () => {
  const logger = freshLogger();
  const { json } = capture('stderr', () => logger.reportError(new Error('boom'), { route: 'GET /x' }));
  assert.equal(json[0].level, 'error');
  assert.equal(json[0].message, 'boom');
  assert.equal(json[0].route, 'GET /x');
  assert.match(json[0].stack, /Error: boom/);
});

test('with no webhook configured, reportError just logs and resolves false', async () => {
  const logger = freshLogger();
  const { result } = capture('stderr', () => logger.reportError(new Error('quiet')));
  assert.equal(await result, false);
});

test('with a webhook configured, errors are POSTed with Slack/Discord-compatible fields', async () => {
  const logger = freshLogger();
  const rx = await startWebhookReceiver();
  process.env.ERROR_WEBHOOK_URL = rx.url;

  const { result } = capture('stderr', () => logger.reportError(new Error('database exploded'), { route: 'POST /api/calculate' }));
  assert.equal(await result, true);
  rx.server.close();

  assert.equal(rx.received.length, 1);
  const p = rx.received[0];
  assert.match(p.text, /database exploded/);
  assert.equal(p.content, p.text, 'Discord reads `content`, Slack reads `text`');
  assert.equal(p.route, 'POST /api/calculate');
  assert.ok(p.stack);
});

test('the webhook payload contains ONLY a fixed set of safe fields', async () => {
  const logger = freshLogger();
  const rx = await startWebhookReceiver();
  process.env.ERROR_WEBHOOK_URL = rx.url;
  const { result } = capture('stderr', () => logger.reportError(new Error('x'), { route: 'GET /y' }));
  await result;
  rx.server.close();
  assert.deepEqual(Object.keys(rx.received[0]).sort(), ['content', 'level', 'message', 'route', 'service', 'stack', 'text', 'time']);
});

test('identical errors are collapsed — a failure loop cannot flood the channel', async () => {
  const logger = freshLogger();
  const rx = await startWebhookReceiver();
  process.env.ERROR_WEBHOOK_URL = rx.url;
  const results = [];
  for (let i = 0; i < 4; i++) results.push(capture('stderr', () => logger.reportError(new Error('same problem'), { route: 'GET /z' })).result);
  await Promise.all(results);
  rx.server.close();
  assert.equal(rx.received.length, 1, 'only the first is sent');
});

test('webhook alerts are capped per minute', async () => {
  const logger = freshLogger();
  const rx = await startWebhookReceiver();
  process.env.ERROR_WEBHOOK_URL = rx.url;
  const results = [];
  for (let i = 0; i < 9; i++) results.push(capture('stderr', () => logger.reportError(new Error('distinct error ' + i))).result);
  await Promise.all(results);
  rx.server.close();
  assert.equal(rx.received.length, 5, 'capped at 5 per minute');
});

test('a dead webhook never throws or breaks error reporting', async () => {
  const logger = freshLogger();
  process.env.ERROR_WEBHOOK_URL = 'http://127.0.0.1:9/nothing-here';
  const { result } = capture('stderr', () => logger.reportError(new Error('still logged')));
  assert.equal(await result, false);
});

// ---------------- Express error handler ----------------
test('errorHandler returns a generic 500 and does NOT leak the internal error', () => {
  const logger = freshLogger();
  const res = mockRes();
  capture('stderr', () => logger.errorHandler(new Error('SELECT * FROM agents failed: secret path /var/db'), { method: 'GET', path: '/api/x' }, res, () => {}));
  assert.equal(res.statusCode, 500);
  assert.ok(!JSON.stringify(res.body).includes('SELECT'));
  assert.ok(!JSON.stringify(res.body).includes('/var/db'));
  assert.ok(res.body.error);
});

test('errorHandler still reports the real error to the log', () => {
  const logger = freshLogger();
  const { json } = capture('stderr', () => logger.errorHandler(new Error('the real cause'), { method: 'POST', path: '/api/y' }, mockRes(), () => {}));
  assert.equal(json[0].message, 'the real cause');
  assert.equal(json[0].route, 'POST /api/y');
});

test('errorHandler does not try to send a second response if headers already went out', () => {
  const logger = freshLogger();
  const res = mockRes({ headersSent: true });
  capture('stderr', () => logger.errorHandler(new Error('late'), { method: 'GET', path: '/api/z' }, res, () => {}));
  assert.equal(res.body, null, 'no JSON body written');
  assert.equal(res.ended, true, 'connection closed instead');
});
