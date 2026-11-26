/* Date-wise: the seven days of the selected week.
 * Data: GET /reports/allocation-vs-utilization?year&week (daily rows + carriers + week totals in one
 * answer). The backend lists only days that have forecast, stuffing or an adjustment, so the seven
 * rows are built from the ISO Monday and missing days read as zero.
 * Actual CBM per day (same rule as the backend): (1) the typed adjustment, else (2) the stuffing report's
 * rows (row CBM if the file has a CBM column, else TEU x CBM-per-TEU), else (3) 0. The API gives the
 * computed value (actual_cbm_computed) so the page can recompute live while an adjustment is typed.
 * Editable: the optional Adjust field, PUT /daily/{date} {actual_cbm}; null clears it (the computed value
 * returns). 0 is a valid adjustment. Actual TEU = CBM / CBM-per-TEU.
 * Week: to be arrived = max(0, forecast basis - total actual TEU); left = confirmed - utilized (stuffed);
 * deficit = left - to be arrived. Bottom rows: confirmed, utilized, left, share = carrier utilized / week utilized. */
(function () {
  'use strict';

  var P = window.CA.page, API = window.CA.api, SH = window.CA.shell, W = window.CA.weeks, D = window.CA.data;
  var $ = P.$, el = P.el, fmt = P.fmt, CARRIERS = P.CARRIERS;
  var DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var main = $('#main');
  var sel = SH.week();
  var reqId = 0, cfg = null, res = null, dates = [], firstPaint = true;
  var rows = {};               // iso -> {tr, cells}
  var basis = 0;   // forecast basis of the week (for live to-be-arrived)
  var calc = {};               // key -> {carrier -> el, total -> el}

  /* ---------- header ---------- */
  (function buildHead() {
    var hr = $('#head-row'), after = hr.children[0];
    CARRIERS.slice().reverse().forEach(function (c) {
      var th = el('th', 'car-h');
      th.scope = 'col';
      th.setAttribute('data-carrier', c);
      th.textContent = c;
      var sm = el('small', null, 'stuffed TEU'); th.appendChild(sm);
      after.insertAdjacentElement('afterend', th);
    });
  })();

  // TEU figures are shown as whole TEU, rounded up (CA.numbers.teu); CBM figures stay exact (cellCbm)
  function n(cls) { return el('span', 'n' + (cls ? ' ' + cls : ''), '—'); }

  /* ---------- body skeleton (built once per week) ---------- */
  function build() {
    var tb = $('#days'); tb.textContent = '';
    rows = {};
    var mon = W.mondayOf(sel.year, sel.week);
    dates = [];
    var today = W.todayIso();
    for (var i = 0; i < 7; i++) {
      var d = new Date(mon.getTime() + i * 86400000);
      var iso = W.isoDate(d);
      dates.push(iso);
      var tr = el('tr');
      if (iso === today) tr.classList.add('is-today');
      var th = el('th'); th.scope = 'row';
      var day = el('span', 'day');
      day.appendChild(el('b', null, DAYS[i].slice(0, 3) + ' ' + d.getUTCDate()));
      day.appendChild(el('span', null, iso === today ? 'Today' : MON3[d.getUTCMonth()] + ' ' + d.getUTCFullYear()));
      th.appendChild(day);
      tr.appendChild(th);
      var cells = { car: {} };
      CARRIERS.forEach(function (c) { var td = el('td'); td.setAttribute('data-carrier', c); cells.car[c] = n(); td.appendChild(cells.car[c]); tr.appendChild(td); });
      var td;
      td = el('td', 'grp'); cells.stuffed = n(); td.appendChild(cells.stuffed); tr.appendChild(td);
      td = el('td', 'grp'); cells.fcCbm = n('n--fc'); td.appendChild(cells.fcCbm); tr.appendChild(td);
      td = el('td'); cells.fcTeu = n('n--fc'); td.appendChild(cells.fcTeu); tr.appendChild(td);
      td = el('td', 'grp'); cells.actCbm = n(); cells.src = el('span', 'src', ''); td.appendChild(cells.actCbm); td.appendChild(cells.src); tr.appendChild(td);
      td = el('td'); td.appendChild(adjustField(iso, cells, DAYS[i] + ' ' + d.getUTCDate() + ' ' + MON3[d.getUTCMonth()])); tr.appendChild(td);
      td = el('td'); cells.actTeu = n(); td.appendChild(cells.actTeu); tr.appendChild(td);
      rows[iso] = { tr: tr, cells: cells };
      tb.appendChild(tr);
    }
    // the week total
    var tt = el('tr', 'is-total');
    var tth = el('th'); tth.scope = 'row'; tth.appendChild(el('span', 'day')).appendChild(el('b', null, 'Week'));
    tt.appendChild(tth);
    var tc = { car: {} };
    CARRIERS.forEach(function (c) { var td = el('td'); tc.car[c] = n(); td.appendChild(tc.car[c]); tt.appendChild(td); });
    ['stuffed', 'fcCbm', 'fcTeu', 'actCbm', 'adj', 'actTeu'].forEach(function (k) {
      var td = el('td', k === 'stuffed' || k === 'fcCbm' || k === 'actCbm' ? 'grp' : '');
      if (k !== 'adj') { tc[k] = n(k.indexOf('fc') === 0 ? 'n--fc' : ''); td.appendChild(tc[k]); }
      tt.appendChild(td);
    });
    rows.total = { tr: tt, cells: tc };
    tb.appendChild(tt);

    // confirmed / utilized / left / share
    var cb = $('#calc'); cb.textContent = '';
    calc = {};
    [['confirmed', 'Confirmed', 'from Weekly allocation'], ['utilized', 'Utilized', 'stuffed this week'], ['left', 'Left', 'confirmed − utilized'], ['share', '% share', 'of the week’s utilized']].forEach(function (r) {
      var tr = el('tr');
      var th = el('th'); th.scope = 'row'; th.textContent = r[1]; th.appendChild(el('small', null, r[2]));
      tr.appendChild(th);
      calc[r[0]] = {};
      CARRIERS.forEach(function (c) { var td = el('td'); td.setAttribute('data-carrier', c); calc[r[0]][c] = n(); td.appendChild(calc[r[0]][c]); tr.appendChild(td); });
      var td = el('td', 'grp'); calc[r[0]].total = n(); td.appendChild(calc[r[0]].total); tr.appendChild(td);
      var rest = el('td'); rest.colSpan = 5; tr.appendChild(rest);
      cb.appendChild(tr);
    });
  }

  /* ---------- the optional Adjust field ---------- */
  var XSVG = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>';
  var SRC_TEXT = { entered: 'adjusted by you', stuffing_cbm: 'from stuffing CBM', stuffing_mixed: 'mixed', none: 'no stuffing' };
  function srcText(src) {
    if (src === 'stuffing_teu') return 'stuffed TEU x ' + fmt(cfg ? cfg.cbm_per_teu : 33);
    return SRC_TEXT[src] || '';
  }
  function adjustField(iso, cells, label) {
    var box = el('span', 'ovr');
    var line = el('span', 'ovr__line');
    var id = 'ovr-' + iso;
    var lab = el('label', 'sr', 'Adjust the actual CBM for ' + label + ' (optional; replaces the value from the stuffing report)'); lab.htmlFor = id;
    var inp = el('input', 'big big--sm'); inp.type = 'text'; inp.id = id; inp.placeholder = '—';
    P.numericField(inp, { step: 1 });
    var x = el('button', 'ovr__x'); x.type = 'button'; x.innerHTML = XSVG; x.setAttribute('aria-label', 'Clear the adjustment for ' + label + ' and use the computed value'); x.hidden = true;
    var hint = el('span', 'hint'); hint.id = id + '-h';
    inp.setAttribute('aria-describedby', hint.id);
    line.appendChild(lab); line.appendChild(inp); line.appendChild(x);
    box.appendChild(line); box.appendChild(hint);
    cells.ovr = { box: box, input: inp, x: x, hint: hint, saved: null, comp: 0, compSrc: 'none' };

    function commit() {
      if (box.getAttribute('data-state') === 'saving') return;
      var v = P.parseNum(inp.value);
      if (v !== null && isNaN(v)) { inp.setAttribute('aria-invalid', 'true'); hint.className = 'hint hint--err'; hint.textContent = 'Use digits, no minus.'; return; }
      inp.setAttribute('aria-invalid', 'false');
      var cur = cells.ovr.saved;
      if ((v === null && cur === null) || (v !== null && cur !== null && Math.abs(v - cur) < 1e-9)) { paintHint(cells); return; }
      save(iso, cells, v);
    }
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { inp.value = cells.ovr.saved == null ? '' : P.plain(cells.ovr.saved); inp.setAttribute('aria-invalid', 'false'); paintHint(cells); live(); }
    });
    inp.addEventListener('change', commit);
    inp.addEventListener('input', live);
    x.addEventListener('click', function () { inp.value = ''; save(iso, cells, null); inp.focus(); });
    return box;
  }
  function paintHint(cells) {
    var o = cells.ovr;
    o.hint.className = 'hint';
    o.hint.textContent = o.saved == null ? 'optional' : 'computed ' + fmt(o.comp);
    o.x.hidden = o.saved == null;
  }

  function save(iso, cells, value) {
    var o = cells.ovr;
    o.box.setAttribute('data-state', 'saving');
    o.hint.className = 'hint';
    o.hint.textContent = 'Saving…';
    API.putDay(iso, value).then(function () {
      o.box.removeAttribute('data-state');
      SH.say(value == null ? 'Adjustment cleared for ' + iso + '; the computed value is back.' : 'Adjusted actual CBM for ' + iso + ' saved.');
      return refresh();
    }).catch(function (err) {
      o.box.removeAttribute('data-state');
      o.hint.className = 'hint hint--err';
      o.hint.textContent = 'Not saved: ' + (err.message || 'error');
    });
  }

  /* ---------- live figures while typing (same rule as the backend) ---------- */
  function dayValue(iso) {
    var o = rows[iso].cells.ovr, v = P.parseNum(o.input.value);
    if (v === null) return { cbm: o.comp, src: o.compSrc };                  // empty: the computed value
    if (isNaN(v)) return o.saved == null ? { cbm: o.comp, src: o.compSrc } : { cbm: o.saved, src: 'entered' };
    return { cbm: v, src: 'entered' };                                       // typed (0 is a value)
  }
  function live() {
    if (!res) return;
    var per = cfg ? cfg.cbm_per_teu : 33, cbm = 0;
    dates.forEach(function (iso) {
      var dv = dayValue(iso); cbm += dv.cbm;
      var c = rows[iso].cells;
      cell(c.actCbm, dv.cbm, null, true); cell(c.actTeu, dv.cbm / per);
      c.src.textContent = srcText(dv.src);
      c.src.classList.toggle('src--adj', dv.src === 'entered');
    });
    cell(rows.total.cells.actCbm, cbm, null, true);
    cell(rows.total.cells.actTeu, cbm / per);
    arrivedSummary(cbm / per, res.forecast > 0 ? Math.max(0, basis - cbm / per) : 0);
  }
  function arrivedSummary(totalActualTeu, tba) {
    var noFc = !(res.forecast > 0);
    var bal = res.to_be_utilized - tba, st = bal < -0.5 ? 'deficit' : bal > 0.5 ? 'surplus' : 'balanced';
    P.roll($('#s-act'), totalActualTeu, { format: P.teu });
    P.roll($('#s-tba'), noFc ? null : tba, { format: P.teu });
    P.roll($('#s-bal'), noFc ? null : bal, { format: P.teuDs });
    var br = $('#s-bal-row');
    br.classList.toggle('is-red', !noFc && st === 'deficit');
    br.classList.toggle('is-sea', !noFc && st === 'surplus');
    $('#s-bal-word').textContent = noFc ? 'Deficit / surplus: no forecast yet' : st === 'deficit' ? 'Deficit' : st === 'surplus' ? 'Surplus' : 'Balanced';
  }

  /* ---------- paint ---------- */
  function cell(e, v, cls, cbm) {
    P.roll(e, v, { format: cbm ? P.fmt : P.teu, duration: firstPaint ? 1000 : 760 });
    e.classList.toggle('zero', cbm ? v === 0 : window.CA.numbers.teuValue(v) === 0);
    if (cls) e.classList.toggle(cls[0], !!cls[1]);
  }

  function paint() {
    P.resetSeq();
    var by = {};
    (res.daily || []).forEach(function (d) { by[d.date] = d; });
    var tot = { car: {}, stuffed: 0, fcCbm: 0, fcTeu: 0, actCbm: 0, actTeu: 0 };
    CARRIERS.forEach(function (c) { tot.car[c] = 0; });
    dates.forEach(function (iso) {
      var d = by[iso] || { carrier_teus: {}, stuffed_teus: 0, forecast_cbm: 0, forecast_teu: 0, actual_cbm: 0, actual_teu: 0, actual_cbm_override: null, actual_cbm_source: 'none', actual_cbm_computed: 0, actual_cbm_computed_source: 'none' };
      var c = rows[iso].cells;
      CARRIERS.forEach(function (k) { var v = d.carrier_teus[k] || 0; tot.car[k] += v; cell(c.car[k], v); });
      cell(c.stuffed, d.stuffed_teus);
      cell(c.fcCbm, d.forecast_cbm, null, true);
      cell(c.fcTeu, d.forecast_teu);
      cell(c.actCbm, d.actual_cbm, null, true);
      cell(c.actTeu, d.actual_teu);
      c.src.textContent = srcText(d.actual_cbm_source);
      c.src.classList.toggle('src--adj', d.actual_cbm_source === 'entered');
      tot.stuffed += d.stuffed_teus; tot.fcCbm += d.forecast_cbm; tot.fcTeu += d.forecast_teu; tot.actCbm += d.actual_cbm; tot.actTeu += d.actual_teu;
      var o = c.ovr;
      o.saved = d.actual_cbm_override;
      o.comp = d.actual_cbm_computed != null ? d.actual_cbm_computed : d.actual_cbm;
      o.compSrc = d.actual_cbm_computed_source || (d.actual_cbm_override == null ? d.actual_cbm_source : 'none');
      if (document.activeElement !== o.input || o.box.getAttribute('data-state') === 'saving') o.input.value = o.saved == null ? '' : P.plain(o.saved);
      paintHint(c);
    });
    var t = rows.total.cells;
    CARRIERS.forEach(function (k) { cell(t.car[k], tot.car[k]); });
    cell(t.stuffed, tot.stuffed); cell(t.fcCbm, tot.fcCbm, null, true); cell(t.fcTeu, tot.fcTeu); cell(t.actCbm, tot.actCbm, null, true); cell(t.actTeu, tot.actTeu);

    var totalConf = 0, totalUtil = 0;
    CARRIERS.forEach(function (k) {
      var cr = res.carriers[k];
      totalConf += cr.confirmed; totalUtil += cr.utilized;
      cell(calc.confirmed[k], cr.confirmed);
      cell(calc.utilized[k], cr.utilized);
      cell(calc.left[k], cr.left, ['n--red', cr.left < -0.0049]);
      P.roll(calc.share[k], res.total_utilized > 0 ? cr.pct_share : null, { format: P.pct });
    });
    cell(calc.confirmed.total, totalConf);
    cell(calc.utilized.total, totalUtil);
    cell(calc.left.total, totalConf - totalUtil, ['n--red', totalConf - totalUtil < -0.0049]);
    P.roll(calc.share.total, totalUtil > 0 ? 100 : null, { format: P.pct });

    var noFc = !(res.forecast > 0);
    P.roll($('#s-fc'), noFc ? null : res.forecast, { format: P.teu });
    // forecast basis of the week, as in the backend: the daily forecast sum when days carry forecast, else the week total
    basis = (res.daily || []).some(function (d) { return d.forecast_teu > 0; }) ? tot.fcTeu : res.forecast;
    P.roll($('#s-left'), res.to_be_utilized, { format: P.teu });
    arrivedSummary(res.total_actual_teu, res.to_be_arrived);   // server figures; live() recomputes the same rule while typing
    var br = $('#s-bal-row');
    br.classList.toggle('is-red', !noFc && res.status === 'deficit');
    br.classList.toggle('is-sea', !noFc && res.status === 'surplus');
    $('#s-bal-word').textContent = noFc ? 'Deficit / surplus: no forecast yet' : res.status === 'deficit' ? 'Deficit' : res.status === 'surplus' ? 'Surplus' : 'Balanced';
    if (window.CA.cursor) window.CA.cursor.refresh();
  }

  /* ---------- load ---------- */
  function setState(s) { main.setAttribute('data-state', s); main.setAttribute('aria-busy', s === 'loading' ? 'true' : 'false'); }

  function refresh() {
    var id = reqId;
    return API.getAlloc(sel.year, sel.week).then(function (r) {
      if (id !== reqId) return;
      res = r; firstPaint = false; paint();
    });
  }

  function load() {
    var id = ++reqId;
    sel = SH.week();
    setState('loading');
    firstPaint = true;
    $('#err').hidden = true;
    var range = W.rangeText(sel.year, sel.week);
    P.pop($('#title'), ['Week ' + sel.week + ' ', { em: 'day by day' }]);
    P.pop($('#sub'), [range + '. Loading…']);
    build();
    Promise.all([API.getAlloc(sel.year, sel.week), cfg ? Promise.resolve(cfg) : API.getConfig()]).then(function (out) {
      if (id !== reqId) return;
      res = out[0]; cfg = out[1];
      var nothing = !(res.forecast > 0) && !(res.daily || []).length && !(res.total_confirmed > 0);
      setState(nothing ? 'empty' : 'ready');
      $('#empty').hidden = !nothing;
      $('#body').hidden = false;
      P.pop($('#sub'), [range + '. Stuffed TEU by carrier, forecast by Rfi date, and what arrived, from the stuffing report. 1 TEU is ' + fmt(cfg.cbm_per_teu) + ' CBM.'], { delay: 220, step: 12, dur: 520 });
      paint();
    }, function (err) {
      if (id !== reqId) return;
      setState('error');
      $('#body').hidden = true;
      $('#empty').hidden = true;
      $('#err').hidden = false;
      $('#err-body').textContent = err.message || 'Something went wrong.';
      P.pop($('#sub'), [range + '.']);
      SH.say('Could not load week ' + sel.week + '. ' + (err.message || ''));
    });
  }
  $('#retry').addEventListener('click', load);

  // a typed adjustment that was not committed yet counts as unsaved
  SH.setGuard(function () {
    for (var i = 0; i < dates.length; i++) {
      var o = rows[dates[i]] && rows[dates[i]].cells.ovr;
      if (!o) continue;
      var v = P.parseNum(o.input.value);
      if ((v === null) !== (o.saved === null) || (v !== null && o.saved !== null && Math.abs(v - o.saved) > 1e-9)) return 'An adjustment has not been saved (press Enter to save it).';
    }
    return '';
  });

  window.CA.cursor.init();
  SH.onWeek(load);
  load();
})();
