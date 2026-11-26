/* MOCKUP ONLY, not part of the app. Builds the static page copy inside #mk-stage of
 * cleanup-before-after.html:
 *   before   the page as it is today (DOM copied from the live page, cleanup-data.js)
 *   after    the same DOM with the items of cleanup-items.js applied (A below)
 *   changes  the "before" DOM with every item outlined and badged (T below: the targets)
 * The Overview chart lanes are drawn by the real js/carrierbars.js from week 45's figures.
 * Exposes window.MKS (select an item, redraw) for cleanup-before-after.js and calls back through
 * window.MK when a badge on the page is selected.
 */
(function () {
  'use strict';

  var d = document.documentElement;
  var PAGE = d.getAttribute('data-mk-page'), VIEW = d.getAttribute('data-mk-view');
  var S = window.MK_SCREENS[PAGE];
  var ITEMS = window.MK_ITEMS;
  var stage = document.getElementById('mk-stage');

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function rowOf(id) { var e = document.getElementById(id); return e ? e.closest('dl > div') : null; }
  function rm(e) { if (e && e.parentNode) e.parentNode.removeChild(e); }

  d.classList.add('mk-still');   // no entrance animations: the views swap instantly
  stage.innerHTML = (S.bar + S.main + (S.up || '') + S.foot).replace(/ src="assets\//g, ' src="../assets/');

  /* ---------- the footer source line: split into units / developer text ---------- */
  var src = $('#foot-source');
  if (src) {
    var t = src.textContent, i = t.search(/ (Data from|Demo data)/);
    src.textContent = '';
    var u = document.createElement('span'); u.id = 'mk-units'; u.textContent = i < 0 ? t : t.slice(0, i); src.appendChild(u);
    if (i >= 0) { var dv = document.createElement('span'); dv.id = 'mk-dev'; dv.textContent = t.slice(i); src.appendChild(dv); }
  }

  /* ---------- Overview: the chart lanes, from the real carrier bar module ---------- */
  if (PAGE === 'overview' && window.CA && window.CA.carrierBars) {
    var CB = window.CA.carrierBars, fc = 72.660565;   // week 45 forecast total, TEU
    var W = {
      MAERSK: { forecast: fc * 0.30, confirmed: 20, utilized: 2 },
      HAPAG: { forecast: fc * 0.25, confirmed: 24, utilized: 16 },
      HELLMAN: { forecast: fc * 0.20, confirmed: 0, utilized: 0 },
      ONE: { forecast: fc * 0.25, confirmed: 10, utilized: 14 },
      FML: { forecast: 10, confirmed: 10, utilized: 0 }
    };
    var sc = CB.scale(CB.maxOf(W));
    CB.axis($('#axis'), sc);
    ['MAERSK', 'HAPAG', 'HELLMAN', 'ONE', 'FML'].forEach(function (c, k) {
      var ln = $('.cb__item[data-bar="' + c + '"] .cb__lane');
      if (!ln) return;
      ln.textContent = '';
      ln.appendChild(CB.lane(W[c], sc, { i: k }));
    });
  }

  /* ---------- targets (in the "before" DOM) and edits ("after") ---------- */
  var SUB_AFTER = '2 to 8 November 2026.';
  var T = {
    1: function () { return [$('#sub')]; },
    2: function () { return [rowOf('l-forecast'), rowOf('l-arrive')]; },
    3: function () { return [$('.key--left')]; },
    4: function () { return [$('#up-title'), $('.drop__title'), $('.up__lede'), $('.drop__what')]; },
    5: function () { return [$('.figs__list')]; },
    6: function () { return [rowOf('f-fc'), rowOf('f-cf'), rowOf('f-left')]; },
    7: function () { var r = rowOf('f-fc'); return [r && $('dt', r)]; },
    8: function () { return [$('#to-datewise')]; },
    9: function () { return [$('#sub')]; },
    10: function () { return $$('.av__word').filter(function (w) { return !/on forecast/i.test(w.textContent); }); },
    11: function () { return [$$('.av__lede')[1]]; },
    12: function () { return $$('.av__level .lvl'); },
    13: function () { return [$('.foot .round-note'), $('#mk-units')]; },
    14: function () { return [$('#mk-dev')]; }
  };
  var A = {
    1: function () { $('#sub').textContent = SUB_AFTER; },
    2: function () { T[2]().forEach(rm); },
    3: function () { T[3]().forEach(rm); },
    4: function () {
      rm($('.drop__title')); rm($('.drop__what'));
      $('.up__lede').textContent = 'The weekly forecast workbook (.xlsx) that every figure above starts from; upload it again whenever the forecast changes.';
      $('.up').classList.add('mk-up-one');
    },
    5: function () { $('.figs__list').classList.add('mk-nounit'); },
    6: function () { T[6]().forEach(rm); },
    7: function () { /* the second note was the label of the Forecast row, which item 6 removes */ },
    8: function () {},
    9: function () { $('#sub').textContent = SUB_AFTER; },
    10: function () { T[10]().forEach(rm); },
    11: function () { T[11]()[0].textContent = 'Stuffed TEU per carrier for each day; the deeper the colour, the busier the cell. Select a day to open it in Date-wise.'; },
    12: function () { T[12]().forEach(rm); $$('.av__level').forEach(function (c) { c.classList.add('mk-nolvl'); }); },
    13: function () { rm($('.foot .round-note')); $('#mk-units').textContent = 'Figures in TEU, rounded up to whole TEU. 1 TEU is 33 CBM after the 30% uplift.'; },
    14: function () { rm($('#mk-dev')); }
  };
  // where the badge sits: corner (on the outline's top-left corner, default), gutter (number only,
  // left of the outline), right (after the outline), above (over the outline)
  var PLACE = { 2: 'gutter', 3: 'right', 7: 'gutter', 10: 'gutter', 13: 'above', 14: 'right' };
  // outline padding: tight where neighbours sit close (ledger rows, table cells, footer lines)
  var PADS = { 2: 2, 4: 4, 6: 3, 7: 2, 10: 3, 12: 3, 13: 3, 14: 3 };
  // badges that show their caption only on hover / focus / when selected
  var TIGHT = { 2: 1, 7: 1, 10: 1, 12: 1 };

  var mine = ITEMS.filter(function (it) { return it.page === PAGE || it.page === 'all'; });
  if (VIEW === 'after') mine.forEach(function (it) { A[it.n](); });

  /* ---------- static: nothing in the copy navigates; its theme button switches the theme ---------- */
  stage.addEventListener('click', function (e) {
    if (e.target.closest('#theme-toggle')) { e.preventDefault(); if (window.MK) window.MK.toggleTheme(); return; }
    if (e.target.closest('.mk-chip')) return;
    if (e.target.closest('a, button, label[for]')) e.preventDefault();
  }, true);
  stage.addEventListener('submit', function (e) { e.preventDefault(); }, true);

  /* ---------- live layout bits shell.js / dashboard.js normally set ---------- */
  function placeTabInd() {
    var tabs = $('.tabs'), ind = $('.tabs__ind'), tab = $('.tab[aria-current="page"]') || $('.tab[data-sec="' + d.getAttribute('data-section') + '"]');
    if (!tabs || !ind || !tab) return;
    var z = zoom();
    var span = $('span', tab), box = span && span.offsetWidth ? span : tab;
    var tr = tabs.getBoundingClientRect(), br = (tab.querySelector('svg') || box).getBoundingClientRect(), er = box.getBoundingClientRect();
    var left = (Math.min(br.left, er.left) - tr.left) / z + tabs.scrollLeft, right = (Math.max(br.right, er.right) - tr.left) / z + tabs.scrollLeft;
    ind.style.setProperty('--ix', left + 'px');
    ind.style.setProperty('--iw', ((right - left) / 100).toFixed(3));
    ind.setAttribute('data-sec', tab.getAttribute('data-sec') || '');
  }
  if (PAGE !== 'overview') {
    var cur = $('.tab[data-sec="' + d.getAttribute('data-section') + '"]');
    if (cur) cur.classList.add('is-current');
  }
  function placeFigBar() {
    var bar = $('.figs__bar'), f = $('.fig.is-on');
    if (!bar || !f) return;
    bar.style.setProperty('--by', (f.offsetTop + f.offsetHeight * 0.22) + 'px');
    bar.style.setProperty('--bh', (f.offsetHeight * 0.56 / 100).toFixed(3));
  }
  function placeTube() {
    var tube = $('#tube'), tick = $('#tube-tick');
    if (tube && tick) tick.style.setProperty('--tx', (32 / 72.660565 * (tube.clientWidth - 1)).toFixed(1) + 'px');
  }

  /* ---------- the "Changes" layer: outlines + numbered badges ---------- */
  function zoom() { var z = parseFloat(getComputedStyle(stage).zoom); return z > 0 ? z : 1; }
  var layer = null, active = 0;
  function rectIn(el, sr, z) {
    var r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    var x1 = r.left, y1 = r.top, x2 = r.right, y2 = r.bottom;
    for (var p = el.parentElement; p && p !== stage; p = p.parentElement) {
      if (/(auto|scroll|hidden)/.test(getComputedStyle(p).overflowX)) {
        var pr = p.getBoundingClientRect();
        x1 = Math.max(x1, pr.left); x2 = Math.min(x2, pr.right);
      }
    }
    if (x2 - x1 < 2) return null;
    return { x: (x1 - sr.left) / z, y: (y1 - sr.top) / z, w: (x2 - x1) / z, h: (y2 - y1) / z };
  }
  function drawLayer() {
    if (VIEW !== 'changes') return;
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'mk-layer';
      stage.appendChild(layer);
    }
    layer.textContent = '';
    var z = zoom(), sr = stage.getBoundingClientRect(), W = stage.clientWidth;
    mine.forEach(function (it) {
      var first = true, PAD = PADS[it.n] || 6;
      T[it.n]().filter(Boolean).forEach(function (el) {
        var r = rectIn(el, sr, z);
        if (!r) return;
        var bx = { x: r.x - PAD, y: r.y - PAD, w: r.w + PAD * 2, h: r.h + PAD * 2 };
        var b = document.createElement('span');
        b.className = 'mk-box' + (it.keep ? ' is-keep' : '') + (it.n === active ? ' is-active' : '');
        b.setAttribute('data-n', it.n);
        b.style.cssText = 'left:' + bx.x + 'px;top:' + bx.y + 'px;width:' + bx.w + 'px;height:' + bx.h + 'px';
        layer.appendChild(b);
        if (!first) return;
        first = false;
        var c = document.createElement('button');
        c.type = 'button';
        c.className = 'mk-chip' + (it.keep ? ' is-keep' : '') + (TIGHT[it.n] ? ' is-tight' : '') + (it.n === active ? ' is-active' : '');
        c.setAttribute('data-n', it.n);
        c.setAttribute('aria-label', 'Item ' + it.n + ': ' + it.title + '. ' + it.cap);
        c.innerHTML = '<b></b><span></span>';
        c.firstChild.textContent = it.n;
        c.lastChild.textContent = it.cap;
        layer.appendChild(c);
        var place = PLACE[it.n] || 'corner', cw = c.offsetWidth, x, y;
        if (place === 'gutter') { x = bx.x - cw - 6; y = bx.y + 2; }
        else if (place === 'right') { x = bx.x + bx.w + 6; y = bx.y + bx.h / 2 - 10; }
        else if (place === 'above') { x = bx.x; y = bx.y - 24; }
        else { x = bx.x - 4; y = bx.y - 10; }
        x = Math.max(2, Math.min(x, W - cw - 2));
        c.style.left = x + 'px';
        c.style.top = y + 'px';
        c.addEventListener('click', function () { select(it.n, true); if (window.MK) window.MK.selected(it.n); });
      });
    });
    layer.classList.toggle('has-active', !!active);
  }
  function select(n, fromChip) {
    active = n;
    drawLayer();
    var c = layer && layer.querySelector('.mk-chip[data-n="' + n + '"]');
    if (!c || fromChip) return;
    var strip = document.querySelector('.mk-strip'), z = zoom();
    var top = stage.getBoundingClientRect().top + scrollY + parseFloat(c.style.top) * z - (strip ? strip.offsetHeight : 0) - 56;
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: Math.max(0, top), behavior: reduce ? 'auto' : 'smooth' });
    c.focus({ preventScroll: true });
  }

  // item 10 (after): rows lose their second line unevenly; keep the table's row rhythm even
  function evenRows() {
    if (PAGE !== 'avu' || VIEW !== 'after') return;
    var rows = $$('#rows tr'), max = 0;
    rows.forEach(function (r) { r.style.height = ''; });
    if (innerWidth <= 760) return;   // phones: the rows are stacked cards
    rows.forEach(function (r) { max = Math.max(max, r.offsetHeight); });
    rows.forEach(function (r) { r.style.height = max + 'px'; });
  }
  function layout() { evenRows(); placeTabInd(); placeFigBar(); placeTube(); drawLayer(); }
  var pending = 0;
  function soon() { if (!pending) pending = requestAnimationFrame(function () { pending = 0; layout(); }); }
  layout();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(soon);
  addEventListener('resize', soon);
  addEventListener('load', soon);
  if (window.ResizeObserver) new ResizeObserver(soon).observe(stage);
  $$('.av__wrap').forEach(function (w) { w.addEventListener('scroll', soon, { passive: true }); });
  var how = $('#how'); if (how) how.addEventListener('toggle', soon);

  window.MKS = { select: function (n) { select(n, false); }, redraw: soon, page: PAGE, view: VIEW };
})();
