// ============================================================
// Tests for branding-store.js — config storage, partial-update
// merging, and validation.
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshBranding() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpi-branding-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  delete require.cache[require.resolve('../db.js')];
  delete require.cache[require.resolve('../branding-store.js')];
  return require('../branding-store.js');
}

test('getBranding returns sensible defaults when nothing has been saved', () => {
  const branding = freshBranding();
  const b = branding.getBranding();
  assert.equal(b.companyName, 'Walter Jungah');
  assert.equal(b.productName, 'Medical Premium Illustrator');
  assert.ok(/^#[0-9a-fA-F]{6}$/.test(b.colors.primary));
});

test('saveBranding merges a partial update without clobbering other fields', () => {
  const branding = freshBranding();
  branding.saveBranding({ colors: { accent: '#00aa55' } });
  const b = branding.getBranding();
  assert.equal(b.colors.accent, '#00aa55');
  assert.equal(b.companyName, 'Walter Jungah', 'unrelated fields are untouched');
  assert.equal(b.colors.primary, '#a6192e', 'unrelated color fields are untouched');
});

test('validateBranding rejects a payload that would blank out the company name', () => {
  const branding = freshBranding();
  const errors = branding.validateBranding({ companyName: '' });
  assert.ok(errors.some(e => e.includes('Company name')));
});

test('validateBranding validates against the MERGED result, not the raw partial payload', () => {
  // A partial update that only changes the accent color must not be
  // rejected for "missing company name" just because this specific
  // request didn't include one.
  const branding = freshBranding();
  const errors = branding.validateBranding({ colors: { accent: '#112233' } });
  assert.deepEqual(errors, []);
});

test('validateBranding rejects an invalid hex color', () => {
  const branding = freshBranding();
  const errors = branding.validateBranding({ colors: { primary: 'notacolor' } });
  assert.ok(errors.some(e => e.includes('hex value')));
});

test('validateBranding rejects an invalid email', () => {
  const branding = freshBranding();
  const errors = branding.validateBranding({ contactEmail: 'not-an-email' });
  assert.ok(errors.some(e => e.toLowerCase().includes('email')));
});

test('saveBranding stamps an updatedAt timestamp', () => {
  const branding = freshBranding();
  const saved = branding.saveBranding({ companyName: 'Acme' });
  assert.ok(saved.updatedAt);
  assert.ok(new Date(saved.updatedAt).getTime() > 0);
});
