// ============================================================
// Medical Premium Illustrator — Branding Config Store (Phase 1 prototype)
// ============================================================
//
// One branding config, now stored as one row in a real SQLite database
// (db.js) instead of a JSON file. It exists to prove that the app's
// name, colors, and contact details can be externalized from hardcoded
// strings into something an admin can edit at runtime — see
// ROADMAP.md, Phase 1.
//
// When Phase 3 (true multi-tenancy) is built, this becomes "one config
// per company, keyed by tenant" instead of a single row — the shape of
// each individual config stays basically the same, and the underlying
// table just gains a company_id column plus one row per company.

const db = require('./db.js');

const DEFAULT_BRANDING = {
  companyName: 'Walter Jungah',
  productName: 'Medical Premium Illustrator',
  tagline: 'Instant Multi-Plan Quotations',
  logoInitial: 'M',
  colors: {
    primary: '#a6192e',
    primaryDark: '#3a0510',
    accent: '#b8892b',
  },
  contactPhone: '0798511366',
  contactEmail: 'walterjungah9@outlook.com',
  updatedAt: null,
};

function rowToBranding(row) {
  if (!row) return DEFAULT_BRANDING;
  return {
    companyName: row.company_name,
    productName: row.product_name,
    tagline: row.tagline,
    logoInitial: row.logo_initial,
    colors: {
      primary: row.color_primary,
      primaryDark: row.color_primary_dark,
      accent: row.color_accent,
    },
    contactPhone: row.contact_phone,
    contactEmail: row.contact_email,
    updatedAt: row.updated_at,
  };
}

function getBranding() {
  const row = db.prepare('SELECT * FROM branding WHERE id = 1').get();
  return rowToBranding(row);
}

function isValidHexColor(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}

function mergeBranding(current, input) {
  return {
    ...current,
    ...input,
    colors: { ...current.colors, ...(input && input.colors ? input.colors : {}) },
  };
}

function validateBranding(input) {
  if (!input || typeof input !== 'object') return ['Branding payload must be an object.'];
  const merged = mergeBranding(getBranding(), input);
  const errors = [];
  if (!merged.companyName || !String(merged.companyName).trim()) errors.push('Company name is required.');
  if (!merged.productName || !String(merged.productName).trim()) errors.push('Product name is required.');
  if (merged.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(merged.contactEmail)) errors.push('Contact email looks invalid.');
  if (merged.colors) {
    if (merged.colors.primary && !isValidHexColor(merged.colors.primary)) errors.push('Primary color must be a hex value like #a6192e.');
    if (merged.colors.primaryDark && !isValidHexColor(merged.colors.primaryDark)) errors.push('Primary-dark color must be a hex value.');
    if (merged.colors.accent && !isValidHexColor(merged.colors.accent)) errors.push('Accent color must be a hex value.');
  }
  if (merged.logoInitial && String(merged.logoInitial).length > 3) errors.push('Logo initial should be at most a few characters.');
  return errors;
}

function saveBranding(input) {
  const merged = mergeBranding(getBranding(), input);
  merged.updatedAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO branding (id, company_name, product_name, tagline, logo_initial, color_primary, color_primary_dark, color_accent, contact_phone, contact_email, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      company_name = excluded.company_name, product_name = excluded.product_name,
      tagline = excluded.tagline, logo_initial = excluded.logo_initial,
      color_primary = excluded.color_primary, color_primary_dark = excluded.color_primary_dark,
      color_accent = excluded.color_accent, contact_phone = excluded.contact_phone,
      contact_email = excluded.contact_email, updated_at = excluded.updated_at
  `).run(
    merged.companyName, merged.productName, merged.tagline, merged.logoInitial,
    merged.colors.primary, merged.colors.primaryDark, merged.colors.accent,
    merged.contactPhone, merged.contactEmail, merged.updatedAt
  );

  return merged;
}

module.exports = { getBranding, saveBranding, validateBranding, DEFAULT_BRANDING };
