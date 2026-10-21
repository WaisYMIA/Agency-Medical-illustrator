// ============================================================
// Tests proving generic-engine.js (schema-driven) reproduces engine.js
// (hand-written) EXACTLY, scenario for scenario. This is the actual
// technical proof behind Phase 2 (guided rate import) — see
// ROADMAP.md. If this file ever fails, the schema/engine approach has
// stopped being trustworthy and Phase 2 cannot be relied on until it's
// fixed.
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { calcJCare, calcJunior, calcSenior } = require('../engine.js');
const { calcFromSchema } = require('../generic-engine.js');
const jcareSchema = require('../schemas/jcare.schema.json');
const juniorSchema = require('../schemas/junior.schema.json');
const seniorSchema = require('../schemas/jsenior.schema.json');

function assertResultsMatch(ref, gen, label) {
  for (let i = 0; i < ref.length; i++) {
    assert.equal(gen[i].totalPremium, ref[i].totalPremium, `${label} — tier ${i} totalPremium`);
    assert.equal(gen[i].basicPremium, ref[i].basicPremium, `${label} — tier ${i} basicPremium`);
    assert.equal(!!gen[i].sharedUnavailable, !!ref[i].sharedUnavailable, `${label} — tier ${i} sharedUnavailable`);
    assert.equal(!!gen[i].sharedFamilySizeUnsupported, !!ref[i].sharedFamilySizeUnsupported, `${label} — tier ${i} sharedFamilySizeUnsupported`);
  }
}

const jcareScenarios = [
  ['single principal, person mode, everything off', { principalAge: 35, hasSpouse: false, spouseAge: 0, numChildren: 0, outpatient: 'person', maternity: false, dental: false, lastExpense: false, personalAccident: false, covid: false, covidLimit: null }],
  ['full family, all riders, person mode', { principalAge: 42, hasSpouse: true, spouseAge: 38, numChildren: 2, outpatient: 'person', maternity: true, dental: true, lastExpense: true, personalAccident: true, covid: true, covidLimit: 1000000 }],
  ['shared mode, Royal tier, full family', { principalAge: 42, hasSpouse: true, spouseAge: 38, numChildren: 2, outpatient: 'shared', maternity: true, dental: true, lastExpense: true, personalAccident: true, covid: true, covidLimit: 1000000 }],
  ['shared mode, family-size unsupported', { principalAge: 42, hasSpouse: true, spouseAge: 38, numChildren: 2, outpatient: 'shared', maternity: false, dental: false, lastExpense: false, personalAccident: false, covid: false, covidLimit: null }],
  ['no spouse, 3 children', { principalAge: 40, hasSpouse: false, spouseAge: 0, numChildren: 3, outpatient: 'person', maternity: false, dental: false, lastExpense: true, personalAccident: true, covid: false, covidLimit: null }],
  ['older age band (60-64), all riders', { principalAge: 62, hasSpouse: false, spouseAge: 0, numChildren: 0, outpatient: 'person', maternity: false, dental: true, lastExpense: false, personalAccident: false, covid: true, covidLimit: 2000000 }],
  ['outpatient fully off', { principalAge: 30, hasSpouse: true, spouseAge: 28, numChildren: 1, outpatient: 'no', maternity: false, dental: false, lastExpense: false, personalAccident: false, covid: false, covidLimit: null }],
  ['spouse-scoped benefits with spouse present', { principalAge: 45, hasSpouse: true, spouseAge: 43, numChildren: 0, outpatient: 'person', maternity: false, dental: false, lastExpense: true, personalAccident: true, covid: false, covidLimit: null }],
  ['shared mode requested on ineligible tier', { principalAge: 35, hasSpouse: true, spouseAge: 33, numChildren: 1, outpatient: 'shared', maternity: false, dental: true, lastExpense: false, personalAccident: false, covid: false, covidLimit: null }],
  ['no principal age given', { principalAge: '', hasSpouse: false, spouseAge: 0, numChildren: 2, outpatient: 'person', maternity: false, dental: false, lastExpense: false, personalAccident: false, covid: false, covidLimit: null }],
  ['boundary ages 64 and 18', { principalAge: 64, hasSpouse: true, spouseAge: 18, numChildren: 0, outpatient: 'person', maternity: true, dental: true, lastExpense: true, personalAccident: true, covid: true, covidLimit: 1500000 }],
  ['7 children (max), Prestige tier, everything on', { principalAge: 50, hasSpouse: true, spouseAge: 48, numChildren: 7, outpatient: 'shared', maternity: true, dental: true, lastExpense: true, personalAccident: true, covid: true, covidLimit: 2000000 }],
];

jcareScenarios.forEach(([name, input]) => {
  test('JCare schema equivalence — ' + name, () => {
    assertResultsMatch(calcJCare(input), calcFromSchema(jcareSchema, input), name);
  });
});

const juniorScenarios = [
  ['3 children, all benefits on', { numChildren: 3, outpatient: true, dental: true, covid: true, covidLimit: 500000 }],
  ['1 child, nothing on', { numChildren: 1, outpatient: false, dental: false, covid: false, covidLimit: null }],
  ['7 children (max), dental only', { numChildren: 7, outpatient: false, dental: true, covid: false, covidLimit: null }],
];
juniorScenarios.forEach(([name, input]) => {
  test('J-Junior schema equivalence — ' + name, () => {
    assertResultsMatch(calcJunior(input), calcFromSchema(juniorSchema, input), name);
  });
});

const seniorScenarios = [
  ['co-payment Yes, all benefits', { principalAge: 71, coPayment: true, hasSpouse: true, spouseAge: 68, numChildren: 0, outpatient: true, dental: true, lastExpense: true, personalAccident: true, covid: true, covidLimit: 1500000 }],
  ['co-payment No, selective loading', { principalAge: 71, coPayment: false, hasSpouse: true, spouseAge: 68, numChildren: 0, outpatient: true, dental: true, lastExpense: true, personalAccident: true, covid: true, covidLimit: 1500000 }],
  ['boundary age 65', { principalAge: 65, coPayment: true, hasSpouse: false, spouseAge: 0, numChildren: 0, outpatient: false, dental: false, lastExpense: false, personalAccident: false, covid: false, covidLimit: null }],
  ['boundary age 79, co-payment No', { principalAge: 79, coPayment: false, hasSpouse: false, spouseAge: 0, numChildren: 0, outpatient: true, dental: true, lastExpense: false, personalAccident: false, covid: false, covidLimit: null }],
  ['principal + children, no spouse (spouse-only benefits never apply)', { principalAge: 67, coPayment: true, hasSpouse: false, spouseAge: 0, numChildren: 2, outpatient: true, dental: true, lastExpense: true, personalAccident: true, covid: true, covidLimit: 1000000 }],
];
seniorScenarios.forEach(([name, input]) => {
  test('JSenior schema equivalence — ' + name, () => {
    assertResultsMatch(calcSenior(input), calcFromSchema(seniorSchema, input), name);
  });
});
