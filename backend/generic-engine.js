// ============================================================
// Medical Premium Illustrator — Generic Schema Engine (Phase 2 prototype)
// ============================================================
//
// This engine computes premiums from a PRODUCT SCHEMA (see
// schemas/jcare.schema.json for a fully worked example) instead of
// hand-written per-product JavaScript like engine.js's calcJCare().
//
// Why this exists: engine.js proves the *numbers* are right, product by
// product, hand-verified against each company's workbook. This file
// proves a different thing — that a NEW company's rates could be
// expressed as data (a schema) and computed correctly WITHOUT writing
// new calculation code for them. See ROADMAP.md, Phase 2.
//
// The acceptance test for this file is that, given the JCare schema
// (schemas/jcare.schema.json — a straight translation of the same rate
// tables engine.js's calcJCare() uses), it reproduces engine.js's
// output EXACTLY, scenario for scenario. That equivalence is what
// "proves the schema is expressive enough" rather than just asserted.

function bandLookup(age, bands) {
  for (const [lo, hi, key] of bands) {
    if (age >= lo && age <= hi) return key;
  }
  return null;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Resolves a per-role rate table entry for a given age, tier index, and
// role — used for the "ageBandedPerRole" rate type shared by inpatient
// and per-person outpatient.
function resolveAgeBandedValue(roleSpec, age, tierIdx) {
  if (!roleSpec) return 0;
  if (roleSpec.flat) return roleSpec.flat[tierIdx] || 0;
  if (roleSpec.fixedBand) return (roleSpec.table[roleSpec.fixedBand] || [])[tierIdx] || 0;
  const band = bandLookup(age, roleSpec.bands || []);
  if (!band) return 0;
  return (roleSpec.table[band] || [])[tierIdx] || 0;
}

function resolveFlatPerTier(rate, tierIdx) {
  return (rate.values || [])[tierIdx] || 0;
}

function resolveOptionsFlat(rate, chosenLimit) {
  const opt = (rate.options || []).find(o => o.limit === chosenLimit);
  return opt ? opt.premium : 0;
}

// Determines whether a benefit is "switched on" for this calculation,
// following mandatory / toggle / mirrorsToggleOf / gatedBy rules.
function isBenefitActive(schema, key, benefit, D) {
  if (benefit.mandatory) return true;
  if (benefit.mirrorsToggleOf) {
    return isBenefitActive(schema, benefit.mirrorsToggleOf, schema.benefits[benefit.mirrorsToggleOf], D);
  }
  if (benefit.gatedBy === 'outpatientEnabled') {
    // Generic stand-in for "requires the outpatient toggle/mode to be on"
    return !!D[key] && D.outpatient && D.outpatient !== 'no';
  }
  if (benefit.toggle) {
    const v = D[key];
    if (typeof v === 'string') return v !== 'no' && v !== '';
    return !!v;
  }
  return false;
}

function calcMemberBenefit(schema, key, benefit, D, role, age, tierIdx) {
  if (!isBenefitActive(schema, key, benefit, D)) return 0;
  if (!benefit.includeRoles.includes(role)) return 0;

  let value = 0;
  if (key === 'outpatient' && benefit.modes) {
    // Outpatient's per-person mode is role/age-driven like inpatient;
    // its "shared" mode is handled separately at the tier level (it's
    // attributed to a single row, not computed per-member), so this
    // function only ever resolves the 'person' mode.
    const mode = D.outpatient;
    if (mode !== 'person') return 0;
    const roleSpec = benefit.modes.person.rate.perRole[role];
    value = resolveAgeBandedValue(roleSpec, age, tierIdx);
  } else {
    const rate = benefit.rate;
    if (!rate) return 0;
    if (rate.type === 'ageBandedPerRole') value = resolveAgeBandedValue(rate.perRole[role], age, tierIdx);
    else if (rate.type === 'flatPerTier') value = resolveFlatPerTier(rate, tierIdx);
    else if (rate.type === 'optionsFlat') value = resolveOptionsFlat(rate, D[key + 'Limit']);
  }

  // Conditional loading multiplier (e.g. JSenior: co-payment=No applies a
  // 1.1x loading, but only to the specific benefits marked as affected —
  // not universally to every benefit).
  if (benefit.appliesLoading && schema.loadings && schema.loadings[benefit.appliesLoading]) {
    if (D[benefit.appliesLoading] === false) {
      value = value * schema.loadings[benefit.appliesLoading].falseMultiplier;
    }
  }

  return value;
}

// Computes the JCare-style "shared family outpatient limit" pattern.
// This is intentionally its own function rather than a fully generic
// rule, because it's the one pattern seen so far that doesn't reduce to
// "a value per role per age band per tier" — see ROADMAP.md Phase 2 for
// why a genuinely novel pricing pattern from a future company would
// still need this kind of dedicated handling rather than pure config.
function calcSharedOutpatient(benefit, D, tierIdx, schema) {
  const modeSpec = benefit.modes && benefit.modes.shared;
  if (!modeSpec) return { value: 0, unavailable: false, sizeUnsupported: false };
  const tierLimit = modeSpec.outpatientLimitsByTier[tierIdx];
  const eligible = modeSpec.eligibleTierLimits.includes(tierLimit);
  if (!eligible) return { value: 0, unavailable: true, sizeUnsupported: false };

  const oldestAdult = D.hasSpouse ? Math.max(D.principalAge, D.spouseAge) : D.principalAge;
  const bracket = bandLookup(oldestAdult, modeSpec.ageBracketBands);
  if (!bracket) return { value: 0, unavailable: false, sizeUnsupported: true };

  const extra = (D.hasSpouse ? 1 : 0) + (D.numChildren || 0);
  const table = modeSpec.table[bracket] && modeSpec.table[bracket][tierLimit];
  if (!table || extra > 4) return { value: 0, unavailable: false, sizeUnsupported: true };
  const value = table[extra] || 0;
  return { value, unavailable: false, sizeUnsupported: !value };
}

function calcTierFromSchema(schema, D, tierIdx) {
  const tier = schema.tiers[tierIdx];
  const rows = [];
  const benefitKeys = Object.keys(schema.benefits);

  // Determine which member "instances" exist for this input.
  const members = [];
  if (schema.roles.includes('principal')) {
    const pElig = schema.roleEligibility.principal;
    if (D.principalAge !== undefined && D.principalAge !== null && D.principalAge !== '' &&
        D.principalAge >= pElig.min && D.principalAge <= pElig.max) {
      members.push({ role: 'principal', label: 'Principal', age: D.principalAge, index: 0 });
    }
  }
  if (schema.roles.includes('spouse') && D.hasSpouse) {
    const sElig = schema.roleEligibility.spouse;
    if (D.spouseAge >= sElig.min && D.spouseAge <= sElig.max) {
      members.push({ role: 'spouse', label: 'Spouse', age: D.spouseAge, index: 0 });
    }
  }
  if (schema.roles.includes('child')) {
    for (let i = 1; i <= (D.numChildren || 0); i++) {
      members.push({ role: 'child', label: 'Child ' + i, age: 0, index: i });
    }
  }

  let sharedResult = null;
  const outpatientBenefit = schema.benefits.outpatient;
  if (outpatientBenefit && outpatientBenefit.modes && D.outpatient === 'shared') {
    sharedResult = calcSharedOutpatient(outpatientBenefit, D, tierIdx, schema);
  }

  members.forEach(m => {
    const rowValues = {};
    let total = 0;
    benefitKeys.forEach(key => {
      const benefit = schema.benefits[key];
      let value = 0;

      if (key === 'outpatient' && sharedResult) {
        // Shared mode is attributed to a single role (usually principal), not computed per role.
        const attributeRole = outpatientBenefit.modes.shared.attributeToRole;
        value = (m.role === attributeRole && m.index === 0) ? sharedResult.value : 0;
      } else if (benefit.onceForFamily) {
        // e.g. maternity: only attributed to the first included role present, once.
        const eligiblePresent = (benefit.requireAnyOfRoles || []).some(r => members.some(mm => mm.role === r));
        const isAttributedRow = benefit.includeRoles.includes(m.role) && m.index === 0 &&
          members.findIndex(mm => benefit.includeRoles.includes(mm.role)) === members.indexOf(m);
        value = (eligiblePresent && isAttributedRow) ? calcMemberBenefit(schema, key, benefit, D, m.role, m.age, tierIdx) : 0;
      } else {
        value = calcMemberBenefit(schema, key, benefit, D, m.role, m.age, tierIdx);
      }

      rowValues[key] = value;
      total += value;
    });
    const roundRowFirst = !!schema.roundRowTotalsBeforeSum;
    rows.push({ label: m.label, ...rowValues, total: roundRowFirst ? round2(total) : total });
  });

  const basicPremium = rows.reduce((s, r) => s + r.total, 0);
  const stampDuty = basicPremium > 0 ? schema.stampDuty : 0;
  const levy = basicPremium > 0 ? round2(basicPremium * schema.levyRate) : 0;
  const totalPremium = basicPremium > 0 ? round2(basicPremium + stampDuty + levy) : 0;

  return {
    tier, rows,
    basicPremium: round2(basicPremium), stampDuty, levy, totalPremium,
    sharedUnavailable: sharedResult ? sharedResult.unavailable : false,
    sharedFamilySizeUnsupported: sharedResult ? sharedResult.sizeUnsupported : false,
  };
}

function calcFromSchema(schema, D) {
  return schema.tiers.map((t, i) => calcTierFromSchema(schema, D, i));
}

module.exports = { calcFromSchema };
