/* Small helpers shared by the data-entry, report and settings pages. */
(function () {
  'use strict';

  var NUM = window.CA.numbers;
  var reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
  var CARRIERS = ['MAERSK', 'HAPAG', 'HELLMAN', 'ONE', 'FML'];

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmt(n) { return NUM.format(n); }
  function signed(n) { return NUM.format(n, { sign: true }); }
  // TEU figures: whole TEU, rounded up (CA.numbers.teu, js/numbers.js); teuDs = deficit/surplus with sign and the balanced band
  function teu(n) { return NUM.teu(n); }
  function teuDs(n) { return NUM.teu(n, { band: true, sign: true }); }
  function teuSigned(n) { return NUM.teu(n, { sign: true }); }
  function pct(n) {
    if (n == null || !isFinite(n)) return '—';
    if (n > 0 && n < 1) return '<1%';
    return Math.round(n) + '%';
  }

  /* roll a figure; successive calls in one render start a little later (top to bottom) */
  var seq = 0;
  function resetSeq() { seq = 0; }
  function roll(e, v, o) {
    o = o || {};
    NUM.roll(e, v, {
      format: o.format || fmt,
      delay: (o.delay || 0) + (o.noStagger ? 0 : Math.min(seq++ * 32, 700)),
      duration: o.duration || 900
    });
  }

  /* ---------- the headline reveal (every page title and the Overview headline) ----------
   *
   *   pop(el, parts, o)   set a title (.hl) or its sub line (.hl-sub) and play the reveal
   *     parts: strings, { em: 'key words' } (the accent) and nodes (e.g. a rolling number)
   *     o.label           plain text of the title for screen readers (default: from parts)
   *     o.onReveal(info)  called when the lines start to rise; info.delayOf(node) is the delay
   *                       of the line holding node, info.settle the ms after that when the line
   *                       has visually settled (use it to land a CA.numbers.roll on the line)
   *   headExit(el)        start the exit of a title group now (the Overview calls it on week change,
   *                       so the old line leaves while the new week loads)
   *   headSettle(el)      jump a running reveal to its final state
   *
   * Choreography (tokens --hl-* in css/tokens.css): the title is split into its rendered lines;
   * each line sits in its own overflow-hidden mask and rises from below it with a long expo-style
   * ease-out (--hl-dur, --hl-ease), one --hl-step after the line above. One step after the last
   * line the hairline draws from left to right (scaleX), one step later the sub line rises a little
   * and fades in. On a change of text the old lines first leave upward through the same masks
   * (--hl-exit), the hairline retracts to the right and the sub fades, then the new text rises.
   * Transform and opacity only, Web Animations on a handful of elements, no per-frame script.
   * While it plays the masks are aria-hidden and a visually hidden copy carries the text; at the
   * end the title is rebuilt as plain text (an em for the accent), so screen readers read it once
   * and selection works. Reduced motion or a hidden tab: the final state at once. The resting CSS
   * is the final state; every animation only animates FROM an offset (fill backwards), so an
   * interrupted reveal always leaves visible text. */
  var groups = new WeakMap();
  var hlTiming = null;
  function msVar(cs, name, dflt) {
    var v = cs.getPropertyValue(name).trim();
    if (!v) return dflt;
    var n = parseFloat(v);
    if (!isFinite(n)) return dflt;
    return /ms$/.test(v) ? n : /s$/.test(v) ? n * 1000 : n;
  }
  function timing() {
    if (hlTiming) return hlTiming;
    var cs = getComputedStyle(document.documentElement);
    hlTiming = {
      dur: msVar(cs, '--hl-dur', 900),
      step: msVar(cs, '--hl-step', 90),
      exit: msVar(cs, '--hl-exit', 260),
      ease: cs.getPropertyValue('--hl-ease').trim() || 'cubic-bezier(0.16, 1, 0.3, 1)',
      easeExit: cs.getPropertyValue('--hl-ease-exit').trim() || 'cubic-bezier(0.5, 0, 0.75, 0)'
    };
    return hlTiming;
  }
  function still() { return reduceMQ.matches || document.hidden || !Element.prototype.animate; }

  // the face must be in before lines are measured (display=swap would re-break them later)
  var fontWait = null;
  function fontSpec(elm) { var cs = getComputedStyle(elm); return cs.fontWeight + ' 48px ' + cs.fontFamily; }
  function fontsReady(elm) {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    if (!fontWait) {
      fontWait = Promise.race([
        document.fonts.load(fontSpec(elm)).catch(function () {}),
        new Promise(function (r) { setTimeout(r, 500); })
      ]);
    }
    return fontWait;
  }
  function fontsIn(elm) {
    try { return !document.fonts || document.fonts.check(fontSpec(elm)); } catch (e) { return true; }
  }

  function group(elm) {
    var g = groups.get(elm);
    if (g) return g;
    var box = elm.parentNode;
    var rule = elm.nextElementSibling && elm.nextElementSibling.classList.contains('hl-rule') ? elm.nextElementSibling : null;
    if (!rule) {
      rule = el('span', 'hl-rule');
      rule.setAttribute('aria-hidden', 'true');
      elm.parentNode.insertBefore(rule, elm.nextSibling);
    }
    var sub = box.querySelector('.hl-sub');
    g = {
      title: elm, rule: rule, sub: sub,
      phase: 'idle', shown: false, tok: 0, text: null, parts: null,
      exitDone: Promise.resolve(), timer: 0,
      subWaiting: !!sub && !sub.classList.contains('hl-on'),
      subAt: 0, ruleAnim: null, subAnim: null
    };
    groups.set(elm, g);
    if (sub) groups.set(sub, g);
    return g;
  }

  // parts -> tokens: one per word or node, with whether a space came before it
  function tokenize(parts) {
    var toks = [], space = false;
    parts.forEach(function (p) {
      var em = false;
      if (p && typeof p === 'object' && !p.nodeType && 'em' in p) { em = true; p = p.em; }
      if (p == null) return;
      if (typeof p !== 'string') { toks.push({ node: p, em: em, sp: space }); space = false; return; }
      p.split(/(\s+)/).forEach(function (t) {
        if (!t) return;
        if (/^\s+$/.test(t)) { space = true; return; }
        toks.push({ text: t, em: em, sp: space }); space = false;
      });
    });
    return toks;
  }
  function textOf(parts) {
    return parts.map(function (p) {
      if (p && typeof p === 'object' && !p.nodeType && 'em' in p) p = p.em;
      if (p == null) return '';
      return typeof p === 'string' ? p : (p.getAttribute && p.getAttribute('data-text')) || p.textContent;
    }).join('');
  }
  // the current plain content of a title as parts (for its exit)
  function domParts(elm) {
    var out = [];
    Array.prototype.forEach.call(elm.childNodes, function (n) {
      if (n.nodeType === 3) out.push(n.nodeValue);
      else if (n.nodeType === 1 && n.tagName === 'EM') out.push({ em: n.textContent });
      else if (n.nodeType === 1 && !n.classList.contains('sr')) out.push(n);
    });
    return out;
  }
  // plain final DOM: text, one em per accent part, nodes as they are
  function buildPlain(elm, parts) {
    elm.textContent = '';
    parts.forEach(function (p) {
      var parent = elm;
      if (p && typeof p === 'object' && !p.nodeType && 'em' in p) { parent = el('em'); elm.appendChild(parent); p = p.em; }
      if (p == null) return;
      parent.appendChild(typeof p === 'string' ? document.createTextNode(p) : p);
    });
  }
  // tokens -> DOM; consecutive accent words share one em; wrap(tokNode) may wrap each token
  function renderToks(box, toks, wrap) {
    var em = null;
    toks.forEach(function (t, i) {
      if (!t.em) em = null;
      // a space between two accent words stays inside their em, any other space outside
      if (t.sp && i > 0) (em || box).appendChild(document.createTextNode(' '));
      if (t.em && !em) { em = el('em'); box.appendChild(em); }
      var n = t.node || document.createTextNode(t.text);
      (em || box).appendChild(wrap ? wrap(n) : n);
    });
  }
  // split into rendered lines: one layout read for all words
  function measure(elm, toks, wholeBlock) {
    if (wholeBlock || toks.length < 2) return [toks];
    var spans = [];
    elm.textContent = '';
    renderToks(elm, toks, function (n) { var s = el('span'); s.appendChild(n); spans.push(s); return s; });
    var lines = [], top = null;
    spans.forEach(function (s, i) {
      var y = s.offsetTop;
      if (top === null || Math.abs(y - top) > 3) { lines.push([]); top = y; }
      lines[lines.length - 1].push(toks[i]);
    });
    return lines;
  }
  // build the masks; returns the inner (moving) spans
  function masks(elm, lines, label, whole) {
    var vis = el('span', 'hl-vis');
    vis.setAttribute('aria-hidden', 'true');
    var ins = [];
    lines.forEach(function (lt) {
      var m = el('span', 'hl-line' + (whole ? ' hl-line--all' : ''));
      var inn = el('span', 'hl-in');
      renderToks(inn, lt.map(function (t, i) { return i ? t : { node: t.node, text: t.text, em: t.em, sp: false }; }));
      m.appendChild(inn); vis.appendChild(m); ins.push(inn);
    });
    elm.textContent = '';
    elm.appendChild(el('span', 'sr', label));
    elm.appendChild(vis);
    return ins;
  }
  function lineStep(n) { var T = timing(); return n < 2 ? T.step : Math.min(T.step, Math.round(2.5 * T.step / (n - 1))); }

  function cancel(a) { if (a) { try { a.cancel(); } catch (e) {} } return null; }
  function refreshCursor() { if (window.CA.cursor && window.CA.cursor.refresh) window.CA.cursor.refresh(); }

  // the old title leaves upward through its masks; rule retracts to the right; sub fades
  function exit(g) {
    var T = timing(), t = g.title;
    g.phase = 'exiting';
    $$('.nr-on', t).forEach(function (n) { NUM.settle(n); });
    var label = t.textContent, parts = domParts(t), toks = tokenize(parts);
    var whole = !fontsIn(t);
    var lines = measure(t, toks, whole);
    var ins = masks(t, lines, label, whole);
    var step = 40, last = 0;
    ins.forEach(function (inn, i) {
      last = i * step;
      inn.animate([{ transform: 'none', opacity: 1 }, { transform: 'translate3d(0,-135%,0)', opacity: 0 }],
        { duration: T.exit, delay: last, easing: T.easeExit, fill: 'forwards' });
    });
    g.ruleAnim = cancel(g.ruleAnim);
    if (g.rule.classList.contains('hl-on')) {
      g.ruleAnim = g.rule.animate([{ transform: 'scaleX(1)', transformOrigin: '100% 50%' }, { transform: 'scaleX(0)', transformOrigin: '100% 50%' }],
        { duration: T.exit, easing: T.easeExit, fill: 'forwards' });
    }
    if (g.sub) {
      g.subAnim = cancel(g.subAnim);
      if (g.sub.classList.contains('hl-on')) {
        g.subAnim = g.sub.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translate3d(0,-0.3em,0)' }],
          { duration: Math.round(T.exit * 0.8), easing: T.easeExit, fill: 'forwards' });
      }
      g.subWaiting = true;
    }
    var total = T.exit + last + 20;
    g.exitDone = new Promise(function (r) {
      setTimeout(function () { if (g.phase === 'exiting') g.phase = 'waiting'; r(); }, total);
    });
  }

  // force: an interruption (new text, settle): jump everything to the end first
  function finalize(g, force) {
    clearTimeout(g.timer);
    var t = g.title;
    if (force) {
      $$('.nr-on', t).forEach(function (n) { NUM.settle(n); });
      [g.ruleAnim, g.subAnim].forEach(function (a) { if (a) { try { a.finish(); } catch (e) {} } });
    }
    buildPlain(t, g.parts);
    g.phase = 'idle';
    g.shown = true;
    refreshCursor();
  }

  function enter(g, parts, o, label) {
    var T = timing(), t = g.title, tok = g.tok;
    g.phase = 'entering';
    g.parts = parts;
    var toks = tokenize(parts);
    var whole = !fontsIn(t);
    var lines = measure(t, toks, whole);
    var ins = masks(t, lines, label, whole);
    t.classList.add('hl-on');
    var n = ins.length, step = lineStep(n), base = o.delay || 0, end = 0;
    // 135%: the line must start fully below its mask, which reaches 0.2em below the line box.
    // Newsreader at leading 1.04 keeps its ascenders and figures inside the line box (accented
    // capitals stand ~0.2em above it), so the minimum is ~120% for plain English titles and ~138%
    // for accented capitals; the exit (mask top pad 0.16em, descenders inside the box) needs ~111%.
    // Re-check these if the face or leading changes: tips peeking at the mask edge is the symptom.
    var KF = [{ transform: 'translate3d(0,135%,0)', opacity: 0 }, { transform: 'none', opacity: 1 }];
    ins.forEach(function (inn, i) {
      inn.animate(KF, { duration: T.dur, delay: base + i * step, easing: T.ease, fill: 'backwards' });
      end = base + i * step + T.dur;
    });
    var ruleAt = base + Math.min(n, 3) * step;
    g.ruleAnim = cancel(g.ruleAnim);
    g.rule.classList.add('hl-on');
    g.ruleAnim = g.rule.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
      { duration: Math.round(T.dur * 0.85), delay: ruleAt, easing: T.ease, fill: 'backwards' });
    end = Math.max(end, ruleAt + Math.round(T.dur * 0.85));
    if (g.sub && g.subWaiting) {
      var subAt = ruleAt + T.step;
      g.subAnim = cancel(g.subAnim);
      g.sub.classList.add('hl-on');
      g.subAnim = g.sub.animate([{ opacity: 0, transform: 'translate3d(0,0.5em,0)' }, { opacity: 1, transform: 'none' }],
        { duration: Math.round(T.dur * 0.8), delay: subAt, easing: T.ease, fill: 'backwards' });
      g.subAt = performance.now() + subAt;
      g.subWaiting = false;
      end = Math.max(end, subAt + Math.round(T.dur * 0.8));
    }
    if (o.onReveal) {
      o.onReveal({
        dur: T.dur,
        settle: Math.round(T.dur * 0.7),
        delayOf: function (node) {
          for (var i = 0; i < ins.length; i++) if (ins[i].contains(node)) return base + i * step;
          return base;
        }
      });
    }
    // rebuild as plain text once every line has settled and no number in it is still rolling
    var waited = 0;
    function done() {
      if (tok !== g.tok || g.phase !== 'entering') return;
      if (t.querySelector('.nr-on') && waited < 1500) { waited += 80; g.timer = setTimeout(done, 80); return; }
      finalize(g, waited >= 1500);
    }
    g.timer = setTimeout(done, end + 40);
  }

  function showNow(g, parts, o) {
    clearTimeout(g.timer);
    g.parts = parts;
    buildPlain(g.title, parts);
    g.title.classList.add('hl-on');
    g.ruleAnim = cancel(g.ruleAnim);
    g.rule.classList.add('hl-on');
    if (g.sub) { g.subAnim = cancel(g.subAnim); g.sub.classList.add('hl-on'); g.subWaiting = false; }
    g.phase = 'idle'; g.shown = true;
    if (o.onReveal) o.onReveal({ dur: 0, settle: 0, delayOf: function () { return 0; } });
    refreshCursor();
  }

  function popTitle(elm, parts, o) {
    var g = group(elm);
    var tok = ++g.tok;
    var label = o.label || textOf(parts);
    if (still()) { if (g.phase === 'entering') finalize(g, true); g.text = label; showNow(g, parts, o); return; }
    // same words already showing: no replay (a filter change, a refresh of the same week)
    if (g.phase === 'idle' && g.shown && label === g.text) { g.parts = parts; buildPlain(elm, parts); if (o.onReveal) o.onReveal({ dur: 0, settle: 0, delayOf: function () { return 0; } }); return; }
    g.text = label;
    if (g.phase === 'entering') finalize(g, true);
    if (g.phase === 'idle' && g.shown) exit(g);
    else if (g.phase === 'idle') g.phase = 'waiting';
    Promise.all([g.exitDone, fontsReady(elm)]).then(function () {
      if (tok !== g.tok) return;
      enter(g, parts, o, label);
    });
  }

  function popSub(elm, parts) {
    var g = groups.get(elm) || null;
    buildPlain(elm, parts);
    if (!g || still()) {
      if (g) g.subAnim = cancel(g.subAnim), g.subWaiting = false;
      elm.classList.add('hl-on');
      return;
    }
    var T = timing(), now = performance.now();
    if (g.phase === 'exiting' || g.phase === 'waiting') {
      // the title is on its way: the new sub waits for its slot in the title's reveal
      g.subAnim = cancel(g.subAnim);
      if (elm.classList.contains('hl-on')) g.subAnim = elm.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 3000 });
      g.subWaiting = true;
      return;
    }
    if (g.subWaiting && !g.shown) return;            // first reveal not started yet
    if (g.subAt && now < g.subAt) return;            // its scheduled rise will show the new text
    g.subAnim = cancel(g.subAnim);
    elm.classList.add('hl-on');
    g.subWaiting = false;
    g.subAnim = elm.animate([{ opacity: 0, transform: 'translate3d(0,0.4em,0)' }, { opacity: 1, transform: 'none' }],
      { duration: Math.round(T.dur * 0.7), easing: T.ease, fill: 'backwards' });
  }

  function pop(elm, parts, o) {
    if (!elm) return;
    o = o || {};
    if (elm.classList.contains('hl')) return popTitle(elm, parts, o);
    if (elm.classList.contains('hl-sub')) {
      // a sub line belongs to the title in the same head
      var t = elm.parentNode.querySelector('.hl');
      if (t) group(t);
      return popSub(elm, parts);
    }
    buildPlain(elm, parts);
  }
  function headExit(elm) {
    if (!elm || still()) return;
    var g = group(elm);
    g.tok++;
    if (g.phase === 'entering') finalize(g, true);
    if (g.phase === 'idle' && g.shown) exit(g);
  }
  function headSettle(elm) {
    var g = elm && groups.get(elm);
    if (g && g.phase === 'entering') finalize(g, true);
  }

  /* a small jar glyph in the carrier colour; level 0..1 fills it */
  function mark(level) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 14 20');
    s.setAttribute('class', 'car__mark');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<rect x="2.6" y="5" width="8.8" height="12.4" rx="1.6"/><path d="M3.5 1.2h7M4.3 1.2v1.9c0 .5-.4.9-.9 1.3-.6.4-.9 1-.9 1.7v10.6A2 2 0 0 0 4.5 18.7h5a2 2 0 0 0 2-2V6.1c0-.7-.3-1.3-.9-1.7-.5-.4-.9-.8-.9-1.3V1.2"/>';
    s.style.setProperty('--lv', level == null ? 1 : Math.max(0, Math.min(1, level)).toFixed(3));
    return s;
  }
  function carrierLabel(name, level) {
    var c = el('span', 'car');
    c.setAttribute('data-carrier', name);
    c.appendChild(mark(level));
    c.appendChild(el('span', 'car__name', name));
    return c;
  }

  var CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5"/></svg>';

  /* parse a typed number: comma or dot decimal, no negatives. '' -> null; bad -> NaN */
  function parseNum(s) {
    s = String(s == null ? '' : s).trim().replace(/\s/g, '').replace(',', '.');
    if (s === '') return null;
    if (!/^\d*\.?\d*$/.test(s) || s === '.') return NaN;
    return parseFloat(s);
  }
  /* keep a numeric field clean while typing, and give it stepper keys */
  function numericField(input, opts) {
    opts = opts || {};
    input.setAttribute('inputmode', 'decimal');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.addEventListener('beforeinput', function (e) {
      if (e.inputType && e.inputType.indexOf('insert') === 0 && e.data != null && /[^0-9.,]/.test(e.data)) e.preventDefault();
    });
    // a click or tab into the field selects the figure, so typing replaces it
    var fresh = false;
    input.addEventListener('focus', function () { fresh = true; input.select(); });
    input.addEventListener('mouseup', function (e) { if (fresh) { e.preventDefault(); fresh = false; } });
    input.addEventListener('blur', function () { fresh = false; });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        var v = parseNum(input.value);
        if (v == null || isNaN(v)) v = 0;
        var step = e.shiftKey ? 10 : e.altKey ? 0.1 : (opts.step || 1);
        v = Math.max(opts.min || 0, Math.round((v + (e.key === 'ArrowUp' ? step : -step)) * 100) / 100);
        if (opts.max != null) v = Math.min(opts.max, v);
        input.value = String(v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  }
  function plain(n) {
    if (n == null || !isFinite(n)) return '';
    return String(Math.round(n * 10000) / 10000);
  }

  /* a file size for people: 812 bytes, 6.4 KB, 1.2 MB */
  function bytes(n) {
    if (!(n >= 0)) return 'size unknown';
    if (n < 1024) return n + ' bytes';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  /* The one footer line (#foot-source). The HTML already holds the default wording; here the CBM per
     TEU and the uplift come from the real config (one GET /config, non-blocking, falls back to the
     HTML text). In ?demo the figures are fake, so the line says so; no other developer text. */
  function footLine() {
    var node = document.getElementById('foot-source'), D = window.CA && window.CA.data, API = window.CA && window.CA.api;
    if (!node || !D) return;
    var demo = D.USE_BACKEND === false;
    function write(cfg) {
      var s = 'Figures in TEU, rounded up to whole TEU. 1 TEU is ' + fmt(cfg.cbm_per_teu) + ' CBM after the ' + fmt(cfg.uplift_pct) + '% uplift.';
      node.textContent = s + (demo ? ' Demo data: weeks 45 to 47 of the 2026 workbook.' : '');
    }
    if (demo) { write({ cbm_per_teu: 33, uplift_pct: 30 }); return; }
    if (!API || typeof API.getConfig !== 'function') return;
    API.getConfig().then(function (c) {
      if (c && isFinite(c.cbm_per_teu) && isFinite(c.uplift_pct)) write(c);
    }, function () {});
  }
  setTimeout(footLine, 0);

  window.CA = window.CA || {};
  window.CA.page = {
    bytes: bytes,
    $: $, $$: $$, el: el, fmt: fmt, signed: signed, teu: teu, teuDs: teuDs, teuSigned: teuSigned, pct: pct, roll: roll, resetSeq: resetSeq,
    pop: pop, headExit: headExit, headSettle: headSettle, mark: mark, carrierLabel: carrierLabel, CARRIERS: CARRIERS, CHECK: CHECK,
    parseNum: parseNum, numericField: numericField, plain: plain,
    reduced: function () { return reduceMQ.matches; }
  };
})();
