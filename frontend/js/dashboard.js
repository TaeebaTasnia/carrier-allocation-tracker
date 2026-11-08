/* Overview controller: data loading, figures, jars, notes. The bar, menus and week live in js/shell.js. */
(function () {
  'use strict';

  var D = window.CA.data;
  var W = window.CA.weeks, SH = window.CA.shell;
  var rangeText = W.rangeText, mondayOf = W.mondayOf;
  function say(t) { SH.say(t); }
  var CARRIERS = D.CARRIERS;
  var reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---------- numbers ---------- */

  var NUM = window.CA.numbers;
  function fmt(n) { return NUM.format(n); }
  function signed(n) { return NUM.format(n, { sign: true }); }
  // TEU is shown as whole TEU, rounded up (CA.numbers.teu); the deficit/surplus also applies the balanced band
  function teu(n) { return NUM.teu(n); }
  function teuDs(n) { return NUM.teu(n, { band: true, sign: true }); }
  function teuDsAbs(n) { return NUM.teu(Math.abs(n), { band: true }); }
  function pct(n) {
    if (n == null || !isFinite(n)) return '—';
    if (n > 0 && n < 1) return '<1%';
    return Math.round(n) + '%';
  }
  // every figure is rolled by CA.numbers (js/numbers.js); within one render each successive figure
  // starts a little later, so the page reads as being worked out top to bottom
  var seq = 0;
  function countTo(el, to, opts) {
    opts = opts || {};
    var stagger = Math.min(seq++ * 55, 620);
    NUM.roll(el, to, {
      format: opts.format || teu,
      delay: (opts.delay || 0) + stagger,
      duration: opts.duration || 950
    });
  }

  /* ---------- state ---------- */

  var sel = SH.week();

  var ov = $('#main');
  var stage = $('.stage');
  var jars, firstLoad = true, reqId = 0, loadingTimer = 0;
  var pinned = 'left', current = null;

  /* ---------- build the jars ---------- */

  var row = $('#jars');
  var tpl = $('#jar-tpl');
  CARRIERS.forEach(function (name, i) {
    var node = tpl.content.firstElementChild.cloneNode(true);
    node.setAttribute('data-jar', name);
    node.setAttribute('data-carrier', name);
    node.style.setProperty('--d', (260 + i * 80) + 'ms');
    $('.jar__name', node).textContent = name;
    $('.tip__title', node).textContent = name;
    var tip = $('.tip', node);
    tip.id = 'tip-' + name.toLowerCase();
    $('.jar__btn', node).setAttribute('aria-describedby', tip.id);
    row.appendChild(node);
  });

  // entrance order: headline (its own reveal, js/page.js), figures, jars, notes
  $$('.fig').forEach(function (f, i) { f.style.setProperty('--d', (120 + i * 55) + 'ms'); });
  $('.stage__key').style.setProperty('--d', '760ms');
  $('#note-arrive').style.setProperty('--d', '560ms');
  $('#note-balance').style.setProperty('--d', '660ms');

  jars = new window.CA.Jars(stage);
  window.CA.cursor.init();
  $$('.jar').forEach(function (j) {
    var name = j.getAttribute('data-jar');
    window.CA.cursor.tilt($('.jar__glass', j), {
      max: 9, reach: 36, perspective: 640,
      onTilt: function (rx, ry) { jars.lean(name, ry); }
    });
  });
  $$('.fig__num').forEach(function (n) { window.CA.cursor.tilt(n, { max: 7, reach: 0, perspective: 500 }); });
  window.addEventListener('pointermove', onFirstPointer, { passive: true });
  function onFirstPointer() { jars.measure(); window.removeEventListener('pointermove', onFirstPointer); }


  /* ---------- figures: accent bar + link to the picture ---------- */

  var bar = $('.figs__bar');
  var JAR_FOCUS = { forecast: 'forecast', confirmed: 'confirmed', utilized: 'utilized', left: 'left', arrive: 'none', balance: 'none' };
  function focusKey(key) {
    current = key;
    $$('.fig').forEach(function (f) { f.classList.toggle('is-on', f.getAttribute('data-key') === key); });
    stage.setAttribute('data-focus', key);
    jars.setFocus(JAR_FOCUS[key] || 'left');
    $('#note-arrive').classList.toggle('is-hot', key === 'arrive');
    $('#note-balance').classList.toggle('is-hot', key === 'balance');
    placeBar();
  }
  function placeBar() {
    var f = $('.fig[data-key="' + (current || pinned) + '"]');
    if (!f) return;
    var top = f.offsetTop + f.offsetHeight * 0.22, h = f.offsetHeight * 0.56;
    bar.style.setProperty('--by', top + 'px');
    bar.style.setProperty('--bh', (h / 100).toFixed(3));
    var bal = f.getAttribute('data-key') === 'balance' && current && f.classList.contains('is-deficit');
    bar.classList.toggle('is-deficit', !!bal);
    bar.classList.toggle('is-surplus', f.getAttribute('data-key') === 'balance' && f.classList.contains('is-surplus'));
  }
  $$('.fig').forEach(function (f) {
    var key = f.getAttribute('data-key');
    f.addEventListener('pointerenter', function () { focusKey(key); });
    f.addEventListener('focus', function () { focusKey(key); });
    f.addEventListener('click', function () {
      pinned = key;
      $$('.fig').forEach(function (g) { g.setAttribute('aria-pressed', String(g === f)); });
      focusKey(key);
    });
  });
  $('.figs').addEventListener('pointerleave', function () { focusKey(pinned); });
  $('.figs').addEventListener('focusout', function (e) { if (!e.relatedTarget || !e.relatedTarget.closest('.figs')) focusKey(pinned); });
  window.addEventListener('resize', placeBar);

  /* ---------- phones: one readout under the jar row instead of floating tooltips ---------- */

  var narrowMQ = matchMedia('(max-width: 760px)');
  var readJar = null;
  function showReadout(j) {
    var box = $('#readout');
    readJar = j;
    if (!j || !narrowMQ.matches) { box.hidden = true; return; }
    $('#readout-title').textContent = j.getAttribute('data-jar');
    $('#readout-rows').innerHTML = $('.tip__rows', j).innerHTML;
    box.hidden = false;
  }

  /* ---------- tooltips: Esc dismisses (WCAG 1.4.13) ---------- */

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') $$('.jar').forEach(function (j) { j.classList.add('tip-off'); });
  });
  $$('.jar').forEach(function (j) {
    var btn = $('.jar__btn', j);
    j.addEventListener('pointerleave', function () { j.classList.remove('tip-off'); });
    btn.addEventListener('blur', function () { j.classList.remove('tip-off'); j.classList.remove('is-open'); });
    // tap or click pins the details open (touch has no hover)
    btn.addEventListener('click', function () {
      var open = !j.classList.contains('is-open');
      $$('.jar.is-open').forEach(function (o) { o.classList.remove('is-open'); });
      j.classList.toggle('is-open', open);
      j.classList.remove('tip-off');
      showReadout(open ? j : null);
    });
    btn.addEventListener('focus', function () { if (narrowMQ.matches) showReadout(j); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') $$('.jar.is-open').forEach(function (o) { o.classList.remove('is-open'); });
  });


  /* ---------- load and render ---------- */

  function setState(s) {
    ov.setAttribute('data-state', s);
    ov.setAttribute('aria-busy', s === 'loading' ? 'true' : 'false');
  }

  function stageMessage(title, body, retry) {
    var box = $('#stage-msg');
    box.hidden = !title && !body;
    $('#stage-msg-title').textContent = title || '';
    $('#stage-msg-title').hidden = !title;
    $('#stage-msg-body').textContent = body || '';
    $('#retry').hidden = !retry;
  }

  function load() {
    var id = ++reqId;
    clearTimeout(loadingTimer);
    // the loading line only if the week is slow to come (a quick answer goes straight to its
    // headline; on a week change the old line has already left, see SH.onWeek below)
    loadingTimer = setTimeout(function () {
      if (id !== reqId) return;
      setState('loading');
      headText = 'Loading week ' + sel.week;
      pop($('#headline'), [headText]);
      pop($('#sub'), [rangeText(sel.year, sel.week)]);
      stageMessage('', '');
      if (firstLoad) jars.setOutline(16);
      window.CA.cursor.refresh();
    }, firstLoad ? 250 : 450);
    D.getWeek(sel.year, sel.week).then(function (res) {
      if (id !== reqId) return;
      clearTimeout(loadingTimer);
      render(res);
    }, function (err) {
      if (id !== reqId) return;
      clearTimeout(loadingTimer);
      renderError(err);
    });
  }
  $('#retry').addEventListener('click', load);

  function setFig(key, value, opts) {
    var el = $('.fig[data-key="' + key + '"] [data-v]');
    el.closest('.fig').classList.toggle('is-null', value == null || !isFinite(value));
    countTo(el, value, opts);
  }

  var headText = '';

  /* The headline reveal (js/page.js CA.page.pop): each line rises out of its own mask, the
   * hairline draws, the sub line follows; afterwards plain text again. Reduced motion: at once. */
  function pop(elm, parts, o) { window.CA.page.pop(elm, parts, o); }

  // the headline number rolls like the figures and locks in as its line settles; headText keeps
  // the plain sentence for announcements
  function headNum(h, before, value, after) {
    var n = document.createElement('span');
    n.className = 'hl-num';
    var text = teu(value);
    n.textContent = text;                       // measured at its final width when lines are found
    headText = before + text + after;
    pop(h, [before, n, after], {
      label: headText,
      onReveal: function (r) {
        var digits = (text.match(/\d/g) || []).length;
        // last digit locks at delay + (digits - 1) * 24 + duration (+ ~33 ms of arming frames)
        var lead = 40, dur = Math.max(360, r.settle - lead - 33 - Math.max(0, digits - 1) * 24);
        NUM.roll(n, value, { format: teu, delay: r.delayOf(n) + lead, duration: r.dur ? dur : 0 });
      }
    });
  }
  function headPlain(h, before, key) { headText = before + key; pop(h, [before, { em: key }]); }
  function subPop(text) { pop($('#sub'), [text]); }

  function render(res) {
    var noForecast = !(res.forecast_cbm_plus > 0) && !(res.daily || []).some(function (d) { return d.forecast_teu > 0; });
    var nothing = noForecast && !(res.total_confirmed > 0) && !(res.total_utilized > 0);
    var dur = firstLoad ? 1050 : 850;
    seq = 0;
    var w = res.week, range = rangeText(res.year, res.week);
    var left = res.to_be_utilized, tba = res.to_be_arrived, ds = res.deficit_surplus;
    var status = noForecast ? 'none' : res.status;

    setState(nothing ? 'empty' : 'ready');
    var h = $('#headline'), sub = $('#sub');
    if (nothing) {
      headPlain(h, 'Week ' + w + ': ', 'no forecast uploaded');
      subPop(range + '. No forecast, confirmed space or stuffing is on file for this week yet.');
    } else if (left < 0) {
      headNum(h, 'Week ' + w + ': ', -left, ' TEU over confirmed space');
      subPop(range + '. More was utilized than the carriers confirmed.');
    } else {
      headNum(h, 'Week ' + w + ': ', left, ' TEU left to use');
      if (noForecast) subPop(range + '. No forecast uploaded for this week, so there is nothing to balance against yet.');
      else if (status === 'deficit') subPop(range + '. ' + teu(tba) + ' TEU is still to arrive, so the week is ' + teuDsAbs(ds) + ' TEU short.');
      else if (status === 'surplus') subPop(range + '. ' + teu(tba) + ' TEU is still to arrive, leaving ' + teuDsAbs(ds) + ' TEU spare.');
      else subPop(range + '. What is left matches the ' + teu(tba) + ' TEU still to arrive.');
    }

    // figures
    var o = { duration: dur };
    setFig('forecast', noForecast ? null : res.forecast, o);
    setFig('confirmed', nothing ? null : res.total_confirmed, o);
    setFig('utilized', nothing ? null : res.total_utilized, o);
    setFig('left', nothing ? null : left, o);
    setFig('arrive', noForecast ? null : tba, o);
    setFig('balance', noForecast ? null : ds, { duration: dur, format: teuDs });
    var bal = $('.fig--balance');
    bal.classList.toggle('is-deficit', status === 'deficit');
    bal.classList.toggle('is-surplus', status === 'surplus');
    $('#status-word').textContent = status === 'deficit' ? 'Deficit' : status === 'surplus' ? 'Surplus' : status === 'balanced' ? 'Balanced' : 'Deficit / surplus: no forecast yet';

    // jars
    $('#jars').classList.toggle('is-blank', nothing);
    if (nothing) jars.setOutline(16);
    else jars.setData(res.carriers, { fromEmpty: firstLoad, delay: 420, stagger: 90 });
    CARRIERS.forEach(function (name) { fillJar(name, res.carriers[name], res, nothing); });
    ['.key--glass', '.key--water', '.key--tick'].forEach(function (s) { $(s).hidden = nothing; });
    $('.key--rest').hidden = !nothing;
    $('.key--ghost').hidden = nothing || !CARRIERS.some(function (c) { return res.carriers[c].confirmed <= 0; });
    if (nothing) stageMessage('', 'The jars fill once a forecast and confirmed space are on file for ' + range + '. Upload the forecast under Uploads below.');
    else stageMessage('', '');

    // notes
    var actual = res.total_actual_teu;
    var arrivedShare = res.forecast > 0 ? Math.min(1, actual / res.forecast) : 0;
    $('#tube-fill').style.setProperty('--f', noForecast ? 0 : arrivedShare.toFixed(4));
    var tube = $('#tube');
    $('#tube-tick').style.setProperty('--tx', (noForecast ? 0 : arrivedShare * (tube.clientWidth - 1)).toFixed(1) + 'px');
    tube.setAttribute('aria-label', noForecast ? 'No forecast for this week'
      : 'Arrived so far, from the stuffing report, ' + teu(actual) + ' of ' + teu(res.forecast) + ' TEU forecast; ' + teu(tba) + ' TEU still to arrive');
    countTo($('#l-forecast'), noForecast ? null : res.forecast, o);
    countTo($('#l-actual'), noForecast ? null : actual, o);
    countTo($('#l-arrive'), noForecast ? null : tba, o);
    var adj = (res.daily || []).filter(function (d) { return d.actual_cbm_source === 'entered'; }).length;
    var anyStuff = (res.daily || []).some(function (d) { return d.actual_cbm_source && d.actual_cbm_source !== 'none' && d.actual_cbm_source !== 'entered'; });
    var fine = $('#arrive-fine');
    fine.hidden = false;
    fine.textContent = 'Arrived so far is the CBM from the daily stuffing report (its CBM column if the file has one, otherwise TEU x CBM per TEU) divided by the CBM per TEU' +
      (adj ? '; ' + adj + (adj === 1 ? ' day is' : ' days are') + ' counted as adjusted in Date-wise.' : '.') +
      (anyStuff || adj ? '' : ' No stuffing report is on file for this week yet, so it reads 0.');

    countTo($('#b-left'), noForecast ? null : left, o);
    countTo($('#b-arrive'), noForecast ? null : tba, o);
    countTo($('#b-total'), noForecast ? null : ds, { duration: dur, format: teuDs });
    var sum = $('#note-balance .ledger__sum');
    sum.classList.toggle('is-deficit', status === 'deficit');
    sum.classList.toggle('is-surplus', status === 'surplus');
    $('#b-word').textContent = status === 'deficit' ? 'Deficit' : status === 'surplus' ? 'Surplus' : status === 'balanced' ? 'Balanced' : 'Balance';

    // footer
    var src = D.USE_BACKEND ? 'Data from the backend at ' + D.API_BASE + '.' : 'Demo data: weeks 45 to 47 of the 2026 workbook.';
    if (D.FIXTURE) src += ' Test fixture: ' + D.FIXTURE + '.';
    $('#foot-source').textContent = 'Figures in TEU. 1 TEU is 33 CBM after the 30% uplift. ' + src;

    placeBar();
    if (readJar) showReadout(readJar);
    window.CA.cursor.refresh();
    if (!firstLoad) say(headText + '. ' + $('#sub').textContent);
    firstLoad = false;
  }

  function fillJar(name, c, res, nothing) {
    var node = $('.jar[data-jar="' + name + '"]');
    var mode = nothing ? 'blank' : c.confirmed <= 0 ? 'none' : c.left < 0 ? 'over' : 'ok';
    node.classList.toggle('is-over', mode === 'over');
    node.classList.toggle('is-none', mode === 'none');
    var v = $('.jar__v', node), unit = $('.jar__unit', node), p = $('.jar__pct', node), btn = $('.jar__btn', node);
    var o = { duration: firstLoad ? 1100 : 900, delay: firstLoad ? 420 : 0 };
    if (mode === 'blank') {
      countTo(v, null); unit.textContent = ''; p.textContent = 'Nothing on file';
      btn.setAttribute('aria-label', name + ': nothing on file for this week. The low water is a resting level, not capacity.');
    } else if (mode === 'none') {
      countTo(v, c.forecast, o); unit.textContent = ' TEU'; p.textContent = 'Forecast only';
      btn.setAttribute('aria-label', name + ': no capacity confirmed. The faint hatched level is the forecast allocation, ' + teu(c.forecast) + ' TEU, not confirmed space.');
    } else if (mode === 'over') {
      countTo(v, c.left, o); unit.textContent = ' TEU'; p.textContent = 'Over by ' + teu(-c.left) + ' TEU';
      btn.setAttribute('aria-label', name + ': over confirmed space by ' + teu(-c.left) + ' TEU, ' + teu(c.utilized) + ' utilized of ' + teu(c.confirmed) + ' confirmed.');
    } else {
      countTo(v, c.left, o); unit.textContent = ' TEU left';
      countTo(p, c.pct_of_confirmed, { duration: o.duration, delay: o.delay, format: function (n) { return pct(n) + ' used'; } });
      btn.setAttribute('aria-label', name + ': ' + teu(c.left) + ' TEU left of ' + teu(c.confirmed) + ' TEU confirmed, ' + pct(c.pct_of_confirmed) + ' used.');
    }
    var rows = [
      ['Forecast allocation', teu(c.forecast) + ' TEU'],
      ['Confirmed', teu(c.confirmed) + ' TEU'],
      ['Utilized', teu(c.utilized) + ' TEU'],
      ['Left', teu(c.left) + ' TEU', c.left < 0],
      ['Used of confirmed', pct(c.pct_of_confirmed)],
      ['Share of the week’s utilized', res.total_utilized > 0 ? pct(c.pct_share) : '—'],
      ['Confirmed minus forecast', NUM.teu(c.confirmed - c.forecast, { sign: true }) + ' TEU', c.confirmed - c.forecast < -0.005]
    ];
    var dl = $('.tip__rows', node);
    dl.textContent = '';
    rows.forEach(function (r) {
      var d = document.createElement('div');
      if (r[2]) d.className = 'is-red';
      var dt = document.createElement('dt'); dt.textContent = r[0];
      var dd = document.createElement('dd'); dd.textContent = r[1];
      d.appendChild(dt); d.appendChild(dd); dl.appendChild(d);
    });
  }

  function renderError(err) {
    setState('error');
    headText = 'Could not load week ' + sel.week;
    pop($('#headline'), [headText]);
    pop($('#sub'), [rangeText(sel.year, sel.week) + '. No figures are shown until it loads.']);
    ['forecast', 'confirmed', 'utilized', 'left', 'arrive', 'balance'].forEach(function (k) { setFig(k, null); });
    jars.setOutline(16);
    $$('.jar').forEach(function (node) {
      countTo($('.jar__v', node), null);
      $('.jar__unit', node).textContent = '';
      $('.jar__pct', node).textContent = '';
      node.classList.remove('is-over', 'is-none');
      $('.jar__btn', node).setAttribute('aria-label', node.getAttribute('data-jar') + ': not loaded.');
      $('.tip__rows', node).textContent = '';
    });
    ['#l-forecast', '#l-actual', '#l-arrive', '#b-left', '#b-arrive', '#b-total'].forEach(function (s) { countTo($(s), null); });
    $('#tube-fill').style.setProperty('--f', 0);
    $('#arrive-fine').hidden = true;
    stageMessage('The week did not load', (err && err.message) || 'Something went wrong while loading the week.', true);
    window.CA.cursor.refresh();
    say('Could not load week ' + sel.week + '. ' + ((err && err.message) || ''));
    firstLoad = false;
  }

  // used by uploads.js
  window.CA.overview = {
    reload: load,
    go: function (y, w) { if (!SH.go(y, w)) load(); },
    mondayIso: function () { return mondayOf(sel.year, sel.week).toISOString().slice(0, 10); }
  };

  // a week change: the old headline leaves at once, the new one rises when the week has loaded
  SH.onWeek(function (y, w) { sel = { year: y, week: w }; window.CA.page.headExit($('#headline')); load(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { placeBar(); window.CA.cursor.invalidate(); jars.layout(); });
  focusKey(pinned);
  load();
})();
