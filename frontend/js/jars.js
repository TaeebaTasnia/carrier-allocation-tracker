/* Water jars: one per carrier.
 *
 * Semantics (shared TEU scale across the five jars):
 *   glass body height = confirmed TEU      water height = left TEU (confirmed - utilized)
 *   empty glass above the water = utilized  amber tick on the right = forecast allocation
 *   left < 0      -> empty glass, red rim and a spill down the side
 *   confirmed = 0 -> dashed ghost glass at forecast height holding a faint, hatched "forecast level"
 *                    (the planned amount, not confirmed space)
 *   nothing on file (blank, loading, error) -> outline glass with a thin neutral waterline at zero
 *
 * Two layers per jar, so the water can live all the time without a per-frame redraw:
 *   1. a small 2D canvas for the glass (outline, neck, highlights, tick, rim, shelf reflection).
 *      It is drawn only when something changes (data, focus, size) and while the glass grows to
 *      a new capacity, then the loop stops: 0 JavaScript per frame at rest.
 *   2. the water: plain elements inside a clip-path shaped like the glass body. Two wave strips
 *      (a mask of one pre-drawn SVG period, repeated) slide sideways with CSS transform loops at
 *      different speeds and directions, the whole surface bobs slowly, three tiny bubbles rise.
 *      Level changes are one CSS transform transition (the pour). Every moving part is a
 *      transform or opacity on a small layer, so the compositor runs it without main-thread work.
 *   Pointer: moving across a jar leans the surface against the glass tilt (one transform write per
 *   tilt change, eased by a springy CSS transition) and a quick move kicks a splash (a class that
 *   plays a short scaleY keyframe on the waves).
 *
 * Budget: the CSS loops pause (animation-play-state) when the stage is off screen; browsers stop
 * them in hidden tabs. prefers-reduced-motion: no loops, no pour, no slosh; the water stands still
 * at its level.
 */
(function () {
  'use strict';

  var reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
  var REFL = 30;                    // reflection band under the shelf (css px)
  var NECK = 9;                     // neck height above the body (css px)
  var PAD_X = 16;                   // room left/right of the glass for the tick and tilt
  var TOP_ROOM = 26;                // room above the tallest jar for ticks above the rim
  var BLANK_LVL = 16;               // px of resting water when nothing is on file (labelled in the legend)

  // canvas colours come from the theme tokens in css/tokens.css (these are the dark values, the
  // fallback); readColours() runs at start and again on every theme change ('ca:themechange')
  var C = { ink: '247,244,238', hi: '247,244,238', steel: '143,176,207', red: '226,108,82', amber: '240,183,90', water: '94,195,245' };
  var TOK = { ink: '--ink-rgb', hi: '--jar-hi-rgb', steel: '--steel-rgb', red: '--jar-red-rgb', amber: '--acc-forecast-rgb', water: '--water-rgb' };
  function readColours() {
    var cs = getComputedStyle(document.documentElement);
    Object.keys(TOK).forEach(function (k) {
      var v = cs.getPropertyValue(TOK[k]).replace(/\s+/g, '');
      if (/^\d+,\d+,\d+$/.test(v)) C[k] = v;
    });
  }
  readColours();

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function rgbOf(cssColor) {
    var m = /rgba?\(([^)]+)\)/.exec(cssColor || '');
    if (m) return m[1].split(',').slice(0, 3).map(function (s) { return Math.round(parseFloat(s)); }).join(',');
    var h = /^#?([0-9a-f]{6})$/i.exec((cssColor || '').trim());
    if (h) { var n = parseInt(h[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(','); }
    return C.steel;
  }

  function el(tag, cls) { var e = document.createElement(tag); e.className = cls; return e; }

  function Jar(host, name) {
    this.name = name;
    this.host = host;
    this.canvas = host.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.cur = { cap: 0, fc: 0, over: 0 };
    this.tgt = { cap: 0, fc: 0, over: 0 };
    this.lvl = 0;                   // water level, TEU (target; the CSS transition animates it)
    this.mode = 'blank';
    this.rect = null;
    this.w = 0; this.hgt = 0;
    this.rgb = C.steel;

    // the water layers
    var glass = host.querySelector('.jar__glass');
    var w = el('div', 'water');
    w.setAttribute('aria-hidden', 'true');
    var lvl = el('div', 'water__lvl');
    var tilt = el('div', 'water__tilt');
    var bob = el('div', 'water__bob');
    bob.appendChild(el('i', 'water__body'));
    bob.appendChild(el('i', 'wave wave--back'));
    bob.appendChild(el('i', 'wave wave--front'));
    for (var b = 0; b < 3; b++) bob.appendChild(el('i', 'bubble bubble--' + b));
    tilt.appendChild(bob);
    lvl.appendChild(tilt);
    w.appendChild(lvl);
    glass.appendChild(w);
    this.water = w; this.lvlEl = lvl; this.tiltEl = tilt; this.waves = bob;
    this.lastTilt = 0;
    // a random start phase per jar, so the five surfaces never move in step
    w.style.setProperty('--ph', (-Math.random() * 6).toFixed(2) + 's');
  }

  Jar.prototype.resize = function (w, h, dpr) {
    this.w = w; this.hgt = h;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var shelf = h - REFL;
    this.water.style.left = PAD_X + 'px';
    this.water.style.width = (w - 2 * PAD_X) + 'px';
    this.water.style.height = shelf + 'px';
    this.water.style.setProperty('--shelf', shelf + 'px');
  };

  /* the clip follows the glass body (or the ghost outline) */
  Jar.prototype.clipTo = function (bodyH) {
    var jw = this.w - 2 * PAD_X;
    var shelf = this.hgt - REFL;
    var r = Math.max(0, Math.min(16, bodyH / 2, jw / 2));
    var top = Math.max(0, shelf - bodyH);
    var key = top.toFixed(1) + '/' + r.toFixed(1);
    if (key === this.clipKey) return;
    this.clipKey = key;
    this.water.style.clipPath = 'inset(' + top.toFixed(1) + 'px 0 0 0 round 0 0 ' + r.toFixed(1) + 'px ' + r.toFixed(1) + 'px)';
  };

  /* water height in px; the move is a CSS transition on transform */
  Jar.prototype.pour = function (px, delayMs, instant) {
    var shelf = this.hgt - REFL;
    var y = Math.max(0, shelf - px);
    var st = this.lvlEl.style;
    st.transitionDelay = (delayMs || 0) + 'ms';
    if (instant) {
      st.transition = 'none';
      st.transform = 'translate3d(0,' + y.toFixed(1) + 'px,0)';
      void this.lvlEl.offsetHeight;
      st.transition = '';
      st.transitionDelay = (delayMs || 0) + 'ms';
    } else {
      st.transform = 'translate3d(0,' + y.toFixed(1) + 'px,0)';
    }
    this.water.style.setProperty('--rise', (-Math.max(0, px - 10)).toFixed(0) + 'px');
    this.water.classList.toggle('is-low', px < 14);
  };

  Jar.prototype.step = function (dt) {
    // capacity and forecast tick: exponential approach (tau ~0.32 s), so the glass grows into place
    var k = 1 - Math.exp(-dt / 0.32);
    var c = this.cur, t = this.tgt, moving = false;
    ['cap', 'fc', 'over'].forEach(function (key) {
      var d = t[key] - c[key];
      if (Math.abs(d) > 0.004) { c[key] += d * k; moving = true; } else c[key] = t[key];
    });
    return moving;
  };

  function bodyPath(ctx, x0, x1, top, bottom) {
    var hgt = bottom - top;
    var r = Math.max(0, Math.min(16, hgt / 2, (x1 - x0) / 2));
    var s = Math.max(0, Math.min(9, hgt / 3));
    ctx.beginPath();
    ctx.moveTo(x0, top + s);
    ctx.lineTo(x0, bottom - r);
    ctx.quadraticCurveTo(x0, bottom, x0 + r, bottom);
    ctx.lineTo(x1 - r, bottom);
    ctx.quadraticCurveTo(x1, bottom, x1, bottom - r);
    ctx.lineTo(x1, top + s);
    ctx.quadraticCurveTo(x1, top, x1 - s, top);
    ctx.lineTo(x0 + s, top);
    ctx.quadraticCurveTo(x0, top, x0, top + s);
    ctx.closePath();
  }

  Jar.prototype.draw = function (focus, ppt) {
    var ctx = this.ctx, W = this.w, H = this.hgt;
    ctx.clearRect(0, 0, W, H);
    var shelf = H - REFL;
    var x0 = PAD_X, x1 = W - PAD_X, jw = x1 - x0;
    var cur = this.cur;
    var capH = Math.max(0, cur.cap * ppt);
    var top = shelf - capH;

    // ghost jar for "no capacity confirmed": dashed, at forecast height, amber forecast water inside
    if (this.mode === 'none') {
      var gh = Math.max(36, cur.fc * ppt);
      this.clipTo(gh);
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(' + C.ink + ',' + (focus === 'confirmed' ? 0.62 : 0.4) + ')';
      bodyPath(ctx, x0 + 0.5, x1 - 0.5, shelf - gh + 0.5, shelf - 0.5);
      ctx.stroke();
      ctx.restore();
      this.drawTick(ctx, x1, shelf, shelf - gh, cur.fc * ppt, focus, true);
      this.drawShelf(ctx, x0, x1, shelf, Math.min(gh, cur.fc * ppt), C.water, 0.07);
      return;
    }
    this.clipTo(Math.max(capH, this.mode === 'blank' ? capH : 0));
    if (capH < 1) return;

    // back wall of the glass
    bodyPath(ctx, x0, x1, top, shelf);
    ctx.fillStyle = 'rgba(' + C.steel + ',0.045)';
    ctx.fill();

    var lvlH = clamp(this.lvl * ppt, 0, capH);

    // utilized = the glass already emptied above the water (hatched when in focus)
    if (focus === 'utilized' && capH - lvlH > 2) {
      ctx.save();
      bodyPath(ctx, x0, x1, top, shelf);
      ctx.clip();
      ctx.beginPath();
      ctx.rect(x0, top, jw, capH - lvlH);
      ctx.clip();
      ctx.strokeStyle = 'rgba(' + C.ink + ',0.26)';
      ctx.lineWidth = 1;
      var band = capH - lvlH;
      ctx.beginPath();
      for (var d = 0; d < jw + band; d += 7) { ctx.moveTo(x0 + d, top); ctx.lineTo(x0 + d - band, top + band); }
      ctx.stroke();
      ctx.restore();
    }

    // glass front: outline, shoulder, neck, rim
    var over = this.mode === 'over';
    var edgeA = focus === 'confirmed' ? 0.8 : 0.38;
    ctx.lineWidth = 1;
    ctx.strokeStyle = over ? 'rgba(' + C.red + ',0.8)' : 'rgba(' + C.ink + ',' + edgeA + ')';
    bodyPath(ctx, x0 + 0.5, x1 - 0.5, top + 0.5, shelf - 0.5);
    ctx.stroke();
    var inset = Math.min(10, jw * 0.12);
    ctx.beginPath();
    ctx.moveTo(x0 + inset + 0.5, top + 0.5);
    ctx.lineTo(x0 + inset + 0.5, top - NECK + 0.5);
    ctx.moveTo(x1 - inset - 0.5, top + 0.5);
    ctx.lineTo(x1 - inset - 0.5, top - NECK + 0.5);
    ctx.stroke();
    ctx.lineWidth = 2;
    // the rim carries the carrier colour (red when over-used)
    ctx.strokeStyle = over ? 'rgba(' + C.red + ',0.95)' : (this.mode === 'blank' ? 'rgba(' + C.ink + ',0.4)' : 'rgba(' + this.rgb + ',0.95)');
    ctx.beginPath();
    ctx.moveTo(x0 + inset - 3, top - NECK + 0.5);
    ctx.lineTo(x1 - inset + 3, top - NECK + 0.5);
    ctx.stroke();
    ctx.lineWidth = 1;

    // highlights: a long soft one on the left, a hairline on the right
    var hl = ctx.createLinearGradient(0, top, 0, shelf);
    hl.addColorStop(0, 'rgba(' + C.hi + ',0)');
    hl.addColorStop(0.25, 'rgba(' + C.hi + ',0.28)');
    hl.addColorStop(0.8, 'rgba(' + C.hi + ',0.10)');
    hl.addColorStop(1, 'rgba(' + C.hi + ',0)');
    ctx.fillStyle = hl;
    ctx.fillRect(x0 + 6, top + 10, 2.5, Math.max(0, capH - 26));
    ctx.fillStyle = 'rgba(' + C.ink + ',0.12)';
    ctx.fillRect(x1 - 7, top + 14, 1, Math.max(0, capH - 34));
    // thick glass base
    ctx.strokeStyle = 'rgba(' + C.ink + ',0.12)';
    ctx.beginPath();
    ctx.moveTo(x0 + 14, shelf - 4.5);
    ctx.lineTo(x1 - 14, shelf - 4.5);
    ctx.stroke();

    if (over) this.drawOverflow(ctx, x0, x1, top, inset);
    this.drawTick(ctx, x1, shelf, top, cur.fc * ppt, focus, false);
    this.drawShelf(ctx, x0, x1, shelf, this.mode === 'blank' ? 0 : lvlH, C.water, 0.22);
  };

  Jar.prototype.drawTick = function (ctx, x1, shelf, top, fcH, focus, ghost) {
    if (fcH <= 0) return;
    var y = Math.round(shelf - fcH) + 0.5;
    var hot = focus === 'forecast';
    ctx.strokeStyle = 'rgba(' + C.amber + ',' + (hot ? 1 : 0.85) + ')';
    ctx.lineWidth = hot ? 2 : 1.5;
    ctx.beginPath();
    ctx.moveTo(x1 + 2, y);
    ctx.lineTo(x1 + (hot ? 13 : 10), y);
    ctx.stroke();
    ctx.save();
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    // a faint line across the glass at the same height, only where there is glass
    if (!ghost && y >= top + 2) {
      ctx.strokeStyle = 'rgba(' + C.amber + ',' + (hot ? 0.6 : 0.26) + ')';
      ctx.beginPath();
      ctx.moveTo(x1 - (this.w - 2 * PAD_X) + 4, y);
      ctx.lineTo(x1 - 2, y);
      ctx.stroke();
    }
    // forecast above the rim: dashed riser from the shoulder to the tick (space short of forecast)
    if (!ghost && y < top - 1) {
      ctx.strokeStyle = 'rgba(' + C.amber + ',' + (hot ? 0.85 : 0.5) + ')';
      ctx.beginPath();
      ctx.moveTo(x1 + 6.5, top);
      ctx.lineTo(x1 + 6.5, y);
      ctx.stroke();
    }
    ctx.restore();
  };

  Jar.prototype.drawOverflow = function (ctx, x0, x1, top, inset) {
    var a = clamp(this.cur.over, 0, 1);
    if (a <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = 'rgba(' + C.red + ',0.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x1 - inset + 2, top - NECK);
    ctx.quadraticCurveTo(x1 + 3, top - NECK - 2, x1 + 3.5, top + 6);
    ctx.lineTo(x1 + 3.5, top + 22);
    ctx.stroke();
    ctx.fillStyle = 'rgba(' + C.red + ',0.95)';
    ctx.beginPath(); ctx.arc(x1 + 3.5, top + 28, 1.8, 0, 6.29); ctx.fill();
    ctx.beginPath(); ctx.arc(x1 + 3.5, top + 36, 1.3, 0, 6.29); ctx.fill();
    ctx.restore();
  };

  Jar.prototype.drawShelf = function (ctx, x0, x1, shelf, lvlH, rgb, a) {
    // mirrored water on the shelf
    var hh = Math.min(REFL - 8, lvlH * 0.4);
    if (hh > 1) {
      var g = ctx.createLinearGradient(0, shelf + 2, 0, shelf + 2 + hh);
      g.addColorStop(0, 'rgba(' + rgb + ',' + a + ')');
      g.addColorStop(1, 'rgba(' + rgb + ',0)');
      ctx.fillStyle = g;
      ctx.fillRect(x0 + 12, shelf + 2, (x1 - x0) - 24, hh);
    }
  };

  /* ---------- the group ---------- */

  function Jars(stage) {
    this.stage = stage;
    this.jars = [];
    this.focus = 'left';
    this.ppt = 10;
    this.visible = true;
    this.raf = 0;
    this.lastT = 0;
    this.reduced = reduceMQ.matches;
    var self = this;

    stage.querySelectorAll('[data-jar]').forEach(function (host) {
      var j = new Jar(host, host.getAttribute('data-jar'));
      j.rgb = rgbOf(getComputedStyle(host).getPropertyValue('--car').trim());
      self.jars.push(j);
    });
    stage.classList.toggle('is-still', this.reduced);

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        self.visible = es[0].isIntersecting;
        stage.classList.toggle('is-paused', !self.visible);
        if (self.visible) self.kick();
      }).observe(stage);
    }
    document.addEventListener('visibilitychange', function () { if (!document.hidden) self.kick(); });
    // theme switch: re-read the canvas colours and each carrier hue, then redraw the glass once
    document.addEventListener('ca:themechange', function () {
      readColours();
      self.jars.forEach(function (j) { j.rgb = rgbOf(getComputedStyle(j.host).getPropertyValue('--car').trim()); });
      self.kick();
    });
    reduceMQ.addEventListener('change', function () {
      self.reduced = reduceMQ.matches;
      stage.classList.toggle('is-still', self.reduced);
      self.jars.forEach(function (j) { j.tiltEl.style.transform = ''; });
      self.kick();
    });

    // a quick pass across a jar kicks a splash (throttled, a class that plays a short keyframe)
    var lastX = null, lastY = null, lastT = 0;
    window.addEventListener('pointermove', function (e) {
      if (self.reduced || e.pointerType === 'touch') return;
      var now = performance.now();
      var dt = Math.max(8, now - lastT);
      var vx = lastX == null ? 0 : (e.clientX - lastX) / dt, vy = lastY == null ? 0 : (e.clientY - lastY) / dt;
      lastX = e.clientX; lastY = e.clientY; lastT = now;
      var speed = Math.sqrt(vx * vx + vy * vy);   // px per ms
      if (speed < 0.6) return;
      for (var i = 0; i < self.jars.length; i++) {
        var j = self.jars[i], r = j.rect;
        if (!r || j.mode === 'over') continue;
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) continue;
        if (now - (j.splashAt || 0) < 700) continue;
        j.splashAt = now;
        var w = j.waves;
        w.classList.remove('is-splash');
        void w.offsetWidth;
        w.classList.add('is-splash');
      }
    }, { passive: true });

    this.layout();
    var ro = 'ResizeObserver' in window ? new ResizeObserver(function () { self.layout(); }) : null;
    if (ro) ro.observe(stage); else window.addEventListener('resize', function () { self.layout(); });
    window.addEventListener('scroll', function () { self.measure(); }, { passive: true });
  }

  Jars.prototype.measure = function () {
    this.jars.forEach(function (j) { j.rect = j.canvas.getBoundingClientRect(); });
  };

  Jars.prototype.layout = function () {
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    var first = this.jars[0];
    if (!first) return;
    var holder = first.host.querySelector('.jar__glass');
    var w = Math.max(80, Math.round(holder.clientWidth));
    var h = Math.max(160, Math.round(holder.clientHeight));
    if (w === this.lw && h === this.lh) { this.measure(); return; }
    this.lw = w; this.lh = h;
    this.jars.forEach(function (j) { j.resize(w, h, dpr); j.clipKey = ''; });
    this.height = h;
    this.rescale();
    this.measure();
    this.repour(true);
    this.kick();
  };

  Jars.prototype.rescale = function () {
    var maxTeu = this.maxTeu || 1;
    var usable = (this.height || 300) - REFL - NECK - TOP_ROOM;
    this.ppt = usable / maxTeu;
  };

  /* set every water level from the current data (px depend on the scale) */
  Jars.prototype.repour = function (instant, opts) {
    opts = opts || {};
    var self = this;
    this.jars.forEach(function (j, i) {
      var px;
      if (j.mode === 'blank') px = BLANK_LVL;
      else if (j.mode === 'none') px = Math.min(Math.max(36, j.tgt.fc * self.ppt), j.tgt.fc * self.ppt);
      else px = clamp(j.lvl * self.ppt, 0, j.tgt.cap * self.ppt);
      var delay = instant ? 0 : (opts.delay || 0) + i * (opts.stagger || 0);
      j.pour(px, delay, instant || self.reduced);
    });
  };

  function setMode(j, mode) {
    j.mode = mode;
    var w = j.water;
    w.classList.toggle('is-ghost', mode === 'none');
    w.classList.toggle('is-blank', mode === 'blank');
    w.classList.toggle('is-over', mode === 'over');
  }

  /* carriers: {NAME: {confirmed, left, forecast}} as returned by the backend */
  Jars.prototype.setData = function (carriers, opts) {
    opts = opts || {};
    var maxTeu = 0;
    this.jars.forEach(function (j) {
      var c = carriers ? carriers[j.name] : null;
      if (!c) return;
      maxTeu = Math.max(maxTeu, c.confirmed, c.forecast || 0);
    });
    this.maxTeu = Math.max(maxTeu, 10);
    this.rescale();
    var instant = opts.instant || this.reduced;
    this.jars.forEach(function (j) {
      var c = carriers ? carriers[j.name] : null;
      if (!c) { setMode(j, 'blank'); j.tgt = { cap: 0, fc: 0, over: 0 }; j.lvl = 0; }
      else {
        setMode(j, c.confirmed <= 0 ? 'none' : c.left < 0 ? 'over' : 'ok');
        j.tgt = { cap: Math.max(0, c.confirmed), fc: Math.max(0, c.forecast || 0), over: c.left < 0 ? 1 : 0 };
        j.lvl = j.mode === 'ok' ? Math.max(0, c.left) : 0;
      }
      if (opts.fromEmpty) {
        // the glass is already standing (it rises with the CSS entrance); the water pours in after
        if (!j.cur.cap) j.cur.cap = j.tgt.cap;
        j.cur.fc = j.tgt.fc; j.cur.over = 0;
        j.pour(0, 0, true);
      }
      if (instant) j.cur = { cap: j.tgt.cap, fc: j.tgt.fc, over: j.tgt.over };
    });
    this.repour(instant, { delay: opts.fromEmpty ? (opts.delay || 0) : 0, stagger: opts.fromEmpty ? (opts.stagger || 0) : 40 });
    this.kick();
  };

  /* outline only, used while loading, on error and when nothing is on file */
  Jars.prototype.setOutline = function (teu) {
    this.maxTeu = teu * 1.2;
    this.rescale();
    this.jars.forEach(function (j) {
      setMode(j, 'blank');
      j.tgt = { cap: teu, fc: 0, over: 0 };
      j.cur.cap = teu; j.cur.fc = 0; j.cur.over = 0;
      j.lvl = 0;
    });
    this.repour(false, { stagger: 30 });
    this.kick();
  };

  Jars.prototype.setFocus = function (f) {
    if (f === this.focus) return;
    this.focus = f;
    this.kick();
  };

  /* glass tilt from the cursor module: the surface leans the other way, eased by CSS */
  Jars.prototype.lean = function (name, ry) {
    if (this.reduced) return;
    for (var i = 0; i < this.jars.length; i++) {
      var j = this.jars[i];
      if (j.name !== name) continue;
      var deg = clamp(-ry * 0.55, -6, 6);
      if (Math.abs(deg - j.lastTilt) < 0.15 && deg !== 0) return;
      j.lastTilt = deg;
      j.tiltEl.style.transform = deg ? 'rotate(' + deg.toFixed(2) + 'deg)' : '';
      return;
    }
  };

  // canvas loop: runs only while the glass is changing shape, then stops
  Jars.prototype.kick = function () {
    this.dirty = true;
    if (this.raf || document.hidden) return;
    var self = this;
    this.lastT = performance.now();
    this.raf = requestAnimationFrame(function (n) { self.frame(n); });
  };

  Jars.prototype.frame = function (now) {
    this.raf = 0;
    if (document.hidden) return;
    var dt = clamp((now - this.lastT) / 1000, 1 / 120, 0.1);
    this.lastT = now;
    var moving = false, i;
    for (i = 0; i < this.jars.length; i++) {
      var j = this.jars[i];
      if (this.reduced) { j.cur = { cap: j.tgt.cap, fc: j.tgt.fc, over: j.tgt.over }; }
      else if (j.step(dt)) moving = true;
    }
    if (moving || this.dirty) {
      for (i = 0; i < this.jars.length; i++) this.jars[i].draw(this.focus, this.ppt);
      this.dirty = false;
    }
    if (moving) {
      var self = this;
      this.raf = requestAnimationFrame(function (n) { self.frame(n); });
    }
  };

  window.CA = window.CA || {};
  window.CA.Jars = Jars;
})();
