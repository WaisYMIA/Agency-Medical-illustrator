// ============================================================
// Tests for store.js — OTP generation/verification, agent records,
// and terms acceptance logging.
//
// Each run uses a fresh temp SQLite database file (via DB_PATH) so tests never
// touch real agent data and never interfere with each other.
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpi-store-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  delete require.cache[require.resolve('../db.js')];
  delete require.cache[require.resolve('../store.js')];
  const store = require('../store.js');
  return { store, dir };
}

test('normalizePhone converts local format to +254', () => {
  const { store } = freshStore();
  assert.equal(store.normalizePhone('0712345678'), '+254712345678');
  assert.equal(store.normalizePhone('254712345678'), '+254712345678');
  assert.equal(store.normalizePhone('+254712345678'), '+254712345678');
});

test('isValidKenyanPhone accepts valid formats and rejects invalid ones', () => {
  const { store } = freshStore();
  assert.equal(store.isValidKenyanPhone('0712345678'), true);
  assert.equal(store.isValidKenyanPhone('0112345678'), true);
  assert.equal(store.isValidKenyanPhone('12345'), false);
  assert.equal(store.isValidKenyanPhone(''), false);
  assert.equal(store.isValidKenyanPhone('0812345678'), false, '08 is not a valid Kenyan mobile prefix');
});

test('createOtp then verifyOtp with the correct code succeeds exactly once', () => {
  const { store } = freshStore();
  const result = store.createOtp('0712345678');
  assert.equal(result.rateLimited, false);
  assert.ok(/^\d{6}$/.test(result.otp));

  const verify1 = store.verifyOtp('0712345678', result.otp);
  assert.equal(verify1.ok, true);

  const verify2 = store.verifyOtp('0712345678', result.otp);
  assert.equal(verify2.ok, false, 'the same code cannot be used twice');
});

test('verifyOtp rejects an incorrect code without consuming the real one', () => {
  const { store } = freshStore();
  const result = store.createOtp('0712345678');
  const wrongCode = result.otp === '111111' ? '222222' : '111111';

  const failedAttempt = store.verifyOtp('0712345678', wrongCode);
  assert.equal(failedAttempt.ok, false);

  const correctAttempt = store.verifyOtp('0712345678', result.otp);
  assert.equal(correctAttempt.ok, true, 'the real code still works after a wrong attempt');
});

test('verifyOtp locks out after too many wrong attempts', () => {
  const { store } = freshStore();
  const result = store.createOtp('0712345678');
  const wrongCode = result.otp === '111111' ? '222222' : '111111';
  let lastAttempt;
  for (let i = 0; i < 6; i++) {
    lastAttempt = store.verifyOtp('0712345678', wrongCode);
  }
  assert.equal(lastAttempt.ok, false);
  const correctAfterLockout = store.verifyOtp('0712345678', result.otp);
  assert.equal(correctAfterLockout.ok, false, 'locked out even with the correct code after too many wrong attempts');
});

test('OTP requests are rate-limited per phone number', () => {
  const { store } = freshStore();
  store.createOtp('0712345678');
  store.createOtp('0712345678');
  store.createOtp('0712345678');
  const fourth = store.createOtp('0712345678');
  assert.equal(fourth.rateLimited, true, 'a 4th request within the window should be rate-limited');
});

test('rate limiting is per-phone-number, not global', () => {
  const { store } = freshStore();
  store.createOtp('0712345678');
  store.createOtp('0712345678');
  store.createOtp('0712345678');
  const otherNumber = store.createOtp('0798511366');
  assert.equal(otherNumber.rateLimited, false, 'a different phone number is unaffected');
});

test('upsertAgent creates a new agent record and reuses it on a second call', () => {
  const { store } = freshStore();
  const first = store.upsertAgent('0712345678', 'Walter Jungah');
  const second = store.upsertAgent('0712345678', 'Walter Jungah');
  assert.equal(first.agentToken, second.agentToken, 'the same phone number keeps the same token across calls');
});

test('getAgentByToken finds an agent created via upsertAgent', () => {
  const { store } = freshStore();
  const agent = store.upsertAgent('0712345678', 'Walter Jungah');
  const found = store.getAgentByToken(agent.agentToken);
  assert.equal(found.phone, '+254712345678');
});

test('getAgentByToken returns null for an unknown token', () => {
  const { store } = freshStore();
  assert.equal(store.getAgentByToken('not-a-real-token'), null);
});

test('recordAcceptance logs an entry retrievable by phone', () => {
  const { store } = freshStore();
  store.upsertAgent('0712345678', 'Walter Jungah');
  const entry = store.recordAcceptance({ phone: '0712345678', agentName: 'Walter Jungah', agentToken: 'tok-123', termsVersion: '1.0-2026-08-19', ip: '127.0.0.1' });
  assert.equal(entry.termsVersion, '1.0-2026-08-19');
  const history = store.getAcceptances('0712345678');
  assert.equal(history.length, 1);
});

test('recordAcceptance appends rather than overwrites on repeated acceptance', () => {
  const { store } = freshStore();
  store.recordAcceptance({ phone: '0712345678', agentName: 'Walter Jungah', agentToken: 'tok-123', termsVersion: '1.0', ip: '127.0.0.1' });
  store.recordAcceptance({ phone: '0712345678', agentName: 'Walter Jungah', agentToken: 'tok-123', termsVersion: '2.0', ip: '127.0.0.1' });
  const history = store.getAcceptances('0712345678');
  assert.equal(history.length, 2, 'both acceptances are kept, not the second overwriting the first');
});

// ---------------- Agent management (Phase 4) ----------------

test('listAgents returns every verified agent with acceptance counts', () => {
  const { store } = freshStore();
  const a1 = store.upsertAgent('0724888057', 'Walter Jungah');
  store.recordAcceptance({ agentToken: a1.agentToken, phone: '0724888057', agentName: 'Walter Jungah', termsVersion: '1.0', ip: '127.0.0.1' });
  store.upsertAgent('0712345678', 'Jane Test');

  const agents = store.listAgents();
  assert.equal(agents.length, 2);

  const walter = agents.find(a => a.phone === '+254724888057');
  assert.equal(walter.agentName, 'Walter Jungah');
  assert.equal(walter.acceptanceCount, 1);
  assert.ok(walter.lastAcceptedAt, 'includes when they last accepted');

  const jane = agents.find(a => a.phone === '+254712345678');
  assert.equal(jane.acceptanceCount, 0, 'an agent with no acceptances reports zero, not null');
});

test('listAgents returns an empty array when no agents exist', () => {
  const { store } = freshStore();
  assert.deepEqual(store.listAgents(), []);
});

test('revokeAgent removes the agent so their token stops working', () => {
  const { store } = freshStore();
  const agent = store.upsertAgent('0724888057', 'Walter Jungah');
  assert.ok(store.getAgentByToken(agent.agentToken), 'token works before revoke');

  assert.equal(store.revokeAgent('0724888057'), true);
  assert.equal(store.getAgentByToken(agent.agentToken), null, 'token no longer resolves after revoke');
  assert.equal(store.getAgentByPhone('0724888057'), null);
});

test('revokeAgent KEEPS the acceptance audit trail', () => {
  // This is deliberate and important: revoking access and erasing the
  // record that someone accepted responsibility are different things.
  // TERMS.md Sections 2/3 depend on that history surviving.
  const { store } = freshStore();
  const agent = store.upsertAgent('0724888057', 'Walter Jungah');
  store.recordAcceptance({ agentToken: agent.agentToken, phone: '0724888057', agentName: 'Walter Jungah', termsVersion: '1.0', ip: '127.0.0.1' });

  store.revokeAgent('0724888057');

  const history = store.getAcceptances('0724888057');
  assert.equal(history.length, 1, 'acceptance record survives revocation');
  assert.equal(history[0].termsVersion, '1.0');
});

test('revokeAgent returns false for an unknown phone number', () => {
  const { store } = freshStore();
  assert.equal(store.revokeAgent('0700000000'), false);
});

test('a revoked agent can re-verify and gets a NEW token', () => {
  const { store } = freshStore();
  const original = store.upsertAgent('0724888057', 'Walter Jungah');
  store.revokeAgent('0724888057');
  const reVerified = store.upsertAgent('0724888057', 'Walter Jungah');

  assert.notEqual(reVerified.agentToken, original.agentToken,
    'a fresh token is issued, so the old revoked one stays dead');
});
