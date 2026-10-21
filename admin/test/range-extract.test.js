// ============================================================
// Tests for range-extract.js — parsing cell ranges like "D6:I6" and
// extracting values from a SheetJS-shaped worksheet object.
//
// Run with: node --test admin/test/range-extract.test.js
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRange, extractRange } = require('../range-extract.js');

test('parseRange handles a single-row range', () => {
  const cells = parseRange('D6:I6');
  assert.equal(cells.length, 6);
  assert.deepEqual(cells[0], { col: 4, row: 6 });
  assert.deepEqual(cells[5], { col: 9, row: 6 });
});

test('parseRange handles a single-column range', () => {
  const cells = parseRange('D6:D11');
  assert.equal(cells.length, 6);
  assert.deepEqual(cells[0], { col: 4, row: 6 });
  assert.deepEqual(cells[5], { col: 4, row: 11 });
});

test('parseRange handles a single cell', () => {
  const cells = parseRange('D6');
  assert.equal(cells.length, 1);
  assert.deepEqual(cells[0], { col: 4, row: 6 });
});

test('parseRange rejects a genuinely two-dimensional range', () => {
  assert.throws(() => parseRange('D6:I11'), /single row or single column/);
});

test('parseRange rejects an empty string', () => {
  assert.throws(() => parseRange(''), /empty/);
});

test('parseRange handles reversed order (end before start) gracefully', () => {
  const cells = parseRange('I6:D6');
  assert.equal(cells.length, 6, 'should still produce all 6 cells regardless of which end was typed first');
});

test('extractRange pulls real values matching an actual JCare inpatient row', () => {
  const values = [22569.40309569475, 26708.913, 32026.5792, 40374.87299999999, 50772.6941288919, 58178.201395087235];
  const ws = {};
  ['D', 'E', 'F', 'G', 'H', 'I'].forEach((col, i) => { ws[col + '8'] = { v: values[i] }; });
  const extracted = extractRange(ws, 'D8:I8', { expectNumeric: true });
  assert.deepEqual(extracted, values);
});

test('extractRange throws a clear error on a missing cell', () => {
  const ws = { D8: { v: 100 }, E8: { v: 200 } };
  assert.throws(() => extractRange(ws, 'D8:G8', { expectNumeric: true }), /empty/);
});

test('extractRange throws a clear error when a non-numeric value is found but numeric was expected', () => {
  const ws = { D8: { v: 'N/A' }, E8: { v: 200 } };
  assert.throws(() => extractRange(ws, 'D8:E8', { expectNumeric: true }), /not a number/);
});

test('extractRange works down a column, not just across a row', () => {
  const ws = { P6: { v: 30 }, P7: { v: 40 }, P8: { v: 50 }, P9: { v: 59 }, P10: { v: 64 } };
  assert.deepEqual(extractRange(ws, 'P6:P10', { expectNumeric: true }), [30, 40, 50, 59, 64]);
});

test('extractRange does not require expectNumeric for text values', () => {
  const ws = { D6: { v: 'Classic' }, E6: { v: 'Premier' } };
  assert.deepEqual(extractRange(ws, 'D6:E6'), ['Classic', 'Premier']);
});
