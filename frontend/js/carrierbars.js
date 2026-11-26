/* CA.carrierBars: the carrier bar chart on the Overview (js/dashboard.js). It came from Allocation
 * vs Utilization, which now shows the same figures as numbers only. One lane per carrier on a
 * single shared TEU scale:
 *   confirmed space  = a container (.lt__box, outline in the carrier hue, oblique top and end faces)
 *   utilized         = the solid striped fill inside it (.lt__fill), red hatched past its end (.lt__over)
 *   forecast         = an amber pin with its number (.lt__fc); a dashed bracket (.lt__gap) joins the
 *                      container's end to the pin (red when confirmed is below forecast, sea above)
 *   no space         = "nothing confirmed" with a dashed start line (.lt__none)
 * Labels are numbers only (whole TEU, CA.numbers.teu); the unit is written once, on the axis.
 * Styles and the entrance (transform/opacity, once per render) are in css/carrierbars.css; the
 * page places the lane in its own row layout (css/dashboard.css .cb).
 *
 *   scale(max)                 -> { top, ticks }   a round top and 4-6 ticks
 *   maxOf(carriers)            -> the largest forecast / confirmed / utilized of the five carriers
 *   axis(el, sc)               fills el (.lt-axis) with the tick labels and the "TEU" unit
 *   lane(r, sc, o)             -> span.lt for one carrier row r = { forecast, confirmed, utilized }
 *       o.i        row index (stagger of the entrance)
 *       o.fc       show the forecast pin (default true)
 *       o.pin(b, v) fill the pin's number element (default: its whole-TEU text at once)
 *       o.blank    grid lines only (nothing on file / not loaded)
 */
(function () {
  'use strict';

  var NUM = window.CA.numbers;
  var CARRIERS = ['MAERSK', 'HAPAG', 'HELLMAN', 'ONE', 'FML'];
  var EPS = 0.0049;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function teu(n) { return NUM.teu(n); }

  function scale(max) {
    if (!(max > 0)) max = 10;
    var steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
    var step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) { if (max / steps[i] <= 5) { step = steps[i]; break; } }
    var top = Math.ceil(max * 1.04 / step) * step;
    var ticks = [];
    for (var t = 0; t <= top + 1e-9; t += step) ticks.push(t);
    return { top: top, ticks: ticks };
  }
  function pc(v, top) { return (Math.max(0, v) / top * 100).toFixed(3) + '%'; }

  function maxOf(carriers) {
    var max = 0;
    CARRIERS.forEach(function (c) {
      var r = carriers && carriers[c];
      if (r) max = Math.max(max, r.forecast || 0, r.confirmed || 0, r.utilized || 0);
    });
    return max;
  }

  function axis(ax, sc) {
    ax.textContent = '';
    sc.ticks.forEach(function (t, i) {
      var s = el('span', 'lt-tick' + (i === sc.ticks.length - 1 ? ' is-last' : ''), teu(t));
      s.style.left = pc(t, sc.top);
      ax.appendChild(s);
    });
    ax.appendChild(el('span', 'lt-unit', 'TEU'));
  }

  function lane(r, sc, o) {
    o = o || {};
    var fc = r.forecast, cf = r.confirmed, ut = r.utilized;
    var tr = el('span', 'lt');
    tr.style.setProperty('--i', o.i || 0);
    sc.ticks.forEach(function (t) {
      if (t === 0) return;
      var g = el('span', 'lt__grid'); g.style.left = pc(t, sc.top); tr.appendChild(g);
    });
    if (o.blank) return tr;
    if (cf > EPS) {
      var box = el('span', 'lt__box'); box.style.width = pc(cf, sc.top);
      var fill = el('span', 'lt__fill'); fill.style.width = (Math.min(1, ut / cf) * 100).toFixed(3) + '%';
      box.appendChild(fill);
      tr.appendChild(box);
    } else {
      tr.appendChild(el('span', 'lt__none', 'nothing confirmed'));
    }
    if (ut > cf + EPS) {
      var ov = el('span', 'lt__over');
      ov.style.left = pc(cf, sc.top);
      ov.style.width = pc(ut - cf, sc.top);
      tr.appendChild(ov);
    }
    if (o.fc !== false && fc > EPS) {
      var lo = Math.min(fc, cf), hi = Math.max(fc, cf);
      if (hi - lo > EPS) {
        var gap = el('span', 'lt__gap ' + (cf < fc ? 'is-neg' : 'is-pos'));
        gap.style.left = pc(lo, sc.top); gap.style.width = pc(hi - lo, sc.top);
        tr.appendChild(gap);
      }
      var m = el('span', 'lt__fc' + (fc / sc.top > 0.86 ? ' is-end' : ''));
      m.style.left = pc(fc, sc.top);
      var b = el('b');
      if (o.pin) o.pin(b, fc); else b.textContent = teu(fc);
      m.appendChild(b);
      tr.appendChild(m);
    }
    return tr;
  }

  window.CA = window.CA || {};
  window.CA.carrierBars = { EPS: EPS, scale: scale, maxOf: maxOf, axis: axis, lane: lane, pc: pc };
})();
