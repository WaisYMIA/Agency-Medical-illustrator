// ============================================================
// Medical Premium Illustrator — Rate Engine (Backend / Node.js)
// Mirrors the JCare / J-Junior / JSenior Excel workbooks exactly.
// Each product is calculated fully independently — no shared logic
// or cross-referencing between products.
//
// This file, and the data.json it loads, never leave the server.
// The frontend only ever receives the final computed numbers.
// ============================================================

const DATA = require('./data.json');

function bandLookup(age, bands) {
  // bands: array of [min,max,key]
  for (const [lo, hi, key] of bands) {
    if (age >= lo && age <= hi) return key;
  }
  return null;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------
// JCARE
// ---------------------------------------------------------------
const JCARE_ADULT_BANDS = [[18,30,"18-30"],[31,40,"31-40"],[41,50,"41-50"],[51,59,"51-59"],[60,64,"60-64"]];
const JCARE_OUT_BANDS   = [[0,40,"<=40"],[41,50,"41-50"],[51,59,"51-59"],[60,64,"60-64"]];
const JCARE_SHARED_AGE_BANDS = [[18,40,"18-40"],[41,50,"41-50"],[51,59,"51-59"],[60,64,"60-64"]];

function calcJCareForTier(D, tierIdx, tiers) {
  // D = { principalAge, hasSpouse, spouseAge, numChildren,
  //       outpatient:'no'|'person'|'shared', maternity, dental, lastExpense,
  //       personalAccident, covid:'no'|option limit, covidLimit }
  const tier = tiers[tierIdx];
  const limit = tier.limit;
  const rows = []; // {label, inpatient, outpatient, maternity, dental, optical, lastExpense, personalAccident, covid, total}

  const pBand = bandLookup(D.principalAge, JCARE_ADULT_BANDS);
  const pInpatient = pBand ? DATA.JCARE.inpatientPrincipal[pBand][tierIdx] : 0;

  let sBand = null, sInpatient = 0;
  if (D.hasSpouse) {
    sBand = bandLookup(D.spouseAge, JCARE_ADULT_BANDS);
    sInpatient = sBand ? DATA.JCARE.inpatientSpouse[sBand][tierIdx] : 0;
  }
  const childInpatient = DATA.JCARE.inpatientChild[tierIdx];

  // Outpatient — per person mode
  const outLimitForTier = DATA.JCARE.outpatientLimits[tierIdx];
  let pOutpatient = 0, sOutpatient = 0, childOutpatientEach = 0;
  let sharedFamilyOutpatient = 0;
  let outpatientMode = D.outpatient; // 'no' | 'person' | 'shared'

  // Shared mode is ONLY computable when tier limit for outpatient is 150000 (Royal) or 200000 (Prestige)
  const sharedEligible = (outLimitForTier === 150000 || outLimitForTier === 200000) && D.outpatient === 'shared';

  let sharedFamilySizeUnsupported = false;
  if (D.outpatient === 'person') {
    if (pBand) {
      const pOutBand = bandLookup(D.principalAge, JCARE_OUT_BANDS);
      pOutpatient = pOutBand ? DATA.JCARE.outpatientPerson[pOutBand][tierIdx] : 0;
    }
    if (D.hasSpouse && sBand) {
      const sOutBand = bandLookup(D.spouseAge, JCARE_OUT_BANDS);
      sOutpatient = sOutBand ? DATA.JCARE.outpatientPerson[sOutBand][tierIdx] : 0;
    }
    if (D.numChildren > 0) {
      childOutpatientEach = DATA.JCARE.outpatientPerson["<=40"][tierIdx];
    }
  } else if (sharedEligible) {
    const oldestAdult = D.hasSpouse ? Math.max(D.principalAge, D.spouseAge) : D.principalAge;
    const ageBracket = bandLookup(oldestAdult, JCARE_SHARED_AGE_BANDS);
    if (ageBracket) {
      const extra = (D.hasSpouse ? 1 : 0) + (D.numChildren || 0);
      const col = extra; // 0 => M, 1 => M+1 ... index into array [M, M+1, M+2, M+3, M+4]
      const table = DATA.JCARE.outpatientShared[ageBracket] && DATA.JCARE.outpatientShared[ageBracket][outLimitForTier];
      if (table && col <= 4) {
        sharedFamilyOutpatient = table[col] || 0;
        if (!sharedFamilyOutpatient) sharedFamilySizeUnsupported = true;
      } else {
        sharedFamilySizeUnsupported = true;
      }
    } else {
      sharedFamilySizeUnsupported = true;
    }
  }
  // if D.outpatient === 'shared' but not sharedEligible -> 0 (matches Excel: shared only fires for Royal/Prestige columns)

  // Maternity — once, if principal or spouse covered by inpatient
  let maternity = 0;
  if (D.maternity && (pBand || sBand)) {
    const idx = DATA.JCARE.maternity.limits.indexOf(limitAtTier(DATA.JCARE.maternity, tierIdx));
    maternity = DATA.JCARE.maternity.premium[tierIdx];
  }

  // Dental / Optical — per covered person (principal, spouse if present, each child) if dental=Yes AND
  // outpatient toggle is enabled in EITHER mode (matches workbook: gated on D17="Yes" OR D18="Yes", regardless of tier eligibility)
  const dentalOpticalAllowed = D.dental && (D.outpatient === 'person' || D.outpatient === 'shared');
  const dentalEach = dentalOpticalAllowed ? DATA.JCARE.dental.premium[tierIdx] : 0;
  const opticalEach = dentalOpticalAllowed ? DATA.JCARE.optical.premium[tierIdx] : 0;

  // Last Expense — per covered person, if lastExpense=Yes
  const lastExpenseEach = D.lastExpense ? DATA.JCARE.lastExpense.premium[tierIdx] : 0;

  // Personal Accident — per covered person, if personalAccident=Yes
  const personalAccidentEach = D.personalAccident ? DATA.JCARE.personalAccident.premium[tierIdx] : 0;

  // Covid — per covered person, if covid=Yes and covidLimit matches this comparison's fixed option (option is chosen once, same across tiers)
  let covidEach = 0;
  if (D.covid && D.covidLimit) {
    const ci = DATA.JCARE.covid.limits.indexOf(D.covidLimit);
    if (ci >= 0) covidEach = DATA.JCARE.covid.premium[ci];
  }

  function memberRow(label, inpatient, outpatient, hasMaternity, includeDentalOptical, includeLastExpense, includePA, includeCovid) {
    const dental = includeDentalOptical ? dentalEach : 0;
    const optical = includeDentalOptical ? opticalEach : 0;
    const le = includeLastExpense ? lastExpenseEach : 0;
    const pa = includePA ? personalAccidentEach : 0;
    const cv = includeCovid ? covidEach : 0;
    const mat = hasMaternity ? maternity : 0;
    const total = inpatient + outpatient + mat + dental + optical + le + pa + cv;
    return { label, inpatient, outpatient, maternity: mat, dental, optical, lastExpense: le, personalAccident: pa, covid: cv, total };
  }

  if (pBand) {
    // Shared family outpatient is attributed to the Principal's row, matching the workbook's own display convention
    const pOut = D.outpatient === 'person' ? pOutpatient : (sharedEligible ? sharedFamilyOutpatient : 0);
    // Workbook rule: Principal never receives Last Expense or Personal Accident payouts under JCare
    rows.push(memberRow('Principal', pInpatient, pOut, D.maternity, true, false, false, true));
  }
  if (D.hasSpouse && sBand) {
    const sOut = D.outpatient === 'person' ? sOutpatient : 0;
    rows.push(memberRow('Spouse', sInpatient, sOut, false, true, true, true, true));
  }
  for (let i = 1; i <= (D.numChildren || 0); i++) {
    const cOut = D.outpatient === 'person' ? childOutpatientEach : 0;
    // Workbook rule: each child receives Last Expense, but not Personal Accident
    rows.push(memberRow('Child ' + i, childInpatient, cOut, false, true, true, false, true));
  }

  let basicPremium = rows.reduce((s, r) => s + r.total, 0);

  const stampDuty = basicPremium > 0 ? DATA.JCARE.stampDuty : 0;
  const levy = basicPremium > 0 ? round2(basicPremium * DATA.JCARE.levyRate) : 0;
  const totalPremium = basicPremium > 0 ? round2(basicPremium + stampDuty + levy) : 0;

  return {
    tier, rows, sharedFamilyOutpatient: sharedEligible ? sharedFamilyOutpatient : 0,
    basicPremium: round2(basicPremium), stampDuty, levy, totalPremium,
    sharedUnavailable: D.outpatient === 'shared' && !sharedEligible,
    sharedFamilySizeUnsupported: D.outpatient === 'shared' && sharedEligible && sharedFamilySizeUnsupported,
  };
}
function limitAtTier(table, tierIdx) { return table.limits[tierIdx]; }

function calcJCare(D) {
  const tiers = DATA.JCARE.tiers;
  const results = tiers.map((t, i) => calcJCareForTier(D, i, tiers));
  return results;
}

// ---------------------------------------------------------------
// JUNIOR
// ---------------------------------------------------------------
function calcJuniorForTier(D, tierIdx, tiers) {
  const tier = tiers[tierIdx];
  const rows = [];
  const inpatientEach = DATA.JUNIOR.inpatientChild[tierIdx];
  const outpatientEach = D.outpatient ? DATA.JUNIOR.outpatientChild[tierIdx] : 0;
  const dentalEach = D.dental ? DATA.JUNIOR.dental.premium[tierIdx] : 0;
  const opticalEach = D.dental ? DATA.JUNIOR.optical.premium[tierIdx] : 0; // optical mirrors dental toggle
  let covidEach = 0;
  if (D.covid && D.covidLimit) {
    const ci = DATA.JUNIOR.covid.limits.indexOf(D.covidLimit);
    if (ci >= 0) covidEach = DATA.JUNIOR.covid.premium[ci];
  }

  for (let i = 1; i <= (D.numChildren || 0); i++) {
    const total = inpatientEach + outpatientEach + dentalEach + opticalEach + covidEach;
    rows.push({ label: 'Child ' + i, inpatient: inpatientEach, outpatient: outpatientEach,
      dental: dentalEach, optical: opticalEach, covid: covidEach, total });
  }

  const basicPremium = rows.reduce((s, r) => s + r.total, 0);
  const stampDuty = basicPremium > 0 ? DATA.JUNIOR.stampDuty : 0;
  const levy = basicPremium > 0 ? round2(basicPremium * DATA.JUNIOR.levyRate) : 0;
  const totalPremium = basicPremium > 0 ? round2(basicPremium + stampDuty + levy) : 0;

  return { tier, rows, basicPremium: round2(basicPremium), stampDuty, levy, totalPremium };
}

function calcJunior(D) {
  const tiers = DATA.JUNIOR.tiers;
  return tiers.map((t, i) => calcJuniorForTier(D, i, tiers));
}

// ---------------------------------------------------------------
// JSENIOR
// ---------------------------------------------------------------
const SENIOR_BANDS = [[65,69,"65-69"],[70,74,"70-74"],[75,79,"75-79"]];

function calcSeniorForTier(D, tierIdx, tiers) {
  const tier = tiers[tierIdx];
  const loading = D.coPayment ? 1 : DATA.JSENIOR.coPaymentLoading; // co-payment=Yes -> x1, No -> x1.1
  const rows = [];

  const pBand = bandLookup(D.principalAge, SENIOR_BANDS);
  const pInpatientBase = pBand ? DATA.JSENIOR.inpatientPrincipal[pBand][tierIdx] : 0;
  const pInpatient = pInpatientBase * loading;

  let sBand = null, sInpatient = 0;
  if (D.hasSpouse) {
    sBand = bandLookup(D.spouseAge, SENIOR_BANDS);
    sInpatient = sBand ? DATA.JSENIOR.inpatientSpouse[sBand][tierIdx] * loading : 0;
  }
  const childInpatientEach = DATA.JSENIOR.inpatientChild[tierIdx] * loading;

  let pOutpatient = 0, sOutpatient = 0, childOutpatientEach = 0;
  if (D.outpatient) {
    if (pBand) pOutpatient = DATA.JSENIOR.outpatientAdult[pBand][tierIdx] * loading;
    if (D.hasSpouse && sBand) sOutpatient = DATA.JSENIOR.outpatientAdult[sBand][tierIdx] * loading;
    if (D.numChildren > 0) childOutpatientEach = DATA.JSENIOR.outpatientChild[tierIdx] * loading;
  }

  const dentalEach = D.dental ? DATA.JSENIOR.dental.premium[tierIdx] : 0;
  const opticalEach = D.dental ? DATA.JSENIOR.optical.premium[tierIdx] : 0;

  // Last Expense & Personal Accident: SPOUSE ONLY (per workbook rule)
  const lastExpenseSpouse = (D.lastExpense && D.hasSpouse && sBand) ? DATA.JSENIOR.lastExpenseSpouse[sBand][tierIdx] : 0;
  const personalAccidentSpouse = (D.personalAccident && D.hasSpouse) ? DATA.JSENIOR.personalAccidentSpouse.premium[tierIdx] : 0;

  let covidEach = 0;
  if (D.covid && D.covidLimit) {
    const ci = DATA.JSENIOR.covid.limits.indexOf(D.covidLimit);
    if (ci >= 0) covidEach = DATA.JSENIOR.covid.premium[ci];
  }

  if (pBand) {
    const total = pInpatient + pOutpatient + dentalEach + opticalEach + covidEach;
    rows.push({ label: 'Principal', inpatient: round2(pInpatient), outpatient: round2(pOutpatient),
      dental: dentalEach, optical: opticalEach, lastExpense: 0, personalAccident: 0, covid: covidEach, total: round2(total) });
  }
  if (D.hasSpouse && sBand) {
    const total = sInpatient + sOutpatient + dentalEach + opticalEach + lastExpenseSpouse + personalAccidentSpouse + covidEach;
    rows.push({ label: 'Spouse', inpatient: round2(sInpatient), outpatient: round2(sOutpatient),
      dental: dentalEach, optical: opticalEach, lastExpense: round2(lastExpenseSpouse), personalAccident: round2(personalAccidentSpouse),
      covid: covidEach, total: round2(total) });
  }
  for (let i = 1; i <= (D.numChildren || 0); i++) {
    const total = childInpatientEach + childOutpatientEach + dentalEach + opticalEach + covidEach;
    rows.push({ label: 'Child ' + i, inpatient: round2(childInpatientEach), outpatient: round2(childOutpatientEach),
      dental: dentalEach, optical: opticalEach, lastExpense: 0, personalAccident: 0, covid: covidEach, total: round2(total) });
  }

  const basicPremium = rows.reduce((s, r) => s + r.total, 0);
  const stampDuty = basicPremium > 0 ? DATA.JSENIOR.stampDuty : 0;
  const levy = basicPremium > 0 ? round2(basicPremium * DATA.JSENIOR.levyRate) : 0;
  const totalPremium = basicPremium > 0 ? round2(basicPremium + stampDuty + levy) : 0;

  return { tier, rows, basicPremium: round2(basicPremium), stampDuty, levy, totalPremium };
}

function calcSenior(D) {
  const tiers = DATA.JSENIOR.tiers;
  return tiers.map((t, i) => calcSeniorForTier(D, i, tiers));
}

module.exports = {
  DATA,
  calcJCare,
  calcJunior,
  calcSenior,
};
