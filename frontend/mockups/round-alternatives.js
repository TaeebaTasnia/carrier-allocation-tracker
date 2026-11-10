/* Carrier row options: MOCKUP ONLY, not wired to the app (no backend calls, nothing saved into the app).
 *
 * A static copy of the Overview (figures, headline, legend, notes) on the real css/dashboard.css, with six
 * alternative designs for the carrier row. Every option shows the same numbers and the same labels as the
 * jars (name, TEU left, % used, the same tooltip), on the wk45 demo data with ONE 4 TEU over:
 *   donut   one ring per carrier: ring = confirmed, carrier arc = TEU left, thin arc = utilized
 *   gauge   half-circle meter per carrier, 0 to confirmed, amber needle = forecast
 *   bubble  circle AREA = confirmed on one shared scale, inner disc = TEU left, dashed = forecast
 *   dial    one radial chart, a ring per carrier on one shared TEU scale, week total in the centre
 *   bullet  horizontal bars on one shared scale: solid = utilized, lighter = left, amber = forecast
 *   grid    1 square = 1 TEU, like a bay plan from above: filled = utilized, outlined = left
 *   jars    the current design (the real js/jars.js), for comparison
 * Motion: the marks draw in once per view switch (stroke-dashoffset / transform / opacity, ~700 ms, staggered
 * per carrier); at rest only the ONE over-use mark pulses (opacity). Reduced motion: the final state at once.
 */
(function () {
  'use strict';

  var N = window.CA.numbers;
  var reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
  var html = document.documentElement;
  var VIEWS = ['donut', 'gauge', 'bubble', 'dial', 'bullet', 'grid', 'jars'];

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
    c.mode = c.confirmed <= 0 ? 'none' : c.left < 0 ? 'over' : 'ok';
  });
  var WEEK_LEFT = CARRIERS.reduce(function (s, n) { return s + RAW[n].left; }, 0);   // 32
  // one shared TEU scale for the options where size encodes TEU
  var MAXT = CARRIERS.reduce(function (m, n) { var c = RAW[n]; return Math.max(m, c.confirmed, c.utilized, c.forecast); }, 0);
  var teu = function (x) { return N.teu(x); };
  function pct(n) { if (n == null || !isFinite(n)) return '—'; if (n > 0 && n < 1) return '<1%'; return Math.round(n) + '%'; }
  function f2(x) { return Math.round(x * 100) / 100; }

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var stage = $('.stage'), jarRow = $('#jars'), alt = $('#alt'), tpl = $('#jar-tpl'), keyEl = $('#key');

  /* ---------- labels and tooltip: the same wording as the Overview (js/dashboard.js fillJar) ---------- */
  function fillLabels(node, name, c) {
    var mode = c.mode;
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
    dl.innerHTML = '';
    rows.forEach(function (r) {
      var d = document.createElement('div');
      if (r[2]) d.className = 'is-red';
      var dt = document.createElement('dt'); dt.textContent = r[0];
      var dd = document.createElement('dd'); dd.textContent = r[1];
      d.appendChild(dt); d.appendChild(dd); dl.appendChild(d);
    });
  }
  // the figures of one carrier, for the aria-label of each shape
  function said(name, c) {
    if (c.mode === 'none') return name + ': no space confirmed, forecast allocation ' + teu(c.forecast) + ' TEU.';
    var s = name + ': ' + teu(c.confirmed) + ' TEU confirmed, ' + teu(c.utilized) + ' utilized, ';
    s += c.mode === 'over' ? 'over by ' + teu(-c.left) + ' TEU' : teu(c.left) + ' TEU left (' + pct(c.pct_of_confirmed) + ' used)';
    return s + ', forecast ' + teu(c.forecast) + ' TEU.';
  }

  // one carrier unit: the jar template without its glass (no data-jar, so CA.Jars never picks it up)
  function unit(name, i, cls) {
    var node = tpl.content.firstElementChild.cloneNode(true);
    $('.jar__glass', node).remove();
    node.className = 'jar u ' + (cls || '');
    node.setAttribute('data-unit', name);
    node.setAttribute('data-carrier', name);
    node.style.setProperty('--j', i);
    $('.jar__name', node).textContent = name;
    $('.tip__title', node).textContent = name;
    var tip = $('.tip', node);
    tip.id = 'tip-' + name.toLowerCase() + '-' + (cls || 'u');
    $('.jar__btn', node).setAttribute('aria-describedby', tip.id);
    fillLabels(node, name, RAW[name]);
    return node;
  }
  function fig(svg, cls) {
    var d = document.createElement('div');
    d.className = 'u__fig ' + (cls || '');
    d.innerHTML = svg;
    return d;
  }

  /* ---------- SVG helpers ----------
     arc(): a circle with pathLength 100, so dash lengths are in percent of a lap. The dash starts at
     `start` (percent of a lap from `base` degrees, 0 = 3 o'clock, -90 = 12 o'clock) and is `len` long.
     It draws in by moving stroke-dashoffset from len to 0 (CSS, see .arc). */
  function arc(cx, cy, r, start, len, cls, base, d) {
    if (len <= 0.05) return '';
    var rot = (base == null ? -90 : base) + start * 3.6;
    return '<circle class="arc ' + cls + '" cx="' + cx + '" cy="' + cy + '" r="' + r + '" pathLength="100"' +
      ' stroke-dasharray="' + f2(len) + ' 200" style="--len:' + f2(len) + (d ? ';--d:' + d + 'ms' : '') + '"' +
      ' transform="rotate(' + f2(rot) + ' ' + cx + ' ' + cy + ')"/>';
  }
  // a plain arc path (for the dashed "forecast only" outlines, whose own dash pattern would fight arc())
  function arcPath(cx, cy, r, from, sweep, cls) {
    var a = polar(cx, cy, r, from), b = polar(cx, cy, r, from + sweep);
    return '<path class="' + cls + '" d="M' + a[0] + ' ' + a[1] + 'A' + r + ' ' + r + ' 0 ' + (sweep > 180 ? 1 : 0) + ' 1 ' + b[0] + ' ' + b[1] + '"/>';
  }
  function polar(cx, cy, r, deg) { var a = deg * Math.PI / 180; return [f2(cx + r * Math.cos(a)), f2(cy + r * Math.sin(a))]; }
  function radial(cx, cy, r0, r1, deg, cls) {
    var a = polar(cx, cy, r0, deg), b = polar(cx, cy, r1, deg);
    return '<line class="' + cls + '" x1="' + a[0] + '" y1="' + a[1] + '" x2="' + b[0] + '" y2="' + b[1] + '"/>';
  }
  function svgOpen(vb, label, cls, role) {
    return '<svg class="' + (cls || '') + '" viewBox="' + vb + '" role="' + (role || 'img') + '" aria-label="' + label.replace(/"/g, '&quot;') + '">';
  }

  /* ---------- 1. Donuts ---------- */
  function donut(name, c) {
    var cx = 60, cy = 60, r = 42, s = svgOpen('0 0 120 120', said(name, c), 'sv-donut');
    var Lf = c.left / c.confirmed, Ff = c.forecast / c.confirmed;
    if (c.mode === 'none') {
      s += '<circle class="ring-ghost fade" cx="60" cy="60" r="' + r + '"/>';
      s += '<text class="ctr ctr--muted fade" x="60" y="64">' + teu(c.forecast) + '</text>';
      s += '<text class="ctr-sub fade" x="60" y="80">forecast</text>';
    } else {
      s += '<circle class="ring-bed" cx="60" cy="60" r="' + r + '"/>';
      if (c.mode === 'over') {
        s += arc(cx, cy, r, 0, 100, 'a-over-full');
        s += arc(cx, cy, r + 10, 0, Math.min(1, -c.left / c.confirmed) * 100, 'a-over pulse', null, 420);
        s += radial(cx, cy, r - 9, r + 14, -90, 'mk-zero fade');
      } else {
        s += arc(cx, cy, r, 0, Lf * 100 - 0.8, 'a-left');
        s += arc(cx, cy, r, Lf * 100 + 0.8, (1 - Lf) * 100 - 1.6, 'a-used', null, 240);
      }
      // amber notch: forecast against the confirmed lap; past the lap it sits at 12 o'clock with a dashed
      // amber run outside the ring for the part of the forecast above confirmed space
      var fa = -90 + Math.min(1, Ff) * 360;
      s += radial(cx, cy, r - 9, r + 8, fa, 'mk-fc fade');
      if (Ff > 1.005) s += arc(cx, cy, r + (c.mode === 'over' ? 16 : 10), 0, Math.min(1, Ff - 1) * 100, 'a-fc-run', null, 360);
      s += '<text class="ctr' + (c.mode === 'over' ? ' ctr--red' : '') + ' fade" x="60" y="66">' + teu(c.left) + '</text>';
      s += '<text class="ctr-sub fade" x="60" y="81">' + (c.mode === 'over' ? 'TEU over' : 'TEU left') + '</text>';
    }
    return s + '</svg>';
  }

  /* ---------- 2. Gauges ---------- */
  function gauge(name, c) {
    var cx = 70, cy = 70, r = 54, s = svgOpen('0 0 140 102', said(name, c), 'sv-gauge');
    // a half lap is 50 units of the arc's pathLength; base 180 deg = 9 o'clock, clockwise over the top
    if (c.mode === 'none') {
      s += arcPath(cx, cy, r, 180, 180, 'a-ghost');
      s += '<text class="ctr ctr--muted fade" x="70" y="58">' + teu(c.forecast) + '</text>';
      s += '<text class="ctr-sub fade" x="70" y="72">forecast</text>';
      return s + '</svg>';
    }
    var Lf = Math.max(0, c.left) / c.confirmed, Ff = c.forecast / c.confirmed;
    s += arc(cx, cy, r, 0, 50, 'a-bed', 180);
    if (c.mode === 'over') {
      s += arc(cx, cy, r, 0, 50, 'a-over-full', 180);
      // the excess runs on past the end, below the horizon (to scale, capped at 8% of a lap)
      s += arc(cx, cy, r, 50.6, Math.min(8, 50 * -c.left / c.confirmed), 'a-over pulse', 180, 420);
    } else {
      s += arc(cx, cy, r, 0, Lf * 50 - 0.4, 'a-left', 180);
      s += arc(cx, cy, r, Lf * 50 + 0.4, (1 - Lf) * 50 - 0.4, 'a-used', 180, 240);
    }
    // end ticks: 0 and the confirmed space
    s += radial(cx, cy, r - 12, r + 10, 180, 'mk-end') + radial(cx, cy, r - 12, r + 10, 0, 'mk-end');
    s += '<text class="end-lab" x="' + (cx - r + 28) + '" y="' + (cy + 14) + '">0</text>';
    s += '<text class="end-lab" x="' + (cx + r - 28) + '" y="' + (cy + 14) + '">' + teu(c.confirmed) + '</text>';
    // the needle: forecast against confirmed, pinned just past the end when the forecast is larger
    var fa = 180 + Math.min(1.04, Ff) * 180;
    // a short pointer across the band (kept clear of the figure in the middle)
    s += '<g class="needle' + (Ff > 1.005 ? ' is-pinned' : '') + '" style="--rot:' + f2(fa) + 'deg">' +
      '<line class="needle__halo" x1="' + (cx + r - 15) + '" y1="' + cy + '" x2="' + (cx + r + 11) + '" y2="' + cy + '"/>' +
      '<line x1="' + (cx + r - 15) + '" y1="' + cy + '" x2="' + (cx + r + 11) + '" y2="' + cy + '"/></g>';
    s += '<text class="ctr' + (c.mode === 'over' ? ' ctr--red' : '') + ' fade" x="70" y="62">' + teu(c.left) + '</text>';
    return s + '</svg>';
  }

  /* ---------- 3. Bubbles ---------- */
  function bubble(name, c) {
    var cx = 60, cy = 60, k = 56 / Math.sqrt(MAXT);       // area = TEU on one shared scale
    var rad = function (t) { return f2(k * Math.sqrt(Math.max(0, t))); };
    var s = svgOpen('0 0 120 120', said(name, c), 'sv-bubble');
    if (c.mode === 'none') {
      s += '<g class="pop"><circle class="b-ghost" cx="60" cy="60" r="' + rad(c.forecast) + '"/></g>';
      return s + '</svg>';
    }
    if (c.mode === 'over') {
      var rc = k * Math.sqrt(c.confirmed), ru = k * Math.sqrt(c.utilized);
      s += '<g class="pop pulse"><circle class="b-halo" cx="60" cy="60" r="' + f2((rc + ru) / 2) + '" style="stroke-width:' + f2(ru - rc) + '"/>' +
        '<circle class="b-halo-edge" cx="60" cy="60" r="' + f2(ru) + '"/></g>';
      s += '<g class="pop"><circle class="b-cap b-cap--over" cx="60" cy="60" r="' + f2(rc) + '"/></g>';
    } else {
      s += '<g class="pop"><circle class="b-cap" cx="60" cy="60" r="' + rad(c.confirmed) + '"/></g>';
      s += '<g class="pop pop--2"><circle class="b-left" cx="60" cy="60" r="' + rad(c.left) + '"/></g>';
    }
    s += '<g class="fade"><circle class="b-fc" cx="60" cy="60" r="' + rad(c.forecast) + '"/></g>';
    return s + '</svg>';
  }

  /* ---------- 4. Dial: one radial chart, rings on one shared scale (270 deg = the largest figure) ---------- */
  function dial() {
    var order = CARRIERS.slice().sort(function (a, b) {
      var A = RAW[a], B = RAW[b];
      return (B.confirmed - A.confirmed) || (B.forecast - A.forecast);
    });
    var cx = 180, cy = 180, R0 = 158, STEP = 27, W = 17;
    var u = 75 / MAXT;                                  // pathLength units per TEU (75 units = 270 deg)
    var s = svgOpen('0 0 360 360', 'Week 45, ' + teu(WEEK_LEFT) + ' TEU left across five carriers. ' +
      'Each ring is one carrier.', 'sv-dial', 'group');
    // scale: hairlines every 4 TEU across the whole dial
    for (var t = 0; t <= MAXT; t += 4) {
      s += radial(cx, cy, R0 - 4 * STEP - W, R0 + W / 2 + 3, -90 + t * u * 3.6, 'd-grid');
    }
    order.forEach(function (name, i) {
      var c = RAW[name], r = R0 - i * STEP, j = CARRIERS.indexOf(name);
      s += '<g class="ring" data-carrier="' + name + '" data-ring="' + name + '" style="--j:' + j + '" tabindex="0" role="img" aria-label="' + said(name, c) + '">';
      s += '<circle class="d-hit" cx="' + cx + '" cy="' + cy + '" r="' + r + '"/>';
      s += arc(cx, cy, r, 0, 75, 'd-track');
      if (c.mode === 'none') {
        s += arcPath(cx, cy, r, -90, c.forecast * u * 3.6, 'a-ghost');
      } else if (c.mode === 'over') {
        s += arc(cx, cy, r, 0, c.confirmed * u - 0.3, 'a-over-full d-w');
        s += arc(cx, cy, r, c.confirmed * u + 0.3, (c.utilized - c.confirmed) * u - 0.3, 'a-over d-w pulse', null, 420);
      } else {
        s += arc(cx, cy, r, 0, c.left * u - 0.3, 'a-left d-w');
        s += arc(cx, cy, r, c.left * u + 0.3, c.utilized * u - 0.3, 'a-used d-w', null, 240);
      }
      if (c.mode !== 'none') s += radial(cx, cy, r - W / 2 - 3, r + W / 2 + 3, -90 + c.forecast * u * 3.6, 'mk-fc fade');
      // direct label at the start of the ring, in the open quarter
      s += '<text class="d-name fade" x="' + (cx - 10) + '" y="' + (cy - r + 4) + '">' + name + '</text>';
      s += '</g>';
    });
    // scale figures along the top
    [0, 8, 16, 24].forEach(function (t) {
      if (t > MAXT) return;
      var p = polar(cx, cy, R0 + W / 2 + 12, -90 + t * u * 3.6);
      s += '<text class="d-scale" x="' + p[0] + '" y="' + p[1] + '">' + t + '</text>';
    });
    s += '<text class="ctr ctr--dial fade" x="' + cx + '" y="' + (cy + 12) + '">' + teu(WEEK_LEFT) + '</text>';
    s += '<text class="ctr-sub fade" x="' + cx + '" y="' + (cy + 32) + '">TEU left</text>';
    return s + '</svg>';
  }

  /* ---------- 5. Bullet bars ---------- */
  var BMAX = Math.ceil(MAXT / 4) * 4;                    // 24: axis 0..24 TEU
  function bulletBar(name, c) {
    var P = function (t) { return f2(Math.max(0, t) / BMAX * 100) + '%'; };
    var b = '<span class="bl__bar" role="img" aria-label="' + said(name, c).replace(/"/g, '&quot;') + '">';
    for (var t = 0; t <= BMAX; t += 4) b += '<i class="bl__grid" style="left:' + P(t) + '"></i>';
    if (c.mode === 'none') {
      b += '<i class="bl__ghost grow" style="width:' + P(c.forecast) + '"></i>';
    } else {
      b += '<i class="bl__cap grow" style="width:' + P(c.confirmed) + '"></i>';
      b += '<i class="bl__used grow" style="width:' + P(Math.min(c.utilized, c.confirmed)) + '"></i>';
      if (c.mode === 'over') b += '<i class="bl__over grow pulse" style="left:' + P(c.confirmed) + ';width:' + P(c.utilized - c.confirmed) + '"></i>';
      b += '<i class="bl__fc fade" style="left:' + P(c.forecast) + '"></i>';
    }
    return b + '</span>';
  }

  /* ---------- 6. Container grid: 1 square = 1 TEU, 4 across, rows from the bottom ---------- */
  var GS = 10, GG = 2.6, GP = GS + GG, GCOLS = 4;
  function gridRowsNeeded(c) {
    if (c.mode === 'none') return Math.ceil(teu(c.forecast) / GCOLS);
    var rows = Math.ceil(c.confirmed / GCOLS);
    if (c.mode === 'over') rows += 0.5 + Math.ceil(-c.left / GCOLS);
    return Math.max(rows, c.forecast / GCOLS);
  }
  var GROWS = Math.ceil(CARRIERS.reduce(function (m, n) { return Math.max(m, gridRowsNeeded(RAW[n])); }, 0)) + 0.4;
  function grid(name, c) {
    var W = GCOLS * GP - GG + 14, H = f2(GROWS * GP + 2), base = H - 1;   // base = bottom edge of row 0
    var ox = 1;
    var s = svgOpen('0 0 ' + f2(W) + ' ' + H, said(name, c), 'sv-cgrid');
    function sq(k, cls, rowOff) {
      var col = k % GCOLS, row = Math.floor(k / GCOLS) + (rowOff || 0);
      var x = ox + col * GP, y = base - row * GP - GS;
      return '<rect class="sq ' + cls + '" x="' + f2(x) + '" y="' + f2(y) + '" width="' + GS + '" height="' + GS + '" rx="1.5" style="--k:' + k + '"/>';
    }
    var k, n;
    if (c.mode === 'none') {
      n = teu(c.forecast);
      for (k = 0; k < n; k++) s += sq(k, 'sq-ghost');
      return s + '</svg>';
    }
    n = Math.ceil(c.confirmed);
    var used = Math.min(n, Math.round(c.utilized));
    for (k = 0; k < n; k++) s += sq(k, k < used ? 'sq-used' : 'sq-left');
    if (c.mode === 'over') {
      // over-use: red squares stacked above the grid, outside it, after a half-row gap
      var rowsC = Math.ceil(n / GCOLS), no = Math.round(-c.left);
      var g = '<g class="pulse">';
      for (k = 0; k < no; k++) g += sq(k, 'sq-over', rowsC + 0.5).replace('--k:' + k, '--k:' + (n + k));
      s += g + '</g>';
    }
    // amber edge: a stepped line at the forecast count (between the squares under it and those above)
    var fN = N.teuValue(c.forecast), full = Math.floor(fN / GCOLS), rem = fN % GCOLS;
    var Y = function (r) { return f2(base - r * GP + GG / 2); };
    var X = function (col) { return f2(ox + col * GP - GG / 2); };
    var xL = f2(ox - 3), xR = f2(ox + GCOLS * GP - GG + 3);
    var above = c.forecast > c.confirmed + 0.005;
    if (!above) {
      var d = rem ? 'M' + xL + ' ' + Y(full + 1) + 'H' + X(rem) + 'V' + Y(full) + 'H' + xR : 'M' + xL + ' ' + Y(full) + 'H' + xR;
      s += '<path class="g-fc fade" d="' + d + '"/>';
    } else {
      // forecast above the confirmed space: a dashed amber riser beside the grid, up to the forecast height
      s += '<line class="g-fc is-above fade" x1="' + f2(xR + 5) + '" x2="' + f2(xR + 5) + '" y1="' + Y(Math.ceil(c.confirmed) / GCOLS) + '" y2="' + Y(fN / GCOLS) + '"/>';
    }
    // tick beside the grid at the forecast height (like the jar's tick)
    s += '<line class="g-tick fade" x1="' + f2(xR + 2) + '" x2="' + f2(xR + 8) + '" y1="' + Y(fN / GCOLS) + '" y2="' + Y(fN / GCOLS) + '"/>';
    return s + '</svg>';
  }

  /* ---------- legends (inline SVG swatches) ---------- */
  var SW = {
    left: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect class="sw-left" x="1" y="4" width="12" height="6" rx="1.5"/></svg>',
    used: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect class="sw-used" x="1" y="5.5" width="12" height="3" rx="1.5"/></svg>',
    usedSolid: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect class="sw-left" x="1" y="4" width="12" height="6" rx="1.5"/></svg>',
    leftLight: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect class="sw-light" x="1.5" y="4.5" width="11" height="5" rx="1"/></svg>',
    fc: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect class="sw-fc" x="6" y="1" width="2.2" height="12"/></svg>',
    fcLine: '<svg viewBox="0 0 14 14" aria-hidden="true"><path class="sw-fcline" d="M1 9H7V5H13"/></svg>',
    fcRing: '<svg viewBox="0 0 14 14" aria-hidden="true"><circle class="sw-fcring" cx="7" cy="7" r="5.5"/></svg>',
    over: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect class="sw-over" x="1" y="4" width="12" height="6" rx="1.5"/></svg>',
    ghost: '<svg viewBox="0 0 14 14" aria-hidden="true"><circle class="sw-ghost" cx="7" cy="7" r="5"/></svg>',
    ghostBox: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect class="sw-ghost" x="1.5" y="3.5" width="11" height="7" rx="1"/></svg>',
    disc: '<svg viewBox="0 0 14 14" aria-hidden="true"><circle class="sw-capc" cx="7" cy="7" r="6"/><circle class="sw-discc" cx="7" cy="7" r="3.4"/></svg>',
    sqUsed: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect class="sw-left" x="2" y="2" width="10" height="10" rx="1.5"/></svg>',
    sqLeft: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect class="sw-sqleft" x="2.5" y="2.5" width="9" height="9" rx="1.5"/></svg>'
  };
  var KEYS = {
    donut: [['left', 'Coloured arc: TEU left'], ['used', 'Thin arc: utilized (full ring = confirmed)'], ['fc', 'Amber notch: forecast'], ['over', 'Red arc outside: over confirmed'], ['ghost', 'Dashed ring: forecast only']],
    gauge: [['left', 'Coloured arc: TEU left, 0 to confirmed'], ['used', 'Thin arc: utilized'], ['fc', 'Amber needle: forecast'], ['over', 'Red past the end: over confirmed'], ['ghost', 'Dashed: forecast only']],
    bubble: [['disc', 'Circle area: confirmed, inner disc: TEU left (same scale for all)'], ['fcRing', 'Dashed amber circle: forecast'], ['over', 'Red halo: over confirmed'], ['ghost', 'Dashed grey: forecast only']],
    dial: [['left', 'Coloured arc: TEU left'], ['used', 'Thin arc: utilized (one scale, 0 to 24 TEU)'], ['fc', 'Amber tick: forecast'], ['over', 'Red: over confirmed'], ['ghost', 'Dashed: forecast only']],
    bullet: [['usedSolid', 'Solid: utilized'], ['leftLight', 'Lighter: TEU left (bar = confirmed)'], ['fc', 'Amber marker: forecast'], ['over', 'Red past the end: over confirmed'], ['ghostBox', 'Dashed: forecast only']],
    grid: [['sqUsed', '1 square = 1 TEU, filled: utilized'], ['sqLeft', 'Outlined: TEU left'], ['fcLine', 'Amber edge: forecast'], ['over', 'Red squares above: over confirmed'], ['ghost', 'Dashed squares: forecast only']]
  };
  function renderKey(v) {
    keyEl.innerHTML = '';
    (KEYS[v] || []).forEach(function (k) {
      var s = document.createElement('span');
      s.className = 'key key--svg';
      s.innerHTML = SW[k[0]];
      s.appendChild(document.createTextNode(k[1]));
      keyEl.appendChild(s);
    });
  }

  /* ---------- render one option into #alt ---------- */
  function render(v) {
    alt.innerHTML = '';
    alt.className = 'alt alt--' + v;
    if (v === 'dial') {
      var wrap = document.createElement('div');
      wrap.className = 'dial-wrap';
      wrap.innerHTML = dial();
      alt.appendChild(wrap);
      var labs = document.createElement('div');
      labs.className = 'dial-labels';
      CARRIERS.forEach(function (n, i) { labs.appendChild(unit(n, i, 'u--dial')); });
      alt.appendChild(labs);
      wireDial();
    } else if (v === 'bullet') {
      CARRIERS.forEach(function (n, i) {
        var node = unit(n, i, 'u--bullet');
        var btn = $('.jar__btn', node);
        btn.insertBefore(document.createRange().createContextualFragment(bulletBar(n, RAW[n])), $('.jar__left', btn));
        alt.appendChild(node);
      });
      var ax = document.createElement('div');
      ax.className = 'bl__axis';
      ax.setAttribute('aria-hidden', 'true');
      var a = '<span class="bl__ticks">';
      for (var t = 0; t <= BMAX; t += 4) a += '<i style="left:' + f2(t / BMAX * 100) + '%">' + t + (t === BMAX ? ' TEU' : '') + '</i>';
      ax.innerHTML = a + '</span>';
      alt.appendChild(ax);
    } else {
      var make = { donut: donut, gauge: gauge, bubble: bubble, grid: grid }[v];
      CARRIERS.forEach(function (n, i) {
        var node = unit(n, i, 'u--' + v);
        node.insertBefore(fig(make(n, RAW[n]), 'u__fig--' + v), node.firstChild);
        alt.appendChild(node);
      });
    }
    renderKey(v);
    play();
  }
  function play() {
    alt.classList.remove('in', 'still');
    if (reduceMQ.matches) { alt.classList.add('in', 'still'); return; }
    void alt.offsetWidth;
    requestAnimationFrame(function () { requestAnimationFrame(function () { alt.classList.add('in'); }); });
  }

  // dial: hovering or focusing a ring lights its label (and the other way round)
  function wireDial() {
    var wrap = $('.dial-wrap', alt);
    function hl(name) {
      if (name) alt.setAttribute('data-hl', name); else alt.removeAttribute('data-hl');
      alt.querySelectorAll('.u--dial').forEach(function (u) { u.classList.toggle('is-hl', u.getAttribute('data-unit') === name); });
      alt.querySelectorAll('[data-ring]').forEach(function (g) { g.classList.toggle('is-hl', g.getAttribute('data-ring') === name); });
    }
    alt.querySelectorAll('[data-ring]').forEach(function (g) {
      var n = g.getAttribute('data-ring');
      g.addEventListener('pointerenter', function () { hl(n); });
      g.addEventListener('pointerleave', function () { hl(null); });
      g.addEventListener('focus', function () { hl(n); });
      g.addEventListener('blur', function () { hl(null); });
    });
    alt.querySelectorAll('.u--dial').forEach(function (u) {
      var n = u.getAttribute('data-unit');
      u.addEventListener('pointerenter', function () { hl(n); });
      u.addEventListener('pointerleave', function () { hl(null); });
      u.addEventListener('focusin', function () { hl(n); });
      u.addEventListener('focusout', function () { hl(null); });
    });
    return wrap;
  }

  // phone: the tooltip is hidden by dashboard.css; a tap shows the numbers in the readout under the row
  function readout(name) {
    var j = stage.querySelector('[data-unit="' + name + '"], [data-jar="' + name + '"]');
    if (!j) return;
    $('#readout-title').textContent = name;
    $('#readout-rows').innerHTML = $('.tip__rows', j).innerHTML;
    $('#readout').hidden = false;
  }
  stage.addEventListener('click', function (e) {
    var j = e.target.closest('[data-unit], [data-jar], [data-ring]'); if (!j) return;
    readout(j.getAttribute('data-unit') || j.getAttribute('data-jar') || j.getAttribute('data-ring'));
  });

  /* ---------- the real jars (Jars view only, built the first time it is shown) ---------- */
  var jars = null;
  function showJars() {
    if (!jars) {
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
        jarRow.appendChild(node);
      });
      jars = new window.CA.Jars(stage);
    }
    document.dispatchEvent(new Event('ca:themechange'));
    jars.setData(RAW, { fromEmpty: true, delay: 160, stagger: 90 });
  }

  /* ---------- view switch: a radio group, arrow keys move through all seven ---------- */
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
    if (VIEWS.indexOf(v) < 0) v = 'donut';
    html.setAttribute('data-view', v);
    syncRadios(v, focus);
    $('#readout').hidden = true;
    try {
      var u = new URL(location.href); u.searchParams.set('view', v);
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    } catch (e) {}
    if (v === 'jars') { alt.innerHTML = ''; keyEl.innerHTML = ''; showJars(); }
    else render(v);
  }
  radios.forEach(function (r, i) {
    r.addEventListener('click', function () { if (r.getAttribute('aria-checked') !== 'true') setView(r.getAttribute('data-view')); });
    r.addEventListener('keydown', function (e) {
      var n = radios.length, to = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = (i + 1) % n;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = (i - 1 + n) % n;
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = n - 1;
      if (to == null) return;
      e.preventDefault();
      setView(radios[to].getAttribute('data-view'), true);
    });
  });
  setView(html.getAttribute('data-view') || 'donut');

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

  window.MOCK = { RAW: RAW, setView: setView, get jars() { return jars; } };   // for the test harness
})();
