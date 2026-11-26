/* Allocation vs Utilization (Reports).
 * Data: GET /reports/allocation-vs-utilization?year&week (one answer: per-carrier forecast,
 * confirmed, utilized, left, pct_share, pct_of_confirmed, the week totals and the daily rows).
 * Download: /reports/allocation-vs-utilization/download, saved under the Content-Disposition name.
 *
 * Top: numbers only, one ruled row per carrier (the bar chart of these figures lives on the
 * Overview, js/carrierbars.js): forecast, confirmed, confirmed - forecast (negative = below
 * forecast, the backend's sign), utilized, left, utilized as % of confirmed, share of the week's
 * utilized; a status word under the name when a carrier is over confirmed or has nothing confirmed. Totals follow the backend: forecast total = MGH forecast (excludes FML),
 * confirmed total includes FML.
 * Below: days x carriers, stuffed TEU per cell, cell colour depth = cell / busiest cell; the day
 * total carries a sky-blue level. A carrier opens Weekly allocation, a day opens Date-wise. */
(function () {
  'use strict';

  var P = window.CA.page, API = window.CA.api, SH = window.CA.shell, W = window.CA.weeks, D = window.CA.data;
  var $ = P.$, el = P.el, fmt = P.fmt, CARRIERS = P.CARRIERS;
  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var EPS = 0.0049;

  var main = $('#main');
  var sel = SH.week();
  var reqId = 0, first = true;

  function q(y, w) { return '?year=' + y + '&week=' + w; }
  function keepWeek() { try { localStorage.setItem('ca.week', JSON.stringify(sel)); } catch (e) {} }

  /* ---------- per-carrier figures (a ruled table; the bar chart of the same figures is on the Overview) ---------- */

  function num(v, cls, label, o) {
    var td = el('td', o && o.tdCls);
    td.setAttribute('data-label', label);
    var s = el('span', 'n' + (cls ? ' ' + cls : ''), '—');
    td.appendChild(s);
    P.roll(s, v, { format: (o && o.format) || P.teu, duration: first ? 1000 : 760 });
    return { td: td, n: s };
  }
  function gapCell(v, label) {
    var c = num(v, v == null ? '' : v < -EPS ? 'n--red' : v > EPS ? 'n--sea' : '', label, { format: P.teuSigned, tdCls: 'av__gap' });
    c.td.appendChild(el('span', 'av__word', v == null ? 'no forecast' : v < -EPS ? 'below forecast' : v > EPS ? 'above forecast' : 'on forecast'));
    return c.td;
  }

  // the carrier name in its hue, with a short status word under it (over confirmed / nothing confirmed)
  function carrierCell(c, r) {
    var wrap = el('span', 'av__car');
    wrap.setAttribute('data-carrier', c);
    wrap.appendChild(el('span', 'car__name', c));
    var st = r.utilized > r.confirmed + EPS ? ['over confirmed', 'is-over'] : !(r.confirmed > EPS) ? ['nothing confirmed', 'is-none'] : null;
    if (st) wrap.appendChild(el('span', 'av__status ' + st[1], st[0]));
    return wrap;
  }

  function renderLanes(res, noFc) {
    var tb = $('#rows'), tf = $('#foot');
    tb.textContent = ''; tf.textContent = '';
    CARRIERS.forEach(function (c, i) {
      var r = res.carriers[c];
      var tr = el('tr', 'av__row');
      tr.setAttribute('data-carrier', c);
      if (r.utilized > r.confirmed + EPS) tr.classList.add('is-over');
      var th = el('th'); th.scope = 'row';
      var a = el('a', 'av__go');
      a.href = 'weekly.html' + q(sel.year, sel.week);
      a.setAttribute('aria-label', c + ': open Weekly allocation for week ' + sel.week);
      a.addEventListener('click', keepWeek);
      a.appendChild(carrierCell(c, r));
      th.appendChild(a);
      tr.appendChild(th);
      var fcKnown = !(noFc && c !== 'FML');
      tr.appendChild(num(fcKnown ? r.forecast : null, 'n--fc', 'Forecast').td);
      tr.appendChild(num(r.confirmed, '', 'Confirmed').td);
      tr.appendChild(gapCell(fcKnown ? r.confirmed - r.forecast : null, 'vs forecast'));
      tr.appendChild(num(r.utilized, '', 'Utilized').td);
      tr.appendChild(num(r.left, r.left < -EPS ? 'n--red' : '', 'Left').td);
      tr.appendChild(num(r.pct_of_confirmed, r.pct_of_confirmed > 100.0049 ? 'n--red' : '', 'Of confirmed', { format: P.pct }).td);
      tr.appendChild(num(res.total_utilized > 0 ? r.pct_share : null, 'n--muted', 'Share', { format: P.pct }).td);
      tb.appendChild(tr);
    });
    // week total, as the backend counts it
    var ft = el('tr');
    var fth = el('th'); fth.scope = 'row'; fth.textContent = 'Week ' + sel.week;
    ft.appendChild(fth);
    ft.appendChild(num(noFc ? null : res.forecast, 'n--fc', 'Forecast (MGH)').td);
    ft.appendChild(num(res.total_confirmed, '', 'Confirmed (all five)').td);
    ft.appendChild(gapCell(noFc ? null : res.total_confirmed - res.forecast, 'vs forecast'));
    ft.appendChild(num(res.total_utilized, '', 'Utilized').td);
    ft.appendChild(num(res.to_be_utilized, res.to_be_utilized < -EPS ? 'n--red' : '', 'Left').td);
    ft.appendChild(num(res.total_confirmed > 0 ? res.total_utilized / res.total_confirmed * 100 : null, '', 'Of confirmed', { format: P.pct }).td);
    ft.appendChild(num(res.total_utilized > 0 ? 100 : null, 'n--muted', 'Share', { format: P.pct }).td);
    tf.appendChild(ft);
  }

  /* ---------- the day grid ---------- */
  function weekDates() {
    var mon = W.mondayOf(sel.year, sel.week), out = [];
    for (var i = 0; i < 7; i++) out.push(W.isoDate(new Date(mon.getTime() + i * 86400000)));
    return out;
  }
  function dayLabel(iso) {
    var d = new Date(iso + 'T00:00:00Z');
    return { a: DAYS[(d.getUTCDay() + 6) % 7] + ' ' + d.getUTCDate(), b: MON3[d.getUTCMonth()] };
  }

  function renderGrid(res) {
    var head = $('#grid-head'), tb = $('#grid-rows'), tf = $('#grid-foot');
    head.textContent = ''; tb.textContent = ''; tf.textContent = '';
    var h0 = el('th', null, 'Day'); h0.scope = 'col'; head.appendChild(h0);
    CARRIERS.forEach(function (c) {
      var th = el('th', 'car-h', c); th.scope = 'col'; th.setAttribute('data-carrier', c); head.appendChild(th);
    });
    [['Day total', 'stuffed TEU', 'grp av__levelh'], ['Forecast', 'TEU', 'is-fc grp'], ['Arrived', 'TEU', '']].forEach(function (h) {
      var th = el('th', h[2], h[0]); th.scope = 'col'; th.appendChild(el('small', null, h[1])); head.appendChild(th);
    });

    var by = {};
    (res.daily || []).forEach(function (d) { by[d.date] = d; });
    var dates = weekDates();
    Object.keys(by).forEach(function (k) { if (dates.indexOf(k) < 0) dates.push(k); });
    dates.sort();
    var zero = { carrier_teus: {}, stuffed_teus: 0, forecast_teu: 0, actual_teu: 0 };
    var maxCell = 0, maxDay = 0, busiest = null;
    dates.forEach(function (iso) {
      var d = by[iso] || zero;
      CARRIERS.forEach(function (c) { maxCell = Math.max(maxCell, d.carrier_teus[c] || 0); });
      if (d.stuffed_teus > maxDay + EPS) { maxDay = d.stuffed_teus; busiest = iso; }
    });
    var today = W.todayIso();
    var tot = { car: {}, st: 0, fc: 0, act: 0 };
    CARRIERS.forEach(function (c) { tot.car[c] = 0; });

    dates.forEach(function (iso, ri) {
      var d = by[iso] || zero;
      var tr = el('tr');
      if (iso === today) tr.classList.add('is-today');
      if (iso === busiest) tr.classList.add('is-busy');
      var th = el('th'); th.scope = 'row';
      var a = el('a', 'av__go av__day');
      a.href = 'datewise.html' + q(sel.year, sel.week);
      var lb = dayLabel(iso);
      a.appendChild(el('b', null, lb.a));
      a.appendChild(el('span', null, iso === today ? 'Today' : iso === busiest ? 'Busiest' : lb.b));
      a.setAttribute('aria-label', lb.a + ' ' + lb.b + ': open in Date-wise');
      a.addEventListener('click', keepWeek);
      th.appendChild(a);
      tr.appendChild(th);
      CARRIERS.forEach(function (c) {
        var v = d.carrier_teus[c] || 0;
        tot.car[c] += v;
        var td = el('td', 'heat');
        td.setAttribute('data-carrier', c);
        if (v > EPS && maxCell > 0) {
          td.style.setProperty('--h', (0.12 + 0.36 * v / maxCell).toFixed(3));
          td.style.setProperty('--hd', (ri * 40 + 120) + 'ms');
          td.classList.add('is-on');
        }
        var s = el('span', 'n' + (v > EPS ? '' : ' zero'), '—');
        td.appendChild(s);
        P.roll(s, v, { format: P.teu, duration: first ? 1000 : 760 });
        tr.appendChild(td);
      });
      tot.st += d.stuffed_teus; tot.fc += d.forecast_teu; tot.act += d.actual_teu;
      var lv = el('td', 'grp av__level');
      var bar = el('span', 'lvl'); bar.setAttribute('aria-hidden', 'true');
      var water = el('i'); water.style.setProperty('--f', maxDay > 0 ? (d.stuffed_teus / maxDay).toFixed(4) : 0);
      water.style.setProperty('--hd', (ri * 40 + 160) + 'ms');
      bar.appendChild(water); lv.appendChild(bar);
      var sn = el('span', 'n' + (d.stuffed_teus > EPS ? '' : ' zero'), '—'); lv.appendChild(sn);
      P.roll(sn, d.stuffed_teus, { format: P.teu, duration: first ? 1000 : 760 });
      tr.appendChild(lv);
      [[d.forecast_teu, 'n--fc grp'], [d.actual_teu, '']].forEach(function (x) {
        var td = el('td', x[1].indexOf('grp') >= 0 ? 'grp' : '');
        var s2 = el('span', 'n' + (x[1].indexOf('n--fc') >= 0 ? ' n--fc' : '') + (x[0] > EPS ? '' : ' zero'), '—');
        td.appendChild(s2); P.roll(s2, x[0], { format: P.teu, duration: first ? 1000 : 760 });
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });

    var ft = el('tr');
    var fth = el('th', null, 'Week'); fth.scope = 'row'; ft.appendChild(fth);
    CARRIERS.forEach(function (c) { var td = el('td'); var s = el('span', 'n', '—'); td.appendChild(s); P.roll(s, tot.car[c], { format: P.teu }); ft.appendChild(td); });
    [[tot.st, 'grp', ''], [tot.fc, 'grp', ' n--fc'], [tot.act, '', '']].forEach(function (x) {
      var td = el('td', x[1]); var s = el('span', 'n' + x[2], '—'); td.appendChild(s); P.roll(s, x[0], { format: P.teu }); ft.appendChild(td);
    });
    tf.appendChild(ft);
  }

  /* ---------- headline ---------- */
  function figure(v, cls) {
    var s = el('b', 'av__fig' + (cls ? ' ' + cls : ''), '—');
    P.roll(s, v, { format: P.teu, duration: 1100, noStagger: true, delay: 260 });
    return s;
  }
  function headline(res, noFc) {
    var range = W.rangeText(sel.year, sel.week);
    var parts = [range + '. '];
    if (noFc) parts.push(figure(res.total_confirmed), ' TEU confirmed, no forecast to compare with; ');
    else parts.push(figure(res.total_confirmed), ' TEU confirmed against a forecast of ', figure(res.forecast, 'is-fc'), ' TEU; ');
    parts.push(figure(res.total_utilized), ' stuffed, ', figure(res.to_be_utilized, res.to_be_utilized < -EPS ? 'is-red' : ''), ' left.');
    P.pop($('#sub'), parts, { delay: 200, step: 14, dur: 520 });
  }

  /* ---------- download ---------- */
  $('#dl').addEventListener('click', function () {
    var b = $('#dl'), m = $('#dl-msg');
    var y = sel.year, w = sel.week;
    b.disabled = true;
    m.className = 'save__msg av__dl is-busy';
    m.textContent = 'Preparing the workbook for week ' + w + '…';
    API.downloadAlloc(y, w).then(function (f) {
      b.disabled = false;
      m.className = 'save__msg av__dl is-done';
      m.innerHTML = P.CHECK + '<span></span>';
      m.querySelector('span').textContent = 'Saved as ' + f.name + ' (' + P.bytes(f.size) + ').';
      SH.say('Saved as ' + f.name);
    }, function (err) {
      b.disabled = false;
      m.className = 'save__msg av__dl is-err';
      m.textContent = 'Download failed. ' + (err.message || '');
    });
  });

  /* ---------- MyShipment (placeholder: the API does not exist yet, nothing is sent) ---------- */
  $('#ms').addEventListener('click', function () {
    var m = $('#dl-msg');
    m.className = 'save__msg av__dl';
    m.textContent = 'MyShipment is not connected yet. This button will send the report there once the connection is set up.';
  });

  /* ---------- load ---------- */
  function setState(s) { main.setAttribute('data-state', s); main.setAttribute('aria-busy', s === 'loading' ? 'true' : 'false'); }

  function load() {
    var id = ++reqId;
    sel = SH.week();
    setState('loading');
    $('#err').hidden = true;
    $('#dl-msg').textContent = '';
    P.pop($('#title'), ['Week ' + sel.week + ': ', { em: 'allocation' }, ' vs ', { em: 'utilization' }]);
    P.pop($('#sub'), [W.rangeText(sel.year, sel.week) + '. Reading the week from the backend…']);
    API.getAlloc(sel.year, sel.week).then(function (res) {
      if (id !== reqId) return;
      P.resetSeq();
      var noFc = !(res.forecast > EPS);
      var nothing = noFc && !(res.daily || []).length && !(res.total_confirmed > EPS);
      setState(nothing ? 'empty' : 'ready');
      $('#empty').hidden = !nothing;
      $('#nofc').hidden = nothing || !noFc;
      $('#body').hidden = nothing;
      $('#dl').disabled = false;
      $('#dl').hidden = nothing;   // an empty week would only give a workbook of headings
      $('#ms').hidden = nothing;   // nothing to send either
      if (nothing) {
        P.pop($('#sub'), [W.rangeText(sel.year, sel.week) + '. Nothing on file for this week yet.'], { delay: 200, step: 14, dur: 520 });
      } else {
        headline(res, noFc);
        renderLanes(res, noFc);
        renderGrid(res);
      }
      first = false;
      if (window.CA.cursor) window.CA.cursor.refresh();
    }, function (err) {
      if (id !== reqId) return;
      setState('error');
      $('#body').hidden = true; $('#empty').hidden = true; $('#nofc').hidden = true;
      $('#err').hidden = false;
      $('#err-body').textContent = err.message || 'Something went wrong.';
      P.pop($('#sub'), [W.rangeText(sel.year, sel.week) + '.']);
      SH.say('Could not load week ' + sel.week + '. ' + (err.message || ''));
    });
  }
  $('#retry').addEventListener('click', load);

  window.CA.cursor.init();
  SH.onWeek(load);
  load();
})();
