// ============================================================
// Guided Rate Import Wizard — core logic
// (paired with admin/rate-import.html)
// ============================================================

const COMMON_BENEFITS = [
  { key: 'inpatient', label: 'Inpatient', mandatoryDefault: true },
  { key: 'outpatient', label: 'Outpatient', mandatoryDefault: false },
  { key: 'dental', label: 'Dental', mandatoryDefault: false },
  { key: 'optical', label: 'Optical (mirrors Dental)', mandatoryDefault: false, mirrorsOnly: true },
  { key: 'maternity', label: 'Maternity', mandatoryDefault: false },
  { key: 'lastExpense', label: 'Last Expense', mandatoryDefault: false },
  { key: 'personalAccident', label: 'Personal Accident', mandatoryDefault: false },
  { key: 'covid', label: 'Covid-19', mandatoryDefault: false },
];

function makeInitialState() {
  const state = {
    workbook: null,
    sheetNames: [],
    activeSheet: null,
    product: {
      id: '', name: '', roles: ['principal', 'spouse', 'child'],
      roleEligibility: { principal: { min: 18, max: 64 }, spouse: { min: 18, max: 64 }, child: { min: 0, max: 17 } },
      levyRate: 0.0045, stampDuty: 40,
    },
    tiers: [],
    benefits: {},
  };
  COMMON_BENEFITS.forEach(b => ensureBenefit(state, b.key, b.label));
  return state;
}

function ensureBenefit(state, key, label) {
  if (!state.benefits[key]) {
    state.benefits[key] = {
      label: label || key,
      included: false,
      includeRoles: [],
      rateType: 'flatPerTier',
      flatRange: '',
      flatExtracted: null,
      perRole: {}, // role -> { mode: 'flat'|'banded', flatRange, flatExtracted, bands: [{label,min,max,range,extracted}] }
    };
  }
  return state.benefits[key];
}

// ---------------- Schema assembly ----------------
function buildSchema(state) {
  const errors = [];
  const p = state.product;
  if (!p.id.trim()) errors.push('Product id is required.');
  if (!p.name.trim()) errors.push('Product name is required.');
  if (state.tiers.length === 0) errors.push('At least one tier is required.');

  const benefits = {};
  Object.entries(state.benefits).forEach(([key, b]) => {
    if (!b.included) return;
    const def = COMMON_BENEFITS.find(cb => cb.key === key);
    if (def && def.mirrorsOnly) return; // optical handled via mirrorsToggleOf below, not its own toggle
    const includeRoles = b.includeRoles.filter(r => state.product.roles.includes(r));
    if (includeRoles.length === 0) { errors.push(`Benefit "${b.label}" needs at least one role selected.`); return; }

    let rate;
    if (b.rateType === 'flatPerTier') {
      if (!b.flatExtracted) { errors.push(`Benefit "${b.label}" — extract its rate values before saving.`); return; }
      rate = { type: 'flatPerTier', values: b.flatExtracted };
    } else if (b.rateType === 'ageBandedPerRole') {
      const perRole = {};
      let ok = true;
      includeRoles.forEach(role => {
        const rSpec = b.perRole[role];
        if (!rSpec) { ok = false; return; }
        if (rSpec.mode === 'flat') {
          if (!rSpec.flatExtracted) { ok = false; return; }
          perRole[role] = { flat: rSpec.flatExtracted };
        } else {
          const bands = (rSpec.bands || []).filter(bd => bd.extracted);
          if (bands.length === 0) { ok = false; return; }
          const table = {};
          const bandDefs = [];
          bands.forEach(bd => { table[bd.label] = bd.extracted; bandDefs.push([Number(bd.min), Number(bd.max), bd.label]); });
          perRole[role] = { bands: bandDefs, table };
        }
      });
      if (!ok) { errors.push(`Benefit "${b.label}" — every included role needs its rate extracted before saving.`); return; }
      rate = { type: 'ageBandedPerRole', perRole };
    }

    benefits[key] = {
      label: b.label,
      mandatory: !!(def && def.mandatoryDefault),
      toggle: !(def && def.mandatoryDefault),
      includeRoles,
      rate,
    };
  });

  // Optical mirrors dental automatically if dental is included
  if (state.benefits.dental && state.benefits.dental.included && state.benefits.optical && state.benefits.optical.included) {
    const opticalB = state.benefits.optical;
    const includeRoles = opticalB.includeRoles.filter(r => state.product.roles.includes(r));
    if (opticalB.rateType === 'flatPerTier' && opticalB.flatExtracted && includeRoles.length) {
      benefits.optical = {
        label: 'Optical', mirrorsToggleOf: 'dental', includeRoles,
        rate: { type: 'flatPerTier', values: opticalB.flatExtracted },
      };
    }
  }

  if (Object.keys(benefits).length === 0) errors.push('At least one benefit must be included.');

  const roleEligibility = {};
  state.product.roles.forEach(r => { roleEligibility[r] = state.product.roleEligibility[r]; });

  const schema = {
    id: p.id.trim(), name: p.name.trim(),
    roles: state.product.roles,
    roleEligibility,
    tiers: state.tiers,
    levyRate: Number(p.levyRate), stampDuty: Number(p.stampDuty),
    benefits,
  };

  return { schema, errors };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { COMMON_BENEFITS, makeInitialState, ensureBenefit, buildSchema };
}
