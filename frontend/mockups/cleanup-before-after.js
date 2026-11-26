/* MOCKUP ONLY, not part of the app. The chrome of cleanup-before-after.html: page tabs, the
 * Before | After | Changes switch, the theme, and the item list shown in Changes. Switching page or
 * view reloads with the new query (the copies are static, so it is instant) and keeps the scroll
 * position, so Before and After can be compared at the same spot.
 */
(function () {
  'use strict';

  var ITEMS = window.MK_ITEMS;
  var GROUPS = [['overview', 'Overview'], ['weekly', 'Weekly allocation'], ['avu', 'Allocation vs Utilization'], ['all', 'Every page']];
  var d = document.documentElement;
  var q = new URLSearchParams(location.search);
  var st = { page: d.getAttribute('data-mk-page'), view: d.getAttribute('data-mk-view'), item: parseInt(q.get('item'), 10) || 0 };
  var body = document.getElementById('mk-body'), stage = document.getElementById('mk-stage');
  var KEEP = 'ca.mock.cleanup.scroll';

  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function theme() { return d.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
  function query(o) {
    var u = new URLSearchParams(location.search);
    u.set('page', o.page); u.set('view', o.view);
    if (o.view === 'changes' && o.item) u.set('item', o.item); else u.delete('item');
    if (u.has('theme')) u.set('theme', theme());
    return location.pathname + '?' + u.toString();
  }
  function go(o, keepScroll) {
    try { sessionStorage.setItem(KEEP, keepScroll ? String(Math.round(scrollY)) : '0'); } catch (e) {}
    location.href = query(o);
  }

  /* ---------- controls ---------- */
  body.setAttribute('data-view', st.view);
  $$('.mk-seg--page button').forEach(function (b) {
    var p = b.getAttribute('data-page');
    b.setAttribute('aria-pressed', String(p === st.page));
    b.addEventListener('click', function () {
      if (p === st.page) return;
      var it = ITEMS[st.item - 1];
      go({ page: p, view: st.view, item: it && it.page === 'all' ? st.item : 0 }, false);
    });
  });
  $$('.mk-seg--view button').forEach(function (b) {
    var v = b.getAttribute('data-view');
    b.setAttribute('aria-pressed', String(v === st.view));
    b.addEventListener('click', function () { if (v !== st.view) go({ page: st.page, view: v, item: st.item }, true); });
  });
  $$('.mk-seg').forEach(function (seg) {
    seg.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      var bs = $$('button', seg), i = bs.indexOf(document.activeElement);
      if (i < 0) return;
      bs[(i + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length].click();
      e.preventDefault();
    });
  });

  var tb = document.getElementById('mk-theme');
  function showTheme() {
    var light = theme() === 'light';
    tb.setAttribute('aria-pressed', String(light));
    tb.setAttribute('aria-label', light ? 'Dark theme' : 'Light theme');
  }
  function toggleTheme() {
    var t = theme() === 'light' ? 'dark' : 'light';
    d.setAttribute('data-theme', t);
    try { localStorage.setItem('ca.mock.theme', t); } catch (e) {}
    showTheme();
    history.replaceState(null, '', query(st));
    if (window.MKS) window.MKS.redraw();
  }
  tb.addEventListener('click', toggleTheme);
  showTheme();

  /* ---------- the list (Changes) ---------- */
  var groups = document.getElementById('mk-groups');
  GROUPS.forEach(function (g) {
    var sec = document.createElement('section');
    sec.className = 'mk-group';
    var h = document.createElement('h3'); h.className = 'mk-group__t'; h.textContent = g[1];
    sec.appendChild(h);
    var ol = document.createElement('ol'); ol.className = 'mk-items';
    ITEMS.filter(function (it) { return it.page === g[0]; }).forEach(function (it) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      var here = it.page === st.page || it.page === 'all';
      b.type = 'button';
      b.className = 'mk-item' + (it.keep ? ' is-keep' : '') + (here ? ' is-here' : '');
      b.setAttribute('data-n', it.n);
      b.setAttribute('aria-current', String(it.n === st.item));
      b.innerHTML = '<span class="mk-num"></span><span class="mk-item__txt"><span class="mk-item__t"></span><span class="mk-item__a"></span></span>';
      b.querySelector('.mk-num').textContent = it.n;
      b.querySelector('.mk-item__t').textContent = it.title;
      b.querySelector('.mk-item__a').textContent = (it.keep ? '' : 'After: ') + it.after;
      b.addEventListener('click', function () {
        if (!here) { go({ page: it.page, view: 'changes', item: it.n }, false); return; }
        mark(it.n);
        if (window.MKS) window.MKS.select(it.n);
      });
      li.appendChild(b); ol.appendChild(li);
    });
    sec.appendChild(ol);
    groups.appendChild(sec);
  });
  function mark(n) {
    st.item = n;
    $$('.mk-item').forEach(function (b) { b.setAttribute('aria-current', String(+b.getAttribute('data-n') === n)); });
    history.replaceState(null, '', query(st));
  }

  // wide: the list is a column beside the page; narrow: a closed panel above it
  var box = document.getElementById('mk-list-box');
  var narrow = window.matchMedia('(max-width: 1179px)');
  function fitList() { box.open = !narrow.matches; }
  fitList();
  if (narrow.addEventListener) narrow.addEventListener('change', fitList);

  /* With the list beside it, the page column is narrower than the window the app lays out for (its
   * type and gaps follow the window width). The copy keeps the window's width and is zoomed down to
   * fit, so the outlines sit on exactly the layout Before shows. */
  function fit() {
    var on = st.view === 'changes' && !narrow.matches;
    stage.style.width = ''; stage.style.zoom = '';
    if (!on) return;
    var avail = stage.parentNode.clientWidth - document.getElementById('mk-list').offsetWidth;
    var full = document.documentElement.clientWidth;
    if (avail < full) { stage.style.width = full + 'px'; stage.style.zoom = (avail / full).toFixed(4); }
  }
  var strip = document.querySelector('.mk-strip');
  function stripH() { d.style.setProperty('--mk-strip-h', strip.offsetHeight + 'px'); }
  stripH(); fit();
  addEventListener('resize', function () { stripH(); fit(); if (window.MKS) window.MKS.redraw(); });

  /* ---------- called by the page copy ---------- */
  window.MK = {
    toggleTheme: toggleTheme,
    selected: function (n) {
      mark(n);
      var b = document.querySelector('.mk-item[data-n="' + n + '"]');
      if (b && !narrow.matches) b.scrollIntoView({ block: 'nearest' });
    }
  };
  if (window.MKS) window.MKS.redraw();

  /* ---------- scroll kept across Before / After, then the item from ?item= ---------- */
  var y = 0;
  try { y = parseInt(sessionStorage.getItem(KEEP), 10) || 0; sessionStorage.removeItem(KEEP); } catch (e) {}
  function settle() {
    if (st.view === 'changes' && st.item && window.MKS) window.MKS.select(st.item);
    else if (y) window.scrollTo(0, y);
  }
  if (document.readyState === 'complete') setTimeout(settle, 50);
  else addEventListener('load', function () { setTimeout(settle, 50); });
})();
