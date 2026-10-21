// ============================================================
// Tests for db.js — proves the database actually PERSISTS data, which
// is the entire reason this replaced the earlier JSON-file storage.
//
// The critical test here spawns a genuinely separate Node process,
// writes data, lets that process exit, then reads it back from a new
// process. That's the real-world scenario that matters: a server
// restart, a redeploy, or a machine reboot must not lose agent
// verification records or published rates.
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BACKEND_DIR = path.join(__dirname, '..');

function runInSeparateProcess(dbPath, code) {
  return execFileSync(process.execPath, ['-e', code], {
    env: { ...process.env, DB_PATH: dbPath },
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'], // ignore stderr (Node's experimental-SQLite warning)
  }).trim();
}

test('data written by one process is readable by a completely separate process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpi-persist-test-'));
  const dbPath = path.join(dir, 'persist.db');

  // Process 1: write an agent, an acceptance record, and branding, then exit.
  const writeOutput = runInSeparateProcess(dbPath, `
    const store = require('./store.js');
    const branding = require('./branding-store.js');
    const agent = store.upsertAgent('0724888057', 'Walter Jungah');
    store.recordAcceptance({ agentToken: agent.agentToken, phone: '0724888057', agentName: 'Walter Jungah', termsVersion: '1.0-test', ip: '127.0.0.1' });
    branding.saveBranding({ companyName: 'Persisted Co' });
    console.log(agent.agentToken);
  `);
  assert.ok(writeOutput.length > 0, 'first process wrote an agent token');

  // Process 2: a brand new process, same database file.
  const readOutput = runInSeparateProcess(dbPath, `
    const store = require('./store.js');
    const branding = require('./branding-store.js');
    const agent = store.getAgentByPhone('0724888057');
    console.log(JSON.stringify({
      agentName: agent && agent.agentName,
      agentToken: agent && agent.agentToken,
      acceptances: store.getAcceptances('0724888057').length,
      companyName: branding.getBranding().companyName,
    }));
  `);
  const result = JSON.parse(readOutput);

  assert.equal(result.agentName, 'Walter Jungah', 'agent record survived the process boundary');
  assert.equal(result.agentToken, writeOutput, 'the same agent token is returned, not a regenerated one');
  assert.equal(result.acceptances, 1, 'terms acceptance audit record survived');
  assert.equal(result.companyName, 'Persisted Co', 'branding config survived');
});

test('a published product schema survives a process restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpi-persist-products-'));
  const dbPath = path.join(dir, 'persist.db');

  runInSeparateProcess(dbPath, `
    const products = require('./products-store.js');
    products.saveDraft('PERSISTCO', {
      id: 'PERSISTCO', name: 'Persist Co Cover', roles: ['principal'],
      roleEligibility: { principal: { min: 18, max: 60 } },
      tiers: [{ id: 'basic', label: 'Basic', limit: 500000 }],
      levyRate: 0.0045, stampDuty: 40,
      benefits: { inpatient: { label: 'Inpatient', mandatory: true, includeRoles: ['principal'], rate: { type: 'flatPerTier', values: [10000] } } },
    });
    products.publish('PERSISTCO');
    console.log('written');
  `);

  const readOutput = runInSeparateProcess(dbPath, `
    const products = require('./products-store.js');
    const published = products.getPublished('PERSISTCO');
    console.log(JSON.stringify({ name: published && published.name, listed: products.listProducts().length }));
  `);
  const result = JSON.parse(readOutput);

  assert.equal(result.name, 'Persist Co Cover', 'published schema survived the restart');
  assert.equal(result.listed, 1, 'product still appears in the product list');
});

test('the database is a single file that can be copied as a backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpi-backup-test-'));
  const dbPath = path.join(dir, 'original.db');
  const backupPath = path.join(dir, 'backup.db');

  runInSeparateProcess(dbPath, `
    const branding = require('./branding-store.js');
    branding.saveBranding({ companyName: 'Backup Test Co' });
    console.log('ok');
  `);

  assert.ok(fs.existsSync(dbPath), 'the database exists as a real file on disk');
  fs.copyFileSync(dbPath, backupPath);

  const restored = runInSeparateProcess(backupPath, `
    const branding = require('./branding-store.js');
    console.log(branding.getBranding().companyName);
  `);
  assert.equal(restored, 'Backup Test Co', 'a plain file copy is a working backup');
});
