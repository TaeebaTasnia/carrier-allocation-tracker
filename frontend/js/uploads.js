/* Upload on the Overview: the forecast workbook only. Daily stuffing is typed in Data entry >
 * Daily stuffing (stuffing.html); the supplier list is fixed (suppliers are added in Settings).
 * States (data-state on the form): idle, over (drag-over), busy, done, error.
 * After a successful upload the Overview reloads the selected week. */
(function () {
  'use strict';

  var D = window.CA.data;
  var NUM = window.CA.numbers;
  var CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5"/></svg>';
  var rollAt = 0;   // stagger for the figures of one result

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

  function setup(form) {
    var input = form.querySelector('.drop__input');
    var box = form.querySelector('.drop__status');
    var busy = false, depth = 0, before = 'idle';

    function state(s) { form.setAttribute('data-state', s); }
    state('idle');

    function send(file) {
      if (!file || busy) return;
      busy = true;
      state('busy');
      box.textContent = '';
      box.appendChild(el('span', 'drop__bar'));
      box.appendChild(el('p', 'drop__ok', 'Uploading ' + file.name + '…'));
      D.upload('forecast', file).then(function (res) {
        busy = false;
        state('done');
        box.textContent = '';
        rollAt = 0;
        renderForecast(box, res, file);
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

    input.addEventListener('change', function () { send(input.files && input.files[0]); });
    // the whole dashed field opens the picker (the button is the keyboard path)
    form.querySelector('.drop__zone').addEventListener('click', function (e) {
      if (e.target.closest('label, input') || busy) return;
      input.click();
    });
    form.addEventListener('submit', function (e) { e.preventDefault(); });

    form.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return;
      e.preventDefault();
      if (depth++ === 0 && !busy) { before = form.getAttribute('data-state'); state('over'); }
    });
    form.addEventListener('dragover', function (e) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = busy ? 'none' : 'copy'; });
    form.addEventListener('dragleave', function () {
      if (--depth <= 0) { depth = 0; if (!busy) state(before); }
    });
    form.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) send(f); else state(before);
    });
  }

  // a file dropped next to a target must not navigate away from the page
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  Array.prototype.forEach.call(document.querySelectorAll('.drop'), setup);
})();
