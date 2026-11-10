/* Battery mockup: MOCKUP ONLY, not wired to the app (no backend calls, nothing saved into the app).
 *
 * The page is a static copy of the Overview centre (figures, carrier row, legend, notes) with the real
 * css/dashboard.css. The carrier row is built from the app's own jar template, so every unit has exactly
 * the jar's slot: the battery is drawn inside the same .jar__glass box, on the same shared TEU scale
 * (the real CA.Jars instance computes it; the battery reads its px-per-TEU), with the same labels and
 * tooltip under / beside it. The "Jars" view runs the real js/jars.js in the same slots for comparison.
 *
 * Battery, per carrier (same meaning as the jar):
 *   case height  = confirmed TEU (shared scale), terminal cap on top in the jar's neck space
 *   blocks       = one per 4 TEU of confirmed space; LIT blocks = TEU left (confirmed - utilized),
 *                  the dark slots above them = utilized; a part block lights in proportion
 *   amber tick   = forecast allocation, beside the case like the jar's tick (dashed riser when the
 *                  forecast is above the confirmed space, faint line across the case when inside)
 *   over-used    = red case and cap, red hatched blocks stacked above the cap (4 TEU each), which flash
 *   no space     = dashed case at forecast height ("forecast only")
 * Motion (transform / opacity only): cells charge bottom-to-top one by one, then a soft glow pulses on
 * the top lit cell three times and rests; over-use flashes four times. Hover replays the pulse. Nothing
 * loops at rest. prefers-reduced-motion: the final state at once.
 */
(function () {
  'use strict';

  var N = window.CA.numbers;
  var reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
  var html = document.documentElement;
  // jar geometry constants (js/jars.js): the battery uses the same box
  var REFL = 30, NECK = 9, PAD_X = 16;
  var CELL_TEU = 4;                // TEU per block (legend: "1 block = 4 TEU")

  /* ---------- mock data: week 45 demo + overflow fixture (ONE 14 stuffed against 10) ---------- */
  var FC = 72.660565;
  var RAW = {
    MAERSK:  { confirmed: 20, utilized: 2,  forecast: FC * 0.30 },
    HAPAG:   { confirmed: 24, utilized: 16, forecast: FC * 0.25 },
    HELLMAN: { confirmed: 0,  utilized: 0,  forecast: FC * 0.20 },
    ONE:     { confirmed: 10, utilized: 14, forecast: FC * 0.25 },
    FML:     { confirmed: 10, utilized: 0,  forecast: 10 }
  };
  var CARRIERS = ['MAERSK', 'HAPAG', 'HELLMAN', 'ONE', 'FML'];
  var totalUtil = 32;
  CARRIERS.forEach(function (n) {
    var c = RAW[n];
    c.left = c.confirmed - c.utilized;
    c.pct_of_confirmed = c.confirmed ? c.utilized / c.confirmed * 100 : null;
    c.pct_share = c.utilized / totalUtil * 100;
  });
  var teu = function (x) { return N.teu(x); };
  function pct(n) { if (n == null || !isFinite(n)) return '—'; if (n > 0 && n < 1) return '<1%'; return Math.round(n) + '%'; }

  /* ---------- build the row from the app's jar template ---------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var row = $('#jars'), tpl = $('#jar-tpl'), stage = $('.stage');
  CARRIERS.forEach(function (name, i) {
    var node = tpl.content.firstElementChild.cloneNode(true);
    node.setAttribute('data-jar', name);
    node.setAttribute('data-carrier', name);
    node.style.setProperty('--j', i);
    $('.jar__name', node).textContent = name;
    $('.tip__title', node).textContent = name;
    var tip = $('.tip', node);
    tip.id = 'tip-' + name.toLowerCase();
    $('.jar__btn', node).setAttribute('aria-describedby', tip.id);
    fillLabels(node, name, RAW[name]);
    row.appendChild(node);
  });

  // labels and tooltip: the same wording as the Overview (js/dashboard.js fillJar)
  function fillLabels(node, name, c) {
    var mode = c.confirmed <= 0 ? 'none' : c.left < 0 ? 'over' : 'ok';
    node.classList.toggle('is-over', mode === 'over');
    node.classList.toggle('is-none', mode === 'none');
    var v = $('.jar__v', node), unit = $('.jar__unit', node), p = $('.jar__pct', node), btn = $('.jar__btn', node);
    var val;
    if (mode === 'none') {
      val = c.forecast; unit.textContent = ' TEU'; p.textContent = 'Forecast only';
      btn.setAttribute('aria-label', name + ': no capacity confirmed. Forecast allocation ' + teu(c.forecast) + ' TEU, not confirmed space.');
    } else if (mode === 'over') {
      val = c.left; unit.textContent = ' TEU'; p.textContent = 'Over by ' + teu(-c.left) + ' TEU';
      btn.setAttribute('aria-label', name + ': over confirmed space by ' + teu(-c.left) + ' TEU, ' + teu(c.utilized) + ' utilized of ' + teu(c.confirmed) + ' confirmed.');
    } else {
      val = c.left; unit.textContent = ' TEU left'; p.textContent = pct(c.pct_of_confirmed) + ' used';
      btn.setAttribute('aria-label', name + ': ' + teu(c.left) + ' TEU left of ' + teu(c.confirmed) + ' TEU confirmed, ' + pct(c.pct_of_confirmed) + ' used.');
    }
    v.textContent = teu(val);
    v.setAttribute('data-val', val);
    var rows = [
      ['Forecast allocation', teu(c.forecast) + ' TEU'],
      ['Confirmed', teu(c.confirmed) + ' TEU'],
      ['Utilized', teu(c.utilized) + ' TEU'],
      ['Left', teu(c.left) + ' TEU', c.left < 0],
      ['Used of confirmed', pct(c.pct_of_confirmed)],
      ['Share of the week’s utilized', pct(c.pct_share)],
      ['Confirmed minus forecast', N.teu(c.confirmed - c.forecast, { sign: true }) + ' TEU', c.confirmed - c.forecast < -0.005]
    ];
    var dl = $('.tip__rows', node);
    rows.forEach(function (r) {
      var d = document.createElement('div');
      if (r[2]) d.className = 'is-red';
      var dt = document.createElement('dt'); dt.textContent = r[0];
      var dd = document.createElement('dd'); dd.textContent = r[1];
      d.appendChild(dt); d.appendChild(dd); dl.appendChild(d);
    });
  }

  // phone: the tooltip is hidden by dashboard.css; a tap shows the numbers in the readout under the row
  row.addEventListener('click', function (e) {
    var j = e.target.closest('.jar'); if (!j) return;
    $('#readout-title').textContent = j.getAttribute('data-jar');
    $('#readout-rows').innerHTML = $('.tip__rows', j).innerHTML;
    $('#readout').hidden = false;
  });

  /* ---------- the real jars (for the Jars view and for the shared scale) ---------- */
  var jars = new window.CA.Jars(stage);
  jars.setData(RAW, { fromEmpty: true, delay: 420, stagger: 90 });

  /* ---------- batteries ---------- */
  function el(tag, cls) { var e = document.createElement(tag); e.className = cls; return e; }

  function buildBattery(node, name, c, ppt, w) {
    var glass = $('.jar__glass', node);
    var old = $('.batt', glass); if (old) old.remove();
    var b = el('div', 'batt');
    b.setAttribute('aria-hidden', 'true');
    var bw = w - 2 * PAD_X;
    var C = N.teuValue(c.confirmed), L = N.teuValue(c.left), F = N.teuValue(c.forecast);
    var none = c.confirmed <= 0, over = c.left < 0;
    var capH = none ? Math.max(36, c.forecast * ppt) : c.confirmed * ppt;   // same body height as the jar
    var fcH = c.forecast * ppt;

    var body = el('div', 'batt__body' + (none ? ' is-ghost' : '') + (over ? ' is-over' : ''));
    body.style.left = PAD_X + 'px'; body.style.width = bw + 'px';
    body.style.bottom = REFL + 'px'; body.style.height = capH + 'px';
    // bold outline: about 8.5% of the case width (8px at 1440 and 390), cap in the outline colour,
    // attached to the outline and filling the jar's neck space
    var BORDER = Math.max(6, Math.round(bw * 0.085)), PAD = 4;
    body.style.borderWidth = BORDER + 'px';
    body.style.borderRadius = Math.round(BORDER * 1.6) + 'px';
    body.style.setProperty('--pad', PAD + 'px');
    var cap = el('i', 'batt__cap' + (none ? ' is-ghost' : '') + (over ? ' is-over' : ''));
    cap.style.left = (PAD_X + bw * 0.3) + 'px'; cap.style.width = (bw * 0.4) + 'px';
    cap.style.bottom = (REFL + capH - 2) + 'px'; cap.style.height = (NECK + 2) + 'px';

    // blocks: one per 4 TEU of confirmed space (forecast for the ghost), so they stay chunky
    var nCells = Math.max(1, Math.ceil((none ? F : C) / CELL_TEU));
    var GAP = capH / nCells > 30 ? 4 : 3;
    var inner = capH - 2 * BORDER - 2 * PAD;
    var cellH = (inner - (nCells - 1) * GAP) / nCells;
    var lit = none || over ? 0 : Math.max(0, L) / CELL_TEU;   // e.g. 18 TEU -> 4.5 blocks (the top one half lit)
    var full = Math.floor(lit), part = lit - full;
    var topIdx = part > 0 ? full : full - 1;
    for (var k = 0; k < nCells; k++) {
      var cell = el('i', 'cell');
      cell.style.bottom = (PAD + k * (cellH + GAP)) + 'px';
      cell.style.height = cellH + 'px';
      if (k < full || (k === full && part > 0)) {
        cell.classList.add('is-lit');
        cell.style.setProperty('--f', k < full ? 1 : part.toFixed(3));
        cell.style.setProperty('--k', k);
        if (k === topIdx) cell.classList.add('is-top');
        cell.appendChild(el('b', 'cell__fill'));
        if (k === topIdx) cell.appendChild(el('s', 'cell__glow'));
      }
      body.appendChild(cell);
    }
    b.style.setProperty('--last', Math.max(0, topIdx));
    b.appendChild(body); b.appendChild(cap);

    // over-used: red hatched blocks above the cap, 4 TEU each, as tall as the case cells (room allowing)
    if (over) {
      var overT = -L, nOver = Math.ceil(overT / CELL_TEU);
      var base = REFL + capH + NECK + 5;
      var room = glass.clientHeight - base - 2;
      var oh = Math.max(4, Math.min(cellH, (room - (nOver - 1) * GAP) / nOver));
      for (var o = 0; o < nOver; o++) {
        var oc = el('i', 'ocell');
        oc.style.left = (PAD_X + BORDER + PAD) + 'px'; oc.style.width = (bw - 2 * BORDER - 2 * PAD) + 'px';
        oc.style.bottom = (base + o * (oh + GAP)) + 'px'; oc.style.height = oh + 'px';
        oc.style.setProperty('--k', o);
        b.appendChild(oc);
      }
    }

    // forecast tick beside the case (same place as the jar's), plus the faint line across / dashed riser
    if (fcH > 0) {
      var tick = el('i', 'batt__tick');
      tick.style.left = (w - PAD_X + 2) + 'px'; tick.style.bottom = (REFL + fcH) + 'px';
      b.appendChild(tick);
      if (!none && fcH <= capH - 2) {
        var across = el('i', 'batt__across');
        across.style.left = (PAD_X + 4) + 'px'; across.style.width = (bw - 6) + 'px'; across.style.bottom = (REFL + fcH) + 'px';
        b.appendChild(across);
      } else if (!none && fcH > capH) {
        var riser = el('i', 'batt__riser');
        riser.style.left = (w - PAD_X + 6) + 'px'; riser.style.bottom = (REFL + capH) + 'px'; riser.style.height = (fcH - capH) + 'px';
        b.appendChild(riser);
      }
    }
    glass.appendChild(b);
  }

  var lastKey = '';
  function layoutBatteries(replay) {
    var g = $('.jar__glass', row);
    var w = Math.round(g.clientWidth), h = Math.round(g.clientHeight);
    var key = w + 'x' + h + '/' + jars.ppt.toFixed(3);
    if (key === lastKey && !replay) return;
    lastKey = key;
    Array.prototype.forEach.call(row.querySelectorAll('.jar'), function (node) {
      var name = node.getAttribute('data-jar');
      buildBattery(node, name, RAW[name], jars.ppt, w);
    });
    if (replay) charge();
  }
  function charge() {
    stage.classList.remove('batt-in');
    if (reduceMQ.matches) { stage.classList.add('batt-in', 'batt-still'); return; }
    stage.classList.remove('batt-still');
    void stage.offsetWidth;
    requestAnimationFrame(function () { requestAnimationFrame(function () { stage.classList.add('batt-in'); }); });
  }
  if ('ResizeObserver' in window) new ResizeObserver(function () { requestAnimationFrame(function () { layoutBatteries(false); }); }).observe(row);
  layoutBatteries(false);

  /* ---------- Jars | Batteries switch ---------- */
  var radios = Array.prototype.slice.call(document.querySelectorAll('.mk-switch [role="radio"]'));
  function syncRadios(v, focus) {
    radios.forEach(function (r) {
      var on = r.getAttribute('data-view') === v;
      r.setAttribute('aria-checked', on ? 'true' : 'false');
      r.tabIndex = on ? 0 : -1;
      if (on && focus) r.focus();
    });
  }
  function setView(v, focus) {
    html.setAttribute('data-view', v);
    syncRadios(v, focus);
    if (v === 'batt') { layoutBatteries(true); }
    else { document.dispatchEvent(new Event('ca:themechange')); jars.setData(RAW, { fromEmpty: true, delay: 120, stagger: 90 }); }
  }
  radios.forEach(function (r, i) {
    r.addEventListener('click', function () { if (r.getAttribute('aria-checked') !== 'true') setView(r.getAttribute('data-view')); });
    r.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      setView(radios[(i + 1) % 2].getAttribute('data-view'), true);
    });
  });
  syncRadios(html.getAttribute('data-view') || 'batt');
  if (html.getAttribute('data-view') !== 'jars') layoutBatteries(true);

  /* ---------- theme toggle (saved under the mockup's own key) ---------- */
  var themeBtn = document.getElementById('theme');
  function syncTheme() { themeBtn.setAttribute('aria-pressed', html.getAttribute('data-theme') === 'light' ? 'true' : 'false'); }
  themeBtn.addEventListener('click', function () {
    var next = html.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    html.classList.add('theme-switch');
    html.setAttribute('data-theme', next);
    try { localStorage.setItem('ca.mock.theme', next); } catch (e) {}
    syncTheme();
    document.dispatchEvent(new Event('ca:themechange'));
    requestAnimationFrame(function () { requestAnimationFrame(function () { html.classList.remove('theme-switch'); }); });
  });
  syncTheme();

  window.MOCK = { jars: jars, RAW: RAW, setView: setView };   // for the test harness
})();
