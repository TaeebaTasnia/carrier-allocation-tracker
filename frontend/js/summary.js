/* Weekly summary: GET /reports/weekly-summary?year&from_week&to_week, one row per week that has
 * data, plus the year total. Deficit/surplus is drawn as a diverging bar around a centre line
 * (red left, sea right) on one scale for the whole table. Download: the .xlsx variant, saved under
 * the name the backend gives in Content-Disposition. A row opens Weekly allocation for that week. */
(function () {
  'use strict';

  var P = window.CA.page, API = window.CA.api, SH = window.CA.shell, D = window.CA.data;
  var $ = P.$, el = P.el, fmt = P.fmt;

  var main = $('#main');
  var params = new URLSearchParams(location.search);
  var sel = SH.week();
  var q = { year: sel.year, from: toInt(params.get('from')), to: toInt(params.get('to')) };
  var reqId = 0, first = true;

  function toInt(s) { var n = parseInt(s, 10); return isNaN(n) ? null : n; }

  $('#f-year').value = q.year;
  $('#f-from').value = q.from == null ? '' : q.from;
  $('#f-to').value = q.to == null ? '' : q.to;

  function readFilters() {
    var err = '';
    var y = toInt($('#f-year').value), f = $('#f-from').value.trim() === '' ? null : toInt($('#f-from').value), t = $('#f-to').value.trim() === '' ? null : toInt($('#f-to').value);
    if (!y || y < 2000 || y > 2100) err = 'Year must be a four-digit year.';
    else if ((f != null && (f < 1 || f > 53)) || (t != null && (t < 1 || t > 53))) err = 'Weeks run from 1 to 53.';
    else if (f != null && t != null && f > t) err = 'From week must not be after To week.';
    $('#f-err').hidden = !err;
    $('#f-err').textContent = err;
    ['#f-year', '#f-from', '#f-to'].forEach(function (s) { $(s).setAttribute('aria-invalid', err ? 'true' : 'false'); });
    return err ? null : { year: y, from: f, to: t };
  }
  $('#filters').addEventListener('submit', function (e) {
    e.preventDefault();
    var r = readFilters();
    if (!r) return;
    q = r;
    var url = new URL(location.href);
    if (q.from != null) url.searchParams.set('from', q.from); else url.searchParams.delete('from');
    if (q.to != null) url.searchParams.set('to', q.to); else url.searchParams.delete('to');
    history.replaceState(history.state, '', url);
    load();
  });

  $('#dl').addEventListener('click', function () {
    var r = readFilters();
    if (!r) return;
    var b = $('#dl'), m = $('#dl-msg');
    b.disabled = true;
    m.textContent = 'Preparing the workbook…';
    API.downloadSummary(r.year, r.from, r.to).then(function (f) {
      b.disabled = false;
      m.innerHTML = P.CHECK + '<span></span>';
      m.querySelector('span').textContent = 'Downloaded ' + f.name + '.';
    }, function (err) {
      b.disabled = false;
      m.textContent = 'Download failed. ' + (err.message || '');
    });
  });

  // Placeholder: the MyShipment API does not exist yet, so this only tells the user. No request is made.
  $('#ms').addEventListener('click', function () {
    var m = $('#dl-msg');
    m.className = 'save__msg';
    m.textContent = 'MyShipment is not connected yet. This button will send the report there once the connection is set up.';
  });

  function dvCell(v, status, scale, label) {
    var w = el('span', 'dv is-' + status);
    var axis = el('span', 'dv__axis');
    axis.setAttribute('aria-hidden', 'true');
    var bar = el('span', 'dv__bar ' + (v < 0 ? 'is-neg' : 'is-pos'));
    bar.style.setProperty('--f', scale ? Math.min(1, Math.abs(v) / scale).toFixed(4) : 0);
    axis.appendChild(bar);
    var val = el('span', 'dv__v');
    var nEl = el('span', 'n', '—');
    val.appendChild(nEl);
    val.appendChild(el('span', 'dv__word', status === 'deficit' ? 'Deficit' : status === 'surplus' ? 'Surplus' : 'Balanced'));
    w.appendChild(axis); w.appendChild(val);
    P.roll(nEl, v, { format: P.teuDs, duration: first ? 1000 : 800 });
    return w;
  }
  function numCell(v, cls, label) {
    var td = el('td');
    td.setAttribute('data-label', label);
    var s = el('span', 'n' + (cls ? ' ' + cls : ''), '—');
    td.appendChild(s);
    P.roll(s, v, { format: P.teu, duration: first ? 1000 : 800 });
    return td;
  }

  function render(res) {
    P.resetSeq();
    var tb = $('#rows'), tf = $('#foot');
    tb.textContent = ''; tf.textContent = '';
    var scale = 0;
    res.weeks.forEach(function (r) { scale = Math.max(scale, Math.abs(r.deficit_surplus)); });
    scale = Math.max(scale, Math.abs(res.year_total.deficit_surplus) / Math.max(1, res.weeks.length), 1);
    var cur = SH.week();
    res.weeks.forEach(function (r) {
      var tr = el('tr');
      if (r.year === cur.year && r.week === cur.week) tr.classList.add('is-sel');
      var th = el('th'); th.scope = 'row';
      var a = el('a', 'wkno');
      a.href = 'weekly.html?year=' + r.year + '&week=' + r.week;
      a.textContent = 'W' + r.week;
      a.appendChild(el('span', null, window.CA.weeks.rangeText(r.year, r.week).replace(/ \d{4}$/, '')));
      a.setAttribute('aria-label', 'Week ' + r.week + ', open its weekly allocation');
      a.addEventListener('click', function () { try { localStorage.setItem('ca.week', JSON.stringify({ year: r.year, week: r.week })); } catch (e) {} });
      th.appendChild(a);
      tr.appendChild(th);
      tr.appendChild(numCell(r.forecast, 'n--fc', 'Forecast'));
      tr.appendChild(numCell(r.total_confirmed, '', 'Confirmed'));
      tr.appendChild(numCell(r.total_utilized, 'n--muted', 'Utilized'));
      tr.appendChild(numCell(r.to_be_arrived, '', 'To be arrived'));
      tr.appendChild(numCell(r.to_be_utilized, r.to_be_utilized < -0.0049 ? 'n--red' : '', 'To be utilized'));
      var td = el('td', 'dv-cell'); td.setAttribute('data-label', 'Deficit / surplus');
      td.appendChild(dvCell(r.deficit_surplus, r.status, scale));
      tr.appendChild(td);
      tb.appendChild(tr);
    });
    var t = res.year_total, ft = el('tr');
    var fth = el('th'); fth.scope = 'row';
    fth.textContent = (q.from != null || q.to != null) ? 'Total, weeks shown' : 'Year ' + res.year;
    ft.appendChild(fth);
    ft.appendChild(numCell(t.forecast, 'n--fc', 'Forecast'));
    ft.appendChild(numCell(t.total_confirmed, '', 'Confirmed'));
    ft.appendChild(numCell(t.total_utilized, '', 'Utilized'));
    ft.appendChild(numCell(t.to_be_arrived, '', 'To be arrived'));
    ft.appendChild(numCell(t.to_be_utilized, '', 'To be utilized'));
    var ftd = el('td', 'dv-cell'); ftd.setAttribute('data-label', 'Deficit / surplus');
    ftd.appendChild(dvCell(t.deficit_surplus, t.status, Math.max(scale, Math.abs(t.deficit_surplus))));
    ft.appendChild(ftd);
    tf.appendChild(ft);
    first = false;
    if (window.CA.cursor) window.CA.cursor.refresh();
  }

  function setState(s) { main.setAttribute('data-state', s); main.setAttribute('aria-busy', s === 'loading' ? 'true' : 'false'); }

  function load() {
    var id = ++reqId;
    setState('loading');
    $('#err').hidden = true;
    $('#dl-msg').textContent = '';
    var rangeTxt = q.from == null && q.to == null ? 'every week of ' + q.year : 'weeks ' + (q.from || 1) + ' to ' + (q.to || 53) + ' of ' + q.year;
    P.pop($('#title'), ['Weekly ', { em: 'summary' }, ' ' + q.year]);
    P.pop($('#sub'), ['Loading ' + rangeTxt + '…']);
    API.getSummary(q.year, q.from, q.to).then(function (res) {
      if (id !== reqId) return;
      var none = !res.weeks.length;
      setState(none ? 'empty' : 'ready');
      $('#empty').hidden = !none;
      $('#body').hidden = none;
      var def = res.weeks.filter(function (r) { return r.status === 'deficit'; }).length;
      P.pop($('#sub'), [none ? 'Nothing on file for ' + (q.from == null && q.to == null ? q.year : rangeTxt) + ' yet.'
        : res.weeks.length + ' week' + (res.weeks.length === 1 ? '' : 's') + ' on file, ' + def + ' short of what is still to arrive. Select a week to open its allocation.'], { delay: 200, step: 12, dur: 520 });
      if (!none) render(res);
    }, function (err) {
      if (id !== reqId) return;
      setState('error');
      $('#body').hidden = true; $('#empty').hidden = true;
      $('#err').hidden = false;
      $('#err-body').textContent = err.message || 'Something went wrong.';
      P.pop($('#sub'), ['']);
    });
  }
  $('#retry').addEventListener('click', load);

  // the week selector: highlight that week, and follow it to another year
  SH.onWeek(function (y, w) {
    if (y !== q.year) { q.year = y; $('#f-year').value = y; load(); return; }
    Array.prototype.forEach.call(document.querySelectorAll('#rows tr'), function (tr) {
      var a = tr.querySelector('.wkno');
      tr.classList.toggle('is-sel', !!a && a.getAttribute('href') === 'weekly.html?year=' + y + '&week=' + w);
    });
  });

  window.CA.cursor.init();
  load();
})();
