// ============================================================
// Medical Premium Illustrator — Product Schema Store (Phase 2 prototype)
// ============================================================
//
// Holds draft and published rate schemas for products imported via the
// guided import wizard (admin/rate-import.html), as distinct from
// JCare/J-Junior/JSenior, which stay on the original hand-written,
// individually-validated engine.js — see ROADMAP.md Phase 2 for why
// those three are treated as the trusted reference rather than
// migrated onto this new path.
//
// Storage: a real SQLite database (db.js) — one row per product id,
// with the draft and published schema each stored as a JSON blob in
// their own column. Schemas are nested, variable-shaped objects (tiers,
// per-role rate tables, etc.), so storing them as JSON text rather than
// fully normalized SQL columns is the pragmatic choice here — the
// *data about* each product (id, timestamps, draft/published status)
// is still real queryable SQL, which is what listProducts() below
// actually needs.

const db = require('./db.js');

function rowToListEntry(row) {
  let draftName = null, publishedName = null;
  if (row.draft_json) { try { draftName = JSON.parse(row.draft_json).name; } catch (e) {} }
  if (row.published_json) { try { publishedName = JSON.parse(row.published_json).name; } catch (e) {} }
  return {
    id: row.id,
    name: draftName || publishedName || row.id,
    hasDraft: !!row.draft_json,
    hasPublished: !!row.published_json,
    publishedAt: row.published_at || null,
  };
}

function listProducts() {
  const rows = db.prepare('SELECT * FROM products ORDER BY id ASC').all();
  return rows.map(rowToListEntry);
}

function getDraft(id) {
  const row = db.prepare('SELECT draft_json FROM products WHERE id = ?').get(id);
  if (!row || !row.draft_json) return null;
  return JSON.parse(row.draft_json);
}

function getPublished(id) {
  const row = db.prepare('SELECT published_json FROM products WHERE id = ?').get(id);
  if (!row || !row.published_json) return null;
  return JSON.parse(row.published_json);
}

function saveDraft(id, schema) {
  const draftSavedAt = new Date().toISOString();
  const draftJson = JSON.stringify(schema);
  db.prepare(`
    INSERT INTO products (id, draft_json, draft_saved_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET draft_json = excluded.draft_json, draft_saved_at = excluded.draft_saved_at
  `).run(id, draftJson, draftSavedAt);
  return schema;
}

function publish(id) {
  const row = db.prepare('SELECT draft_json FROM products WHERE id = ?').get(id);
  if (!row || !row.draft_json) return null;
  const publishedAt = new Date().toISOString();
  db.prepare('UPDATE products SET published_json = ?, published_at = ? WHERE id = ?')
    .run(row.draft_json, publishedAt, id);
  return JSON.parse(row.draft_json);
}

function validateSchema(schema) {
  const errors = [];
  if (!schema || typeof schema !== 'object') return ['Schema must be an object.'];
  if (!schema.id || !String(schema.id).trim()) errors.push('Product id is required.');
  if (!schema.name || !String(schema.name).trim()) errors.push('Product name is required.');
  if (!Array.isArray(schema.tiers) || schema.tiers.length === 0) errors.push('At least one tier is required.');
  else {
    schema.tiers.forEach((t, i) => {
      if (!t.id || !t.label) errors.push(`Tier ${i + 1} is missing an id or label.`);
      if (typeof t.limit !== 'number' || t.limit <= 0) errors.push(`Tier ${i + 1} ("${t.label || '?'}") needs a positive numeric limit.`);
    });
    for (let i = 1; i < schema.tiers.length; i++) {
      if (schema.tiers[i].limit < schema.tiers[i - 1].limit) {
        errors.push(`Tier "${schema.tiers[i].label}" has a lower limit than "${schema.tiers[i - 1].label}" — check the tier order.`);
      }
    }
  }
  if (!Array.isArray(schema.roles) || schema.roles.length === 0) errors.push('At least one covered role is required (e.g. principal, spouse, child).');
  if (!schema.benefits || typeof schema.benefits !== 'object' || Object.keys(schema.benefits).length === 0) {
    errors.push('At least one benefit (e.g. inpatient) is required.');
  } else {
    const hasMandatory = Object.values(schema.benefits).some(b => b.mandatory);
    if (!hasMandatory) errors.push('At least one benefit should be marked mandatory (usually inpatient) — otherwise every illustration could total zero.');
    Object.entries(schema.benefits).forEach(([key, b]) => {
      if (!b.includeRoles || !Array.isArray(b.includeRoles) || b.includeRoles.length === 0) {
        errors.push(`Benefit "${key}" needs at least one role in includeRoles.`);
      }
      const someRoleInvalid = (b.includeRoles || []).some(r => !schema.roles.includes(r));
      if (someRoleInvalid) errors.push(`Benefit "${key}" includes a role not listed in the product's roles.`);
      if (!b.rate && !b.modes) errors.push(`Benefit "${key}" has no rate values defined.`);
      const tierCount = (schema.tiers || []).length;
      function checkValues(values, label) {
        if (Array.isArray(values) && values.length !== tierCount) {
          errors.push(`${label} has ${values.length} value(s) but the product has ${tierCount} tier(s) — these should match.`);
        }
      }
      if (b.rate && b.rate.type === 'flatPerTier') checkValues(b.rate.values, `Benefit "${key}"`);
      if (b.rate && b.rate.type === 'ageBandedPerRole') {
        Object.entries(b.rate.perRole || {}).forEach(([role, spec]) => {
          if (spec.flat) checkValues(spec.flat, `Benefit "${key}" (${role}, flat)`);
          if (spec.table) Object.entries(spec.table).forEach(([band, values]) => checkValues(values, `Benefit "${key}" (${role}, band ${band})`));
        });
      }
    });
  }
  if (typeof schema.levyRate !== 'number' || schema.levyRate < 0) errors.push('Levy rate must be a non-negative number (e.g. 0.0045 for 0.45%).');
  if (typeof schema.stampDuty !== 'number' || schema.stampDuty < 0) errors.push('Stamp duty must be a non-negative number.');
  return errors;
}

module.exports = { listProducts, getDraft, getPublished, saveDraft, publish, validateSchema };
