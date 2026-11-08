/* Cursor ball and pointer tilt.
 *
 * Ball: one fixed element ABOVE the page (pointer-events: none), moved and scaled with transform
 *       only, trailing the pointer with a lerp. Its core is a backdrop-filter disc (css/base.css
 *       .ball__core) that re-inks everything under it: the dark ground turns cream and text of any
 *       colour turns dark ink, so no element has to opt in and nothing is written per element.
 *       Size zones: the nearest [data-ball] ancestor of the element under the pointer picks the
 *       scale (text = full size, ui = small, jar/none = gone). At scale 0 the ball is hidden
 *       (visibility) so no filter surface stays alive.
 * Tilt: elements registered with tilt() lean toward the pointer (perspective rotateX/rotateY).
 *
 * Off on touch / coarse pointers, under prefers-reduced-motion and in forced-colors mode.
 */
(function () {
  'use strict';

  var root = document.documentElement;
  var fineMQ = matchMedia('(hover: hover) and (pointer: fine)');
  var reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
  var forcedMQ = matchMedia('(forced-colors: active)');

  // scale per [data-ball] zone; size at scale 1 is --ball-size in css/tokens.css
  var SCALE = { text: 1, ui: 0.34, jar: 0, none: 0 };
  var BASE = 0.55;

  var ball = null, enabled = false, tiltOn = false, gone = true;
  var tx = -400, ty = -400, x = -400, y = -400, s = 0, ts = 0;
  var raf = 0, idleFrames = 0;
  var tilts = [];
  var dirty = true;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function measure() {
    for (var i = 0; i < tilts.length; i++) {
      var t = tilts[i];
      // measure the untransformed box: the parent, so the tilt does not feed back
      t.rect = t.el.parentNode.getBoundingClientRect();
    }
    dirty = false;
  }

  function scaleFor(target) {
    var z = target && target.closest ? target.closest('[data-ball]') : null;
    var k = z ? z.getAttribute('data-ball') : '';
    return Object.prototype.hasOwnProperty.call(SCALE, k) ? SCALE[k] : BASE;
  }

  function onMove(e) {
    if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    tx = e.clientX; ty = e.clientY;
    if (enabled) ts = scaleFor(e.target);
    if (x < -300) { x = tx; y = ty; }
    kick();
  }

  function onLeave() { ts = 0; kick(); }

  function kick() {
    idleFrames = 0;
    if (!raf) raf = requestAnimationFrame(frame);
  }

  var lastMeasure = 0;
  function frame(now) {
    raf = 0;
    var i;
    if (tiltOn && tilts.length && (dirty || now - lastMeasure > 400)) { measure(); lastMeasure = now; }

    // ball
    var dx = tx - x, dy = ty - y, ds = ts - s;
    x += dx * 0.2; y += dy * 0.2; s += ds * 0.2;
    if (Math.abs(ds) < 0.002) s = ts;
    if (enabled && ball) {
      var off = s < 0.01;
      if (off !== gone) { ball.classList.toggle('is-gone', off); gone = off; }
      if (!off) ball.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) scale(' + s.toFixed(3) + ')';
    }

    // tilt
    var tiltMoving = false;
    if (tiltOn) {
      for (i = 0; i < tilts.length; i++) {
        var t = tilts[i], b = t.rect;
        var trx = 0, try_ = 0;
        if (b && tx > b.left - t.reach && tx < b.right + t.reach && ty > b.top - t.reach && ty < b.bottom + t.reach) {
          var nx = clamp((tx - (b.left + b.width / 2)) / (b.width / 2 + t.reach), -1, 1);
          var ny = clamp((ty - (b.top + b.height / 2)) / (b.height / 2 + t.reach), -1, 1);
          try_ = nx * t.max; trx = -ny * t.max * 0.7;
        }
        t.rx += (trx - t.rx) * 0.12; t.ry += (try_ - t.ry) * 0.12;
        if (Math.abs(trx - t.rx) < 0.01) t.rx = trx;
        if (Math.abs(try_ - t.ry) < 0.01) t.ry = try_;
        if (t.rx !== t.wrx || t.ry !== t.wry) {
          t.el.style.transform = (t.rx || t.ry)
            ? 'perspective(' + t.persp + 'px) rotateX(' + t.rx.toFixed(2) + 'deg) rotateY(' + t.ry.toFixed(2) + 'deg)'
            : '';
          t.wrx = t.rx; t.wry = t.ry;
          if (t.onTilt) t.onTilt(t.rx, t.ry);
          tiltMoving = true;
        }
      }
    }

    var settled = Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3 && s === ts && !tiltMoving;
    if (settled) idleFrames++; else idleFrames = 0;
    if (idleFrames < 3) raf = requestAnimationFrame(frame);
  }

  function enable() {
    var on = fineMQ.matches && !reduceMQ.matches && !forcedMQ.matches;
    enabled = on;
    tiltOn = fineMQ.matches && !reduceMQ.matches;
    root.classList.toggle('ball-on', on);
    if (ball) ball.hidden = !on;
    if (!on) {
      tilts.forEach(function (t) { t.el.style.transform = ''; t.rx = t.ry = t.wrx = t.wry = 0; if (t.onTilt) t.onTilt(0, 0); });
    }
    dirty = true;
  }

  function init() {
    ball = document.querySelector('.ball');
    if (ball) { ball.classList.add('is-gone'); gone = true; }
    enable();
    [fineMQ, reduceMQ, forcedMQ].forEach(function (mq) { mq.addEventListener('change', function () { enable(); kick(); }); });
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', onLeave);
    window.addEventListener('blur', onLeave);
    // scrolling moves content under a still pointer: re-pick the zone (once per frame) so the ball
    // never sits full size over a jar or the bar it was not moved onto
    var scrollPick = 0;
    window.addEventListener('scroll', function () {
      dirty = true;
      if (!enabled || scrollPick || tx < -300) return;
      scrollPick = requestAnimationFrame(function () {
        scrollPick = 0;
        ts = scaleFor(document.elementFromPoint(tx, ty));
        kick();
      });
    }, { passive: true, capture: true });
    window.addEventListener('resize', function () { dirty = true; });
    if ('ResizeObserver' in window) new ResizeObserver(function () { dirty = true; }).observe(document.body);
  }

  window.CA = window.CA || {};
  window.CA.cursor = {
    init: init,
    /* kept for the pages that call them after text changes; the ball needs no per-element state */
    refresh: function () { dirty = true; },
    invalidate: function () { dirty = true; },
    /* el leans toward the pointer; its parent is measured so the tilt does not feed back */
    tilt: function (el, opts) {
      opts = opts || {};
      tilts.push({ el: el, max: opts.max || 8, reach: opts.reach == null ? 40 : opts.reach, persp: opts.perspective || 700,
        rx: 0, ry: 0, wrx: 0, wry: 0, rect: null, onTilt: opts.onTilt || null });
      dirty = true;
    }
  };
})();
