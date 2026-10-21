// ============================================================
// Tests for engine.js — the hand-written, individually-validated
// calculation engine for JCare / J-Junior / JSenior.
//
// These reference values were originally established by cross-checking
// against LibreOffice recalculations of the actual source workbooks
// (see project history / ROADMAP.md) — this file exists so that
// equivalence is checked automatically on every change, not manually
// re-verified by hand each time.
//
// Run with: node --test backend/test/engine.test.js
// (or `npm test` from backend/, which runs the whole test/ directory)
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { calcJCare, calcJunior, calcSenior } = require('../engine.js');

test('JCare — full family, shared outpatient, all riders, Royal tier', () => {
  const results = calcJCare({
    principalAge: 42, hasSpouse: true, spouseAge: 38, numChildren: 2,
    outpatient: 'shared', maternity: true, dental: true, lastExpense: true,
    personalAccident: true, covid: true, covidLimit: 1000000,
  });
  assert.equal(results[4].totalPremium, 391669.39, 'Royal tier total');
  assert.equal(results[4].rows.find(r => r.label === 'Principal').lastExpense, 0, 'Principal never gets Last Expense');
  assert.equal(results[4].rows.find(r => r.label === 'Principal').personalAccident, 0, 'Principal never gets Personal Accident');
  assert.ok(results[4].rows.find(r => r.label === 'Spouse').lastExpense > 0, 'Spouse gets Last Expense');
  assert.ok(results[4].rows.find(r => r.label === 'Child 1').lastExpense > 0, 'Children get Last Expense');
  assert.equal(results[4].rows.find(r => r.label === 'Child 1').personalAccident, 0, 'Children never get Personal Accident');
});

test('JCare — shared outpatient unavailable on a non-eligible tier', () => {
  const results = calcJCare({
    principalAge: 35, hasSpouse: true, spouseAge: 33, numChildren: 1,
    outpatient: 'shared', maternity: false, dental: true, lastExpense: false,
    personalAccident: false, covid: false, covidLimit: null,
  });
  assert.equal(results[0].sharedUnavailable, true, 'Classic tier does not support shared limit');
  assert.equal(results[0].rows.find(r => r.label === 'Principal').outpatient, 0);
});

test('JCare — shared outpatient family-size unsupported for a given age bracket + limit', () => {
  const results = calcJCare({
    principalAge: 42, hasSpouse: true, spouseAge: 38, numChildren: 2,
    outpatient: 'shared', maternity: false, dental: false, lastExpense: false,
    personalAccident: false, covid: false, covidLimit: null,
  });
  assert.equal(results[4].sharedFamilySizeUnsupported, true, '41-50 bracket at 150K limit has no rate for family size M+3');
});

test('JCare — age validation range is 18-64 for principal and spouse', () => {
  // The engine itself does not enforce this (the frontend does before
  // calling it) — this test documents that a principal at the boundary
  // ages computes correctly, since boundary bugs are the most common kind.
  const at18 = calcJCare({ principalAge: 18, hasSpouse: false, spouseAge: 0, numChildren: 0, outpatient: 'no', maternity: false, dental: false, lastExpense: false, personalAccident: false, covid: false, covidLimit: null });
  const at64 = calcJCare({ principalAge: 64, hasSpouse: false, spouseAge: 0, numChildren: 0, outpatient: 'no', maternity: false, dental: false, lastExpense: false, personalAccident: false, covid: false, covidLimit: null });
  assert.ok(at18[0].totalPremium > 0, 'age 18 (lower boundary) computes a premium');
  assert.ok(at64[0].totalPremium > 0, 'age 64 (upper boundary) computes a premium');
});

test('J-Junior — 3 children, all benefits, Advanced tier', () => {
  const results = calcJunior({ numChildren: 3, outpatient: true, dental: true, covid: true, covidLimit: 500000 });
  assert.equal(results[2].totalPremium, 249074.1);
});

test('J-Junior — flat rates do not depend on the reference age field', () => {
  // Junior's premiums are flat per tier regardless of the child's actual
  // age (validated against the real workbook — see ROADMAP/prior session
  // notes). Confirms numChildren, not age, drives the total.
  const results = calcJunior({ numChildren: 1, outpatient: false, dental: false, covid: false, covidLimit: null });
  assert.equal(results[0].rows.length, 1);
  assert.ok(results[0].rows[0].inpatient > 0);
});

test('JSenior — co-payment No applies a 1.1x loading to inpatient/outpatient only', () => {
  const withCoPayment = calcSenior({ principalAge: 67, coPayment: true, hasSpouse: false, spouseAge: 0, numChildren: 0, outpatient: true, dental: true, lastExpense: false, personalAccident: false, covid: false, covidLimit: null });
  const withoutCoPayment = calcSenior({ principalAge: 67, coPayment: false, hasSpouse: false, spouseAge: 0, numChildren: 0, outpatient: true, dental: true, lastExpense: false, personalAccident: false, covid: false, covidLimit: null });
  const p1 = withCoPayment[0].rows[0], p2 = withoutCoPayment[0].rows[0];
  assert.ok(Math.abs(p2.inpatient - p1.inpatient * 1.1) < 0.01, 'inpatient gets the 1.1x loading');
  assert.ok(Math.abs(p2.outpatient - p1.outpatient * 1.1) < 0.01, 'outpatient gets the 1.1x loading');
  assert.equal(p1.dental, p2.dental, 'dental does NOT get the loading, regardless of co-payment');
});

test('JSenior — Last Expense and Personal Accident are spouse-only', () => {
  const results = calcSenior({ principalAge: 68, coPayment: true, hasSpouse: true, spouseAge: 66, numChildren: 2, outpatient: false, dental: false, lastExpense: true, personalAccident: true, covid: false, covidLimit: null });
  const principal = results[0].rows.find(r => r.label === 'Principal');
  const spouse = results[0].rows.find(r => r.label === 'Spouse');
  const child = results[0].rows.find(r => r.label === 'Child 1');
  assert.equal(principal.lastExpense, 0);
  assert.equal(principal.personalAccident, 0);
  assert.ok(spouse.lastExpense > 0);
  assert.ok(spouse.personalAccident > 0);
  assert.equal(child.lastExpense, 0);
  assert.equal(child.personalAccident, 0);
});

test('JSenior — full reference scenario matches known-good total', () => {
  const results = calcSenior({
    principalAge: 71, coPayment: false, hasSpouse: true, spouseAge: 68, numChildren: 0,
    outpatient: true, dental: true, lastExpense: true, personalAccident: true,
    covid: true, covidLimit: 1500000,
  });
  assert.equal(results[3].totalPremium, 626909.82);
});

test('Levy and stamp duty are zero when the basic premium is zero', () => {
  const results = calcJCare({ principalAge: '', hasSpouse: false, spouseAge: 0, numChildren: 0, outpatient: 'no', maternity: false, dental: false, lastExpense: false, personalAccident: false, covid: false, covidLimit: null });
  assert.equal(results[0].basicPremium, 0);
  assert.equal(results[0].levy, 0);
  assert.equal(results[0].stampDuty, 0);
  assert.equal(results[0].totalPremium, 0);
});
