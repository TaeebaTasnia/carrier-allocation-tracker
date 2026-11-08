/* CA.numbers: a dependency-free number roller ("being calculated" look), shared by every page.
 *
 *   CA.numbers.roll(el, value, opts)  roll el's text to value
 *   CA.numbers.format(value, opts)    the default formatter (also usable on its own)
 *   CA.numbers.settle(el)             jump a running roll to its final text
 *   CA.numbers.teu(x, opts)           the ONE TEU display rule: whole TEU, rounded UP (see teuValue below);
 *                                     opts.band (deficit/surplus), opts.sign, opts.empty
 *   CA.numbers.teuFmt / teuDsFmt      formatters for roll(): TEU, and the signed deficit/surplus TEU
 *
 * opts:
 *   format(value) -> string  formatter; default: up to 2 decimals, trailing ".00" dropped,
 *                             thousands separated with a thin comma, U+2212 minus
 *   sign: true               prefix "+" on positive values (deficit/surplus)
 *   empty: '—'               text for null / NaN (shown at once, no roll)
 *   delay: ms                start delay (use it to stagger a group of figures)
 *   duration: ms             time until the last digit locks (default 900)
 *
 * How it works: each digit becomes a short vertical strip of digits inside a clipped cell, and the
 * strip is moved with a CSS transform transition (compositor only, no per-frame JavaScript, no
 * layout per frame). Strips start on a random digit, spin through a full cycle and lock in left to
 * right, the leftmost first, on a strong ease-out, so the figure looks computed rather than tweened.
 * Signs, separators, units and the decimal point stand still. All rolls started in the same task
 * are armed together in one requestAnimationFrame (one style pass for the whole batch). When the
 * roll ends the cell markup is replaced by the plain final text, so selection and copy see
 * ordinary text.
 *
 * Budget: at most MAX_CELLS digit strips move at once; anything beyond shows its final text at once.
 * prefers-reduced-motion, a hidden tab, or an empty value: the final text appears at once.
 * Accessibility: the moving strips are aria-hidden and a visually hidden copy of the final text is
 * present from the first frame, so a screen reader reads the final value, never the spin. Put the
 * figure inside an aria-live region only if it should be announced; it then announces once.
 *
 * Needs the small CSS block that ships with it (.nr-*) in css/dashboard.css.
 */
(function () {
  'use strict';

  var MAX_CELLS = 96;
  var reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
  var MINUS = '−';
  var live = 0;                       // digit strips currently moving
  var pending = [];                   // rolls waiting for the batch frame
  var raf = 0;
  var state = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  function format(n, opts) {
    opts = opts || {};
    if (n == null || !isFinite(n)) return opts.empty || '—';
    var a = Math.abs(n), s = a.toFixed(2);
    if (s.slice(-3) === '.00') s = s.slice(0, -3);
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    s = parts.join('.');
    var neg = n < 0 && s !== '0';
    var pos = opts.sign && n > 0.0049;
    return (neg ? MINUS : pos ? '+' : '') + s;
  }

  /* TEU display rule (display only, calculations stay exact):
   *   null / undefined / NaN -> null (the caller shows its empty mark)
   *   positive: ceil(x - 1e-6)        72.66 -> 73, 72.01 -> 73, 72.0 -> 72, 28.000000000004 -> 28, 0.2 -> 1
   *   negative: away from zero        -11.67 -> -12, -8.0 -> -8
   *   opts.band: |x| <= 0.5 -> 0 (the deficit/surplus figure: a "balanced" week never shows 1)
   *   never -0.
   * Same rule in backend/app/services/reports.py (teu_up) for the .xlsx files. */
  var TEU_EPS = 1e-6;
  function teuValue(n, opts) {
    if (n == null || n === '' || !isFinite(n)) return null;
    n = Number(n);
    var a = Math.abs(n);
    if (opts && opts.band && a <= 0.5) return 0;
    var r = Math.ceil(a - TEU_EPS);
    if (!(r > 0)) return 0;
    return n < 0 ? -r : r;
  }
  function teu(n, opts) {
    opts = opts || {};
    var v = teuValue(n, opts);
    if (v == null) return opts.empty || '—';
    return format(v, { sign: opts.sign, empty: opts.empty });
  }
  // formatters for CA.numbers.roll / CA.page.roll: the roller is fed the exact value and shows the whole number
  function teuFmt(n) { return teu(n); }
  function teuDsFmt(n) { return teu(n, { band: true, sign: true }); }

  /* Over budget: the roll waits its turn (the final text shows faintly meanwhile, so nothing
   * jumps), and starts when earlier strips lock. Big tables therefore resolve as a cascade, top to
   * bottom, instead of most cells appearing at once. A roll that waits longer than WAIT_MAX shows
   * its final text without spinning. */
  var WAIT_MAX = 2600;
  var queue = [];
  function drain() {
    var now = performance.now();
    while (queue.length) {
      var q = queue[0];
      if (q.el.getAttribute('data-nr-wait') !== q.token) { queue.shift(); continue; }   // replaced since
      if (now - q.at > WAIT_MAX) { queue.shift(); unwait(q.el); continue; }
      if (live + q.digits > MAX_CELLS) break;
      queue.shift();
      unwait(q.el);
      roll(q.el, q.value, q.opts, true);
    }
  }
  function unwait(el) { el.removeAttribute('data-nr-wait'); el.classList.remove('nr-wait'); }

  function finish(el) {
    var st = state && state.get(el);
    if (!st) return;
    clearTimeout(st.timer);
    live -= st.cells;
    state.delete(el);
    el.textContent = st.text;
    el.classList.remove('nr-on');
    if (queue.length) drain();
  }

  function arm() {
    raf = 0;
    var batch = pending;
    pending = [];
    // the strips were inserted at their start digit in an earlier frame; now set the targets
    for (var i = 0; i < batch.length; i++) {
      var b = batch[i];
      if (!state || state.get(b.el) !== b.st) continue;
      for (var j = 0; j < b.strips.length; j++) {
        var s = b.strips[j];
        s.node.style.transition = 'transform ' + s.dur + 'ms var(--ease-settle, cubic-bezier(.12,.8,.18,1)) ' + s.delay + 'ms';
        s.node.style.transform = 'translate3d(0,' + (-s.target / s.len * 100).toFixed(4) + '%,0)';
      }
    }
  }

  var tokens = 0;
  function roll(el, value, opts, fromQueue) {
    if (!el) return;
    opts = opts || {};
    var text = (value == null || !isFinite(value)) ? (opts.empty || '—')
      : (opts.format ? opts.format(value) : format(value, opts));
    finish(el);
    if (!fromQueue && el.hasAttribute('data-nr-wait')) unwait(el);

    var digits = (text.match(/\d/g) || []).length;
    if (!state || !digits || reduceMQ.matches || document.hidden || digits > MAX_CELLS) {
      el.textContent = text;
      return;
    }
    if (live + digits > MAX_CELLS) {
      var token = String(++tokens);
      el.textContent = text;
      el.setAttribute('data-nr-wait', token);
      el.classList.add('nr-wait');
      // a waiting roll keeps a short delay so the cascade reads as one sweep
      queue.push({ el: el, value: value, opts: { format: opts.format, sign: opts.sign, empty: opts.empty, duration: opts.duration, delay: 0 }, digits: digits, token: token, at: performance.now() });
      return;
    }

    var dur = opts.duration || 900, delay = opts.delay || 0;
    var frag = document.createDocumentFragment();
    var sr = document.createElement('span');
    sr.className = 'nr-sr';
    sr.textContent = text;
    frag.appendChild(sr);
    var vis = document.createElement('span');
    vis.setAttribute('aria-hidden', 'true');
    frag.appendChild(vis);

    var strips = [], k = 0;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (!/\d/.test(ch)) { vis.appendChild(document.createTextNode(ch)); continue; }
      var d = +ch;
      var cell = document.createElement('span');
      cell.className = 'nr-d';
      var ph = document.createElement('span');
      ph.className = 'nr-ph';
      ph.textContent = ch;                     // holds width and baseline
      var win = document.createElement('span');
      win.className = 'nr-w';
      var strip = document.createElement('span');
      strip.className = 'nr-s';
      // start on a random digit, run one full cycle (two for the leading digits), stop on d
      var start = Math.floor(Math.random() * 10);
      var cycles = k < 2 ? 2 : 1;
      var target = cycles * 10 + ((d - start + 10) % 10);   // (start + target) % 10 === d
      var len = target + 1, html = '';
      for (var n = 0; n < len; n++) html += '<i>' + ((start + n) % 10) + '</i>';
      strip.innerHTML = html;
      win.appendChild(strip);
      cell.appendChild(ph);
      cell.appendChild(win);
      vis.appendChild(cell);
      // left to right: the first digit locks first, the last at `dur`
      var t = digits > 1 ? k / (digits - 1) : 1;
      strips.push({ node: strip, target: target, len: len, delay: delay + k * 24, dur: Math.round(dur * (0.62 + 0.38 * t)) });
      k++;
    }

    el.textContent = '';
    el.appendChild(frag);
    el.classList.add('nr-on');
    live += digits;

    var st = { text: text, cells: digits, timer: 0 };
    var longest = 0;
    strips.forEach(function (s) { longest = Math.max(longest, s.delay + s.dur); });
    st.timer = setTimeout(function () { if (state.get(el) === st) finish(el); }, longest + 60);
    state.set(el, st);

    pending.push({ el: el, st: st, strips: strips });
    // two frames: the first paints the start digits, the second sets the targets
    if (!raf) raf = requestAnimationFrame(function () { raf = requestAnimationFrame(arm); });
  }

  // a tab hidden mid-roll: settle everything so it is right when the tab comes back
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden || !state) return;
    Array.prototype.forEach.call(document.querySelectorAll('.nr-on'), finish);
  });

  window.CA = window.CA || {};
  window.CA.numbers = { roll: roll, format: format, settle: finish, teu: teu, teuValue: teuValue, teuFmt: teuFmt, teuDsFmt: teuDsFmt };
})();
