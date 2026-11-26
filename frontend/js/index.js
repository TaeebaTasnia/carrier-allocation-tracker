/* The landing (index.html): the film, the sign-in card and the dive into the dashboard.
 *
 * Sign-in is the company identity provider; the server does all of it (backend/README.md,
 * "Authentication contract"). This page only:
 *   - labels the one button "Sign in with <provider_name>" from GET /api/auth/config ("Sign in" while
 *     that loads or when it fails). A click is a page navigation to /api/auth/login (never a fetch).
 *   - index.html#enter (where the server sends the browser after sign-in): GET /api/auth/me; 200 plays
 *     the dive into dashboard.html, 401 just shows the landing (no card, no loop).
 *   - index.html?auth_error=<code> (a failed sign-in): opens the card with a short fixed message for
 *     that code, then removes the parameter from the address bar.
 *   - index.html?next=<path> (a signed-in page found no session): the button passes the path on, so
 *     after sign-in the browser lands back on that page. It is only ever handed to the server, which
 *     checks it again.
 *   - development only: when /api/auth/config says auth "off", a small note says so and the button
 *     plays the dive straight into the dashboard.
 * js/data.js (loaded first) says where the API is (CA.data.API_BASE, CA.auth).
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var overlay = $('overlay'), card = $('card'), opener = $('open-login');
  var btn = $('signin'), note = $('note');
  var video = document.querySelector('.bg');
  var A = window.CA && window.CA.auth;
  var lastFocus = null;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Reduced motion: hold the film on its first frame.
  if (reduceMotion) { video.removeAttribute('autoplay'); video.pause(); }

  /* ---- messages for ?auth_error=<code> (a fixed set; nothing from the URL is ever shown) ---- */
  var AUTH_ERRORS = {
    not_allowed: 'This account is not allowed to use the tracker. Ask an administrator.',
    inactive: 'Your account has been deactivated. Ask an administrator.',
    cancelled: 'Sign-in was cancelled.',
    failed: 'Sign-in did not work. Try again in a moment.',
    unavailable: 'Sign-in did not work. Try again in a moment.'
  };

  /* ---- ?next: the same rule as the server's safe_next (backend/app/auth.py) ---- */
  var NEXT_OK = /^\/(?![\/\\])[A-Za-z0-9\-._~!$&'()*+,;=:@%\/?#]*$/;
  function safeNext(v) {
    if (!v || v.length > 512 || !NEXT_OK.test(v)) return '';
    if (v === '/api' || /^\/api[\/?#]/.test(v)) return '';
    return v;
  }
  var query = new URLSearchParams(location.search);
  var next = safeNext(query.get('next'));

  /* ---- cinematic push-in toward the container stack, then on to the dashboard ---- */
  var NEXT_PAGE_URL = 'dashboard.html';
  var DURATION = 1100;                     // ms: a fast aerial dive onto the cargo
  var SRC_W = 1920, SRC_H = 1080;          // source video size
  var FOCUS = { x: 0.40, y: 0.39 };        // centre of the container stack, as a fraction of the video frame
  var END_ZOOM = 3.0;                      // the last part of the dive is hidden by the fade, so the 1080p softness never shows
  var PITCH = 9;                           // degrees the camera noses down by the end
  var black = $('black');
  var raf = 0, startedAt = 0, running = false;

  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };

  // where the focal point sits on screen (object-fit: cover, shifted left on tall screens so cargo stays in view)
  function geometry() {
    var vw = window.innerWidth, vh = window.innerHeight;
    var posX = vw / vh < 1 ? 0.3 : 0.5;
    video.style.objectPosition = (posX * 100) + '% 50%';
    var c = Math.max(vw / SRC_W, vh / SRC_H), w = SRC_W * c, h = SRC_H * c;
    var ox = (vw - w) * posX, oy = (vh - h) * 0.5;
    return { vw: vw, vh: vh,
             fx: clamp(ox + FOCUS.x * w, vw * .12, vw * .88),
             fy: clamp(oy + FOCUS.y * h, vh * .12, vh * .88) };
  }
  var geo = geometry();
  window.addEventListener('resize', function () { if (!running) { geo = geometry(); } });

  function render(p) {                      // p: 0..1 along the shot
    var e = Math.pow(p, 1.8);                                   // a dive: it keeps accelerating until the cut
    var s = Math.exp(Math.log(END_ZOOM) * e);                   // exponential zoom reads as constant forward speed
    var m = 1 - Math.pow(1 - clamp(p / .7, 0, 1), 2.4);         // the cargo swings to screen centre fast, then the camera drops onto it
    var tx = geo.fx + (geo.vw / 2 - geo.fx) * m, ty = geo.fy + (geo.vh / 2 - geo.fy) * m;
    var x = clamp(tx - s * geo.fx, geo.vw * (1 - s), 0), y = clamp(ty - s * geo.fy, geo.vh * (1 - s), 0);
    var pitch = PITCH * Math.pow(p, 2.2);                       // nose down, about the cargo, late in the move
    // transform + opacity only: no filters, no extra full-screen layers, nothing to repaint
    video.style.transform = 'translate3d(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px,0) scale(' + s.toFixed(4) + ') translate(' + geo.fx.toFixed(1) + 'px,' + geo.fy.toFixed(1) + 'px) rotateX(' + pitch.toFixed(2) + 'deg) translate(' + (-geo.fx).toFixed(1) + 'px,' + (-geo.fy).toFixed(1) + 'px)';
    black.style.opacity = clamp((p - .68) / .32, 0, 1).toFixed(3);   // fade to the next page's ground
  }
  function finish() { running = false; cancelAnimationFrame(raf); render(1); location.href = NEXT_PAGE_URL; }
  function tick(now) {
    var p = clamp((now - startedAt) / DURATION, 0, 1);
    render(p);
    if (p < 1) { raf = requestAnimationFrame(tick); } else { finish(); }
  }
  function startCinema() {
    if (running) return; running = true;
    geo = geometry();
    video.pause();                                   // freeze the film: nothing decodes during the dive (a big saving on integrated graphics)
    document.body.classList.add('cinema');          // card lifts away, dimming and title clear: the original film is back
    overlay.classList.remove('open'); overlay.setAttribute('aria-hidden', 'true');
    if (reduceMotion) {                              // no camera move: short fade only
      black.style.transition = 'opacity .35s'; black.style.opacity = 1; setTimeout(finish, 380); return;
    }
    setTimeout(function () {                        // let the glass clear for a beat, then the camera starts moving
      startedAt = performance.now(); raf = requestAnimationFrame(tick);
    }, 60);
    document.addEventListener('keydown', function skip(e) { if (e.key === 'Escape') { document.removeEventListener('keydown', skip); finish(); } });
  }
  // after sign-in the page is fresh: wait (briefly) for the first film frame, so the dive moves over the
  // picture and not over a black box
  function whenFilmReady(fn) {
    if (video.readyState >= 2) { fn(); return; }
    var done = false;
    function go() { if (done) return; done = true; video.removeEventListener('loadeddata', go); fn(); }
    video.addEventListener('loadeddata', go);
    setTimeout(go, 1200);
  }
  window.CA = window.CA || {};
  window.CA.cinema = { start: startCinema, seek: function (p) { document.body.classList.add('cinema'); overlay.classList.remove('open'); geo = geometry(); render(clamp(p, 0, 1)); } };
  window.addEventListener('pageshow', function (e) { if (e.persisted) location.reload(); });  // back button: never show a half-zoomed film

  /* ---- the card ---- */
  function open() {
    lastFocus = document.activeElement;
    overlay.setAttribute('aria-hidden', 'false');
    overlay.classList.add('open');
    document.body.classList.add('login-open');
    setTimeout(function () { btn.focus({ preventScroll: true }); }, 350);
  }
  function close() {
    overlay.classList.remove('open');
    document.body.classList.remove('login-open');
    overlay.setAttribute('aria-hidden', 'true');
    if (lastFocus) lastFocus.focus({ preventScroll: true });
  }
  opener.addEventListener('click', open);
  overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function (e) {
    if (!overlay.classList.contains('open')) return;
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'Tab') { e.preventDefault(); if (!btn.disabled) btn.focus(); }   // the one control: focus stays on it
  });

  // pointer-following sheen on the glass
  card.addEventListener('pointermove', function (e) {
    var r = card.getBoundingClientRect();
    card.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
    card.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
  });

  function say(text, isError) {
    note.className = isError ? 'note err' : 'note';
    note.textContent = text || '';
  }

  /* ---- the button: label from GET /api/auth/config ---- */
  var mode = '';   // 'oidc' | 'off' | '' (not known yet, or the config call failed: the server decides)
  if (A) {
    A.config().then(function (c) {
      mode = c && c.auth === 'off' ? 'off' : 'oidc';
      if (c && c.provider_name) btn.textContent = 'Sign in with ' + c.provider_name;
      if (mode === 'off' && !note.textContent) say('Sign-in is off in this development setup.');
    }, function () {});
  }
  btn.addEventListener('click', function () {
    btn.disabled = true;
    if (mode === 'off') { say(''); setTimeout(startCinema, 150); return; }
    btn.textContent = 'Signing in…';
    say('');
    location.assign(A ? A.loginUrl(next) : '/api/auth/login');
  });

  /* ---- coming back from the identity provider ---- */
  var code = query.get('auth_error');
  if (code !== null) {
    var url = new URL(location.href);
    url.searchParams.delete('auth_error');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    if (Object.prototype.hasOwnProperty.call(AUTH_ERRORS, code)) {
      say(AUTH_ERRORS[code], true);
      open();
    }
  } else if (location.hash === '#enter') {
    // drop the hash first: Back from the dashboard must not dive again
    history.replaceState(history.state, '', location.pathname + location.search);
    if (A) {
      A.me().then(function () {
        whenFilmReady(startCinema);
      }, function (err) {
        if (err && err.status === 403) { say(AUTH_ERRORS.inactive, true); open(); }
        // 401 (no session) or the server could not be asked: the landing stays as it is
      });
    }
  }
})();
