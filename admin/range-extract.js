// ============================================================
// Medical Premium Illustrator — Range Extraction (Phase 2 prototype)
// ============================================================
//
// Pure functions for turning a cell-range string like "D6:I6" plus a
// SheetJS worksheet object into a plain JS array of values. Kept
// separate from the rest of admin/rate-import.html so this logic can
// be tested head-on, without a browser, against fabricated worksheet
// objects shaped the way SheetJS actually produces them.

function colLettersToIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n; // 1-based (A=1)
}

function indexToColLetters(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function parseCellRef(ref) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
  if (!m) throw new Error('Invalid cell reference: "' + ref + '"');
  return { col: colLettersToIndex(m[1].toUpperCase()), row: parseInt(m[2], 10) };
}

// Parses "D6:I6" or "D6:D11" or a single cell "D6" into a flat, ordered
// list of cell addresses. Only supports single-row or single-column
// ranges deliberately — rate tables in the workbooks seen so far are
// always one or the other, and restricting this makes mistakes (like
// accidentally selecting a 2D block) surface immediately as an error
// rather than silently extracting the wrong shape.
function parseRange(rangeStr) {
  const clean = (rangeStr || '').trim();
  if (!clean) throw new Error('Range is empty.');
  if (!clean.includes(':')) {
    return [parseCellRef(clean)];
  }
  const [startRef, endRef] = clean.split(':');
  const start = parseCellRef(startRef);
  const end = parseCellRef(endRef);
  if (start.row !== end.row && start.col !== end.col) {
    throw new Error('Range "' + rangeStr + '" spans both rows and columns — only a single row or single column is supported.');
  }
  const cells = [];
  if (start.row === end.row) {
    const lo = Math.min(start.col, end.col), hi = Math.max(start.col, end.col);
    for (let c = lo; c <= hi; c++) cells.push({ col: c, row: start.row });
  } else {
    const lo = Math.min(start.row, end.row), hi = Math.max(start.row, end.row);
    for (let r = lo; r <= hi; r++) cells.push({ col: start.col, row: r });
  }
  return cells;
}

function cellAddress(cell) {
  return indexToColLetters(cell.col) + cell.row;
}

// worksheet: a SheetJS-style worksheet object, i.e. { "D6": {v: 21316.11, t:'n'}, "E6": {...}, ... }
function extractRange(worksheet, rangeStr, { expectNumeric } = {}) {
  const cells = parseRange(rangeStr);
  return cells.map(cell => {
    const addr = cellAddress(cell);
    const cellObj = worksheet[addr];
    if (!cellObj || cellObj.v === undefined || cellObj.v === null || cellObj.v === '') {
      throw new Error('Cell ' + addr + ' is empty — check the range "' + rangeStr + '".');
    }
    if (expectNumeric && typeof cellObj.v !== 'number') {
      throw new Error('Cell ' + addr + ' ("' + cellObj.v + '") is not a number — check the range "' + rangeStr + '".');
    }
    return cellObj.v;
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseRange, extractRange, colLettersToIndex, indexToColLetters, cellAddress };
}
