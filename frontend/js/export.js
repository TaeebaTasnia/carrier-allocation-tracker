/* Export (Reports): two real downloads from the backend.
 *   (a) GET /reports/weekly-summary/download?year&from_week&to_week   -> weekly-summary-{year}.xlsx
 *   (b) GET /reports/allocation-vs-utilization/download?year&week     -> allocation-vs-utilization-{year}-wk{week}.xlsx
 *       or, in range mode, one file per week that has data (the weeks GET /reports/weekly-summary
 *       lists), fetched one after another.
 * The file is saved under the Content-Disposition name; the done line says that name and the size.
 * Validation matches the Weekly summary page (year 2000-2100, weeks 1-53, from <= to); a single
 * week must exist in that ISO year. What is on file for the choice is looked up (debounced) with the
 * weekly-summary JSON so an empty database reads as a calm note, not a mystery empty workbook. */
(function () {
  'use strict';

  var P = window.CA.page, API = window.CA.api, SH = window.CA.shell, W = window.CA.weeks, D = window.CA.data;
  var $ = P.$, el = P.el;

  var params = new URLSearchParams(location.search);
  var sel = SH.week();
  function toInt(s) { var n = parseInt(String(s == null ? '' : s).trim(), 10); return isNaN(n) ? null : n; }
  function blank(id) { return $(id).value.trim() === ''; }

  $('#s-year').value = sel.year;
  $('#s-from').value = toInt(params.get('from')) || '';
  $('#s-to').value = toInt(params.get('to')) || '';
  $('#a-year').value = sel.year;
  $('#a-week').value = sel.week;
  $('#a-from').value = Math.max(1, sel.week - 4);
  $('#a-to').value = sel.week;

  P.pop($('#title'), ['Export the ', { em: 'workbooks' }]);

  /* ---------- shared bits ---------- */
  var CHECK = P.CHECK;
  function setErr(id, fields, msg) {
    $(id).hidden = !msg;
    $(id).textContent = msg || '';
    fields.forEach(function (f) { $(f).setAttribute('aria-invalid', msg ? 'true' : 'false'); });
  }
  function readRange(yId, fId, tId) {
    var y = toInt($(yId).value);
    var f = blank(fId) ? null : toInt($(fId).value), t = blank(tId) ? null : toInt($(tId).value);
    if (!y || y < 2000 || y > 2100 || !/^\d{4}$/.test($(yId).value.trim())) return { err: 'Year must be a four-digit year.' };
    if ((!blank(fId) && f == null) || (!blank(tId) && t == null)) return { err: 'Weeks are whole numbers from 1 to 53.' };
    if ((f != null && (f < 1 || f > 53)) || (t != null && (t < 1 || t > 53))) return { err: 'Weeks run from 1 to 53.' };
    if (f != null && t != null && f > t) return { err: 'From week must not be after To week.' };
    return { year: y, from: f, to: t };
  }
  function rangeWords(r) {
    if (r.from == null && r.to == null) return 'in ' + r.year;
    return 'in weeks ' + (r.from || 1) + ' to ' + (r.to || 53) + ' of ' + r.year;
  }
  function weekList(ws) {
    if (!ws.length) return '';
    var nums = ws.map(function (w) { return w.week; });
    if (nums.length > 6) return 'W' + nums[0] + ' to W' + nums[nums.length - 1];
    return nums.map(function (n) { return 'W' + n; }).join(', ');
  }
  function state(box, s, html) {
    var b = $(box);
    b.setAttribute('data-state', s);
    b.querySelector('.ex__msg').innerHTML = html || '';
  }
  function esc(t) { var d = el('span'); d.textContent = t; return d.innerHTML; }
  function emptyNote(what) {
    return 'Nothing on file ' + what + ' yet, so the workbook would only have headings. <a class="link" href="dashboard.html#uploads">Upload the forecast</a> on the Overview first.';
  }
  function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------- (a) weekly summary ---------- */
  var sReq = 0;
  function sCheck() {
    var r = readRange('#s-year', '#s-from', '#s-to');
    setErr('#s-err', ['#s-year', '#s-from', '#s-to'], r.err);
    $('#s-dl').disabled = !!r.err;
    if (r.err) { $('#s-avail').textContent = ''; return null; }
    $('#s-name').textContent = 'weekly-summary-' + r.year + '.xlsx';
    $('#s-view').href = 'summary.html?year=' + r.year + '&week=' + (r.year === sel.year ? sel.week : 1) + (r.from != null ? '&from=' + r.from : '') + (r.to != null ? '&to=' + r.to : '');
    return r;
  }
  var sLook = debounce(function () {
    var r = sCheck();
    if (!r) return;
    var id = ++sReq;
    var av = $('#s-avail');
    av.className = 'ex__avail';
    av.textContent = 'Checking what is on file…';
    API.getSummary(r.year, r.from, r.to).then(function (res) {
      if (id !== sReq) return;
      var n = res.weeks.length;
      if (!n) { av.className = 'ex__avail is-none'; av.innerHTML = emptyNote(rangeWords(r)); return; }
      av.textContent = '';
      var c = el('b', 'ex__count', '—'); av.appendChild(c);
      P.roll(c, n, { noStagger: true, duration: 700 });
      av.appendChild(document.createTextNode(' week' + (n === 1 ? '' : 's') + ' on file ' + rangeWords(r) + ': ' + weekList(res.weeks) + '.'));
    }, function (err) {
      if (id !== sReq) return;
      av.className = 'ex__avail';
      av.textContent = 'Could not check what is on file. ' + (err.message || '');
    });
  }, 280);
  ['#s-year', '#s-from', '#s-to'].forEach(function (s) { $(s).addEventListener('input', function () { sCheck(); sLook(); }); });
  $('#sum-form').addEventListener('submit', function (e) { e.preventDefault(); $('#s-dl').click(); });

  $('#s-dl').addEventListener('click', function () {
    var r = sCheck();
    if (!r) return;
    var b = $('#s-dl');
    b.disabled = true;
    state('#s-state', 'busy', 'Preparing the workbook ' + esc(rangeWords(r)) + '…');
    API.downloadSummary(r.year, r.from, r.to).then(function (f) {
      b.disabled = false;
      state('#s-state', 'done', CHECK + '<span>Saved as <b>' + esc(f.name) + '</b>, ' + P.bytes(f.size) + '. Look in your Downloads folder.</span>');
      SH.say('Saved as ' + f.name);
    }, function (err) {
      b.disabled = false;
      state('#s-state', 'error', '<span>Not downloaded. ' + esc(err.message || 'Something went wrong.') + '</span>');
    });
  });

  /* ---------- (b) allocation vs utilization ---------- */
  function mode() { return document.querySelector('input[name="av-mode"]:checked').value; }
  var aReq = 0, aWeeks = null;
  function aRead() {
    if (mode() === 'one') {
      var y = toInt($('#a-year').value), w = toInt($('#a-week').value);
      if (!y || y < 2000 || y > 2100 || !/^\d{4}$/.test($('#a-year').value.trim())) return { err: 'Year must be a four-digit year.' };
      var max = W.weeksInYear(y);
      if (w == null || w < 1 || w > max) return { err: 'Week must be between 1 and ' + max + ' for ' + y + '.' };
      return { year: y, week: w };
    }
    return readRange('#a-year', '#a-from', '#a-to');
  }
  function aCheck() {
    var one = mode() === 'one';
    $('#a-week-f').hidden = !one;
    $('#a-from-f').hidden = one;
    $('#a-to-f').hidden = one;
    var r = aRead();
    setErr('#a-err', one ? ['#a-year', '#a-week'] : ['#a-year', '#a-from', '#a-to'], r.err);
    $('#a-dl').disabled = !!r.err;
    if (r.err) { $('#a-avail').textContent = ''; return null; }
    if (one) {
      $('#a-name-label').textContent = 'File name';
      $('#a-name').textContent = 'allocation-vs-utilization-' + r.year + '-wk' + r.week + '.xlsx';
      $('#a-dl-label').textContent = 'Download week ' + r.week;
      $('#a-view').href = 'allocvsutil.html?year=' + r.year + '&week=' + r.week;
    } else {
      $('#a-name-label').textContent = 'File names';
      $('#a-view').href = 'allocvsutil.html?year=' + r.year + '&week=' + (r.from || 1);
    }
    return r;
  }
  function paintRangeName(r, weeks) {
    var nm = $('#a-name');
    nm.textContent = '';
    if (!weeks.length) { nm.textContent = 'allocation-vs-utilization-' + r.year + '-wk….xlsx'; $('#a-dl-label').textContent = 'Nothing to download'; return; }
    nm.appendChild(document.createTextNode('allocation-vs-utilization-' + r.year + '-wk' + weeks[0].week + '.xlsx'));
    if (weeks.length > 1) nm.appendChild(el('small', null, ' to …-wk' + weeks[weeks.length - 1].week + '.xlsx, ' + weeks.length + ' files'));
    $('#a-dl-label').textContent = 'Download ' + weeks.length + ' workbook' + (weeks.length === 1 ? '' : 's');
  }
  var aLook = debounce(function () {
    var r = aCheck();
    aWeeks = null;
    if (!r) return;
    var id = ++aReq;
    var av = $('#a-avail');
    av.className = 'ex__avail';
    av.textContent = 'Checking what is on file…';
    var one = mode() === 'one';
    if (!one) $('#a-dl').disabled = true;
    API.getSummary(r.year, one ? r.week : r.from, one ? r.week : r.to).then(function (res) {
      if (id !== aReq) return;
      var weeks = res.weeks;
      if (one) {
        if (!weeks.length) { av.className = 'ex__avail is-none'; av.innerHTML = emptyNote('for week ' + r.week + ' of ' + r.year); return; }
        var wk = weeks[0];
        av.textContent = 'Week ' + r.week + ' is on file: forecast ';
        var a = el('b', null, '—'); av.appendChild(a); P.roll(a, wk.forecast, { format: P.teu, noStagger: true, duration: 700 });
        av.appendChild(document.createTextNode(' TEU, confirmed '));
        var b = el('b', null, '—'); av.appendChild(b); P.roll(b, wk.total_confirmed, { format: P.teu, noStagger: true, duration: 700, delay: 60 });
        av.appendChild(document.createTextNode(' TEU.'));
        return;
      }
      aWeeks = weeks;
      paintRangeName(r, weeks);
      $('#a-dl').disabled = !weeks.length;
      if (!weeks.length) { av.className = 'ex__avail is-none'; av.innerHTML = 'No week has data ' + esc(rangeWords(r)) + ', so there is nothing to download. <a class="link" href="dashboard.html#uploads">Upload the forecast</a> on the Overview first.'; return; }
      av.textContent = '';
      var c = el('b', 'ex__count', '—'); av.appendChild(c);
      P.roll(c, weeks.length, { noStagger: true, duration: 700 });
      av.appendChild(document.createTextNode(' week' + (weeks.length === 1 ? '' : 's') + ' with data ' + rangeWords(r) + ': ' + weekList(weeks) + '. They download one after another; your browser may ask once to allow several files.'));
    }, function (err) {
      if (id !== aReq) return;
      av.className = 'ex__avail';
      av.textContent = 'Could not check what is on file. ' + (err.message || '');
      if (!one) $('#a-dl').disabled = true;
    });
  }, 280);
  ['#a-year', '#a-week', '#a-from', '#a-to'].forEach(function (s) { $(s).addEventListener('input', function () { aCheck(); aLook(); }); });
  Array.prototype.forEach.call(document.querySelectorAll('input[name="av-mode"]'), function (r) {
    r.addEventListener('change', function () { state('#a-state', 'idle', ''); aCheck(); aLook(); });
  });
  $('#av-form').addEventListener('submit', function (e) { e.preventDefault(); $('#a-dl').click(); });

  var busy = false;
  $('#a-dl').addEventListener('click', function () {
    if (busy) return;
    var r = aCheck();
    if (!r) return;
    var b = $('#a-dl');
    if (mode() === 'one') {
      busy = true; b.disabled = true;
      state('#a-state', 'busy', 'Preparing the workbook for week ' + r.week + '…');
      API.downloadAlloc(r.year, r.week).then(function (f) {
        busy = false; b.disabled = false;
        state('#a-state', 'done', CHECK + '<span>Saved as <b>' + esc(f.name) + '</b>, ' + P.bytes(f.size) + '. Look in your Downloads folder.</span>');
        SH.say('Saved as ' + f.name);
      }, function (err) {
        busy = false; b.disabled = false;
        state('#a-state', 'error', '<span>Not downloaded. ' + esc(err.message || 'Something went wrong.') + '</span>');
      });
      return;
    }
    var weeks = aWeeks || [];
    if (!weeks.length) return;
    busy = true; b.disabled = true;
    var saved = [], total = 0, i = 0;
    function next() {
      if (i >= weeks.length) return Promise.resolve();
      var wk = weeks[i];
      state('#a-state', 'busy', 'Saving week ' + wk.week + ', ' + (i + 1) + ' of ' + weeks.length + '…');
      return API.downloadAlloc(r.year, wk.week).then(function (f) {
        saved.push(f.name); total += f.size; i++;
        return sleep(450).then(next);   // a short gap so the browser keeps every file
      });
    }
    next().then(function () {
      busy = false; b.disabled = false;
      var names = saved.length > 1 ? esc(saved[0]) + '</b> to <b>' + esc(saved[saved.length - 1]) : esc(saved[0]);
      state('#a-state', 'done', CHECK + '<span>Saved ' + saved.length + ' workbook' + (saved.length === 1 ? '' : 's') + ': <b>' + names + '</b>, ' + P.bytes(total) + ' in all.</span>');
      SH.say('Saved ' + saved.length + ' workbooks');
    }, function (err) {
      busy = false; b.disabled = false;
      state('#a-state', 'error', '<span>Stopped after ' + saved.length + ' of ' + weeks.length + '. ' + esc(err.message || 'Something went wrong.') + '</span>');
    });
  });

  /* the week selector sets the single week (and both years) */
  SH.onWeek(function (y, w) {
    sel = { year: y, week: w };
    $('#a-year').value = y; $('#a-week').value = w;
    $('#s-year').value = y;
    sCheck(); sLook(); aCheck(); aLook();
  });

  window.CA.cursor.init();
  sCheck(); sLook(); aCheck(); aLook();
})();
