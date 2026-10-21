// ============================================================
// Tests for admin-cli.js — adding, listing, resetting and removing admin
// accounts from the server's command line. Each test runs the REAL script
// in a separate process against its own database file.
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BACKEND = path.join(__dirname, '..');

function setup() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mpi-cli-test-')), 'cli.db');
  function run(args, { password, input } = {}) {
    const env = { ...process.env, DB_PATH: dbPath };
    delete env.ADMIN_CLI_PASSWORD;
    if (password) env.ADMIN_CLI_PASSWORD = password;
    const r = spawnSync(process.execPath, ['admin-cli.js', ...args], { cwd: BACKEND, env, input, encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr.replace(/\(node:\d+\)[^\n]*\n?|\(Use `node --trace-warnings[^\n]*\n?/g, '') };
  }
  function login(username, password) {
    process.env.DB_PATH = dbPath;
    delete require.cache[require.resolve('../db.js')];
    delete require.cache[require.resolve('../admin-auth.js')];
    const auth = require('../admin-auth.js');
    const result = auth.login(username, password);
    require('../db.js').close();
    return result;
  }
  return { run, login };
}

test('create makes an account that can sign in', () => {
  const { run, login } = setup();
  const r = run(['create', 'alice'], { password: 'alice-password-1' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Created admin account "alice"/);
  assert.equal(login('alice', 'alice-password-1').ok, true);
});

test('the password can be typed at a prompt instead of an environment variable', () => {
  const { run, login } = setup();
  const r = run(['create', 'bob'], { input: 'bob-typed-password\n' });
  assert.equal(r.code, 0, r.err);
  assert.equal(login('bob', 'bob-typed-password').ok, true);
});

test('create refuses a duplicate username with a plain message', () => {
  const { run } = setup();
  run(['create', 'alice'], { password: 'alice-password-1' });
  const r = run(['create', 'alice'], { password: 'another-password' });
  assert.equal(r.code, 1);
  assert.match(r.err, /already exists/);
});

test('create refuses a short password', () => {
  const { run } = setup();
  const r = run(['create', 'alice'], { password: 'short' });
  assert.equal(r.code, 1);
  assert.match(r.err, /at least 8/);
});

test('list shows accounts and never prints a password or hash', () => {
  const { run } = setup();
  run(['create', 'alice'], { password: 'alice-password-1' });
  const r = run(['list']);
  assert.match(r.out, /alice/);
  assert.ok(!/alice-password-1|hash|salt/i.test(r.out));
});

test('set-password resets a forgotten password', () => {
  const { run, login } = setup();
  run(['create', 'alice'], { password: 'forgotten-password' });
  const r = run(['set-password', 'alice'], { password: 'recovered-password' });
  assert.equal(r.code, 0, r.err);
  assert.equal(login('alice', 'forgotten-password').ok, false);
  assert.equal(login('alice', 'recovered-password').ok, true);
});

test('remove deletes an account, but refuses to remove the last one', () => {
  const { run, login } = setup();
  run(['create', 'alice'], { password: 'alice-password-1' });
  run(['create', 'bob'], { password: 'bob-password-123' });
  assert.equal(run(['remove', 'bob']).code, 0);
  assert.equal(login('bob', 'bob-password-123').ok, false);

  const last = run(['remove', 'alice']);
  assert.equal(last.code, 1);
  assert.match(last.err, /only admin/);
});

test('unknown commands print usage instead of doing something', () => {
  const { run } = setup();
  const r = run(['explode']);
  assert.equal(r.code, 2);
  assert.match(r.out, /Usage/);
});
