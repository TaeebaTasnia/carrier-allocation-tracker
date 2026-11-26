/* Weekly allocation: confirmed TEU per carrier for the selected week.
 * GET /weekly/{y}/{w} fills the forecast, the split and the saved confirmed values; the user types
 * confirmed TEU; left, used % and the totals recompute live with the backend's rules:
 *   left = confirmed - utilized; total confirmed includes FML; total forecast (MGH) excludes FML;
 *   left in hand = total confirmed - total utilized; deficit/surplus = left in hand - to be arrived
 *   (to be arrived does not depend on confirmed space); balanced within 0.5 TEU.
 * PUT /weekly/{y}/{w} saves {confirmed: {...5}, fml_forecast?}. fml_forecast null = back to the default. */
(function () {
  'use strict';

  var P = window.CA.page, API = window.CA.api, SH = window.CA.shell, W = window.CA.weeks, D = window.CA.data;
  var $ = P.$, el = P.el, fmt = P.fmt, CARRIERS = P.CARRIERS;
  var TOL = 0.5;
  // every TEU figure is shown as whole TEU, rounded up (CA.numbers.teu); the exact values stay in the maths
  function rollT(e, v, o) { o = o || {}; P.roll(e, v, o.format ? o : Object.assign({ format: P.teu }, o)); }

  var main = $('#main'), form = $('#wk'), rowsBox = $('#rows');
  var sel = SH.week();
  var res = null;             // last server answer
  var saved = {};             // carrier -> saved confirmed
  var cfgFml = null;          // fml_default from /config
  var savedFml = null;        // resolved FML forecast as saved
  var fmlOverridden = false;
  var fmlReset = false;       // user asked to go back to the default (sends null)
  var reqId = 0, saving = false, firstPaint = true, debounce = 0;
  var inputs = {};

  /* ---------- rows ---------- */

  function buildRows() {
    rowsBox.textContent = '';
    CARRIERS.forEach(function (c) {
      var tr = el('tr');
      tr.setAttribute('data-carrier', c);
      var th = el('th'); th.scope = 'row';
      th.appendChild(P.carrierLabel(c, 0));
      if (c === 'FML') th.appendChild(el('span', 'fml-note', 'Outside the MGH split'));
      tr.appendChild(th);

      var fc = el('td'); fc.setAttribute('data-label', 'Forecast'); fc.appendChild(el('span', 'n n--fc', '—')); tr.appendChild(fc);

      var cf = el('td', 'cf-cell'); cf.setAttribute('data-label', 'Confirmed');
      var wrap = el('span', 'cf-wrap');
      var id = 'cf-' + c.toLowerCase();
      var lab = el('label', 'sr', c + ' confirmed TEU'); lab.htmlFor = id;
      var inp = el('input', 'big'); inp.type = 'text'; inp.id = id; inp.placeholder = '0';
      inp.setAttribute('aria-describedby', id + '-was');
      P.numericField(inp);
      var was = el('span', 'was'); was.id = id + '-was';
      wrap.appendChild(lab); wrap.appendChild(inp); wrap.appendChild(was);
      cf.appendChild(wrap); tr.appendChild(cf);
      inputs[c] = inp;

      var ut = el('td'); ut.setAttribute('data-label', 'Utilized'); ut.appendChild(el('span', 'n n--muted', '—')); tr.appendChild(ut);
      var lf = el('td'); lf.setAttribute('data-label', 'Left'); lf.appendChild(el('span', 'n', '—')); tr.appendChild(lf);
      var us = el('td'); us.setAttribute('data-label', 'Used');
      var bar = el('span', 'ubar'); var trk = el('span', 'ubar__track'); trk.appendChild(el('span', 'ubar__fill')); bar.appendChild(trk); bar.appendChild(el('span', 'ubar__v', '—'));
      us.appendChild(bar); tr.appendChild(us);
      rowsBox.appendChild(tr);

      inp.addEventListener('input', onEdit);
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          var i = CARRIERS.indexOf(c);
          if (i < CARRIERS.length - 1) { inputs[CARRIERS[i + 1]].focus(); inputs[CARRIERS[i + 1]].select(); }
          else $('#save-btn').disabled ? $('#fml').focus() : $('#save-btn').focus();
        } else if (e.key === 'Escape') {
          inp.value = P.plain(saved[c]);
          onEdit();
        }
      });
    });
  }

  /* ---------- reading the form ---------- */

  function typed() {
    var o = {}, bad = false;
    CARRIERS.forEach(function (c) {
      var v = P.parseNum(inputs[c].value);
      if (v !== null && isNaN(v)) bad = true;
      o[c] = v == null ? 0 : v;
      inputs[c].setAttribute('aria-invalid', v !== null && isNaN(v) ? 'true' : 'false');
    });
    return { conf: o, bad: bad };
  }
  function fmlTyped() {
    var v = P.parseNum($('#fml').value);
    $('#fml').setAttribute('aria-invalid', v !== null && isNaN(v) ? 'true' : 'false');
    return v;
  }
  function dirtyList() {
    var t = typed(), list = [];
    CARRIERS.forEach(function (c) { if (Math.abs((t.conf[c] || 0) - (saved[c] || 0)) > 1e-9 || (isNaN(t.conf[c]))) list.push(c); });
    var f = fmlTyped();
    var fmlDirty = fmlReset ? fmlOverridden : (f !== null && !isNaN(f) && Math.abs(f - savedFml) > 1e-9) || (f !== null && isNaN(f));
    return { carriers: list, fml: fmlDirty, bad: t.bad || (f !== null && isNaN(f)) };
  }

  /* ---------- live recompute ---------- */

  function compute() {
    var t = typed().conf;
    var util = {}, tot = { cf: 0, ut: 0 };
    CARRIERS.forEach(function (c) {
      util[c] = res ? res.carriers[c].utilized : 0;
      tot.cf += t[c]; tot.ut += util[c];
    });
    var fmlF = fmlReset ? cfgFml : (function () { var f = fmlTyped(); return f == null || isNaN(f) ? savedFml : f; })();
    var left = tot.cf - tot.ut;
    var tba = res ? res.to_be_arrived : 0;
    var ds = left - tba;
    return { conf: t, util: util, tot: tot, left: left, tba: tba, ds: ds, fml: fmlF,
      status: ds < -TOL ? 'deficit' : ds > TOL ? 'surplus' : 'balanced' };
  }

  function paint(opts) {
    opts = opts || {};
    if (!res) return;
    var k = compute();
    var live = !!opts.live;
    var ro = live ? { noStagger: true, duration: 520 } : { duration: firstPaint ? 1000 : 820 };
    if (!live) P.resetSeq();
    var noFc = !(res.forecast > 0);
    var dl = dirtyList();

    CARRIERS.forEach(function (c) {
      var tr = rowsBox.querySelector('tr[data-carrier="' + c + '"]');
      var cells = tr.children;
      var conf = k.conf[c], ut = k.util[c], left = conf - ut;
      var fcv = c === 'FML' ? k.fml : res.carrier_forecast[c];
      if (!live || (c === 'FML' && opts.fml)) rollT(cells[1].querySelector('.n'), (noFc && c !== 'FML') ? null : fcv, ro);
      if (!live) rollT(cells[3].querySelector('.n'), ut, ro);
      var lfEl = cells[4].querySelector('.n');
      if (!live || (opts.changed && opts.changed[c])) rollT(lfEl, left, ro);
      lfEl.classList.toggle('n--red', left < -0.0049);
      var p = conf > 0 ? ut / conf * 100 : null;
      var bar = cells[5].querySelector('.ubar');
      bar.style.setProperty('--f', p == null ? 0 : Math.min(1, p / 100).toFixed(4));
      bar.classList.toggle('is-over', p != null && p > 100.0001);
      if (!live || (opts.changed && opts.changed[c])) rollT(bar.querySelector('.ubar__v'), p, Object.assign({ format: P.pct }, ro));
      var mk = tr.querySelector('.car__mark');
      if (mk) mk.style.setProperty('--lv', conf > 0 ? Math.max(0, Math.min(1, left / conf)).toFixed(3) : 0);
      var dirty = dl.carriers.indexOf(c) >= 0;
      tr.classList.toggle('is-dirty', dirty);
      inputs[c].classList.toggle('is-dirty', dirty);
      var was = tr.querySelector('.was');
      was.innerHTML = dirty ? 'saved <b>' + P.teu(saved[c] || 0) + '</b>' : '';
    });

    var tro = live ? ro : ro;
    if (!live) rollT($('#t-fc'), noFc ? null : res.forecast, tro);
    rollT($('#t-cf'), k.tot.cf, tro);
    if (!live) rollT($('#t-ut'), k.tot.ut, tro);
    rollT($('#t-left'), k.left, tro);
    $('#t-left').classList.toggle('n--red', k.left < -0.0049);
    var tp = k.tot.cf > 0 ? k.tot.ut / k.tot.cf * 100 : null;
    $('#t-bar').style.setProperty('--f', tp == null ? 0 : Math.min(1, tp / 100).toFixed(4));
    $('#t-bar').classList.toggle('is-over', tp != null && tp > 100.0001);
    rollT($('#t-pct'), tp, Object.assign({ format: P.pct }, tro));

    if (!live) rollT($('#f-tba'), noFc ? null : k.tba, ro);
    rollT($('#f-bal'), noFc ? null : k.ds, Object.assign({ format: P.teuDs }, ro));
    var row = $('#f-bal-row');
    row.classList.toggle('is-red', !noFc && k.status === 'deficit');
    row.classList.toggle('is-sea', !noFc && k.status === 'surplus');
    $('#f-bal-word').textContent = noFc ? 'Deficit / surplus: no forecast yet' : k.status === 'deficit' ? 'Deficit' : k.status === 'surplus' ? 'Surplus' : 'Balanced';

    paintSave(dl);
  }

  var changedSet = {};
  function onEdit(e) {
    if (e && e.target && e.target.id) changedSet[e.target.id.replace('cf-', '').toUpperCase()] = 1;
    else CARRIERS.forEach(function (c) { changedSet[c] = 1; });
    paintSave(dirtyList());
    clearTimeout(debounce);
    debounce = setTimeout(function () { var ch = changedSet; changedSet = {}; paint({ live: true, changed: ch }); }, 240);
  }

  /* ---------- FML forecast override ---------- */

  function paintFml() {
    var f = fmlTyped();
    var shown = fmlReset ? cfgFml : (f == null || isNaN(f) ? savedFml : f);
    var over = fmlReset ? false : (cfgFml != null && Math.abs(shown - cfgFml) > 1e-9);
    $('#fml-state').textContent = cfgFml == null ? ' '
      : over ? 'Set for this week. The default is ' + P.teu(cfgFml) + ' TEU.'
      : fmlReset ? 'Back to the default, ' + P.teu(cfgFml) + ' TEU, when you save.'
      : 'The default from Settings, ' + P.teu(cfgFml) + ' TEU.';
    $('#fml-reset').hidden = !(over || (fmlOverridden && !fmlReset));
  }
  $('#fml').addEventListener('input', function () {
    fmlReset = false;
    paintFml();
    paintSave(dirtyList());
    clearTimeout(debounce);
    debounce = setTimeout(function () { paint({ live: true, fml: true }); }, 240);
  });
  P.numericField($('#fml'));
  $('#fml').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); if (!$('#save-btn').disabled) $('#save-btn').focus(); }
    else if (e.key === 'Escape') { fmlReset = false; $('#fml').value = P.plain(savedFml); paintFml(); paint({ live: true, fml: true }); }
  });
  $('#fml-reset').addEventListener('click', function () {
    fmlReset = true;
    $('#fml').value = P.plain(cfgFml);
    paintFml();
    paint({ live: true, fml: true });
    $('#fml').focus();
  });

  /* ---------- save ---------- */

  var saveBox = $('#save'), saveBtn = $('#save-btn'), saveMsg = $('#save-msg');
  function paintSave(dl) {
    if (saving) return;
    var n = dl.carriers.length + (dl.fml ? 1 : 0);
    var st = saveBox.getAttribute('data-state');
    if (dl.bad) {
      saveBox.setAttribute('data-state', 'error');
      saveMsg.textContent = 'A figure is not a number. Use digits and one decimal point, no minus.';
      saveBtn.disabled = true;
    } else if (n) {
      saveBox.setAttribute('data-state', 'dirty');
      saveMsg.textContent = n + ' unsaved change' + (n === 1 ? '' : 's') + ' to week ' + sel.week + '.';
      saveBtn.disabled = false;
    } else if (st !== 'saved') {
      saveBox.setAttribute('data-state', 'clean');
      saveMsg.textContent = res ? 'No changes. Everything shown is saved.' : '';
      saveBtn.disabled = true;
    } else {
      saveBtn.disabled = true;
    }
    $('#revert').hidden = !n;
    saveBtn.textContent = 'Save week ' + sel.week;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var dl = dirtyList();
    if (saving || dl.bad || (!dl.carriers.length && !dl.fml)) return;
    var t = typed().conf;
    var body = { confirmed: {} };
    CARRIERS.forEach(function (c) { body.confirmed[c] = t[c]; });
    if (dl.fml) body.fml_forecast = fmlReset ? null : fmlTyped();
    saving = true;
    saveBox.setAttribute('data-state', 'saving');
    saveMsg.textContent = 'Saving week ' + sel.week + '…';
    saveBtn.disabled = true;
    var y = sel.year, w = sel.week;
    API.putWeekly(y, w, body).then(function (r) {
      saving = false;
      if (y !== sel.year || w !== sel.week) return;
      accept(r);
      saveBox.setAttribute('data-state', 'saved');
      var now = new Date();
      saveMsg.innerHTML = P.CHECK + '<span></span>';
      saveMsg.querySelector('span').textContent = 'Saved at ' + ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2) + '. Overview and reports use it now.';
      SH.say('Week ' + w + ' saved.');
      paint();
    }, function (err) {
      saving = false;
      saveBox.setAttribute('data-state', 'error');
      saveMsg.textContent = 'Not saved. ' + (err.message || 'The backend did not accept it.') + ' Your figures are still here; try again.';
      saveBtn.disabled = false;
      SH.say('Not saved. ' + (err.message || ''));
    });
  });
  $('#revert').addEventListener('click', function () {
    CARRIERS.forEach(function (c) { inputs[c].value = P.plain(saved[c]); });
    fmlReset = false;
    $('#fml').value = P.plain(savedFml);
    paintFml();
    saveBox.setAttribute('data-state', 'clean');
    paint();
  });

  SH.setGuard(function () {
    var dl = dirtyList();
    return (dl.carriers.length || dl.fml) ? 'Week ' + sel.week + ' has unsaved changes.' : '';
  });

  /* ---------- load ---------- */

  function accept(r) {
    res = r;
    CARRIERS.forEach(function (c) {
      saved[c] = r.carriers[c].confirmed;
      inputs[c].value = r.carriers[c].confirmed ? P.plain(r.carriers[c].confirmed) : '';
    });
    savedFml = r.carrier_forecast.FML;
    fmlOverridden = cfgFml != null && Math.abs(savedFml - cfgFml) > 1e-9;
    fmlReset = false;
    $('#fml').value = P.plain(savedFml);
    paintFml();
  }

  function setState(s) { main.setAttribute('data-state', s); main.setAttribute('aria-busy', s === 'loading' ? 'true' : 'false'); }

  function load() {
    var id = ++reqId;
    sel = SH.week();
    setState('loading');
    $('#err').hidden = true;
    var range = W.rangeText(sel.year, sel.week);
    P.pop($('#title'), ['Week ' + sel.week + ' ', { em: 'allocation' }]);
    P.pop($('#sub'), [range + '. Loading…']);
    Promise.all([API.getWeekly(sel.year, sel.week), cfgFml == null ? API.getConfig() : Promise.resolve(null)]).then(function (out) {
      if (id !== reqId) return;
      if (out[1]) cfgFml = out[1].fml_default;
      var r = out[0];
      accept(r);
      setState('ready');
      form.hidden = false;
      var noFc = !(r.forecast > 0);
      $('#nofc').hidden = !noFc;
      P.pop($('#sub'), [range + '. ' + (noFc ? 'No forecast on file yet, so forecast shows a dash.' : 'Forecast and the carrier split come from the uploaded forecast. Type what each carrier confirmed.')], { delay: 220, step: 12, dur: 520 });
      saveBox.setAttribute('data-state', 'clean');
      paint();
      firstPaint = false;
      if (window.CA.cursor) window.CA.cursor.refresh();
    }, function (err) {
      if (id !== reqId) return;
      setState('error');
      res = null;
      form.hidden = true;
      $('#nofc').hidden = true;
      $('#err').hidden = false;
      $('#err-body').textContent = err.message || 'Something went wrong.';
      P.pop($('#sub'), [range + '.']);
      SH.say('Could not load week ' + sel.week + '. ' + (err.message || ''));
    });
  }
  $('#retry').addEventListener('click', load);

  buildRows();
  window.CA.cursor.init();
  SH.onWeek(function () { load(); });
  load();
})();
