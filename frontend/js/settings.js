/* Settings: GET/PUT /config and GET/POST/DELETE /suppliers.
 * Config PUT is a merge: numbers and the split replace; line_map entries merge, a null value
 * deletes one. The split must have all four carriers and total 100 (checked here live, and again
 * by the backend). Suppliers save at once: POST /suppliers/{code} {name, cw_code}, DELETE /suppliers/{code}. */
(function () {
  'use strict';

  var P = window.CA.page, API = window.CA.api, SH = window.CA.shell, D = window.CA.data;
  var $ = P.$, el = P.el, fmt = P.fmt;
  var SPLIT = ['MAERSK', 'HAPAG', 'HELLMAN', 'ONE'];
  var TARGETS = ['MAERSK', 'HAPAG', 'HELLMAN', 'ONE', 'FML'];

  var main = $('#main'), form = $('#cfg');
  var cfg = null;              // as saved
  var lm = [];                 // [{key, orig, carrier, isNew, del, row}]
  var saving = false;

  /* ---------- split inputs ---------- */
  var splitIn = {};
  SPLIT.forEach(function (c) {
    var f = el('div', 'field');
    f.setAttribute('data-carrier', c);
    var lab = el('label'); lab.htmlFor = 'sp-' + c;
    lab.appendChild(P.carrierLabel(c, 1));
    var inp = el('input', 'big'); inp.type = 'text'; inp.id = 'sp-' + c;
    inp.setAttribute('aria-describedby', 'split-total');
    P.numericField(inp, { max: 100 });
    inp.addEventListener('input', changed);
    f.appendChild(lab); f.appendChild(inp);
    $('#split').appendChild(f);
    splitIn[c] = inp;
    var seg = el('i'); seg.setAttribute('data-carrier', c); seg.id = 'seg-' + c;
    $('#split-bar').appendChild(seg);
  });
  ['#c-uplift', '#c-cbm', '#c-fml'].forEach(function (s) {
    P.numericField($(s), { min: s === '#c-uplift' ? -99 : 0 });
    $(s).addEventListener('input', changed);
  });
  // uplift may be negative: allow one leading minus there
  $('#c-uplift').addEventListener('beforeinput', function (e) { if (e.data === '-') e.stopImmediatePropagation(); }, true);

  function num(s) {
    s = String(s || '').trim().replace(',', '.');
    if (s === '') return null;
    if (!/^-?\d*\.?\d*$/.test(s) || s === '.' || s === '-') return NaN;
    return parseFloat(s);
  }

  /* ---------- shipping lines ---------- */
  var XSVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8.5h4.8l.6-8.5"/></svg>';
  var UNDO = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4 3 6.5 5.5 9"/><path d="M3 6.5h6.5a3.5 3.5 0 0 1 0 7H7"/></svg>';
  function carrierSelect(value, label) {
    var s = el('select', 'inp');
    s.setAttribute('aria-label', label);
    TARGETS.forEach(function (t) { var o = el('option', null, t); o.value = t; s.appendChild(o); });
    s.value = value;
    return s;
  }
  function addLine(key, carrier, isNew) {
    var item = { orig: key, carrier: carrier, isNew: !!isNew, del: false };
    var tr = el('tr'); if (isNew) tr.className = 'is-new';
    var td1 = el('td');
    if (isNew) {
      var inp = el('input', 'inp'); inp.type = 'text'; inp.placeholder = 'For example CMA CGM';
      inp.setAttribute('aria-label', 'New shipping line name');
      inp.addEventListener('input', changed);
      td1.appendChild(inp); item.input = inp;
    } else {
      var dot = el('span', 'car-dot'); dot.setAttribute('data-carrier', carrier);
      td1.appendChild(dot); td1.appendChild(document.createTextNode(key));
      item.dot = dot;
    }
    var td2 = el('td', 'sel');
    var sel = carrierSelect(carrier, 'Carrier for ' + (key || 'the new shipping line'));
    sel.addEventListener('change', function () { if (item.dot) item.dot.setAttribute('data-carrier', sel.value); changed(); });
    td2.appendChild(sel); item.select = sel;
    var td3 = el('td', 'act');
    var b = el('button', 'iconbtn'); b.type = 'button';
    function paintBtn() {
      b.innerHTML = item.del ? UNDO : XSVG;
      b.classList.toggle('iconbtn--undo', item.del);
      b.setAttribute('aria-label', (item.del ? 'Keep ' : 'Remove ') + (key || 'this new line'));
    }
    paintBtn();
    b.addEventListener('click', function () {
      if (item.isNew) { tr.remove(); lm.splice(lm.indexOf(item), 1); changed(); $('#lm-add').focus(); return; }
      item.del = !item.del; tr.classList.toggle('is-del', item.del); sel.disabled = item.del; paintBtn(); changed();
    });
    td3.appendChild(b);
    tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
    $('#lm-rows').appendChild(tr);
    item.row = tr;
    lm.push(item);
    return item;
  }
  $('#lm-add').addEventListener('click', function () { var it = addLine('', 'ONE', true); it.input.focus(); changed(); });

  /* ---------- reading + validation ---------- */
  function read() {
    var errs = {}, out = {};
    var up = num($('#c-uplift').value), cb = num($('#c-cbm').value), fm = num($('#c-fml').value);
    if (up === null || isNaN(up) || up <= -100) errs.uplift = 'A number above −100.';
    if (cb === null || isNaN(cb) || cb <= 0) errs.cbm = 'A number greater than 0.';
    if (fm === null || isNaN(fm) || fm < 0) errs.fml = 'A number, 0 or more.';
    out.uplift_pct = up; out.cbm_per_teu = cb; out.fml_default = fm;
    var split = {}, sum = 0, badSplit = false;
    SPLIT.forEach(function (c) {
      var v = num(splitIn[c].value);
      if (v === null || isNaN(v) || v < 0) { badSplit = true; splitIn[c].setAttribute('aria-invalid', 'true'); v = isNaN(v) || v === null ? 0 : v; }
      else splitIn[c].setAttribute('aria-invalid', 'false');
      split[c] = v; sum += v;
    });
    out.split = split; out.sum = sum;
    if (badSplit) errs.split = 'Every share needs a number, 0 or more.';
    else if (Math.abs(sum - 100) > 1e-9) errs.split = 'The split totals ' + fmt(sum) + '. It must total exactly 100.';
    // line map patch
    var patch = {}, names = {};
    lm.forEach(function (it) {
      if (it.isNew) {
        var k = it.input.value.trim().toUpperCase();
        if (!k) { errs.lm = 'Give every new shipping line a name, or remove the row.'; return; }
        if (names[k] || (cfg && cfg.line_map[k] !== undefined && !lm.some(function (o) { return o.orig === k && o.del; }))) { errs.lm = k + ' is already in the list.'; return; }
        names[k] = 1;
        patch[k] = it.select.value;
      } else if (it.del) patch[it.orig] = null;
      else if (it.select.value !== it.carrier) patch[it.orig] = it.select.value;
    });
    out.lmPatch = patch;
    return { v: out, errs: errs };
  }
  function hint(id, err, normal) {
    var h = $(id + '-h');
    h.textContent = err || normal;
    h.className = 'hint' + (err ? ' hint--err' : '');
    $(id).setAttribute('aria-invalid', err ? 'true' : 'false');
  }

  function isDirty(r) {
    if (!cfg) return false;
    var v = r.v;
    if (v.uplift_pct !== cfg.uplift_pct || v.cbm_per_teu !== cfg.cbm_per_teu || v.fml_default !== cfg.fml_default) return true;
    if (SPLIT.some(function (c) { return v.split[c] !== cfg.split[c]; })) return true;
    return Object.keys(v.lmPatch).length > 0 || lm.some(function (it) { return it.isNew; });
  }

  function changed() {
    if (!cfg) return;
    var r = read();
    hint('#c-uplift', r.errs.uplift, 'Above −100.');
    hint('#c-cbm', r.errs.cbm, 'More than 0.');
    hint('#c-fml', r.errs.fml, 'The default when a week sets none.');
    // split total, live
    var tot = $('#split-total');
    var ok = !r.errs.split;
    tot.classList.toggle('is-ok', ok);
    tot.classList.toggle('is-bad', !ok);
    P.roll($('#split-sum'), r.v.sum, { noStagger: true, duration: 420, format: function (n) { return fmt(n) + '%'; } });
    $('#split-word').textContent = ok ? 'Totals 100' : r.errs.split;
    SPLIT.forEach(function (c) { $('#seg-' + c).style.flexGrow = Math.max(0, r.v.split[c]); });
    var dirty = isDirty(r);
    var bad = Object.keys(r.errs).length > 0;
    paintSave(dirty, bad ? (r.errs.split || r.errs.cbm || r.errs.uplift || r.errs.fml || r.errs.lm) : '');
  }

  var saveBox = $('#save'), saveBtn = $('#save-btn'), saveMsg = $('#save-msg');
  function paintSave(dirty, problem) {
    if (saving) return;
    $('#revert').hidden = !dirty;
    if (problem && dirty) {
      saveBox.setAttribute('data-state', 'error'); saveBtn.disabled = true;
      saveMsg.textContent = 'Not ready to save: ' + problem;
    } else if (dirty) {
      saveBox.setAttribute('data-state', 'dirty'); saveBtn.disabled = false;
      saveMsg.textContent = 'Unsaved changes. Saving recalculates every week.';
    } else if (saveBox.getAttribute('data-state') !== 'saved') {
      saveBox.setAttribute('data-state', 'clean'); saveBtn.disabled = true;
      saveMsg.textContent = 'No changes.';
    } else saveBtn.disabled = true;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var r = read();
    if (saving || Object.keys(r.errs).length || !isDirty(r)) return;
    var body = { uplift_pct: r.v.uplift_pct, cbm_per_teu: r.v.cbm_per_teu, fml_default: r.v.fml_default, split: r.v.split };
    if (Object.keys(r.v.lmPatch).length) body.line_map = r.v.lmPatch;
    send(body);
  });
  function send(body) {
    saving = true;
    saveBox.setAttribute('data-state', 'saving');
    saveMsg.textContent = 'Saving…';
    saveBtn.disabled = true;
    return API.putConfig(body).then(function (c) {
      saving = false;
      fill(c);
      saveBox.setAttribute('data-state', 'saved');
      saveMsg.innerHTML = P.CHECK + '<span>Saved. Every week now uses these settings.</span>';
      $('#revert').hidden = true;
      SH.say('Settings saved.');
    }, function (err) {
      saving = false;
      saveBox.setAttribute('data-state', 'error');
      // e.g. a user (not an administrator): "Not saved. Only an administrator can do this."
      saveMsg.textContent = 'Not saved. ' + sentence(err.message || 'The server did not accept the change');
      saveBtn.disabled = false;
      SH.say('Settings not saved. ' + (err.message || ''));
    });
  }
  function sentence(t) { t = String(t).trim(); return /[.!?]$/.test(t) ? t : t + '.'; }
  // test hook: lets a check send a body the form would block (the backend must reject it too)
  window.CA.settingsSend = send;

  $('#revert').addEventListener('click', function () { fill(cfg); saveBox.setAttribute('data-state', 'clean'); changed(); });
  SH.setGuard(function () { return cfg && isDirty(read()) ? 'Settings have unsaved changes.' : ''; });

  function fill(c) {
    cfg = c;
    $('#c-uplift').value = P.plain(c.uplift_pct);
    $('#c-cbm').value = P.plain(c.cbm_per_teu);
    $('#c-fml').value = P.plain(c.fml_default);
    SPLIT.forEach(function (k) { splitIn[k].value = P.plain(c.split[k]); });
    $('#lm-rows').textContent = '';
    lm = [];
    Object.keys(c.line_map).sort().forEach(function (k) { addLine(k, c.line_map[k], false); });
    changed();
    if (window.CA.cursor) window.CA.cursor.refresh();
  }

  /* ---------- suppliers ---------- */
  var sups = [];
  function renderSups() {
    var q = $('#sup-find').value.trim().toUpperCase();
    var tb = $('#sup-rows'); tb.textContent = '';
    var shown = sups.filter(function (s) { return !q || s.code.toUpperCase().indexOf(q) >= 0 || (s.name || '').toUpperCase().indexOf(q) >= 0; });
    shown.forEach(function (s) {
      var tr = el('tr');
      tr.appendChild(el('td', 'code', s.code));
      tr.appendChild(el('td', null, s.name || '—'));
      tr.appendChild(el('td', null, s.cw_code || '—'));
      var td = el('td', 'act');
      var b = el('button', 'btn btn--line btn--small', 'Remove'); b.type = 'button';
      b.setAttribute('aria-label', 'Remove supplier ' + s.code);
      var armed = 0;
      b.addEventListener('click', function () {
        if (!armed) {
          b.textContent = 'Confirm remove'; b.classList.add('is-armed');
          armed = setTimeout(function () { armed = 0; b.textContent = 'Remove'; b.classList.remove('is-armed'); }, 3500);
          return;
        }
        clearTimeout(armed); armed = 0;
        b.disabled = true; b.textContent = 'Removing…';
        API.deleteSupplier(s.code).then(function () {
          tr.classList.add('is-gone');
          setTimeout(function () { sups = sups.filter(function (x) { return x.code !== s.code; }); renderSups(); }, 280);
          supMsg('Removed ' + s.code + '. Forecast lines from it no longer count as MGH.');
        }, function (err) { b.disabled = false; b.textContent = 'Remove'; supMsg('Not removed: ' + err.message, true); });
      });
      td.appendChild(b); tr.appendChild(td);
      tb.appendChild(tr);
    });
    if (!shown.length) {
      var tr = el('tr'); var td = el('td', null, sups.length ? 'No supplier matches “' + $('#sup-find').value + '”.' : 'No suppliers yet. Add one with the form above.');
      td.colSpan = 4; tr.className = 'sup__empty'; tr.appendChild(td); tb.appendChild(tr);
    }
    P.roll($('#sup-n'), shown.length === sups.length ? sups.length : shown.length, { noStagger: true, duration: 600, format: function (n) { return shown.length === sups.length ? fmt(n) : fmt(n) + ' of ' + fmt(sups.length); } });
  }
  function supMsg(t, bad) {
    var m = $('#sup-msg');
    if (bad) { m.textContent = t; m.style.color = 'var(--red-text)'; }
    else { m.innerHTML = P.CHECK + '<span></span>'; m.querySelector('span').textContent = t; m.style.color = ''; }
  }
  $('#sup-find').addEventListener('input', renderSups);
  $('#sup-add').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = $('#s-code').value.trim();
    if (!code) { $('#s-code').setAttribute('aria-invalid', 'true'); supMsg('A supplier code is needed.', true); $('#s-code').focus(); return; }
    if (code.toLowerCase() === 'upload') { supMsg('“upload” cannot be used as a code.', true); return; }
    $('#s-code').setAttribute('aria-invalid', 'false');
    var exists = sups.some(function (s) { return s.code.toUpperCase() === code.toUpperCase(); });
    $('#s-btn').disabled = true;
    API.putSupplier(code, $('#s-name').value.trim(), $('#s-cw').value.trim()).then(function (s) {
      $('#s-btn').disabled = false;
      sups = sups.filter(function (x) { return x.code !== s.code; }).concat([s]).sort(function (a, b) { return a.code < b.code ? -1 : 1; });
      $('#s-code').value = ''; $('#s-name').value = ''; $('#s-cw').value = '';
      renderSups();
      supMsg((exists ? 'Updated ' : 'Added ') + s.code + '. Its forecast lines count as MGH from now on.');
      $('#s-code').focus();
    }, function (err) { $('#s-btn').disabled = false; supMsg('Not saved: ' + err.message, true); });
  });

  /* ---------- load ---------- */
  function load() {
    main.setAttribute('data-state', 'loading');
    $('#err').hidden = true;
    P.pop($('#title'), [{ em: 'Settings' }, ' for every week']);
    Promise.all([API.getConfig(), API.getSuppliers()]).then(function (out) {
      main.setAttribute('data-state', 'ready'); main.setAttribute('aria-busy', 'false');
      form.hidden = false; $('#sup').hidden = false;
      fill(out[0]);
      sups = out[1];
      renderSups();
    }, function (err) {
      main.setAttribute('data-state', 'error'); main.setAttribute('aria-busy', 'false');
      form.hidden = true; $('#sup').hidden = true;
      $('#err').hidden = false;
      $('#err-body').textContent = err.message || 'Something went wrong.';
    });
  }
  $('#retry').addEventListener('click', load);

  window.CA.cursor.init();
  load();
})();
