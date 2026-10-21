// ============================================================
// Tests for products-store.js — draft/publish workflow and schema
// validation for the guided rate import pipeline (Phase 2).
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshProducts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpi-products-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  delete require.cache[require.resolve('../db.js')];
  delete require.cache[require.resolve('../products-store.js')];
  return require('../products-store.js');
}

const validSchema = {
  id: 'TESTCO', name: 'TestCo Basic Cover',
  roles: ['principal'],
  roleEligibility: { principal: { min: 18, max: 60 } },
  tiers: [{ id: 'bronze', label: 'Bronze', limit: 300000 }, { id: 'silver', label: 'Silver', limit: 600000 }],
  levyRate: 0.0045, stampDuty: 40,
  benefits: {
    inpatient: { label: 'Inpatient', mandatory: true, includeRoles: ['principal'], rate: { type: 'flatPerTier', values: [15000, 25000] } },
  },
};

test('the three real reference schemas (JCare/Junior/JSenior) validate clean', () => {
  const products = freshProducts();
  const jcare = require('../schemas/jcare.schema.json');
  const junior = require('../schemas/junior.schema.json');
  const jsenior = require('../schemas/jsenior.schema.json');
  assert.deepEqual(products.validateSchema(jcare), []);
  assert.deepEqual(products.validateSchema(junior), []);
  assert.deepEqual(products.validateSchema(jsenior), []);
});

test('validateSchema catches a completely empty schema', () => {
  const products = freshProducts();
  const errors = products.validateSchema({});
  assert.ok(errors.length > 0);
  assert.ok(errors.some(e => e.includes('id')));
  assert.ok(errors.some(e => e.includes('tier')));
});

test('validateSchema requires at least one mandatory benefit', () => {
  const products = freshProducts();
  const schema = JSON.parse(JSON.stringify(validSchema));
  schema.benefits.inpatient.mandatory = false;
  const errors = products.validateSchema(schema);
  assert.ok(errors.some(e => e.includes('mandatory')));
});

test('validateSchema catches a value-count mismatch against the number of tiers', () => {
  const products = freshProducts();
  const schema = JSON.parse(JSON.stringify(validSchema));
  schema.benefits.inpatient.rate.values = [15000]; // only 1 value, but 2 tiers exist
  const errors = products.validateSchema(schema);
  assert.ok(errors.some(e => e.includes('value(s)') && e.includes('tier')));
});

test('validateSchema flags tiers listed out of ascending limit order', () => {
  const products = freshProducts();
  const schema = JSON.parse(JSON.stringify(validSchema));
  schema.tiers = [{ id: 'silver', label: 'Silver', limit: 600000 }, { id: 'bronze', label: 'Bronze', limit: 300000 }];
  const errors = products.validateSchema(schema);
  assert.ok(errors.some(e => e.includes('lower limit')));
});

test('saveDraft then getDraft round-trips correctly', () => {
  const products = freshProducts();
  products.saveDraft('TESTCO', validSchema);
  const draft = products.getDraft('TESTCO');
  assert.equal(draft.name, 'TestCo Basic Cover');
});

test('getPublished returns null before anything has been published', () => {
  const products = freshProducts();
  products.saveDraft('TESTCO', validSchema);
  assert.equal(products.getPublished('TESTCO'), null);
});

test('publish promotes the current draft to published', () => {
  const products = freshProducts();
  products.saveDraft('TESTCO', validSchema);
  const published = products.publish('TESTCO');
  assert.equal(published.name, 'TestCo Basic Cover');
  assert.equal(products.getPublished('TESTCO').name, 'TestCo Basic Cover');
});

test('publish with no draft returns null', () => {
  const products = freshProducts();
  assert.equal(products.publish('NEVERSAVED'), null);
});

test('listProducts reports draft/published status correctly', () => {
  const products = freshProducts();
  products.saveDraft('TESTCO', validSchema);
  let list = products.listProducts();
  assert.equal(list.find(p => p.id === 'TESTCO').hasDraft, true);
  assert.equal(list.find(p => p.id === 'TESTCO').hasPublished, false);

  products.publish('TESTCO');
  list = products.listProducts();
  assert.equal(list.find(p => p.id === 'TESTCO').hasPublished, true);
});

test('saving a new draft over a published product does not affect the live published version', () => {
  const products = freshProducts();
  products.saveDraft('TESTCO', validSchema);
  products.publish('TESTCO');

  const updated = JSON.parse(JSON.stringify(validSchema));
  updated.name = 'TestCo Basic Cover v2';
  products.saveDraft('TESTCO', updated);

  assert.equal(products.getPublished('TESTCO').name, 'TestCo Basic Cover', 'published stays on the old version');
  assert.equal(products.getDraft('TESTCO').name, 'TestCo Basic Cover v2', 'draft reflects the new version');
});
