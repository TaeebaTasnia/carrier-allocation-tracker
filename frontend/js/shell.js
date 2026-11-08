/* Shared shell for every signed-in page: the top bar (logo, tabs with grouped menus and the
 * sliding indicator, ISO week selector, Upload files on the Overview, Sign out), the cursor ball
 * element, ISO week maths, the selected week (kept in the URL and in localStorage so it follows
 * you between pages), an unsaved-changes guard, and a polite live region.
 *
 * Use: <script src="js/shell.js" data-page="weekly"></script> as the FIRST element in <body>.
 * It writes the bar in place while the page is parsed (no flash, no layout jump).
 *
 *   CA.theme   get() -> 'dark' | 'light', set(t), toggle()   (saved in localStorage 'ca.theme';
 *              fires 'ca:themechange' on document)
 *   CA.weeks   isoWeekOf, weeksInYear, mondayOf, rangeText, shift, isoDate, todayIso
 *   CA.shell   page, week() -> {year, week}, onWeek(fn), go(year, week), say(text),
 *              setGuard(fn)  fn() returns a message while there are unsaved changes, else ''
 *              href(page)    a link to another page that keeps the week (and the dev ?api)
 */
(function () {
  'use strict';

  var script = document.currentScript;
  var PAGE = (script && script.getAttribute('data-page')) || 'overview';
  var WEEKLESS = PAGE === 'settings';

  /* ---------- ISO weeks ---------- */

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function isoWeekOf(date) {
    var d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    var day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    var y = d.getUTCFullYear();
    return { year: y, week: Math.ceil(((d - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7) };
  }
  function weeksInYear(y) { return isoWeekOf(new Date(y, 11, 28)).week; }
  function mondayOf(y, w) {
    var jan4 = new Date(Date.UTC(y, 0, 4));
    var day = jan4.getUTCDay() || 7;
    return new Date(Date.UTC(y, 0, 4 - (day - 1) + (w - 1) * 7));
  }
  function rangeText(y, w) {
    var a = mondayOf(y, w), b = new Date(a.getTime() + 6 * 86400000);
    var am = MONTHS[a.getUTCMonth()], bm = MONTHS[b.getUTCMonth()];
    if (a.getUTCFullYear() !== b.getUTCFullYear()) return a.getUTCDate() + ' ' + am + ' ' + a.getUTCFullYear() + ' to ' + b.getUTCDate() + ' ' + bm + ' ' + b.getUTCFullYear();
    if (am !== bm) return a.getUTCDate() + ' ' + am + ' to ' + b.getUTCDate() + ' ' + bm + ' ' + b.getUTCFullYear();
    return a.getUTCDate() + ' to ' + b.getUTCDate() + ' ' + bm + ' ' + b.getUTCFullYear();
  }
  function shift(y, w, n) {
    w += n;
    if (w < 1) { y -= 1; w = weeksInYear(y); }
    else if (w > weeksInYear(y)) { y += 1; w = 1; }
    return { year: y, week: w };
  }
  function isoDate(d) { return d.toISOString().slice(0, 10); }
  function todayIso() { var n = new Date(); return n.getFullYear() + '-' + ('0' + (n.getMonth() + 1)).slice(-2) + '-' + ('0' + n.getDate()).slice(-2); }

  /* ---------- theme (dark default, light on html[data-theme="light"]) ----------
   * The inline script in each page head has already set data-theme before the first paint: the
   * saved choice (localStorage 'ca.theme'), else the system setting. Here: the toggle, following
   * the system while nothing is saved, and other tabs. A change fires 'ca:themechange' on document
   * (js/jars.js re-reads its canvas colours on it). */
  var THEME_KEY = 'ca.theme';
  var docEl = document.documentElement;
  var lightMQ = window.matchMedia ? matchMedia('(prefers-color-scheme: light)') : null;
  function savedTheme() {
    var t = null;
    try { t = localStorage.getItem(THEME_KEY); } catch (e) {}
    return t === 'light' || t === 'dark' ? t : null;
  }
  function themeNow() { return docEl.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
  if (!docEl.hasAttribute('data-theme')) docEl.setAttribute('data-theme', savedTheme() || (lightMQ && lightMQ.matches ? 'light' : 'dark'));
  function showTheme() {
    var b = document.getElementById('theme-toggle');
    if (!b) return;
    var light = themeNow() === 'light';
    b.setAttribute('aria-pressed', light ? 'true' : 'false');
    b.title = light ? 'Switch to the dark theme' : 'Switch to the light theme';
  }
  function setTheme(t, save) {
    t = t === 'light' ? 'light' : 'dark';
    if (save) { try { localStorage.setItem(THEME_KEY, t); } catch (e) {} }
    if (t === themeNow()) { showTheme(); return; }
    // one instant swap: hover/colour transitions would otherwise fade a few elements and not others
    docEl.classList.add('theme-switch');
    docEl.setAttribute('data-theme', t);
    showTheme();
    document.dispatchEvent(new CustomEvent('ca:themechange', { detail: { theme: t } }));
    requestAnimationFrame(function () { requestAnimationFrame(function () { docEl.classList.remove('theme-switch'); }); });
  }
  if (lightMQ && lightMQ.addEventListener) {
    lightMQ.addEventListener('change', function () { if (!savedTheme()) setTheme(lightMQ.matches ? 'light' : 'dark', false); });
  }
  window.addEventListener('storage', function (e) {
    if (e.key === THEME_KEY) setTheme(savedTheme() || (lightMQ && lightMQ.matches ? 'light' : 'dark'), false);
  });

  window.CA = window.CA || {};
  window.CA.theme = {
    get: themeNow,
    set: function (t) { setTheme(t, true); },
    toggle: function () { setTheme(themeNow() === 'light' ? 'dark' : 'light', true); }
  };
  window.CA.weeks = { isoWeekOf: isoWeekOf, weeksInYear: weeksInYear, mondayOf: mondayOf, rangeText: rangeText, shift: shift, isoDate: isoDate, todayIso: todayIso, MONTHS: MONTHS };

  /* ---------- selected week: URL, then localStorage, then today ---------- */

  var params = new URLSearchParams(location.search);
  var today = isoWeekOf(new Date());
  var sel = null;
  var py = parseInt(params.get('year'), 10), pw = parseInt(params.get('week'), 10);
  if (py && pw) sel = { year: py, week: pw };
  if (!sel) {
    try { var kept = JSON.parse(localStorage.getItem('ca.week') || 'null'); if (kept && kept.year && kept.week) sel = { year: +kept.year, week: +kept.week }; } catch (e) {}
  }
  if (!sel || sel.week < 1 || sel.week > weeksInYear(sel.year)) sel = { year: today.year, week: today.week };

  /* ---------- markup ---------- */

  var PAGES = {
    overview: { href: 'dashboard.html', section: 'overview' },
    weekly: { href: 'weekly.html', section: 'entry' },
    datewise: { href: 'datewise.html', section: 'entry' },
    stuffing: { href: 'stuffing.html', section: 'entry' },
    summary: { href: 'summary.html', section: 'reports' },
    allocvsutil: { href: 'allocvsutil.html', section: 'reports' },
    export: { href: 'export.html', section: 'reports' },
    settings: { href: 'settings.html', section: 'settings' }
  };
  var SECTION = (PAGES[PAGE] || PAGES.overview).section;
  document.documentElement.setAttribute('data-section', SECTION);

  function href(page) {
    var p = PAGES[page];
    if (!p) return '#';
    return p.href + '?year=' + sel.year + '&week=' + sel.week;
  }

  var I = {
    overview: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h8M5 2.5v1.2c0 .4-.2.8-.5 1C3.6 5.4 3 6.4 3 7.5V12a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 12V7.5c0-1.1-.6-2.1-1.5-2.8-.3-.2-.5-.6-.5-1V2.5"/><path d="M3.2 9.2c1.2-.7 2.4-.7 3.6 0s2.4.7 3.6 0 1.8-.5 2.4-.2"/></svg>',
    entry: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="10" rx="1"/><path d="M2.5 6.5h11M5 2v3M11 2v3M4.5 10h1M7.5 10h1M10.5 10h1"/></svg>',
    reports: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.5L12.5 4.5v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z"/><path d="M9.5 1.5v3h3M5.5 8h5M5.5 10.5h5M5.5 13h3"/></svg>',
    settings: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6"/><circle cx="10" cy="4.5" r="1.5"/><circle cx="6" cy="11.5" r="1.5"/></svg>',
    chev: '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg>'
  };
  function cur(p) { return PAGE === p ? ' aria-current="page"' : ''; }
  function item(page, label) {
    return '<li><a class="menu__item" data-nav="' + page + '" href="' + href(page) + '"' + cur(page) + '>' + label + '</a></li>';
  }
  function soon(label) {
    return '<li><button type="button" class="menu__item" aria-disabled="true" data-soon="' + label + '">' + label + '<em>Soon</em></button></li>';
  }

  var html =
    '<div class="ball" aria-hidden="true" hidden><i class="ball__core"></i><i class="ball__grain"></i></div>' +
    '<a class="skip" href="#main">Skip to content</a>' +
    '<header class="bar" data-ball="none">' +
      '<a class="bar__brand" data-nav="overview" href="' + href('overview') + '" aria-label="MGH, Carrier Allocation and Utilization: Overview">' +
        '<img src="assets/mgh-logo-white.png" alt="" width="120" height="40"></a>' +
      '<nav class="tabs" aria-label="Sections">' +
        '<a class="tab" data-nav="overview" data-sec="overview" href="' + href('overview') + '"' + cur('overview') + '>' + I.overview + '<span>Overview</span></a>' +
        '<button class="tab tab--menu' + (SECTION === 'entry' ? ' is-current' : '') + '" data-sec="entry" type="button" aria-expanded="false" aria-controls="menu-entry" id="tab-entry">' + I.entry + '<span>Data entry</span>' + I.chev + '</button>' +
        '<button class="tab tab--menu' + (SECTION === 'reports' ? ' is-current' : '') + '" data-sec="reports" type="button" aria-expanded="false" aria-controls="menu-reports" id="tab-reports">' + I.reports + '<span>Reports</span>' + I.chev + '</button>' +
        '<a class="tab" data-nav="settings" data-sec="settings" href="' + href('settings') + '"' + cur('settings') + '>' + I.settings + '<span>Settings</span></a>' +
        '<span class="tabs__ind" aria-hidden="true"></span>' +
      '</nav>' +
      '<div class="menu" id="menu-entry" data-for="tab-entry"><ul>' +
        item('weekly', 'Weekly allocation') + item('datewise', 'Date-wise') + item('stuffing', 'Daily stuffing') +
      '</ul></div>' +
      '<div class="menu" id="menu-reports" data-for="tab-reports"><ul>' +
        item('summary', 'Weekly summary') + item('allocvsutil', 'Allocation vs Utilization') + item('export', 'Export') +
      '</ul></div>' +
      '<div class="bar__end">' +
        (WEEKLESS ? '' :
        '<div class="week" role="group" aria-labelledby="week-label">' +
          '<span id="week-label" class="sr">Selected week</span>' +
          '<button class="week__step" type="button" data-step="-1" aria-label="Previous week"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg></button>' +
          '<button class="week__now" type="button" id="week-pick"><span class="week__w" id="week-w">W' + sel.week + '</span><span class="week__y" id="week-y">' + sel.year + '</span></button>' +
          '<button class="week__step" type="button" data-step="1" aria-label="Next week"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg></button>' +
          '<label class="sr" for="week-input">Go to ISO week</label>' +
          '<input class="week__input" id="week-input" type="week" tabindex="-1">' +
        '</div>') +
        (PAGE === 'overview' ? '<a class="signout uplink" href="#uploads">Upload files</a>' : '') +
        // theme toggle: a pressed/not pressed "Light theme" switch; the glyph shows where a click goes
        '<button class="theme" type="button" id="theme-toggle" aria-pressed="false" aria-label="Light theme">' +
          '<svg class="theme__sun" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.9"/><path d="M8 1.6v1.5M8 12.9v1.5M1.6 8h1.5M12.9 8h1.5M3.5 3.5l1.05 1.05M11.45 11.45l1.05 1.05M3.5 12.5l1.05-1.05M11.45 4.55l1.05-1.05"/></svg>' +
          '<svg class="theme__moon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 10.1A5.6 5.6 0 0 1 5.9 2.8a5.6 5.6 0 1 0 7.3 7.3z"/></svg>' +
        '</button>' +
        '<button class="signout" type="button" id="signout">Sign out</button>' +
      '</div>' +
    '</header>' +
    '<p class="sr" aria-live="polite" id="live"></p>';

  if (script) script.insertAdjacentHTML('beforebegin', html);
  else document.body.insertAdjacentHTML('afterbegin', html);

  /* ---------- behaviour (after the page is parsed) ---------- */

  var listeners = [];
  var guard = null;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function say(t) {
    var live = $('#live');
    if (!live) return;
    live.textContent = '';
    setTimeout(function () { live.textContent = t; }, 30);
  }

  function pending() { return guard ? guard() : ''; }
  function okToLeave() {
    var msg = pending();
    return !msg || window.confirm(msg + '\n\nLeave without saving?');
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function showWeek() {
    var w = $('#week-w');
    if (w) {
      w.textContent = 'W' + sel.week;
      $('#week-y').textContent = sel.year;
      $('#week-pick').setAttribute('aria-label', 'Week ' + sel.week + ', ' + sel.year + ', ' + rangeText(sel.year, sel.week) + '. Choose another week');
      $('#week-input').value = sel.year + '-W' + pad2(sel.week);
    }
    if (!WEEKLESS) {
      var url = new URL(location.href);
      url.searchParams.set('year', sel.year);
      url.searchParams.set('week', sel.week);
      url.searchParams.delete('api');
      history.replaceState(history.state, '', url);
    }
    try { localStorage.setItem('ca.week', JSON.stringify(sel)); } catch (e) {}
    $$('[data-nav]').forEach(function (a) { a.setAttribute('href', href(a.getAttribute('data-nav'))); });
  }

  function go(y, w, force) {
    if (!force && y === sel.year && w === sel.week) return false;
    if (!okToLeave()) return false;
    sel = { year: y, week: w };
    showWeek();
    listeners.forEach(function (fn) { fn(sel.year, sel.week); });
    return true;
  }

  function wire() {
    /* week selector */
    $$('.week__step').forEach(function (b) {
      b.addEventListener('click', function () { var n = shift(sel.year, sel.week, +b.getAttribute('data-step')); go(n.year, n.week); });
    });
    var wk = $('.week');
    if (wk) {
      wk.addEventListener('keydown', function (e) {
        var k = e.key, n = null;
        if (k === 'ArrowLeft' || k === 'PageUp') n = shift(sel.year, sel.week, -1);
        if (k === 'ArrowRight' || k === 'PageDown') n = shift(sel.year, sel.week, 1);
        if (n) { e.preventDefault(); go(n.year, n.week); }
      });
      var input = $('#week-input');
      $('#week-pick').addEventListener('click', function () {
        try { input.showPicker(); }
        catch (err) {
          var v = window.prompt('Go to week (for example 2026-W45)', input.value);
          if (v) { input.value = v; input.dispatchEvent(new Event('change')); }
        }
      });
      input.addEventListener('change', function () {
        var m = /^(\d{4})-W(\d{1,2})$/i.exec(input.value || '');
        if (!m) return;
        var y = +m[1], w = +m[2];
        if (w >= 1 && w <= weeksInYear(y)) go(y, w);
      });
    }

    showTheme();
    $('#theme-toggle').addEventListener('click', function () { window.CA.theme.toggle(); });

    $('#signout').addEventListener('click', function () {
      if (!okToLeave()) return;
      guard = null;
      try { localStorage.removeItem('ca.signedIn'); sessionStorage.removeItem('ca.signedIn'); } catch (e) {}
      location.href = 'index.html';
    });

    // leaving with unsaved work: in-app links ask first, closing the tab gets the browser prompt
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href]');
      if (!a || a.target || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (a.getAttribute('href').charAt(0) === '#') return;
      if (pending()) {
        if (!okToLeave()) { e.preventDefault(); return; }
        guard = null;
      }
    }, true);
    window.addEventListener('beforeunload', function (e) {
      if (pending()) { e.preventDefault(); e.returnValue = ''; }
    });

    /* nav indicator */
    var tabs = $('.tabs'), ind = $('.tabs__ind');
    var activeTab = $('.tab[aria-current="page"]') || $('.tab.is-current');
    var openMenu = null;
    function moveInd(tab, hover) {
      if (!tab) { ind.style.setProperty('--iw', 0); return; }
      var span = $('span', tab), box = (span && span.offsetWidth ? span : tab);
      var tr = tabs.getBoundingClientRect(), br = (tab.querySelector('svg') || box).getBoundingClientRect();
      var er = box.getBoundingClientRect();
      var left = Math.min(br.left, er.left) - tr.left + tabs.scrollLeft;
      var right = Math.max(br.right, er.right) - tr.left + tabs.scrollLeft;
      ind.style.setProperty('--ix', left + 'px');
      ind.style.setProperty('--iw', ((right - left) / 100).toFixed(3));
      ind.setAttribute('data-sec', tab.getAttribute('data-sec') || '');
      ind.classList.toggle('is-hover', !!hover);
    }
    $$('.tab').forEach(function (t) {
      t.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse' && !openMenu) moveInd(t, t !== activeTab); });
      t.addEventListener('focus', function () { moveInd(t, t !== activeTab); });
      t.addEventListener('blur', function () { if (!openMenu) moveInd(activeTab, false); });
    });
    tabs.addEventListener('pointerleave', function () { if (!openMenu) moveInd(activeTab, false); });

    /* grouped menus (disclosure: button + aria-expanded) */
    function menuItems(m) { return $$('.menu__item', m); }
    function closeMenu(focusBack) {
      if (!openMenu) return;
      var btn = document.getElementById(openMenu.getAttribute('data-for'));
      openMenu.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
      openMenu = null;
      moveInd(activeTab, false);
      if (focusBack) btn.focus();
    }
    function openMenuFor(btn, focusFirst) {
      var m = document.getElementById(btn.getAttribute('aria-controls'));
      if (openMenu && openMenu !== m) closeMenu(false);
      var br = btn.getBoundingClientRect(), bar = $('.bar').getBoundingClientRect();
      var left = Math.max(8, Math.min(br.left - bar.left - 4, bar.width - 248));
      m.style.setProperty('--mx', left + 'px');
      m.classList.add('is-open');
      btn.setAttribute('aria-expanded', 'true');
      openMenu = m;
      moveInd(btn, true);
      if (focusFirst) { var it = menuItems(m); if (it[0]) it[0].focus(); }
    }
    $$('.tab--menu').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.getAttribute('aria-expanded') === 'true') closeMenu(false);
        else openMenuFor(btn, false);
      });
      btn.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); openMenuFor(btn, true); }
      });
    });
    $$('.menu').forEach(function (m) {
      m.addEventListener('keydown', function (e) {
        var items = menuItems(m), i = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
        else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
        else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
      });
      m.addEventListener('focusout', function (e) {
        var to = e.relatedTarget;
        if (openMenu === m && (!to || (!m.contains(to) && to.id !== m.getAttribute('data-for')))) closeMenu(false);
      });
      $$('[data-soon]', m).forEach(function (it) {
        it.addEventListener('click', function () {
          it.classList.add('is-nudged');
          say(it.getAttribute('data-soon') + ' is coming in a later phase.');
          clearTimeout(it._n);
          it._n = setTimeout(function () { it.classList.remove('is-nudged'); }, 1600);
        });
      });
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && openMenu) closeMenu(true); });
    document.addEventListener('pointerdown', function (e) {
      if (openMenu && !openMenu.contains(e.target) && !e.target.closest('.tab--menu')) closeMenu(false);
    });
    function place() { moveInd(activeTab, false); }
    window.addEventListener('resize', function () { closeMenu(false); place(); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(place);
    place();
    showWeek();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  // arriving through a cross-document view transition: the transition does the fade, not the body
  window.addEventListener('pagereveal', function (e) {
    if (e.viewTransition) document.documentElement.classList.add('vt-in');
  });

  window.CA.shell = {
    page: PAGE,
    section: SECTION,
    week: function () { return { year: sel.year, week: sel.week }; },
    onWeek: function (fn) { listeners.push(fn); },
    go: go,
    say: say,
    href: href,
    setGuard: function (fn) { guard = fn; },
    okToLeave: okToLeave
  };
})();
