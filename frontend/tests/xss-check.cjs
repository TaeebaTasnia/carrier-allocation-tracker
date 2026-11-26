/* XSS / CSP check for the frontend (no browser needed). Run from the repo root:
 *     node frontend/tests/xss-check.cjs
 * Exit code 0 = pass, 1 = fail (each problem is printed).
 *
 * 1. Every HTML sink in frontend/js (innerHTML / outerHTML assignment, insertAdjacentHTML,
 *    document.write) must be one of the AUDITED sites below, matched by file + exact line text
 *    (whitespace at the ends ignored), with the same number of occurrences. A new sink, a changed sink
 *    line or a removed one fails until someone audits it and updates this list. Each entry says why
 *    what reaches the sink cannot carry markup from data: static strings, the SVG constants, numbers,
 *    or text escaped by esc() (textContent -> innerHTML).
 *    Helpers that pass their argument on to a sink are audited at every call site too (FEEDERS), and
 *    so are the lines that build a value for a sink (BUILDERS) and the SVG constants (CONSTANTS, which
 *    must stay one plain string literal).
 * 2. No eval, new Function, string timers or javascript: URLs in frontend/js (CSP script-src 'self').
 * 3. The nine pages (index.html + the eight signed-in pages): no inline <script> without src, no
 *    inline event-handler attributes (onclick= ...), no javascript: URLs. HTML built in frontend/js
 *    must not carry on*= attributes either. Production serves a CSP with script-src 'self'.
 * frontend/mockups is not part of the app and is not checked.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'js');
const PAGES = ['index', 'dashboard', 'weekly', 'datewise', 'stuffing', 'summary', 'allocvsutil', 'export', 'settings'];

/* ---------- 1. audited sinks: [file, exact trimmed line, reason] ----------
 * (The 23 lines that mention innerHTML/insertAdjacentHTML in frontend/js, audited 2026-11-25: 22 sinks
 * below plus one read, export.js esc(), which turns text into escaped markup. dashboard.js:160 also
 * READS innerHTML on its right-hand side.) */
const SINKS = [
  ['allocvsutil.js', "m.innerHTML = P.CHECK + '<span></span>';",
    'static: the CHECK svg constant + an empty span; the message goes in with textContent afterwards'],
  ['dashboard.js', "lab.innerHTML = '<span class=\"cl__name\" data-ink></span>' +",
    'static markup over 3 lines (continuations below); the carrier name is set with textContent next line',
    ["'<span class=\"cl__left\" data-ink><span class=\"cl__v\">—</span><span class=\"cl__unit\"></span></span>' +",
     "'<span class=\"cl__pct\" data-ink></span>';"]],
  ['dashboard.js', "tip.innerHTML = '<p class=\"tip__title\"></p><dl class=\"tip__rows\"></dl>';",
    'static markup; the title is set with textContent'],
  ['dashboard.js', "$('#readout-rows').innerHTML = $('.tip__rows', j).innerHTML;",
    'copies a tooltip the page built with createElement + textContent (labels and P.teu/pct numbers); serialising escapes its text'],
  ['datewise.js', "var x = el('button', 'ovr__x'); x.type = 'button'; x.innerHTML = XSVG; x.setAttribute('aria-label', 'Clear the adjustment for ' + label + ' and use the computed value'); x.hidden = true;",
    'the XSVG constant; the label goes into an attribute via setAttribute, not into markup'],
  ['export.js', "b.querySelector('.ex__msg').innerHTML = html || '';",
    'state(box, s, html): every caller is audited in FEEDERS (static text, numbers, esc() text)'],
  ['export.js', "if (!n) { av.className = 'ex__avail is-none'; av.innerHTML = emptyNote(rangeWords(r)); return; }",
    'emptyNote(static) + rangeWords(r): r.year/from/to are integers from toInt() (parseInt), validated'],
  ['export.js', "if (!weeks.length) { av.className = 'ex__avail is-none'; av.innerHTML = emptyNote('for week ' + r.week + ' of ' + r.year); return; }",
    'emptyNote(static) with r.week/r.year integers from toInt(), validated'],
  ['export.js', "if (!weeks.length) { av.className = 'ex__avail is-none'; av.innerHTML = 'No week has data ' + esc(rangeWords(r)) + ', so there is nothing to download. <a class=\"link\" href=\"dashboard.html#uploads\">Upload the forecast</a> on the Overview first.'; return; }",
    'static text + esc()'],
  ['numbers.js', 'strip.innerHTML = html;',
    'html is built in BUILDERS from <i> and digits ((start + n) % 10), numbers only'],
  ['page.js', "s.innerHTML = '<rect x=\"2.6\" y=\"5\" width=\"8.8\" height=\"12.4\" rx=\"1.6\"/><path d=\"M3.5 1.2h7M4.3 1.2v1.9c0 .5-.4.9-.9 1.3-.6.4-.9 1-.9 1.7v10.6A2 2 0 0 0 4.5 18.7h5a2 2 0 0 0 2-2V6.1c0-.7-.3-1.3-.9-1.7-.5-.4-.9-.8-.9-1.3V1.2\"/>';",
    'static svg shapes'],
  ['settings.js', 'b.innerHTML = item.del ? UNDO : XSVG;', 'one of two svg CONSTANTS'],
  ['settings.js', "saveMsg.innerHTML = P.CHECK + '<span>Saved. Every week now uses these settings.</span>';", 'static'],
  ['settings.js', "else { m.innerHTML = P.CHECK + '<span></span>'; m.querySelector('span').textContent = t; m.style.color = ''; }",
    'static; the message t goes in with textContent'],
  ['shell.js', "if (script) script.insertAdjacentHTML('beforebegin', html);",
    'the top bar: static markup, PAGES hrefs and sel.year/sel.week (numbers from parseInt or +coercion). The signed-in email is NOT in it (set later with textContent)'],
  ['shell.js', "else document.body.insertAdjacentHTML('afterbegin', html);", 'same markup as the line above'],
  ['stuffing.js', "x.innerHTML = '<svg viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path d=\"M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8M7 7v4M9 7v4\"/></svg>';",
    'static svg'],
  ['stuffing.js', "if (st === 'saved') msg.insertAdjacentHTML('beforeend', P.CHECK);", 'the CHECK svg constant'],
  ['summary.js', "m.innerHTML = P.CHECK + '<span></span>';", 'static; the message goes in with textContent afterwards'],
  ['uploads.js', 'p.innerHTML = CHECK;', 'the CHECK svg constant'],
  ['weekly.js', "was.innerHTML = dirty ? 'saved <b>' + P.teu(saved[c] || 0) + '</b>' : '';",
    'static + P.teu(), which only returns digits, a minus sign or a dash'],
  ['weekly.js', "saveMsg.innerHTML = P.CHECK + '<span></span>';", 'static; the message goes in with textContent afterwards'],
];
// helpers whose argument reaches a sink: every call (definitions excluded) must be listed
const FEEDERS = {
  'export.js': {
    names: ['state', 'emptyNote'],
    calls: [
      ["if (!n) { av.className = 'ex__avail is-none'; av.innerHTML = emptyNote(rangeWords(r)); return; }", 'integers'],
      ["state('#s-state', 'busy', 'Preparing the workbook ' + esc(rangeWords(r)) + '…');", 'esc()'],
      ["state('#s-state', 'done', CHECK + '<span>Saved as <b>' + esc(f.name) + '</b>, ' + P.bytes(f.size) + '. Look in your Downloads folder.</span>');", 'esc() file name; P.bytes() is a number + unit'],
      ["state('#s-state', 'error', '<span>Not downloaded. ' + esc(err.message || 'Something went wrong.') + '</span>');", 'esc() server message'],
      ["if (!weeks.length) { av.className = 'ex__avail is-none'; av.innerHTML = emptyNote('for week ' + r.week + ' of ' + r.year); return; }", 'integers'],
      ["r.addEventListener('change', function () { state('#a-state', 'idle', ''); aCheck(); aLook(); });", 'empty'],
      ["state('#a-state', 'busy', 'Preparing the workbook for week ' + r.week + '…');", 'integer from toInt()'],
      ["state('#a-state', 'done', CHECK + '<span>Saved as <b>' + esc(f.name) + '</b>, ' + P.bytes(f.size) + '. Look in your Downloads folder.</span>');", 'esc()'],
      ["state('#a-state', 'error', '<span>Not downloaded. ' + esc(err.message || 'Something went wrong.') + '</span>');", 'esc()'],
      ["state('#a-state', 'busy', 'Saving week ' + wk.week + ', ' + (i + 1) + ' of ' + weeks.length + '…');", 'wk.week is the integer week from GET /reports/weekly-summary; counters'],
      ["state('#a-state', 'done', CHECK + '<span>Saved ' + saved.length + ' workbook' + (saved.length === 1 ? '' : 's') + ': <b>' + names + '</b>, ' + P.bytes(total) + ' in all.</span>');", 'names is built with esc() (BUILDERS)'],
      ["state('#a-state', 'error', '<span>Stopped after ' + saved.length + ' of ' + weeks.length + '. ' + esc(err.message || 'Something went wrong.') + '</span>');", 'counters + esc()'],
    ],
  },
};
// lines that build a value a sink receives
const BUILDERS = [
  ['export.js', "var names = saved.length > 1 ? esc(saved[0]) + '</b> to <b>' + esc(saved[saved.length - 1]) : esc(saved[0]);", 'esc() only', /var names =/],
  ['numbers.js', "for (var n = 0; n < len; n++) html += '<i>' + ((start + n) % 10) + '</i>';", 'digits only', /html\s*\+=/],
];
// svg constants fed to sinks: each must stay ONE plain string literal (no concatenation, no variables)
const CONSTANTS = [['page.js', 'CHECK'], ['uploads.js', 'CHECK'], ['datewise.js', 'XSVG'], ['settings.js', 'XSVG'], ['settings.js', 'UNDO']];

const problems = [];
const bad = (m) => problems.push(m);
const read = (p) => fs.readFileSync(p, 'utf8');
const linesOf = (text) => text.split(/\r?\n/).map((l) => l.trim());

const SINK_RE = /\.(innerHTML|outerHTML)\s*\+?=(?!=)|insertAdjacentHTML\s*\(|document\.write(ln)?\s*\(/;
const jsFiles = fs.readdirSync(JS).filter((n) => n.endsWith('.js')).sort();
const files = {};
for (const f of jsFiles) files[f] = linesOf(read(path.join(JS, f)));

function countIn(f, text) { return (files[f] || []).filter((l) => l === text).length; }

// 1a. every sink line in the code is audited, the same number of times
const expected = {};
for (const [f, line] of SINKS) { const k = f + '\u0000' + line; expected[k] = (expected[k] || 0) + 1; }
const seen = {};
for (const f of jsFiles) {
  files[f].forEach((l, i) => {
    if (!SINK_RE.test(l)) return;
    const k = f + '\u0000' + l;
    seen[k] = (seen[k] || 0) + 1;
    if (!expected[k]) bad(`unaudited HTML sink ${f}:${i + 1}: ${l}`);
  });
}
for (const k of Object.keys(expected)) {
  const [f, line] = k.split('\u0000');
  if ((seen[k] || 0) !== expected[k]) bad(`audited sink ${f} found ${seen[k] || 0} time(s), expected ${expected[k]} (changed or removed? re-audit and update this list): ${line}`);
}
// 1b. continuation lines of multi-line sinks
for (const [f, line, , cont] of SINKS) {
  if (!cont) continue;
  const L = files[f] || [];
  const at = L.indexOf(line);
  if (at < 0) continue;   // reported above
  cont.forEach((c, j) => { if (L[at + 1 + j] !== c) bad(`sink continuation changed in ${f} after "${line}": expected ${c}, found ${L[at + 1 + j]}`); });
}
// 1c. feeder call sites
for (const f of Object.keys(FEEDERS)) {
  const { names, calls } = FEEDERS[f];
  const callRe = new RegExp('(^|[^\\w.])(' + names.join('|') + ')\\s*\\(');
  const defRe = new RegExp('function\\s+(' + names.join('|') + ')\\s*\\(');
  const want = {};
  for (const [c] of calls) want[c] = (want[c] || 0) + 1;
  const got = {};
  (files[f] || []).forEach((l, i) => {
    if (!callRe.test(l) || defRe.test(l)) return;
    got[l] = (got[l] || 0) + 1;
    if (!want[l]) bad(`unaudited call of a sink helper (${names.join('/')}) ${f}:${i + 1}: ${l}`);
  });
  for (const c of Object.keys(want)) if ((got[c] || 0) !== want[c]) bad(`audited helper call in ${f} found ${got[c] || 0} time(s), expected ${want[c]}: ${c}`);
}
// 1d. builders
for (const [f, line, , re] of BUILDERS) {
  const L = files[f] || [];
  const hits = L.filter((l) => re.test(l));
  if (hits.length !== 1 || hits[0] !== line) bad(`value built for a sink changed in ${f} (re-audit): expected ${line}, found ${hits.join(' | ') || 'nothing'}`);
}
// 1e. constants stay one plain string literal
for (const [f, name] of CONSTANTS) {
  const L = files[f] || [];
  const defs = L.filter((l) => new RegExp('^var\\s+' + name + '\\s*=').test(l));
  if (defs.length !== 1 || !new RegExp("^var\\s+" + name + "\\s*=\\s*'<svg[^'\\\\]*';$").test(defs[0])) {
    bad(`${f}: ${name} must be one plain '<svg ...>' string literal, found: ${defs.join(' | ') || 'no definition'}`);
  }
}

// 2. no string-evaluating code, no inline handlers in HTML built by scripts
for (const f of jsFiles) {
  files[f].forEach((l, i) => {
    const code = l.replace(/^\s*(\/\/|\*|\/\*).*$/, '');   // skip comment lines
    if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(code)) bad(`${f}:${i + 1}: eval/new Function is blocked by the CSP: ${l}`);
    if (/\bset(Timeout|Interval)\s*\(\s*['"`]/.test(code)) bad(`${f}:${i + 1}: string timer is blocked by the CSP: ${l}`);
    if (/javascript:/i.test(code)) bad(`${f}:${i + 1}: javascript: URL: ${l}`);
    if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(code)) bad(`${f}:${i + 1}: inline event handler in built HTML (CSP blocks it): ${l}`);
  });
}

// 3. the nine pages
for (const p of PAGES) {
  const file = path.join(ROOT, p + '.html');
  const html = read(file);
  const tagRe = /<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[1].toLowerCase(), attrs = m[2];
    const line = html.slice(0, m.index).split('\n').length;
    if (tag === 'script' && !/\ssrc\s*=/i.test(attrs)) bad(`${p}.html:${line}: inline <script> (CSP script-src 'self' blocks it)`);
    // attribute names only: strip quoted values first
    const names = attrs.replace(/"[^"]*"|'[^']*'/g, '""');
    const h = /\s(on[a-z]+)\s*=/i.exec(names);
    if (h) bad(`${p}.html:${line}: inline event handler ${h[1]}= on <${tag}> (CSP blocks it)`);
    if (/=\s*["']?\s*javascript:/i.test(attrs)) bad(`${p}.html:${line}: javascript: URL on <${tag}>`);
  }
  // a <script> body that is not empty means inline code even with src
  const bodyRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = bodyRe.exec(html))) if (m[1].trim()) bad(`${p}.html: <script> with inline code: ${m[1].trim().slice(0, 60)}`);
}

const nSinks = SINKS.length, nFeed = Object.values(FEEDERS).reduce((a, v) => a + v.calls.length, 0);
if (problems.length) {
  console.log(problems.map((x) => 'FAIL ' + x).join('\n'));
  console.log(`\n${problems.length} problem(s). Audited: ${nSinks} sinks, ${nFeed} helper calls, ${BUILDERS.length} builders, ${CONSTANTS.length} constants; ${PAGES.length} pages.`);
  process.exit(1);
}
console.log(`xss-check passed: ${nSinks} audited HTML sinks, ${nFeed} helper calls, ${BUILDERS.length} builders, ${CONSTANTS.length} svg constants in ${jsFiles.length} files; no eval/inline handlers; ${PAGES.length} pages without inline script or on*= attributes.`);
