/* Daily stuffing: type (or paste) one day's stuffing rows instead of uploading the Excel report.
 * Data: GET /stuffing/dates?year&week (rows and TEU per day), GET/PUT/DELETE /stuffing/{date}.
 * PUT replaces the whole day in one go, exactly like a re-upload. Rows are the 9 portal fields plus an
 * optional CBM. TEUs auto-fill as 2 x Qty until TEUs is typed by hand (clear it to go back to auto).
 * The carrier chip uses the same rule as the backend map_line: an explicit line_map entry wins, else
 * "FML" followed by a hyphen, space or slash is FML. Anything else is not mapped and counts for no carrier.
 * Validation matches the backend: line required (max 100), TEUs required, numbers 0 or more and finite,
 * dates real calendar days, vessel names max 100, at most 500 rows. Fully blank rows are dropped on save. */
(function () {
  'use strict';

  var P = window.CA.page, API = window.CA.api, SH = window.CA.shell, W = window.CA.weeks, D = window.CA.data;
  var $ = P.$, el = P.el, CARRIERS = P.CARRIERS;
  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var DAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MAX_ROWS = 500;

  // one entry per column: key, label, kind, payload key
  var FIELDS = [
    { k: 'line', label: 'Shipping line', kind: 'text', pk: 'shipping_line', max: 100 },
    { k: 'qty', label: 'Qty', kind: 'num', pk: 'qty' },
    { k: 'teus', label: 'TEUs', kind: 'num', pk: 'teus' },
    { k: 'feeder', label: 'Feeder vessel', kind: 'text', pk: 'feeder_vessel', max: 100 },
    { k: 'fe_etd', label: 'FVSL ETD', kind: 'date', pk: 'fvsl_etd' },
    { k: 'fe_eta', label: 'FVSL ETA', kind: 'date', pk: 'fvsl_eta' },
    { k: 'mother', label: 'Mother vessel', kind: 'text', pk: 'mother_vessel', max: 100 },
    { k: 'm_etd', label: 'MVSL ETD', kind: 'date', pk: 'mvsl_etd' },
    { k: 'm_eta', label: 'MVSL ETA', kind: 'date', pk: 'mvsl_eta' },
    { k: 'cbm', label: 'CBM', kind: 'num', pk: 'cbm' }
  ];

  var main = $('#main');
  var sel = SH.week();
  var cfg = null, lineMap = {};
  var reqId = 0, dayReq = 0;
  var weekDays = [];          // [{date, rows, teus}] from /stuffing/dates
  var date = null;            // selected ISO day
  var rows = [];              // editor rows: {key, touched, els, tr}
  var seq = 0;
  var savedSig = '', savedCount = 0, saving = false, loadingDay = false, dayFailed = false, errors = [];
  var lastMsg = '';           // what #save-msg shows now, so it is only rebuilt when it changes

  /* ---------- carrier mapping (mirror of backend map_line) ---------- */
  function carrierOf(line) {
    var key = String(line || '').trim().toUpperCase();
    if (!key) return null;
    for (var k in lineMap) {
      if (Object.prototype.hasOwnProperty.call(lineMap, k) && String(k).trim().toUpperCase() === key && lineMap[k]) return lineMap[k];
    }
    return /^FML[-\s\/]/.test(key) ? 'FML' : null;
  }

  /* ---------- dates ---------- */
  function realIso(y, m, d) {
    var t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
    return y + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
  }
  /* day-first: '' -> {empty}, '05/11/2026' -> {iso:'2026-11-05'}, junk -> {bad:true} */
  function parseDay(s) {
    s = String(s == null ? '' : s).trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\s*[AP]M)?$/i, '');
    if (!s) return { empty: true };
    var m, iso = null;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/.exec(s))) iso = realIso(+m[1], +m[2], +m[3]);
    else if ((m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})$/.exec(s))) iso = realIso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
    else if ((m = /^(\d{1,2})[\s\-\/]([A-Za-z]{3,9})\.?[\s\-\/,]*(\d{4}|\d{2})$/.exec(s))) {
      var mi = MON3.indexOf(m[2].slice(0, 3).charAt(0).toUpperCase() + m[2].slice(1, 3).toLowerCase());
      if (mi >= 0) iso = realIso(m[3].length === 2 ? 2000 + +m[3] : +m[3], mi + 1, +m[1]);
    } else if (/^\d{5}$/.test(s) && +s > 20000 && +s < 80000) {
      var t = new Date(Date.UTC(1899, 11, 30) + (+s) * 86400000);
      iso = realIso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    }
    return iso ? { iso: iso } : { bad: true };
  }
  function dayLabel(iso) {
    var d = new Date(iso + 'T00:00:00Z'), i = (d.getUTCDay() + 6) % 7;
    return DAYS_LONG[i] + ' ' + d.getUTCDate() + ' ' + W.MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  /* ---------- numbers ---------- */
  function numOf(s) { var v = P.parseNum(s); return v === null ? null : (isFinite(v) ? v : NaN); }
  function autoTeus(qtyText) { var q = numOf(qtyText); return q === null || isNaN(q) ? '' : P.plain(q * 2); }

  /* ---------- the day strip ---------- */
  function paintStrip() {
    var ol = $('#days');
    ol.textContent = '';
    var today = W.todayIso();
    weekDays.forEach(function (d, i) {
      var li = el('li');
      var b = el('button', 'sf__d');
      b.type = 'button';
      b.setAttribute('data-date', d.date);
      var dt = new Date(d.date + 'T00:00:00Z');
      b.appendChild(el('span', 'sf__dn', DAYS[i] + ' ' + dt.getUTCDate()));
      b.appendChild(el('span', 'sf__dm', d.date === today ? 'Today' : MON3[dt.getUTCMonth()]));
      var f = el('span', 'sf__df');
      var num = el('b', 'sf__dt', d.rows ? P.teu(d.teus) : '0');
      f.appendChild(num); f.appendChild(el('span', 'unit', 'TEU'));
      b.appendChild(f);
      b.appendChild(el('span', 'sf__dr', d.rows === 1 ? '1 row' : d.rows + ' rows'));
      if (d.date === today) b.classList.add('is-today');
      if (d.date === date) { b.classList.add('is-sel'); b.setAttribute('aria-current', 'date'); }
      b.setAttribute('aria-label', dayLabel(d.date) + ', ' + (d.rows === 1 ? '1 row' : d.rows + ' rows') + ', ' + (d.rows ? P.teu(d.teus) : '0') + ' TEU' + (d.date === today ? ', today' : ''));
      b.addEventListener('click', function () { pick(d.date); });
      li.appendChild(b);
      ol.appendChild(li);
    });
  }

  function pick(iso) {
    if ((iso === date && !dayFailed) || saving) return;   // a day that failed to load can be retried
    if (!SH.okToLeave()) return;
    selectDay(iso);
  }

  function setUrlDate() {
    try {
      var u = new URL(location.href);
      u.searchParams.set('date', date);
      history.replaceState(history.state, '', u);
    } catch (e) {}
  }

  /* ---------- editor rows ---------- */
  function cellFor(f, r) {
    var td = el('td');
    td.setAttribute('data-label', f.label);
    var inp = el('input', 'sf__in sf__in--' + f.kind);
    inp.id = 'r' + r.key + '-' + f.k;
    var lab = el('label', 'sr', f.label); lab.htmlFor = inp.id;
    r.labs[f.k] = lab;
    if (f.kind === 'date') { inp.type = 'date'; }
    else { inp.type = 'text'; }
    if (f.kind === 'text') { inp.maxLength = 200; inp.autocomplete = 'off'; inp.spellcheck = false; }
    if (f.kind === 'num') { P.numericField(inp, { step: 1 }); inp.placeholder = f.k === 'cbm' ? '—' : '0'; }
    if (f.k === 'line') inp.placeholder = 'e.g. MAERSK';
    r.els[f.k] = inp;
    td.appendChild(lab);
    if (f.k === 'line') {
      var w = el('div', 'sf__line');
      w.appendChild(inp);
      r.chip = el('span', 'sf__chip');
      w.appendChild(r.chip);
      td.appendChild(w);
    } else if (f.k === 'teus') {
      var w2 = el('div', 'sf__teus');
      w2.appendChild(inp);
      r.auto = el('span', 'sf__auto', 'auto, 2 x Qty');
      w2.appendChild(r.auto);
      td.appendChild(w2);
    } else td.appendChild(inp);
    inp.addEventListener('input', function () { onInput(r, f.k); });
    return td;
  }

  function addRow(data, focus) {
    data = data || {};
    var r = { key: ++seq, els: {}, labs: {}, touched: !!data.touched, seen: !!data.seen };
    var tr = el('tr');
    r.tr = tr;
    // required-field errors on a new row wait until focus leaves the row (or Save is pressed)
    tr.addEventListener('focusout', function (e) {
      if (r.seen || (e.relatedTarget && tr.contains(e.relatedTarget))) return;
      r.seen = true; update();
    });
    var th = el('th', 'sf__n'); th.scope = 'row';
    r.num = el('span', null, '');
    th.appendChild(r.num);
    tr.appendChild(th);
    FIELDS.forEach(function (f) { tr.appendChild(cellFor(f, r)); });
    var td = el('td', 'sf__x');
    var x = el('button', 'iconbtn'); x.type = 'button';
    x.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8M7 7v4M9 7v4"/></svg>';
    r.rm = x;
    x.addEventListener('click', function () { removeRow(r); });
    td.appendChild(x);
    tr.appendChild(td);
    FIELDS.forEach(function (f) {
      var v = data[f.k];
      if (v == null) return;
      var inp = r.els[f.k];
      // a stored date that is not a calendar day (e.g. "TBA") stays visible as text; a date input would blank it
      if (f.kind === 'date' && v !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { inp.type = 'text'; inp.placeholder = 'dd/mm/yyyy'; inp.setAttribute('data-raw', v); }
      inp.value = v;
    });
    rows.push(r);
    $('#rows').appendChild(tr);
    renumber();
    if (!r.touched && !r.els.teus.value) r.els.teus.value = autoTeus(r.els.qty.value);
    if (focus) r.els.line.focus();
    return r;
  }

  function removeRow(r) {
    var i = rows.indexOf(r);
    if (i < 0) return;
    var next = rows[i + 1] || rows[i - 1];
    rows.splice(i, 1);
    r.tr.remove();
    renumber();
    note = null;
    update();
    SH.say('Row removed. ' + rows.length + ' left.');
    if (next) next.els.line.focus(); else $('#add').focus();
  }

  function renumber() {
    rows.forEach(function (r, i) {
      r.num.textContent = String(i + 1);
      r.rm.setAttribute('aria-label', 'Remove row ' + (i + 1));
      FIELDS.forEach(function (f) { r.labs[f.k].textContent = 'Row ' + (i + 1) + ' ' + f.label; });
    });
  }

  function onInput(r, k) {
    note = null;
    if (k === 'qty' && !r.touched) r.els.teus.value = autoTeus(r.els.qty.value);
    if (k === 'teus') {
      r.touched = r.els.teus.value.trim() !== '';
      if (!r.touched) r.els.teus.value = autoTeus(r.els.qty.value);
    }
    update();
  }

  // a stored date as ISO when it reads as a calendar day, else the original text (never dropped)
  function srvDate(s) {
    if (s == null || String(s).trim() === '') return '';
    var d = parseDay(s);
    return d.iso || String(s);
  }
  function fromServer(r) {
    var q = r.qty, t = r.teus;
    var o = {
      line: r.shipping_line, qty: q == null ? '' : P.plain(q), teus: t == null ? '' : P.plain(t),
      feeder: r.feeder_vessel || '', fe_etd: srvDate(r.fvsl_etd), fe_eta: srvDate(r.fvsl_eta),
      mother: r.mother_vessel || '', m_etd: srvDate(r.mvsl_etd), m_eta: srvDate(r.mvsl_eta),
      cbm: r.cbm == null ? '' : P.plain(r.cbm), seen: true
    };
    o.touched = !(q != null && Math.abs(t - 2 * q) < 1e-9);
    return o;
  }

  function setRows(list) {
    rows = [];
    $('#rows').textContent = '';
    list.forEach(function (o) { addRow(o); });
    savedSig = sig();
  }

  /* ---------- validation, signature, payload ---------- */
  function sig() {
    return JSON.stringify(rows.filter(function (r) { return !allEmpty(r); }).map(function (r) {
      return FIELDS.map(function (f) { return r.els[f.k].value.trim(); });
    }));
  }
  function allEmpty(r) { return FIELDS.every(function (f) { return r.els[f.k].value.trim() === ''; }); }

  function validate() {
    var errs = [], payload = [], n = 0;
    rows.forEach(function (r, i) {
      var label = 'Row ' + (i + 1);
      // soft = a required-field error on a new row nobody has left yet: blocks Save but is not announced
      function bad(k, msg, soft) {
        soft = !!soft && !r.seen;
        errs.push({ row: i + 1, k: k, soft: soft, msg: label + ', ' + FIELDS.filter(function (f) { return f.k === k; })[0].label + ': ' + msg });
        if (!soft) r.els[k].setAttribute('aria-invalid', 'true');
      }
      FIELDS.forEach(function (f) { r.els[f.k].setAttribute('aria-invalid', 'false'); });
      if (allEmpty(r)) return;
      n++;
      var o = {};
      var line = r.els.line.value.trim();
      if (!line) bad('line', 'required', true); else if (line.length > 100) bad('line', 'at most 100 characters');
      o.shipping_line = line;
      FIELDS.forEach(function (f) {
        var v = r.els[f.k].value.trim();
        if (f.kind === 'num') {
          var x = numOf(v);
          if (x !== null && isNaN(x)) bad(f.k, 'use digits only, 0 or more');
          else if (x === null && f.k === 'teus') bad('teus', 'required', true);
          o[f.pk] = x;
        } else if (f.kind === 'date') {
          var d = parseDay(v);
          var raw = r.els[f.k].getAttribute('data-raw');
          var inpEl = r.els[f.k];
          if (v === '' && inpEl.type === 'date' && inpEl.validity && inpEl.validity.badInput) bad(f.k, 'not a real date');
          else if (d.bad) bad(f.k, raw && raw.trim() === v ? 'the stored value "' + v + '" is not a date. Type a real date (day first) or clear it' : 'not a real date');
          else o[f.pk] = d.iso || null;
        } else if (f.k !== 'line') {
          if (v.length > 100) bad(f.k, 'at most 100 characters');
          o[f.pk] = v || null;
        }
      });
      payload.push(o);
    });
    if (n > MAX_ROWS) errs.push({ row: 0, k: 'rows', msg: 'A day holds at most ' + MAX_ROWS + ' rows.' });
    return { errs: errs, payload: payload };
  }

  /* ---------- live refresh of everything derived from the rows ---------- */
  function update() {
    var v = validate();
    errors = v.errs;
    var tot = {}, unmapped = {}, total = 0, unNames = [];
    CARRIERS.forEach(function (c) { tot[c] = 0; });
    var unmappedTeu = 0;
    rows.forEach(function (r) {
      var line = r.els.line.value.trim(), c = carrierOf(line);
      var t = numOf(r.els.teus.value);
      t = t === null || isNaN(t) ? 0 : t;
      total += t;
      r.chip.className = 'sf__chip';
      r.chip.removeAttribute('data-carrier');
      if (!line) { r.chip.textContent = ''; }
      else if (c) { r.chip.setAttribute('data-carrier', c); r.chip.classList.add('is-ok'); r.chip.textContent = c; tot[c] += t; }
      else {
        r.chip.classList.add('is-warn'); r.chip.textContent = 'Not mapped';
        unmappedTeu += t;
        if (unNames.indexOf(line) < 0) unNames.push(line);
      }
      var showAuto = !r.touched && r.els.teus.value !== '';
      r.auto.hidden = !showAuto;
    });
    // totals
    var sum = $('#sum');
    if (!sum.firstChild) {
      CARRIERS.concat(['unmapped', 'total']).forEach(function (k) {
        var d = el('div');
        if (CARRIERS.indexOf(k) >= 0) d.setAttribute('data-carrier', k);
        d.className = k === 'unmapped' ? 'is-unm' : k === 'total' ? 'is-tot' : 'is-car';
        d.setAttribute('data-k', k);
        var dd = el('dd'); dd.appendChild(el('span', null, '0')); dd.appendChild(el('span', 'unit', 'TEU'));
        d.appendChild(el('dt', null, k === 'unmapped' ? 'Not mapped' : k === 'total' ? 'This day' : k));
        d.appendChild(dd);
        sum.appendChild(d);
      });
    }
    function put(k, val) {
      var node = $('[data-k="' + k + '"] dd span', sum);
      if (node.getAttribute('data-v') === String(val)) return;
      node.setAttribute('data-v', String(val));
      P.roll(node, val, { format: P.teu, noStagger: true, duration: 520 });
      node.parentNode.parentNode.classList.toggle('is-zero', window.CA.numbers.teuValue(val) === 0);
    }
    CARRIERS.forEach(function (c) { put(c, tot[c]); });
    put('unmapped', unmappedTeu);
    put('total', total);
    sum.querySelector('.is-unm').hidden = unNames.length === 0;

    // unknown line warning
    var warn = $('#warn');
    if (unNames.length) {
      warn.hidden = false;
      warn.textContent = '';
      warn.appendChild(el('p', null, (unNames.length === 1 ? 'This shipping line is' : 'These shipping lines are') + ' not mapped to a carrier: ' + unNames.join(', ') + '. Their TEU counts for no carrier until you map them. '));
      var a = el('a', 'link', 'Map it in Settings');
      a.href = SH.href('settings'); a.setAttribute('data-nav', 'settings');
      warn.firstChild.appendChild(a);
      warn.firstChild.appendChild(document.createTextNode('. FML-… lines (FML followed by a hyphen, space or slash) map to FML on their own.'));
    } else warn.hidden = true;

    $('#empty').hidden = rows.length > 0 || loadingDay || dayFailed;
    $('#table').hidden = rows.length === 0;
    saveBar();
    if (window.CA.cursor && window.CA.cursor.refresh) window.CA.cursor.refresh();
  }

  function dirty() { return sig() !== savedSig; }

  // saveBar(text, state) sets a note (saved / deleted / not saved) that stays until the next edit;
  // saveBar() alone repaints. Order: saving, invalid rows, the note, unsaved changes.
  var note = null;
  function saveBar(text, state) {
    if (text !== undefined) note = text ? { text: text, state: state || 'clean' } : null;
    var btn = $('#save-btn'), del = $('#del-btn'), box = $('#save'), msg = $('#save-msg');
    var d = dirty(), bad = errors.length > 0;
    btn.disabled = saving || loadingDay || dayFailed || !d || bad;
    del.disabled = saving || loadingDay || dayFailed || savedCount === 0;
    var loud = errors.filter(function (e) { return !e.soft; });
    var st = 'clean', out = '';
    if (saving) { st = 'saving'; out = 'Saving…'; }
    else if (loud.length) { st = 'error'; out = loud[0].msg + (loud.length > 1 ? ' (and ' + (loud.length - 1) + ' more)' : '') + '. Fix it to save.'; }
    else if (bad) { st = 'dirty'; out = 'Unsaved changes. A new row needs a shipping line and TEUs before it can be saved.'; }
    else if (note) { st = note.state; out = note.text; }
    else if (d) { st = 'dirty'; out = 'Unsaved changes.'; }
    box.setAttribute('data-state', st);
    if (st + '|' + out === lastMsg) return;     // keep the live region still while nothing changed
    lastMsg = st + '|' + out;
    msg.textContent = '';
    if (st === 'saved') msg.insertAdjacentHTML('beforeend', P.CHECK);
    msg.appendChild(document.createTextNode(out));
  }

  /* ---------- load ---------- */
  function setState(s) { main.setAttribute('data-state', s); main.setAttribute('aria-busy', s === 'loading' ? 'true' : 'false'); }

  function refreshStrip() {
    var id = reqId;
    return API.stuffingWeek(sel.year, sel.week).then(function (r) {
      if (id !== reqId) return;
      weekDays = r.days; paintStrip();
    });
  }

  function renderDay(res) {
    setRows((res.rows || []).map(fromServer));
    savedCount = (res.rows || []).length;
    update();
  }

  function selectDay(iso) {
    date = iso;
    setUrlDate();
    paintStrip();
    $('#day-title').textContent = dayLabel(iso);
    $('#day-line').textContent = 'Loading…';
    var id = ++dayReq;
    loadingDay = true; dayFailed = false;
    rows = []; $('#rows').textContent = '';
    savedSig = sig(); savedCount = 0; note = null;
    $('#add').disabled = true;
    update();
    paintPreview();
    return API.stuffingDay(iso).then(function (res) {
      if (id !== dayReq) return;
      loadingDay = false;
      $('#add').disabled = false;
      renderDay(res);
      paintPreview();
      $('#day-line').textContent = savedCount ? savedCount + (savedCount === 1 ? ' row' : ' rows') + ' on file for this day.' : 'Nothing on file for this day yet.';
      setState('ready');
    }, function (err) {
      if (id !== dayReq) return;
      loadingDay = false; dayFailed = true;
      $('#day-line').textContent = '';
      $('#add').disabled = true;
      update();
      paintPreview();
      saveBar('The day did not load: ' + (err.message || 'error') + ' Click the day above to try again.', 'error');
      setState('ready');
      SH.say('The day ' + iso + ' did not load.');
    });
  }

  // agreed: the user already confirmed leaving (week change via SH.go), so do not ask again
  function load(agreed) {
    var id = ++reqId;
    sel = SH.week();
    setState('loading');
    $('#body').inert = true;     // nothing can be typed into the old week while the new one loads
    $('#err').hidden = true;
    var range = W.rangeText(sel.year, sel.week);
    P.pop($('#title'), ['Daily ', { em: 'stuffing' }]);
    P.pop($('#sub'), [range + '. Loading…']);
    Promise.all([API.stuffingWeek(sel.year, sel.week), cfg ? Promise.resolve(cfg) : API.getConfig({ demo: true })]).then(function (out) {
      if (id !== reqId) return;
      weekDays = out[0].days; cfg = out[1]; lineMap = cfg.line_map || {};
      $('#body').hidden = false;
      $('#body').inert = false;
      $('#add').disabled = loadingDay || dayFailed;
      P.pop($('#sub'), [range + '. Type or paste one day’s stuffing rows. Saving replaces that day, like uploading the day’s report again.'], { delay: 220, step: 12, dur: 520 });
      var want = new URLSearchParams(location.search).get('date');
      var dates = weekDays.map(function (d) { return d.date; });
      var today = W.todayIso();
      var pickIso = dates.indexOf(want) >= 0 ? want : dates.indexOf(today) >= 0 ? today : (weekDays.filter(function (d) { return d.rows > 0; })[0] || weekDays[0]).date;
      $('#foot-source').textContent = 'Figures in TEU unless marked CBM. Data from the backend at ' + D.API_BASE + '.';
      // rows still on screen with unsaved edits (e.g. a retry): ask before replacing them, never drop them silently
      if (!agreed && date && !loadingDay && !saving && dirty() && !SH.okToLeave()) {
        paintStrip();
        saveBar('Your unsaved rows for ' + dayLabel(date) + ' are still here. Save them, or pick a day to leave them.', 'dirty');
        setState('ready');
        return;
      }
      selectDay(pickIso);
    }, function (err) {
      if (id !== reqId) return;
      $('#body').inert = false;
      setState('error');
      $('#body').hidden = true;
      $('#err').hidden = false;
      $('#err-body').textContent = err.message || 'Something went wrong.';
      P.pop($('#sub'), [range + '.']);
      SH.say('Could not load week ' + sel.week + '. ' + (err.message || ''));
    });
  }
  $('#retry').addEventListener('click', function () { load(false); });

  /* ---------- save and delete ---------- */
  // a save or delete finished after the view moved to another day or week: unlock the bar, and refresh
  // the strip when the day belongs to the week now on screen
  function afterOtherDay(iso) {
    saveBar();
    SH.say('The change to ' + iso + ' finished.');
    if (weekDays.some(function (d) { return d.date === iso; })) refreshStrip();
  }
  function save() {
    if (saving || loadingDay || dayFailed) return;
    rows.forEach(function (r) { r.seen = true; });      // Save shows every error, including required fields
    var v = validate();
    errors = v.errs;
    if (errors.length) { saveBar(); var first = errors[0]; if (first.row) { var r0 = rows[first.row - 1]; if (r0 && r0.els[first.k]) r0.els[first.k].focus(); } return; }
    var iso = date;
    saving = true; saveBar();
    API.saveStuffingDay(iso, v.payload).then(function (res) {
      saving = false;
      if (iso !== date) { afterOtherDay(iso); return; }
      renderDay(res);
      var n = savedCount;
      saveBar('Saved ' + n + (n === 1 ? ' row' : ' rows') + ' for ' + dayLabel(iso) + '.', 'saved');
      $('#day-line').textContent = n ? n + (n === 1 ? ' row' : ' rows') + ' on file for this day.' : 'Nothing on file for this day yet.';
      SH.say('Saved ' + n + ' rows for ' + iso + '.');
      refreshStrip();
    }, function (err) {
      saving = false;
      if (iso !== date) { saveBar(); SH.say('The change to ' + iso + ' did not finish: ' + (err.message || 'error')); return; }
      saveBar('Not saved: ' + (err.message || 'error') + ' Your rows are still here.', 'error');
    });
  }

  function del() {
    if (saving || loadingDay || savedCount === 0) return;
    var iso = date;
    if (!window.confirm('Delete all ' + savedCount + ' saved row' + (savedCount === 1 ? '' : 's') + ' for ' + dayLabel(iso) + '?\n\nThis removes the day from Utilized and Arrived. It cannot be undone.')) return;
    saving = true; saveBar();
    API.deleteStuffingDay(iso).then(function (res) {
      saving = false;
      if (iso !== date) { afterOtherDay(iso); return; }
      renderDay({ rows: [] });
      saveBar('Deleted ' + res.deleted + (res.deleted === 1 ? ' row' : ' rows') + ' for ' + dayLabel(iso) + '.', 'saved');
      $('#day-line').textContent = 'Nothing on file for this day yet.';
      SH.say('Deleted the day ' + iso + '.');
      refreshStrip();
    }, function (err) {
      saving = false;
      if (iso !== date) { saveBar(); SH.say('The change to ' + iso + ' did not finish: ' + (err.message || 'error')); return; }
      saveBar('Not deleted: ' + (err.message || 'error'), 'error');
    });
  }

  $('#save-btn').addEventListener('click', save);
  $('#del-btn').addEventListener('click', del);
  $('#add').addEventListener('click', function () {
    if (loadingDay || dayFailed) return;
    if (rows.length >= MAX_ROWS) { saveBar('A day holds at most ' + MAX_ROWS + ' rows.', 'error'); return; }
    note = null; addRow({}, true); update();
  });

  /* ---------- paste from Excel ---------- */
  var pasted = [];            // parsed rows with their errors
  // a header row is only recognised by its words; any other first row is data (a bad one is flagged, not dropped)
  var HEAD_WORD = /^(shipping\s*line|line|carrier|qty|quantity|teus?|feeder(\s*vessel)?|mother(\s*vessel)?|vessel|[fm]vsl(\s*(etd|eta))?|etd|eta|cbm)$/i;
  function isHeader(cells) {
    var hits = cells.filter(function (c) { return HEAD_WORD.test(c.trim()); }).length;
    return hits >= 2 || cells.some(function (c) { return /^(qty|quantity|teus?)$/i.test(c.trim()); });
  }
  // pasted numbers: 1,234 or 1,234.5 use the comma as a thousands separator; 1,5 stays a decimal comma
  function pasteNum(raw) {
    var s = String(raw == null ? '' : raw).replace(/\s/g, '');
    if (/^[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
    return numOf(s);
  }
  function parsePaste(text) {
    var lines = text.replace(/\r\n?/g, '\n').split('\n').filter(function (l) { return l.replace(/\t/g, '').trim() !== ''; });
    var out = [];
    lines.forEach(function (ln, i) {
      var cells = ln.split('\t');
      if (i === 0 && isHeader(cells)) return;
      var o = { cells: {}, bad: {}, touched: false };
      FIELDS.forEach(function (f, j) {
        var raw = (cells[j] || '').trim();
        if (f.kind === 'num') {
          var x = pasteNum(raw);
          if (x !== null && isNaN(x)) { o.bad[f.k] = 'not a number'; o.cells[f.k] = raw; }
          else o.cells[f.k] = x === null ? '' : P.plain(x);
        } else if (f.kind === 'date') {
          var d = parseDay(raw);
          if (d.bad) { o.bad[f.k] = 'not a date'; o.cells[f.k] = raw; } else o.cells[f.k] = d.iso || '';
        } else {
          if (raw.length > 100) o.bad[f.k] = 'over 100 characters';
          o.cells[f.k] = raw;
        }
      });
      if (!o.cells.line) o.bad.line = 'line missing';
      if (o.cells.teus === '' && !o.bad.qty) { o.cells.teus = autoTeus(o.cells.qty); o.auto = true; }
      if (o.cells.teus === '') o.bad.teus = 'TEUs missing';
      o.touched = !o.auto;
      out.push(o);
    });
    return out;
  }

  function paintPreview() {
    var text = $('#paste-in').value;
    var prev = $('#prev'), msg = $('#paste-msg');
    pasted = text.trim() ? parsePaste(text) : [];
    prev.textContent = '';
    var nBad = pasted.filter(function (o) { return Object.keys(o.bad).length; }).length;
    var over = rows.length + pasted.length > MAX_ROWS;
    if (!pasted.length) {
      prev.hidden = true;
      msg.textContent = text.trim() ? 'No rows found in what you pasted.' : '';
    } else {
      prev.hidden = false;
      var wrap = el('div', 'sf__prevwrap');
      var tb = el('table', 't sf__pt');
      var cap = el('caption', 'sr', 'Preview of the pasted rows'); tb.appendChild(cap);
      var hr = el('tr');
      hr.appendChild(el('th', 'th-left', '#'));
      FIELDS.forEach(function (f) { hr.appendChild(el('th', f.kind === 'num' ? '' : 'th-left', f.label)); });
      var th = el('thead'); th.appendChild(hr); tb.appendChild(th);
      var body = el('tbody');
      pasted.slice(0, 200).forEach(function (o, i) {
        var tr = el('tr');
        if (Object.keys(o.bad).length) tr.classList.add('is-bad');
        tr.appendChild(el('th', 'sf__n', String(i + 1))).scope = 'row';
        FIELDS.forEach(function (f) {
          var td = el('td', f.kind === 'num' ? '' : 'th-left');
          var t = o.cells[f.k];
          td.textContent = t === '' ? '—' : (f.kind === 'date' && /^\d{4}-/.test(t) ? t.slice(8) + '/' + t.slice(5, 7) + '/' + t.slice(0, 4) : t);
          if (o.bad[f.k]) { td.classList.add('is-badcell'); td.title = o.bad[f.k]; td.textContent = (t === '' ? '' : t + ' ') + '(' + o.bad[f.k] + ')'; }
          if (f.k === 'teus' && o.auto) td.title = 'filled as 2 x Qty';
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });
      tb.appendChild(body);
      wrap.appendChild(tb);
      prev.appendChild(wrap);
      if (pasted.length > 200) prev.appendChild(el('p', 'hint', 'Showing the first 200 of ' + pasted.length + ' rows.'));
      msg.textContent = nBad ? nBad + (nBad === 1 ? ' row has' : ' rows have') + ' a problem (marked). Fix them in Excel and paste again.'
        : over ? 'That would make more than ' + MAX_ROWS + ' rows for the day.'
        : pasted.length + (pasted.length === 1 ? ' row' : ' rows') + ' ready. Nothing is on the day until you add them.';
    }
    var locked = loadingDay || dayFailed || !date;     // no day on screen to add to
    var ok = pasted.length > 0 && nBad === 0 && !over && !locked;
    $('#paste-add').disabled = !ok;
    $('#paste-replace').disabled = !(pasted.length > 0 && nBad === 0 && pasted.length <= MAX_ROWS && !locked);
    $('#paste-add').textContent = pasted.length ? 'Add ' + pasted.length + (pasted.length === 1 ? ' row' : ' rows') : 'Add rows';
    if (window.CA.cursor && window.CA.cursor.refresh) window.CA.cursor.refresh();
  }

  function takePaste(replace) {
    if (!pasted.length || loadingDay || dayFailed) return;
    if (replace) { rows = []; $('#rows').textContent = ''; }
    pasted.forEach(function (o) {
      var d = {}; FIELDS.forEach(function (f) { d[f.k] = o.cells[f.k]; });
      d.touched = o.touched; d.seen = true;
      addRow(d);
    });
    note = null;
    var n = pasted.length;
    $('#paste-in').value = '';
    paintPreview();
    update();
    SH.say((replace ? 'Replaced the rows with ' : 'Added ') + n + ' pasted rows. Not saved yet.');
    saveBar((replace ? 'Replaced with ' : 'Added ') + n + (n === 1 ? ' row' : ' rows') + ' from Excel. Not saved yet.', 'dirty');
  }

  $('#paste-toggle').addEventListener('click', function () {
    var open = this.getAttribute('aria-expanded') === 'true';
    this.setAttribute('aria-expanded', open ? 'false' : 'true');
    $('#paste').hidden = open;
    if (!open) $('#paste-in').focus();
  });
  $('#paste-in').addEventListener('input', paintPreview);
  $('#paste-add').addEventListener('click', function () { takePaste(false); });
  $('#paste-replace').addEventListener('click', function () { takePaste(true); });
  $('#paste-clear').addEventListener('click', function () { $('#paste-in').value = ''; paintPreview(); $('#paste-in').focus(); });

  /* ---------- guard, boot ---------- */
  SH.setGuard(function () {
    if (saving && date) return 'A save or delete for ' + dayLabel(date) + ' is still in progress. It may not have finished.';
    return !loadingDay && !dayFailed && date && dirty() ? 'The rows for ' + dayLabel(date) + ' have not been saved.' : '';
  });

  window.CA.cursor.init();
  SH.onWeek(function () { load(true); });
  load(false);
})();
