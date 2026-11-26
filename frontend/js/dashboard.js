/* Overview controller: data loading, figures, the carrier bar chart, notes. The bar, menus and week live in js/shell.js. */
(function () {
  'use strict';

  var D = window.CA.data;
  var W = window.CA.weeks, SH = window.CA.shell;
  var rangeText = W.rangeText;
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
  var firstLoad = true, reqId = 0, loadingTimer = 0;
  var pinned = 'left', current = null;

  /* ---------- the carrier chart (js/carrierbars.js + css/carrierbars.css) ----------
   * One row per carrier, built once: a button holding the label block the jars had (name in the
   * carrier hue, the TEU left as a big rolling figure, a status line) and the lane on the shared
   * TEU scale, plus its details tooltip. Each render replaces the lanes, so the entrance plays
   * once per week shown. */

  var CB = window.CA.carrierBars;
  var bars = $('#bars');
  var rowsEl = $('#bars-rows');
  CARRIERS.forEach(function (name) {
    var li = document.createElement('li');
    li.className = 'cb__item';
    li.setAttribute('data-carrier', name);
    li.setAttribute('data-bar', name);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cb__row';
    var ln = document.createElement('span');
    ln.className = 'cb__lane';
    ln.setAttribute('aria-hidden', 'true');
    var lab = document.createElement('span');
    lab.className = 'cl';
    lab.innerHTML = '<span class="cl__name" data-ink></span>' +
      '<span class="cl__left" data-ink><span class="cl__v">—</span><span class="cl__unit"></span></span>' +
      '<span class="cl__pct" data-ink></span>';
    $('.cl__name', lab).textContent = name;
    btn.appendChild(lab); btn.appendChild(ln);
    var tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('role', 'tooltip');
    tip.id = 'tip-' + name.toLowerCase();
    tip.innerHTML = '<p class="tip__title"></p><dl class="tip__rows"></dl>';
    $('.tip__title', tip).textContent = name;
    btn.setAttribute('aria-describedby', tip.id);
    btn.setAttribute('aria-label', name + ': loading.');
    li.appendChild(btn); li.appendChild(tip);
    rowsEl.appendChild(li);
  });

  // the lanes for one week (or empty: the axis and the grid lines only)
  function drawChart(wk) {
    var sc = CB.scale(wk && !wk.nothing ? CB.maxOf(wk.res.carriers) : 0);
    CB.axis($('#axis'), sc);
    CARRIERS.forEach(function (name, i) {
      var ln = $('.cb__item[data-bar="' + name + '"] .cb__lane');
      var c = wk ? wk.res.carriers[name] : { forecast: 0, confirmed: 0, utilized: 0 };
      var base = (firstLoad ? 320 : 0) + i * 40;
      ln.textContent = '';
      ln.appendChild(CB.lane(c, sc, {
        i: i, blank: !wk || wk.nothing, fc: !(wk && wk.noForecast && name !== 'FML'),
        // the pin's number rolls in as the pin drops (css/carrierbars.css: +420 ms)
        pin: function (b, val) { NUM.roll(b, val, { format: teu, delay: base + 420, duration: 480 }); }
      }));
    });
  }
  function blankBars() { drawChart(null); }  blankBars();

  // entrance order: headline (its own reveal, js/page.js), figures, chart, notes
  $$('.fig').forEach(function (f, i) { f.style.setProperty('--d', (120 + i * 55) + 'ms'); });
  $('.stage__key').style.setProperty('--d', '760ms');
  $('#note-arrive').style.setProperty('--d', '560ms');

  window.CA.cursor.init();
  $$('.fig__num').forEach(function (n) { window.CA.cursor.tilt(n, { max: 7, reach: 0, perspective: 500 }); });


  /* ---------- figures: accent bar + link to the picture ---------- */

  var bar = $('.figs__bar');
  function focusKey(key) {
    current = key;
    $$('.fig').forEach(function (f) { f.classList.toggle('is-on', f.getAttribute('data-key') === key); });
    // css/dashboard.css dims the parts of the chart the figure is not about
    stage.setAttribute('data-focus', key);
    $('#note-arrive').classList.toggle('is-hot', key === 'arrive' || key === 'balance');
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

  /* ---------- phones: one readout under the chart instead of floating tooltips ---------- */

  var narrowMQ = matchMedia('(max-width: 760px)');
  var readRow = null;
  function showReadout(j) {
    var box = $('#readout');
    readRow = j;
    if (!j || !narrowMQ.matches) { box.hidden = true; return; }
    $('#readout-title').textContent = j.getAttribute('data-bar');
    $('#readout-rows').innerHTML = $('.tip__rows', j).innerHTML;
    box.hidden = false;
  }

  /* ---------- tooltips: Esc dismisses (WCAG 1.4.13) ---------- */

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') $$('.cb__item').forEach(function (j) { j.classList.add('tip-off'); j.classList.remove('is-open'); });
  });
  $$('.cb__item').forEach(function (j) {
    var btn = $('.cb__row', j);
    j.addEventListener('pointerleave', function () { j.classList.remove('tip-off'); });
    btn.addEventListener('blur', function () { j.classList.remove('tip-off'); j.classList.remove('is-open'); });
    // tap or click pins the details open (touch has no hover)
    btn.addEventListener('click', function () {
      var open = !j.classList.contains('is-open');
      $$('.cb__item.is-open').forEach(function (o) { o.classList.remove('is-open'); });
      j.classList.toggle('is-open', open);
      j.classList.remove('tip-off');
      showReadout(open ? j : null);
    });
    btn.addEventListener('focus', function () { if (narrowMQ.matches) showReadout(j); });
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

    // the chart: new lanes for this week (the entrance plays once), one shared scale;
    // under each one the label block the jars had
    if (!firstLoad) bars.removeAttribute('data-first');
    drawChart({ res: res, nothing: nothing, noForecast: noForecast });
    CARRIERS.forEach(function (name) { fillLabel(name, res.carriers[name], res, nothing); });
    $('.key--none').hidden = nothing || !CARRIERS.some(function (c) { return res.carriers[c].confirmed <= 0; });
    $('.key--over').hidden = nothing || !CARRIERS.some(function (c) { return res.carriers[c].utilized > res.carriers[c].confirmed + CB.EPS; });
    if (nothing) stageMessage('', 'The chart fills once a forecast and confirmed space are on file for ' + range + '. Upload the forecast under Upload below.');
    else stageMessage('', '');

    // notes
    var actual = res.total_actual_teu;
    var arrivedShare = res.forecast > 0 ? Math.min(1, actual / res.forecast) : 0;
    $('#tube-fill').style.setProperty('--f', noForecast ? 0 : arrivedShare.toFixed(4));
    var tube = $('#tube');
    $('#tube-tick').style.setProperty('--tx', (noForecast ? 0 : arrivedShare * (tube.clientWidth - 1)).toFixed(1) + 'px');
    tube.setAttribute('aria-label', noForecast ? 'No forecast for this week'
      : 'Arrived so far, from daily stuffing, ' + teu(actual) + ' of ' + teu(res.forecast) + ' TEU forecast; ' + teu(tba) + ' TEU still to arrive');
    countTo($('#l-forecast'), noForecast ? null : res.forecast, o);
    countTo($('#l-actual'), noForecast ? null : actual, o);
    countTo($('#l-arrive'), noForecast ? null : tba, o);

    placeBar();
    if (readRow) showReadout(readRow);
    window.CA.cursor.refresh();
    if (!firstLoad) say(headText + '. ' + $('#sub').textContent);
    firstLoad = false;
  }

  // the label block beside each lane (the jars' labels, unchanged): name, the TEU left as a big
  // rolling figure with its unit, a status line; plus the screen-reader label and the details
  function fillLabel(name, c, res, nothing) {
    var node = $('.cb__item[data-bar="' + name + '"]');
    var mode = nothing ? 'blank' : c.confirmed <= 0 ? 'none' : c.left < 0 ? 'over' : 'ok';
    node.classList.toggle('is-over', mode === 'over');
    node.classList.toggle('is-none', mode === 'none');
    node.classList.toggle('is-blank', mode === 'blank');
    var v = $('.cl__v', node), unit = $('.cl__unit', node), p = $('.cl__pct', node), btn = $('.cb__row', node);
    var o = { duration: firstLoad ? 1100 : 900, delay: firstLoad ? 420 : 0 };
    if (mode === 'blank') {
      countTo(v, null); unit.textContent = ''; p.textContent = 'Nothing on file';
      btn.setAttribute('aria-label', name + ': nothing on file for this week.');
    } else if (mode === 'none') {
      countTo(v, c.forecast, o); unit.textContent = ' TEU'; p.textContent = 'Forecast only';
      btn.setAttribute('aria-label', name + ': no capacity confirmed. The forecast allocation is ' + teu(c.forecast) + ' TEU, not confirmed space.');
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
    blankBars();
    $$('.cb__item').forEach(function (node) {
      countTo($('.cl__v', node), null);
      $('.cl__unit', node).textContent = '';
      $('.cl__pct', node).textContent = '';
      node.classList.remove('is-over', 'is-none', 'is-blank');
      $('.cb__row', node).setAttribute('aria-label', node.getAttribute('data-bar') + ': not loaded.');
      $('.tip__rows', node).textContent = '';
    });
    if (readRow) showReadout(readRow);
    ['#l-forecast', '#l-actual', '#l-arrive'].forEach(function (s) { countTo($(s), null); });
    $('#tube-fill').style.setProperty('--f', 0);
    stageMessage('The week did not load', (err && err.message) || 'Something went wrong while loading the week.', true);
    window.CA.cursor.refresh();
    say('Could not load week ' + sel.week + '. ' + ((err && err.message) || ''));
    firstLoad = false;
  }

  // used by uploads.js
  window.CA.overview = {
    reload: load,
    go: function (y, w) { if (!SH.go(y, w)) load(); }
  };

  // a week change: the old headline leaves at once, the new one rises when the week has loaded
  SH.onWeek(function (y, w) { sel = { year: y, week: w }; window.CA.page.headExit($('#headline')); load(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { placeBar(); window.CA.cursor.invalidate(); });
  focusKey(pinned);
  load();
})();
