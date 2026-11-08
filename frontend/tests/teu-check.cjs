/* Checks the shared TEU display rule (CA.numbers.teu in js/numbers.js) against the same table as
 * backend/tests/test_teu_rounding.py. Run from E:\c&a-newww:  node frontend\tests\teu-check.cjs */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'numbers.js'), 'utf8');
const win = {
  matchMedia: () => ({ matches: false }),
  document: { hidden: false, addEventListener() {} },
  performance: { now: () => 0 },
  requestAnimationFrame() {}, setTimeout, clearTimeout, WeakMap,
};
win.window = win;
vm.createContext(win);
vm.runInContext(src, win);
const N = win.CA.numbers;

const MINUS = '\u2212';
// [value, band, expected number, expected text]
const CASES = [
  [72.66, false, 73, '73'], [72.660565, false, 73, '73'], [72.01, false, 73, '73'], [72.0, false, 72, '72'],
  [28.000000000004, false, 28, '28'], [0.2, false, 1, '1'], [0, false, 0, '0'],
  [-11.67, false, -12, MINUS + '12'], [-8.66, false, -9, MINUS + '9'], [-8.0, false, -8, MINUS + '8'],
  [-11.673292, true, -12, MINUS + '12'], [-8.660565, true, -9, MINUS + '9'], [-8.0, true, -8, MINUS + '8'],
  [0.3, true, 0, '0'], [-0.3, true, 0, '0'], [0.5, true, 0, '0'], [-0.5, true, 0, '0'], [0.51, true, 1, '1'], [-0.51, true, -1, MINUS + '1'],
  [1e-9, false, 0, '0'], [-1e-9, false, 0, '0'], [1234.2, false, 1235, '1,235'],
];
let bad = 0;
function check(name, got, want) {
  if (got !== want || Object.is(got, -0)) { bad++; console.log('FAIL', name, 'got', JSON.stringify(got), 'want', JSON.stringify(want)); }
}
for (const [x, band, wantN, wantT] of CASES) {
  const v = N.teuValue(x, { band });
  check('value ' + x + (band ? ' band' : ''), v, wantN);
  check('text ' + x + (band ? ' band' : ''), N.teu(x, { band }), wantT);
}
check('null', N.teu(null), '\u2014');
check('undefined', N.teu(undefined), '\u2014');
check('NaN', N.teu(NaN), '\u2014');
check('empty option', N.teu(null, { empty: 'n/a' }), 'n/a');
check('signed +', N.teu(12.2, { sign: true }), '+13');
check('signed - ds', N.teu(-8.66, { sign: true, band: true }), MINUS + '9');
check('signed band 0', N.teu(0.3, { sign: true, band: true }), '0');
check('never -0 text', N.teu(-0.0000001), '0');
check('teuDsFmt', N.teuDsFmt(-8.660565), MINUS + '9');
check('teuFmt', N.teuFmt(72.660565), '73');
// CBM and percentage formatting is untouched (2 decimals)
check('cbm format', N.format(72.6605), '72.66');
console.log(bad ? bad + ' FAILED' : 'teu-check: all ' + (CASES.length * 2 + 11) + ' checks passed');
process.exit(bad ? 1 : 0);
