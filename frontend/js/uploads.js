/* Uploads on the Overview: forecast and daily stuffing (the supplier list is fixed; suppliers are added in Settings).
 * States per form (data-state): idle, over (drag-over), busy, done, error.
 * After a successful upload the Overview reloads the selected week. */
(function () {
  'use strict';

  var D = window.CA.data;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var NUM = window.CA.numbers;
  var CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5"/></svg>';
  var rollAt = 0;   // stagger for the figures of one result

  function fmt(n) { return NUM.format(n); }
  // TEU is shown as whole TEU, rounded up (CA.numbers.teu)
  function teu(n) { return NUM.teu(n); }
  // a number in a result: rolls in like the Overview figures (numT: a TEU figure, whole TEU)
  function numT(n, suffix) { return num(n, suffix, NUM.teuFmt); }
  function num(n, suffix, format) {
    var s = el('span');
    var v = el('span');
    s.appendChild(v);
    if (suffix) s.appendChild(document.createTextNode(suffix));
    NUM.roll(v, n, { format: format, delay: Math.min(rollAt++ * 70, 560), duration: 900 });
    return s;
  }
  function okLine(parts) {
    var p = el('p', 'drop__ok');
    p.innerHTML = CHECK;
    var t = el('span');
    parts.forEach(function (x) { t.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
    p.appendChild(t);
    return p;
  }
  function day(iso) {
    var p = iso.split('-').map(Number);
    return p[2] + ' ' + MONTHS[p[1] - 1] + ' ' + p[0];
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function row(dl, label, value, cls) {
    var d = el('div', cls || '');
    d.appendChild(el('dt', null, label));
    var dd = el('dd');
    if (value instanceof Node) dd.appendChild(value); else dd.textContent = value;
    d.appendChild(dd);
    dl.appendChild(d);
  }
  function weekLink(y, w) {
    var b = el('button', 'drop__go', 'Show W' + w);
    b.type = 'button';
    b.addEventListener('click', function () {
      if (window.CA.overview) window.CA.overview.go(y, w);
      document.getElementById('main').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
    return b;
  }

  function renderForecast(box, res, file) {
    if (D.USE_BACKEND) box.appendChild(okLine([file.name + ': ', num(res.rows), ' rows read, ', num(res.mgh_rows), ' from MGH suppliers.']));
    else {
      box.appendChild(okLine([file.name + ' accepted.']));
      box.appendChild(el('p', 'drop__demo', 'Demo mode does not read the workbook. These are the weeks already in the demo data.'));
    }
    var dl = el('dl', 'drop__ledger');
    (res.week_totals || []).forEach(function (t) {
      var v = numT(t.teu, ' TEU ');
      v.appendChild(weekLink(t.year, t.week));
      row(dl, 'W' + t.week + ' ' + t.year, v);
    });
    if (!(res.week_totals || []).length) row(dl, 'Weeks found', 'None');
    box.appendChild(el('p', 'drop__sub', (res.weeks || []).length + ' week' + ((res.weeks || []).length === 1 ? '' : 's') + ' found, TEU for MGH (FML not included)'));
    box.appendChild(dl);
    var un = res.unmatched_supplier_codes || [];
    if (un.length) {
      var w = el('div', 'drop__warn');
      w.appendChild(el('p', null, un.length + ' supplier code' + (un.length === 1 ? ' is' : 's are') + ' not on the MGH list, so ' + (un.length === 1 ? 'its rows are' : 'their rows are') + ' left out:'));
      w.appendChild(el('p', 'drop__codes', un.join(', ')));
      box.appendChild(w);
    } else {
      box.appendChild(el('p', 'drop__fine', 'Every supplier code in the file is on the MGH list.'));
    }
  }

  function renderStuffing(box, res, file) {
    if (D.USE_BACKEND) box.appendChild(okLine((res.skipped_rows || []).length ? [file.name + ': ', num(res.rows), ' rows read, ', num((res.skipped_rows || []).length), ' skipped.'] : [file.name + ': ', num(res.rows), ' rows read.']));
    else {
      box.appendChild(okLine([file.name + ' accepted.']));
      box.appendChild(el('p', 'drop__demo', 'Demo mode does not read the workbook. It books 2 TEU each for MAERSK and HAPAG on that date, plus 1 TEU on an unmapped line, with no CBM column.'));
    }
    box.appendChild(el('p', 'drop__fine', res.cbm_column_found
      ? 'CBM column found. Arrived uses it for rows that have a value.'
      : 'No CBM column in this file. Arrived is worked out as TEU x CBM per TEU.'));
    var dates = res.dates || [];
    dates.forEach(function (d) {
      var k = D.isoKeyOf(d);
      var h = el('p', 'drop__sub', day(d) + ', W' + k.week + ' ');
      h.appendChild(weekLink(k.year, k.week));
      box.appendChild(h);
      var dl = el('dl', 'drop__ledger');
      var ct = (res.carrier_teus || {})[d] || {};
      var names = Object.keys(ct);
      if (!names.length) row(dl, 'No mapped carrier', '0 TEU');
      names.forEach(function (c) { row(dl, c, numT(ct[c], ' TEU')); });
      box.appendChild(dl);
    });
    var un = res.unmapped_lines || [];
    if (un.length) {
      var w = el('div', 'drop__warn');
      w.appendChild(el('p', null, 'Shipping lines with no carrier mapping are not counted:'));
      w.appendChild(el('p', 'drop__codes', un.map(function (u) { return u.shipping_line + ' (' + teu(u.teus) + ' TEU)'; }).join(', ')));
      box.appendChild(w);
    }
  }

  var RENDER = { forecast: renderForecast, stuffing: renderStuffing };

  /* ======================= Daily stuffing: many files at once =======================
   * The stuffing export has no date column, so every file gets its own date, prefilled from the
   * file name. Files go up one at a time in date order. Styles: css/uploads-multi.css (injected
   * below; nothing in dashboard.html had to change). */

  var MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  var MRX = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?![a-z])';
  var P_ISO = /(?:^|\D)(20\d{2})[-_.\/ ](\d{1,2})[-_.\/ ](\d{1,2})(?!\d)/;
  var P_DF = new RegExp('(?:^|\\D)(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-_.,]*(?:of\\s+)?' + MRX + '(?:[\\s\\-_.,]*(\\d{4}|\\d{2})(?!\\d))?');
  var P_MF = new RegExp('(?:^|[^a-z])' + MRX + '[\\s\\-_.,]*(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:[\\s\\-_.,]+(\\d{4}|\\d{2})(?!\\d))?');
  var P_COMPACT = /(?:^|\D)(\d{8})(?!\d)/;
  var P_NUM = /(?:^|\D)(\d{1,2})[-_.\/ ](\d{1,2})[-_.\/ ](\d{4}|\d{2})(?!\d)/;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function mkIso(y, m, d) {
    y = Number(y); m = Number(m); d = Number(d);
    if (y < 2000 || y > 2099 || m < 1 || m > 12 || d < 1 || d > 31) return '';
    var t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return '';
    return y + '-' + pad2(m) + '-' + pad2(d);
  }
  function fullYear(s) {
    if (!s) return new Date().getFullYear();
    return s.length === 2 ? 2000 + Number(s) : Number(s);
  }
  // a numeric day/month pair: day first (Bangladesh) unless the first part cannot be a day-of-month-first reading
  function dayMonth(a, b, y) {
    a = Number(a); b = Number(b);
    if (b > 12 && a <= 12) return mkIso(y, a, b);       // 11-25-2026 can only be month first
    return mkIso(y, b, a);                              // otherwise day first
  }
  /* parseDateFromName('Daily stuffing 02-11-2026.xlsx') -> '2026-11-02', or '' when nothing parses.
   * Supported: 2026-11-05 / 2026_11_05 / 2026.11.05 / 2026 11 05, 20261105, 05-11-2026, 05.11.2026,
   * 5/11/26, 05112026, 5 Nov 2026, 5-Nov-26, 07-Nov-26, 5th November 2026, 5 Nov (this year),
   * Nov 5 2026, November 5th, 2026. Ambiguous dd-mm / mm-dd reads day first unless a part is > 12. */
  function parseDateFromName(name) {
    var s = String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '').toLowerCase();
    var m = s.match(P_ISO);
    if (m && mkIso(m[1], m[2], m[3])) return mkIso(m[1], m[2], m[3]);
    m = s.match(P_DF);
    if (m && mkIso(fullYear(m[3]), MON[m[2].slice(0, 3)], m[1])) return mkIso(fullYear(m[3]), MON[m[2].slice(0, 3)], m[1]);
    m = s.match(P_MF);
    if (m && mkIso(fullYear(m[3]), MON[m[1].slice(0, 3)], m[2])) return mkIso(fullYear(m[3]), MON[m[1].slice(0, 3)], m[2]);
    m = s.match(P_COMPACT);
    if (m) {
      var c = m[1];
      var a = mkIso(c.slice(0, 4), c.slice(4, 6), c.slice(6, 8));
      if (a) return a;
      var b = dayMonth(c.slice(0, 2), c.slice(2, 4), c.slice(4, 8));
      if (b) return b;
    }
    m = s.match(P_NUM);
    if (m) return dayMonth(m[1], m[2], fullYear(m[3]));
    return '';
  }

  function injectCss() {
    if (document.querySelector('link[data-multi-css]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'css/uploads-multi.css';
    l.setAttribute('data-multi-css', '');
    document.head.appendChild(l);
  }

  function isXlsx(f) { return /\.xlsx$/i.test(f.name); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function setupMulti(form, input, dateInput) {
    injectCss();
    input.multiple = true;
    var pickText = form.querySelector('.drop__pick span');
    if (pickText) pickText.textContent = 'Choose stuffing files';
    var orText = form.querySelector('.drop__or');
    if (orText) orText.textContent = 'or drop the .xlsx files here (one file per day)';
    var dateLab = form.querySelector('.drop__date label span');
    if (dateLab) dateLab.textContent = '(used for files with no date in their name)';

    var rows = [];
    var nextId = 1, busy = false, cancelled = false;
    var allowNoDate = false, ackFor = null, dupKey = '', finishedRun = false;
    var host = document.getElementById('uploads');
    var grid = host.querySelector('.up__grid');

    /* ---- DOM ---- */
    var panel = el('section', 'mu drop--stuffing');
    panel.id = 'mu';
    panel.setAttribute('aria-labelledby', 'mu-title');
    panel.setAttribute('data-ball', 'ui');
    panel.hidden = true;
    var head = el('div', 'mu__head');
    var title = el('h3', 'mu__title', 'Daily stuffing files');
    title.id = 'mu-title';
    title.tabIndex = -1;
    var clearBtn = el('button', 'mu__link', 'Clear list');
    clearBtn.type = 'button';
    head.appendChild(title);
    head.appendChild(clearBtn);
    var notice = el('p', 'mu__notice');
    notice.hidden = true;
    var list = el('ol', 'mu__list');
    list.setAttribute('aria-label', 'Stuffing files to upload');

    var opts = el('div', 'mu__opts');
    var ownDate = checkbox('mu-own', 'These files have their own date column');
    var ack = checkbox('mu-ack', 'I know: where two files share a date, the later one replaces the earlier one.');
    ack.wrap.hidden = true;
    ack.wrap.classList.add('mu__check--warn');
    opts.appendChild(ownDate.wrap);
    opts.appendChild(ack.wrap);
    var note = el('p', 'mu__note', 'A file with its own date column keeps its dates. For other files the date above is used. Uploading a date again replaces that day.');

    var actions = el('div', 'mu__actions');
    var go = el('button', 'btn btn--accent mu__go');
    go.type = 'button';
    go.setAttribute('aria-describedby', 'mu-reason');
    var cancelBtn = el('button', 'btn mu__cancel', 'Cancel remaining');
    cancelBtn.type = 'button';
    cancelBtn.hidden = true;
    var reason = el('p', 'mu__reason');
    reason.id = 'mu-reason';
    actions.appendChild(go);
    actions.appendChild(cancelBtn);
    actions.appendChild(reason);

    var live = el('p', 'sr');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    var result = el('div', 'mu__result');
    result.tabIndex = -1;
    result.setAttribute('data-ball', 'none');
    result.setAttribute('aria-label', 'Stuffing upload result');

    [head, notice, list, opts, note, actions, live, result].forEach(function (n) { panel.appendChild(n); });
    grid.parentNode.insertBefore(panel, grid.nextSibling);

    function checkbox(id, text) {
      var w = el('label', 'mu__check');
      w.htmlFor = id;
      var c = el('input');
      c.type = 'checkbox';
      c.id = id;
      w.appendChild(c);
      w.appendChild(el('span', null, text));
      return { wrap: w, box: c };
    }

    function say(t) { live.textContent = t; }
    function state(s) { form.setAttribute('data-state', s); }

    /* ---- rows ---- */
    function sortKey(r) { return r.date || '9999-99-99'; }
    function sortRows() {
      rows.sort(function (a, b) {
        var x = sortKey(a), y = sortKey(b);
        return x < y ? -1 : x > y ? 1 : a.id - b.id;
      });
    }
    function orderDom() {
      var cur = list.firstChild;
      rows.forEach(function (r) {
        if (cur === r.li) { cur = cur.nextSibling; return; }
        list.insertBefore(r.li, cur);
      });
    }

    function makeRow(file, date, src) {
      var r = { id: nextId++, file: file, date: date, src: src, status: 'waiting', msg: '', res: null };
      var li = el('li', 'mu__row');
      var line = el('div', 'mu__line');
      var name = el('span', 'mu__name', file.name);
      name.title = file.name;
      var f = el('div', 'mu__field');
      var lab = el('label', 'mu__lab', 'Date');
      var sr = el('span', 'sr', ' for ' + file.name);
      lab.appendChild(sr);
      var di = el('input', 'mu__date');
      di.type = 'date';
      di.id = 'mu-date-' + r.id;
      di.value = date || '';
      lab.htmlFor = di.id;
      di.setAttribute('aria-describedby', 'mu-warn-' + r.id);
      f.appendChild(lab);
      f.appendChild(di);
      var st = el('span', 'mu__status');
      var stText = el('span', 'mu__st');
      st.appendChild(stText);
      var rm = el('button', 'mu__rm');
      rm.type = 'button';
      rm.setAttribute('aria-label', 'Remove ' + file.name);
      rm.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
      line.appendChild(name);
      line.appendChild(f);
      line.appendChild(st);
      line.appendChild(rm);
      var warn = el('p', 'mu__warn');
      warn.id = 'mu-warn-' + r.id;
      li.appendChild(line);
      li.appendChild(warn);
      r.li = li; r.dateEl = di; r.stEl = st; r.stText = stText; r.warnEl = warn; r.rmEl = rm;

      di.addEventListener('input', function () {
        r.date = di.value;
        r.src = 'user';
        refresh();
      });
      di.addEventListener('change', function () {
        r.date = di.value;
        r.src = 'user';
        var had = document.activeElement === di;
        sortRows();
        var before = Array.prototype.indexOf.call(list.children, li);
        orderDom();
        if (had && Array.prototype.indexOf.call(list.children, li) !== before) di.focus();
        refresh();
      });
      rm.addEventListener('click', function () {
        if (busy) return;
        var i = rows.indexOf(r);
        rows.splice(i, 1);
        list.removeChild(li);
        say('Removed ' + file.name + '. ' + plural(rows.length, 'file', 'files') + ' left.');
        refresh();
        if (!rows.length) { input.focus(); return; }
        var nb = rows[Math.min(i, rows.length - 1)];
        nb.rmEl.focus();
      });
      return r;
    }

    function setStatus(r, status, msg) {
      r.status = status;
      r.msg = msg || '';
      r.li.setAttribute('data-status', status);
      r.stText.textContent = '';
      if (status === 'uploading') {
        r.stText.appendChild(el('span', 'drop__bar'));
        r.stText.appendChild(document.createTextNode('Uploading'));
      } else if (status === 'done') {
        var ic = el('span', 'mu__ic');
        ic.innerHTML = CHECK;
        r.stText.appendChild(ic);
        r.stText.appendChild(document.createTextNode(msg || 'Done'));
      } else if (status === 'error') {
        r.stText.appendChild(document.createTextNode('Error: ' + (msg || 'upload failed')));
      } else if (status === 'cancelled') {
        r.stText.appendChild(document.createTextNode('Not uploaded (cancelled)'));
      } else {
        r.stText.appendChild(document.createTextNode('Waiting'));
      }
    }

    function pending() {
      return rows.filter(function (r) { return r.status !== 'done'; });
    }

    /* flags, warnings, button state: cheap, called after every change */
    function refresh() {
      panel.hidden = !rows.length;
      var counts = {};
      rows.forEach(function (r) { if (r.date) counts[r.date] = (counts[r.date] || 0) + 1; });
      var dups = Object.keys(counts).filter(function (d) { return counts[d] > 1; }).sort();
      dupKey = dups.join(',');
      if (ackFor !== dupKey) ack.box.checked = false;
      if (!dups.length) ackFor = null;
      ack.wrap.hidden = !dups.length;
      var needs = 0;
      rows.forEach(function (r) {
        var need = !r.date && !allowNoDate && r.status !== 'done';
        var dup = !!r.date && counts[r.date] > 1;
        if (need) needs++;
        r.li.setAttribute('data-need', need ? '1' : '0');
        r.li.setAttribute('data-dup', dup ? '1' : '0');
        r.warnEl.textContent = r.status === 'done' ? '' : need ? 'This file needs a date.'
          : dup ? 'Same date as another file: the later one replaces the earlier.'
          : (!r.date && allowNoDate ? 'No date: the file must have its own date column.' : '');
        r.dateEl.disabled = busy;
        r.rmEl.disabled = busy;
      });
      var todo = pending().length;
      var failed = rows.filter(function (r) { return r.status === 'error' || r.status === 'cancelled'; }).length;
      go.textContent = '';
      go.appendChild(document.createTextNode(busy ? 'Uploading…'
        : (failed && failed === todo ? 'Retry ' + plural(todo, 'file', 'files') : 'Upload ' + plural(todo, 'file', 'files'))));
      var why = '';
      if (busy) why = 'Uploading one file at a time, in date order.';
      else if (!todo) why = 'Every file in the list is uploaded.';
      else if (needs) why = plural(needs, 'file needs', 'files need') + ' a date, or tick "These files have their own date column".';
      else if (dups.length && !(ack.box.checked && ackFor === dupKey)) why = 'Tick "I know" above: two files share a date.';
      reason.textContent = why;
      go.disabled = !!why;
      clearBtn.disabled = busy;
      ownDate.box.disabled = busy;
      ack.box.disabled = busy;
      title.textContent = rows.length === 1 ? 'Daily stuffing: 1 file' : 'Daily stuffing: ' + rows.length + ' files';
      cancelBtn.hidden = !busy;
    }

    ownDate.box.addEventListener('change', function () { allowNoDate = ownDate.box.checked; refresh(); });
    ack.box.addEventListener('change', function () { ackFor = ack.box.checked ? dupKey : null; refresh(); });
    clearBtn.addEventListener('click', function () {
      if (busy) return;
      rows.length = 0;
      finishedRun = false;
      list.textContent = '';
      result.textContent = '';
      result.hidden = true;
      notice.hidden = true;
      allowNoDate = false; ownDate.box.checked = false;
      state('idle');
      refresh();
      input.focus();
    });
    cancelBtn.addEventListener('click', function () { cancelled = true; cancelBtn.disabled = true; say('Cancelling after the current file.'); });
    if (dateInput) dateInput.addEventListener('change', function () {
      rows.forEach(function (r) {
        if (r.status === 'done' || r.src === 'name' || r.src === 'user') return;
        r.date = dateInput.value || '';
        r.src = 'box';
        r.dateEl.value = r.date;
      });
      sortRows(); orderDom(); refresh();
    });

    /* ---- adding files ---- */
    function addFiles(files) {
      if (busy || !files.length) return;
      var skipped = [], dupNames = [], added = [];
      if (finishedRun) {   // the last batch is finished: new files start a new list (its result stays until then)
        finishedRun = false;
        rows.length = 0; list.textContent = ''; result.textContent = ''; result.hidden = true;
        allowNoDate = false; ownDate.box.checked = false;
        state('idle');
      }
      files.forEach(function (f) {
        if (!isXlsx(f)) { skipped.push(f.name); return; }
        var same = rows.some(function (r) { return r.file.name === f.name && r.file.size === f.size && r.file.lastModified === f.lastModified; });
        if (same) { dupNames.push(f.name); return; }
        var d = parseDateFromName(f.name), src = 'name';
        if (!d && dateInput && dateInput.value) { d = dateInput.value; src = 'box'; }
        var r = makeRow(f, d, d ? src : 'none');
        setStatus(r, 'waiting');
        rows.push(r);
        list.appendChild(r.li);
        added.push(r);
      });
      var msgs = [];
      if (skipped.length) msgs.push('Left out, not an .xlsx file: ' + skipped.join(', ') + '.');
      if (dupNames.length) msgs.push('Already in the list: ' + dupNames.join(', ') + '.');
      notice.textContent = msgs.join(' ');
      notice.hidden = !msgs.length;
      sortRows();
      orderDom();
      refresh();
      if (!added.length) { if (msgs.length) say(msgs.join(' ')); return; }
      var needRow = rows.filter(function (r) { return !r.date && !allowNoDate && r.status !== 'done'; })[0];
      say(plural(added.length, 'file', 'files') + ' added. ' + (needRow ? 'Some need a date.' : 'Dates are filled in.'));
      if (needRow) needRow.dateEl.focus();
      else if (!go.disabled) go.focus();
      else title.focus();
    }

    /* ---- the queue ---- */
    function run() {
      if (busy || go.disabled) return;
      var queue = rows.filter(function (r) { return r.status !== 'done'; });
      if (!queue.length) return;
      busy = true; cancelled = false; cancelBtn.disabled = false;
      state('busy');
      result.textContent = '';
      result.hidden = true;
      queue.forEach(function (r) { setStatus(r, 'waiting'); });
      var total = rows.length, doneAtStart = rows.length - queue.length, ok = 0;
      refresh();
      say('Uploading ' + plural(queue.length, 'file', 'files') + '.');
      var i = 0;
      function step() {
        if (cancelled || i >= queue.length) { finish(); return; }
        var r = queue[i++];
        setStatus(r, 'uploading');
        var o = {};
        if (r.date) o.report_date = r.date;
        if (window.CA.overview) o.fallbackDate = window.CA.overview.mondayIso();
        D.upload('stuffing', r.file, o).then(function (res) {
          r.res = res;
          var ds = (res.dates || []).map(day).join(', ');
          setStatus(r, 'done', plural(res.rows == null ? 0 : res.rows, 'row', 'rows') + (ds ? ' on ' + ds : ''));
          ok++;
          say((doneAtStart + ok) + ' of ' + total + ' uploaded.');
        }, function (err) {
          setStatus(r, 'error', (err && err.message) || 'The upload failed.');
          say(r.file.name + ' failed. ' + (doneAtStart + ok) + ' of ' + total + ' uploaded.');
        }).then(function () { setTimeout(step, 0); });
      }
      function finish() {
        queue.forEach(function (r) { if (r.status === 'waiting') setStatus(r, 'cancelled'); });
        busy = false;
        finishedRun = true;
        refresh();
        var anyOk = rows.some(function (r) { return r.status === 'done'; });
        state(anyOk ? 'done' : 'error');
        renderResult();
        if (anyOk && window.CA.overview) window.CA.overview.reload();
        if (window.CA.cursor) window.CA.cursor.refresh();
        say(cancelled ? 'Cancelled. ' + (doneAtStart + ok) + ' of ' + total + ' uploaded.' : 'Finished. ' + (doneAtStart + ok) + ' of ' + total + ' uploaded.');
        result.focus();
      }
      step();
    }
    go.addEventListener('click', run);

    /* ---- one aggregate result ---- */
    function renderResult() {
      result.textContent = '';
      result.hidden = false;
      rollAt = 0;
      var done = rows.filter(function (r) { return r.status === 'done' && r.res; });
      var bad = rows.filter(function (r) { return r.status === 'error'; });
      var notRun = rows.filter(function (r) { return r.status === 'cancelled'; });
      // a file whose dates are all re-sent by a later successful file no longer counts: it was replaced
      var byDate = {}, dayCount = 0, rowsRead = 0, skippedRows = 0, cbmFiles = 0;
      var alive = done.filter(function (r, i) {
        var ds = r.res.dates || [];
        return !ds.length || ds.some(function (d) {
          return !done.slice(i + 1).some(function (o) { return (o.res.dates || []).indexOf(d) >= 0; });
        });
      });
      var unmapped = {}, weeks = {};
      done.forEach(function (r) {
        (r.res.dates || []).forEach(function (d) {
          byDate[d] = (r.res.carrier_teus || {})[d] || {};   // later file wins, as in the database
        });
      });
      alive.forEach(function (r) {
        rowsRead += Number(r.res.rows) || 0;
        skippedRows += Array.isArray(r.res.skipped_rows) ? r.res.skipped_rows.length : (Number(r.res.skipped_rows) || 0);
        if (r.res.cbm_column_found) cbmFiles++;
        (r.res.unmapped_lines || []).forEach(function (u) { unmapped[u.shipping_line] = (unmapped[u.shipping_line] || 0) + (Number(u.teus) || 0); });
      });
      var carriers = {};
      var days = Object.keys(byDate).sort();
      days.forEach(function (d) {
        var k = D.isoKeyOf(d);
        weeks[k.year + '-' + k.week] = k;
        Object.keys(byDate[d]).forEach(function (c) { carriers[c] = (carriers[c] || 0) + (Number(byDate[d][c]) || 0); });
      });
      dayCount = days.length;

      if (done.length) {
        result.appendChild(okLine([plural(done.length, 'file', 'files') + ' of ' + rows.length + ' uploaded: ', num(dayCount), dayCount === 1 ? ' day, ' : ' days, ', num(rowsRead), (rowsRead === 1 ? ' row' : ' rows') + ' read' + (skippedRows ? ', ' : '.'), skippedRows ? num(skippedRows) : '', skippedRows ? ' skipped.' : '']));
        var dl = el('dl', 'drop__ledger');
        var order = ['MAERSK', 'HAPAG', 'HELLMAN', 'ONE', 'FML'];
        var names = Object.keys(carriers).sort(function (a, b) {
          var x = order.indexOf(a), y = order.indexOf(b);
          return (x < 0 ? 99 : x) - (y < 0 ? 99 : y) || (a < b ? -1 : 1);
        });
        if (!names.length) row(dl, 'No mapped carrier', '0 TEU');
        names.forEach(function (c) { row(dl, c, numT(carriers[c], ' TEU')); });
        result.appendChild(el('p', 'drop__sub', 'TEU per carrier across the batch'));
        result.appendChild(dl);
        var wk = Object.keys(weeks).sort().map(function (k) { return weeks[k]; });
        if (wk.length) {
          var wp = el('p', 'drop__sub', 'Weeks covered: ' + wk.map(function (k) { return 'W' + k.week; }).join(', ') + ' ');
          wk.forEach(function (k) { wp.appendChild(weekLink(k.year, k.week)); });
          result.appendChild(wp);
        }
        result.appendChild(el('p', 'drop__fine', cbmFiles === 0 ? 'No CBM column in these files. Arrived is worked out as TEU x CBM per TEU.'
          : cbmFiles === alive.length ? 'CBM column found in every file. Arrived uses it for rows that have a value.'
          : 'CBM column found in ' + cbmFiles + ' of ' + alive.length + ' files. Arrived uses it for rows that have a value.'));
        var un = Object.keys(unmapped);
        if (un.length) {
          var w = el('div', 'drop__warn');
          w.appendChild(el('p', null, 'Shipping lines with no carrier mapping are not counted:'));
          w.appendChild(el('p', 'drop__codes', un.map(function (u) { return u + ' (' + teu(unmapped[u]) + ' TEU)'; }).join(', ')));
          result.appendChild(w);
        }
      }
      if (bad.length || notRun.length) {
        var f = el('div', 'drop__warn mu__failed');
        if (bad.length) {
          f.appendChild(el('p', null, plural(bad.length, 'file failed', 'files failed') + '. Nothing was changed for ' + (bad.length === 1 ? 'it' : 'them') + ':'));
          var ul = el('ul', 'mu__faillist');
          bad.forEach(function (r) { ul.appendChild(el('li', null, r.file.name + ': ' + r.msg)); });
          f.appendChild(ul);
        }
        if (notRun.length) f.appendChild(el('p', null, plural(notRun.length, 'file was', 'files were') + ' not uploaded (cancelled).'));
        f.appendChild(el('p', 'drop__fine', 'Fix the date or the file, then use the button above to retry only these.'));
        result.appendChild(f);
      }
    }

    /* ---- input and drop wiring ---- */
    return {
      add: function (list) { addFiles(list); },
      isBusy: function () { return busy; }
    };
  }

  function setup(form) {
    var kind = form.getAttribute('data-kind');
    var input = form.querySelector('.drop__input');
    var box = form.querySelector('.drop__status');
    var dateInput = form.querySelector('input[type="date"]');
    var busy = false, depth = 0, before = 'idle';
    var multi = kind === 'stuffing' ? setupMulti(form, input, dateInput) : null;
    if (kind === 'stuffing') {
      // one line for people who would rather type a day than upload a file
      var typed = el('p', 'drop__note drop__typed');
      typed.setAttribute('data-ink', '');
      typed.appendChild(document.createTextNode('Or type a day’s rows in Data entry › '));
      var typedLink = el('a', null, 'Daily stuffing');
      typedLink.href = 'stuffing.html';
      typedLink.setAttribute('data-nav', 'stuffing');
      typed.appendChild(typedLink);
      var note = form.querySelector('.drop__note');
      if (note) note.insertAdjacentElement('afterend', typed);
    }

    function state(s) { form.setAttribute('data-state', s); }
    state('idle');

    function send(file) {
      if (!file || busy) return;
      busy = true;
      state('busy');
      box.textContent = '';
      box.appendChild(el('span', 'drop__bar'));
      box.appendChild(el('p', 'drop__ok', 'Uploading ' + file.name + '…'));
      var opts = {};
      if (dateInput && dateInput.value) opts.report_date = dateInput.value;
      if (kind === 'stuffing' && window.CA.overview) opts.fallbackDate = window.CA.overview.mondayIso();
      D.upload(kind, file, opts).then(function (res) {
        busy = false;
        state('done');
        box.textContent = '';
        rollAt = 0;
        RENDER[kind](box, res, file);
        if (window.CA.overview) window.CA.overview.reload();
        if (window.CA.cursor) window.CA.cursor.refresh();
      }, function (err) {
        busy = false;
        state('error');
        box.textContent = '';
        box.appendChild(el('p', 'drop__err', (err && err.message) || 'The upload failed.'));
        box.appendChild(el('p', 'drop__fine', 'Nothing was changed. Choose another file to try again.'));
        if (window.CA.cursor) window.CA.cursor.refresh();
      });
      input.value = '';
    }

    function isBusy() { return multi ? multi.isBusy() : busy; }
    input.addEventListener('change', function () {
      if (multi) { var picked = Array.prototype.slice.call(input.files || []); input.value = ''; multi.add(picked); return; }
      send(input.files && input.files[0]);
    });
    // the whole dashed field opens the picker (the button is the keyboard path)
    form.querySelector('.drop__zone').addEventListener('click', function (e) {
      if (e.target.closest('label, input') || isBusy()) return;
      input.click();
    });
    form.addEventListener('submit', function (e) { e.preventDefault(); });

    form.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return;
      e.preventDefault();
      if (depth++ === 0 && !isBusy()) { before = form.getAttribute('data-state'); state('over'); }
    });
    form.addEventListener('dragover', function (e) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = isBusy() ? 'none' : 'copy'; });
    form.addEventListener('dragleave', function () {
      if (--depth <= 0) { depth = 0; if (!isBusy()) state(before); }
    });
    form.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      if (multi) {
        var all = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
        if (!isBusy()) state(before);
        multi.add(all);
        return;
      }
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) send(f); else state(before);
    });
  }

  // a file dropped next to a target must not navigate away from the page
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  Array.prototype.forEach.call(document.querySelectorAll('.drop'), setup);
})();
