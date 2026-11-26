/* Data source for the dashboard.
 *
 * USE_BACKEND = false  -> demo data built in this file (shapes mirror the FastAPI JSON exactly).
 * USE_BACKEND = true   -> GET from API_BASE (the FastAPI backend, see backend/README.md).
 *
 * The demo figures are the real week 45-47 numbers from the user's workbook (forecast TEU,
 * confirmed TEU, utilized TEU, to be arrived, left, deficit/surplus). The per-day split inside
 * `daily` is illustrative only: the Overview reads the week totals, and the days are shaped so
 * every total matches what the backend would return for them.
 *
 * Shapes:
 *   getWeek(year, week)  -> GET /reports/allocation-vs-utilization?year=&week=
 *   getSummary(year)     -> GET /reports/weekly-summary?year=
 *
 * Test fixtures (query string, demo data only, local development only):
 *   ?fixture=overflow  week 45 with ONE stuffed 4 TEU over its confirmed space
 *   ?fixture=error     the request fails
 *   ?fixture=slow      the request takes 2.5 s (shows the loading state)
 *   ?fixture=uploaderror  every demo upload fails
 *
 * Upload: upload('forecast', file) -> POST /forecast/upload (the Overview's only upload; daily
 * stuffing is typed in Data entry > Daily stuffing). Demo mode answers with the same shape (mockUpload).
 *
 * Where the API is:
 *   Production: pages and API share one origin; the API is under /api (the proxy strips the prefix).
 *   Requests send the HttpOnly session cookie (credentials: 'same-origin'); scripts never see it.
 *   Local development only (the page itself is on localhost or 127.0.0.1):
 *     - pages served on port 5500 (serve_frontend.py) use the dev backend at http://127.0.0.1:8002
 *       (started with APP_ENV=dev APP_AUTH=off, see backend/README.md);
 *     - ?api=http://127.0.0.1:8001 points this tab at another local backend (kept in sessionStorage for
 *       the tab, so links between pages keep it; ?api=default clears it);
 *     - ?demo (the built-in demo weeks) and ?fixture=... (test states).
 *   On any other host name these switches are ignored, so a real site can never show demo numbers.
 *
 * Signed out / not allowed (every helper below, the same way):
 *   401 on a page load (a GET)  -> the page goes to index.html?next=<this page> and the promise stays
 *                                  pending (no error flash while it leaves). With unsaved changes on the
 *                                  page (CA.shell.hasUnsaved) it rejects instead and nothing navigates.
 *   401 on a save, upload, delete or download -> rejects (kind 'auth'): "Your session ended. Sign in
 *                                  in a new tab, then press Save again." Nothing navigates, typed rows stay.
 *   403                          -> rejects (kind 'forbidden') with the server's detail, e.g. "Only an
 *                                  administrator can do this."; the page shows it in its error line.
 *                                  The deactivated-account 403 is also remembered: the next move to the
 *                                  landing goes to index.html?auth_error=inactive instead of ?next=.
 * CA.auth: me() (GET /auth/me, once per page), config() (GET /auth/config), loginUrl(next), logout(),
 * toSignIn(), user (after me()).
 */
(function () {
  'use strict';

  var LOCAL = isLocalHost(location.hostname);
  function isLocalHost(h) { return h === 'localhost' || h === '127.0.0.1'; }
  // the test switches in the query string count only on a local development host
  var params = new URLSearchParams(LOCAL ? location.search : '');

  // Real data from the FastAPI backend. ?demo (local only) shows the built-in demo weeks instead.
  var USE_BACKEND = !params.has('demo');
  var API_BASE = LOCAL && location.port === '5500' ? 'http://127.0.0.1:8002' : '/api';
  if (LOCAL) {
    try {
      var apiParam = params.get('api');
      if (apiParam === 'default') sessionStorage.removeItem('ca.api');
      else if (apiParam && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiParam)) sessionStorage.setItem('ca.api', apiParam);
      var apiKept = sessionStorage.getItem('ca.api');
      if (apiKept) API_BASE = apiKept;
    } catch (e) {}
  }
  var TIMEOUT_MS = 8000;

  var CARRIERS = ['MAERSK', 'HAPAG', 'HELLMAN', 'ONE', 'FML'];
  var SPLIT_CARRIERS = ['MAERSK', 'HAPAG', 'HELLMAN', 'ONE'];

  // Mirrors the backend defaults (GET /config).
  var CFG = { uplift_pct: 30, cbm_per_teu: 33, split: { MAERSK: 30, HAPAG: 25, HELLMAN: 20, ONE: 25 }, fml_default: 10 };
  var BALANCE_TOL = 0.5;

  var FIXTURE = params.get('fixture') || '';

  function zeros() { var o = {}; CARRIERS.forEach(function (c) { o[c] = 0; }); return o; }
  function sum(arr) { return arr.reduce(function (a, b) { return a + b; }, 0); }

  function statusOf(d) {
    if (d < -BALANCE_TOL) return 'deficit';
    if (d > BALANCE_TOL) return 'surplus';
    return 'balanced';
  }

  /* Week inputs as the backend stores them:
   *   fcTeu:   {isoDate: forecast TEU (CBM+30% / 33)} from the MGH forecast lines
   *   stuff:   {isoDate: {carrier: stuffed TEUs}}
   *   ovr:     {isoDate: typed adjustment of that day's actual CBM} (none by default)
   *   conf:    {carrier: confirmed TEU}
   */
  var WEEKS = {
    '2026-45': {
      // forecast total 132.399505 TEU (backend golden test value, 14-supplier list of 2026-11-26)
      fcTeu: { '2026-11-02': 36.63, '2026-11-03': 33.53, '2026-11-04': 29.52, '2026-11-05': 32.719505 },
      stuff: {
        '2026-11-02': { MAERSK: 2, ONE: 6 },
        '2026-11-03': { ONE: 4 },
        '2026-11-04': { HAPAG: 4 },
        '2026-11-05': { HAPAG: 12 }
      },
      // The demo stuffing report has no CBM column, so every day's actual CBM is stuffed TEU x 33:
      // 28 TEU arrived. Week 45: forecast 132.40, confirmed 64, utilized 28, to be arrived 104.40,
      // left 36, deficit -68.40.
      ovr: {},
      conf: { MAERSK: 20, HAPAG: 24, HELLMAN: 0, ONE: 10, FML: 10 }
    },
    '2026-46': {
      // forecast total 106.913398 TEU (confirmed 70: deficit -36.91)
      fcTeu: { '2026-11-09': 27.29, '2026-11-10': 25.70, '2026-11-11': 24.12, '2026-11-12': 29.803398 },
      stuff: {}, ovr: {},
      conf: { MAERSK: 20, HAPAG: 20, HELLMAN: 10, ONE: 20, FML: 0 }
    },
    '2026-47': {
      // forecast total 72.004274 TEU (confirmed 55: deficit -17.00; it was a surplus with the 12-supplier list)
      fcTeu: { '2026-11-16': 18.67, '2026-11-17': 18.07, '2026-11-18': 16.24, '2026-11-19': 19.024274 },
      stuff: {}, ovr: {},
      conf: { MAERSK: 15, HAPAG: 20, HELLMAN: 0, ONE: 20, FML: 0 }
    }
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function inputsFor(year, week) {
    var w = WEEKS[year + '-' + week];
    w = w ? clone(w) : { fcTeu: {}, stuff: {}, ovr: {}, conf: zeros() };
    if (FIXTURE === 'overflow' && year === 2026 && week === 45) {
      w.stuff['2026-11-04'] = { HAPAG: 4, ONE: 4 };   // ONE: 14 stuffed against 10 confirmed
    }
    return w;
  }

  // Same arithmetic as backend/app/services/calc.py week_calc (unrounded).
  function weekCalc(year, week) {
    var inp = inputsFor(year, week);
    var per = CFG.cbm_per_teu;
    var fcDates = Object.keys(inp.fcTeu);
    var fcTotal = sum(fcDates.map(function (d) { return inp.fcTeu[d]; }));
    var carrierFc = {};
    SPLIT_CARRIERS.forEach(function (c) { carrierFc[c] = fcTotal * CFG.split[c] / 100; });
    carrierFc.FML = CFG.fml_default;

    var conf = {};
    CARRIERS.forEach(function (c) { conf[c] = +(inp.conf[c] || 0); });

    var dates = {};
    fcDates.concat(Object.keys(inp.stuff), Object.keys(inp.ovr)).forEach(function (d) { dates[d] = 1; });
    var daily = Object.keys(dates).sort().map(function (d) {
      var st = {};
      CARRIERS.forEach(function (c) { st[c] = +((inp.stuff[d] || {})[c] || 0); });
      var stuffed = sum(CARRIERS.map(function (c) { return st[c]; }));
      var fTeu = inp.fcTeu[d] || 0;
      var ov = Object.prototype.hasOwnProperty.call(inp.ovr, d) ? inp.ovr[d] : null;
      // Same rule as the backend: (1) a typed adjustment, else (2) the day's stuffing rows (CBM column if
      // the file had one, else TEU x CBM per TEU), else (3) 0. The demo files have no CBM column.
      var sc = inp.stuffCbm && inp.stuffCbm[d];
      var rowsN = sc ? sc.rows : CARRIERS.filter(function (c) { return st[c] > 0; }).length;
      var compCbm, compSrc;
      if (rowsN > 0 || stuffed > 0) {
        compCbm = sc ? sc.cbm + sc.teu_no_cbm * per : stuffed * per;
        compSrc = !sc || sc.rows_with_cbm === 0 ? 'stuffing_teu' : sc.rows_with_cbm === sc.rows ? 'stuffing_cbm' : 'stuffing_mixed';
      } else { compCbm = 0; compSrc = 'none'; }
      var actCbm = ov !== null ? ov : compCbm, source = ov !== null ? 'entered' : compSrc;
      var actTeu = actCbm / per;
      return {
        date: d, carrier_teus: st, stuffed_teus: stuffed,
        forecast_cbm: fTeu * per, forecast_teu: fTeu,
        actual_cbm: actCbm, actual_teu: actTeu, actual_cbm_override: ov, actual_cbm_source: source,
        actual_cbm_computed: compCbm, actual_cbm_computed_source: compSrc
      };
    });

    var utilized = {};
    CARRIERS.forEach(function (c) { utilized[c] = sum(daily.map(function (r) { return r.carrier_teus[c]; })); });
    var totalConf = sum(CARRIERS.map(function (c) { return conf[c]; }));
    var totalUtil = sum(CARRIERS.map(function (c) { return utilized[c]; }));
    var totalActual = sum(daily.map(function (r) { return r.actual_teu; }));
    var dailyFc = sum(daily.map(function (r) { return r.forecast_teu; }));
    var basis = fcDates.length ? dailyFc : fcTotal;
    var toBeArrived = Math.max(0, basis - totalActual);
    var left = totalConf - totalUtil;
    var deficit = left - toBeArrived;

    var carriers = {};
    CARRIERS.forEach(function (c) {
      carriers[c] = {
        forecast: carrierFc[c], confirmed: conf[c], utilized: utilized[c],
        left: conf[c] - utilized[c],
        pct_share: totalUtil ? utilized[c] / totalUtil * 100 : 0,
        pct_of_confirmed: conf[c] ? utilized[c] / conf[c] * 100 : null
      };
    });

    return {
      forecast_cbm_plus: fcTotal * per,
      forecast: fcTotal,
      carrier_forecast: carrierFc,
      total_confirmed: totalConf,
      total_utilized: totalUtil,
      to_be_arrived: toBeArrived,
      to_be_utilized: left,
      deficit_surplus: deficit,
      status: statusOf(deficit),
      carriers: carriers,
      daily: daily,
      total_actual_teu: totalActual,
      year: year,
      week: week
    };
  }

  function summaryRow(r) {
    var o = {};
    ['year', 'week', 'forecast', 'total_confirmed', 'total_utilized', 'to_be_arrived', 'to_be_utilized', 'deficit_surplus', 'status']
      .forEach(function (k) { o[k] = r[k]; });
    return o;
  }

  function mockSummary(year, fromWeek, toWeek) {
    var weeks = Object.keys(WEEKS)
      .map(function (k) { return k.split('-').map(Number); })
      .filter(function (p) { return p[0] === year && (fromWeek == null || p[1] >= fromWeek) && (toWeek == null || p[1] <= toWeek); })
      .map(function (p) { return p[1]; })
      .sort(function (a, b) { return a - b; });
    var rows = weeks.map(function (w) { return summaryRow(weekCalc(year, w)); });
    var keys = ['forecast', 'total_confirmed', 'total_utilized', 'to_be_arrived', 'to_be_utilized', 'deficit_surplus'];
    var total = {};
    keys.forEach(function (k) { total[k] = sum(rows.map(function (r) { return r[k]; })); });
    total.status = statusOf(total.deficit_surplus);
    return { year: year, weeks: rows, year_total: total };
  }

  function delay(ms, value, fail) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () { fail ? reject(fail) : resolve(value); }, ms);
    });
  }

  function mock(fn) {
    if (FIXTURE === 'error') {
      var e = new Error('The demo data source was set to fail (fixture=error).');
      e.kind = 'fixture';
      return delay(400, null, e);
    }
    var ms = FIXTURE === 'slow' ? 2500 : 120;
    try { return delay(ms, fn()); } catch (err) { return Promise.reject(err); }
  }

  /* ---------- talking to the API: errors, signed out, not allowed ---------- */

  var SESSION_ENDED = {
    save: 'Your session ended. Sign in in a new tab, then press Save again.',
    upload: 'Your session ended. Sign in in a new tab, then upload the file again.',
    download: 'Your session ended. Sign in in a new tab, then download again.',
    load: 'Your session ended. Sign in in a new tab, then try again.'
  };
  function fail(message, kind, status) {
    var e = new Error(message);
    e.kind = kind;
    if (status) e.status = status;
    return e;
  }
  // people see plain words; only on a local development host does the message name the API address
  function devHint() { return LOCAL ? ' (Development: is the backend at ' + API_BASE + ' running, and does it allow this page (CORS)?)' : ''; }
  function netError(err) {
    throw fail(err && err.name === 'AbortError'
      ? 'The server did not answer within ' + (TIMEOUT_MS / 1000) + ' s. Try again.' + devHint()
      : 'Could not reach the server. Check your connection and try again.' + devHint(), 'network');
  }
  function detailOf(text, status) {
    var detail = '';
    try {
      detail = JSON.parse(text).detail;
      // FastAPI validation errors: a list of {loc, msg}
      if (Array.isArray(detail)) detail = detail.map(function (d) { return (d.loc ? d.loc.slice(1).join('.') + ': ' : '') + d.msg; }).join('; ');
    } catch (x) {}
    return String(detail || ('The server answered ' + status + '.'));
  }

  /* 401 on a page load: off to the landing, which passes ?next on to the sign-in so people come back
     here. One navigation per page; the caller's promise stays pending while the page leaves. */
  var leaving = false;
  // a deactivated account gets ONE 403 with this detail (contract), then the cookie is gone and every
  // later call is a 401: remember it, so the landing says why instead of offering sign-in again
  var DEACTIVATED = 'Your account has been deactivated. Ask an administrator.';
  var deactivated = false;
  function toSignIn() {
    if (!leaving) {
      leaving = true;
      location.replace(deactivated ? 'index.html?auth_error=inactive'
        : 'index.html?next=' + encodeURIComponent(location.pathname + location.search));
    }
    return new Promise(function () {});
  }
  // a page that comes back from the back/forward cache may need to leave again
  window.addEventListener('pagehide', function () { leaving = false; });
  function hasUnsaved() {
    var SH = window.CA && window.CA.shell;
    return !!(SH && SH.hasUnsaved && SH.hasUnsaved());
  }
  // what: 'load' (a GET that fills the page), 'save', 'upload' or 'download'
  function refused(res, what) {
    if (res.status === 401) {
      if (what === 'load' && USE_BACKEND && !hasUnsaved()) return toSignIn();
      throw fail(SESSION_ENDED[what], 'auth', 401);
    }
    return res.text().then(function (t) {
      var detail = detailOf(t, res.status);
      if (res.status === 403 && detail === DEACTIVATED) deactivated = true;
      throw fail(detail, res.status === 403 ? 'forbidden' : 'http', res.status);
    });
  }
  function timed(ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    return { signal: ctrl ? ctrl.signal : undefined, timer: setTimeout(function () { if (ctrl) ctrl.abort(); }, ms) };
  }

  function getJSON(path) { return request('GET', path); }

  /* ---------- uploads ---------- */

  function uploadError(detail) {
    var e = new Error(detail);
    e.kind = 'http';
    return e;
  }

  /* The demo upload cannot read the workbook in the browser. It answers with the backend's
   * response shape for the forecast (the only upload on the Overview). */
  function mockUpload(kind, file) {
    if (!/\.xlsx$/i.test(file.name)) {
      return delay(500, null, uploadError('Cannot read ' + kind + ' file: ' + file.name + ' is not an .xlsx workbook.'));
    }
    if (FIXTURE === 'uploaderror') return delay(900, null, uploadError('Cannot read ' + kind + ' file: the demo was set to fail (fixture=uploaderror).'));
    if (kind === 'forecast') {
      var keys = Object.keys(WEEKS).filter(function (k) { return Object.keys(WEEKS[k].fcTeu).length; }).sort();
      return delay(1100, {
        rows: 0, mgh_rows: 0,   // the demo does not read the file, so it reports no rows
        weeks: keys.map(function (k) { var p = k.split('-').map(Number); return { year: p[0], week: p[1] }; }),
        unmatched_supplier_codes: [],
        week_totals: keys.map(function (k) {
          var p = k.split('-').map(Number), r = weekCalc(p[0], p[1]);
          var ct = {}; SPLIT_CARRIERS.forEach(function (c) { ct[c] = r.carrier_forecast[c]; });
          return { year: p[0], week: p[1], cbm_plus: r.forecast_cbm_plus, teu: r.forecast, carrier_teu: ct };
        })
      });
    }
    return delay(800, null, uploadError('Cannot read ' + kind + ' file: that kind of upload does not exist.'));
  }

  function postFile(path, file) {
    var fd = new FormData();
    fd.append('file', file, file.name);
    var t = timed(60000);
    return fetch(API_BASE + path, { method: 'POST', body: fd, credentials: 'same-origin', signal: t.signal })
      .then(function (res) { return res.ok ? res.json() : refused(res, 'upload'); },
        function () { throw fail('Could not reach the server, so the file was not uploaded. Check your connection and try again.' + devHint(), 'network'); })
      .finally(function () { clearTimeout(t.timer); });
  }

  function upload(kind, file) {
    if (!USE_BACKEND) return mockUpload(kind, file);
    if (kind === 'forecast') return postFile('/forecast/upload', file);
    return Promise.reject(uploadError('Cannot upload ' + kind + ': only the forecast is uploaded here. Daily stuffing is typed in Data entry > Daily stuffing.'));
  }

  /* ---------- JSON requests for the data-entry, report and settings pages (backend only) ---------- */

  function request(method, path, body) {
    var t = timed(TIMEOUT_MS);
    var init = { method: method, credentials: 'same-origin', signal: t.signal };
    if (body !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
    return fetch(API_BASE + path, init)
      .then(function (res) { return res.ok ? res.json() : refused(res, method === 'GET' ? 'load' : 'save'); }, netError)
      .finally(function () { clearTimeout(t.timer); });
  }
  /* GET a file and hand it to the browser as a download, named by Content-Disposition */
  function download(path, fallbackName) {
    return fetch(API_BASE + path, { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) return refused(res, 'download');
        var cd = res.headers.get('Content-Disposition') || '';
        var m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
        var name = m ? decodeURIComponent(m[1]) : fallbackName;
        return res.blob().then(function (b) {
          var url = URL.createObjectURL(b);
          var a = document.createElement('a');
          a.href = url; a.download = name;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
          return { name: name, size: b.size };
        });
      }, netError);
  }

  /* ---------- typed daily stuffing (GET /stuffing/dates, GET/PUT/DELETE /stuffing/{date}) ----------
   * ?demo answers from a small in-memory store with the backend's shapes (resets on reload). */
  var DEMO_STUFF = {};
  var DEMO_LINE_MAP = { MAERSK: 'MAERSK', MSK: 'MAERSK', HAPAG: 'HAPAG', 'HAPAG-LLOYD': 'HAPAG', HELLMANN: 'HELLMAN', ONE: 'ONE', ONELINE: 'ONE' };
  function demoCarrier(line) {
    var k = String(line || '').trim().toUpperCase();
    if (DEMO_LINE_MAP[k]) return DEMO_LINE_MAP[k];
    return /^FML[-\s\/]/.test(k) ? 'FML' : null;
  }
  function demoDayJson(iso) {
    var rows = (DEMO_STUFF[iso] || []).map(function (r, i) {
      var c = demoCarrier(r.shipping_line), o = clone(r);
      o.id = i + 1; o.carrier = c; o.mapped = c !== null;
      ['qty', 'cbm', 'feeder_vessel', 'mother_vessel', 'fvsl_etd', 'fvsl_eta', 'mvsl_etd', 'mvsl_eta'].forEach(function (k) { if (o[k] === undefined) o[k] = null; });
      return o;
    });
    var un = {};
    rows.forEach(function (r) { if (!r.mapped) un[r.shipping_line] = (un[r.shipping_line] || 0) + r.teus; });
    return {
      date: iso, rows: rows, total_teus: sum(rows.map(function (r) { return r.teus; })),
      unmapped_lines: Object.keys(un).map(function (k) { return { shipping_line: k, teus: un[k] }; })
    };
  }
  function stuffingWeek(y, w) {
    if (USE_BACKEND) return request('GET', '/stuffing/dates?year=' + y + '&week=' + w);
    return mock(function () {
      var mon = window.CA.weeks.mondayOf(y, w), days = [];
      for (var i = 0; i < 7; i++) {
        var iso = window.CA.weeks.isoDate(new Date(mon.getTime() + i * 86400000)), rows = DEMO_STUFF[iso] || [];
        days.push({ date: iso, rows: rows.length, teus: sum(rows.map(function (r) { return r.teus; })) });
      }
      return { year: y, week: w, days: days };
    });
  }
  function stuffingDay(iso) {
    if (USE_BACKEND) return request('GET', '/stuffing/' + iso);
    return mock(function () { return demoDayJson(iso); });
  }
  function saveStuffingDay(iso, rows) {
    if (USE_BACKEND) return request('PUT', '/stuffing/' + iso, { rows: rows });
    return mock(function () { DEMO_STUFF[iso] = clone(rows); return demoDayJson(iso); });
  }
  function deleteStuffingDay(iso) {
    if (USE_BACKEND) return request('DELETE', '/stuffing/' + iso);
    return mock(function () { var n = (DEMO_STUFF[iso] || []).length; delete DEMO_STUFF[iso]; return { date: iso, deleted: n }; });
  }

  window.CA = window.CA || {};
  window.CA.api = {
    stuffingWeek: stuffingWeek, stuffingDay: stuffingDay, saveStuffingDay: saveStuffingDay, deleteStuffingDay: deleteStuffingDay,
    getWeekly: function (y, w) { return request('GET', '/weekly/' + y + '/' + w); },
    putWeekly: function (y, w, body) { return request('PUT', '/weekly/' + y + '/' + w, body); },
    getAlloc: function (y, w) { return request('GET', '/reports/allocation-vs-utilization?year=' + y + '&week=' + w); },
    getDays: function (y, w) { return request('GET', '/daily?year=' + y + '&week=' + w); },
    putDay: function (iso, actualCbm) { return request('PUT', '/daily/' + iso, { actual_cbm: actualCbm }); },
    getSummary: function (y, from, to) {
      return request('GET', '/reports/weekly-summary?year=' + y + (from != null ? '&from_week=' + from : '') + (to != null ? '&to_week=' + to : ''));
    },
    downloadSummary: function (y, from, to) {
      return download('/reports/weekly-summary/download?year=' + y + (from != null ? '&from_week=' + from : '') + (to != null ? '&to_week=' + to : ''), 'weekly-summary-' + y + '.xlsx');
    },
    downloadAlloc: function (y, w) {
      return download('/reports/allocation-vs-utilization/download?year=' + y + '&week=' + w, 'allocation-vs-utilization-' + y + '-wk' + w + '.xlsx');
    },
    // Only the daily stuffing page asks for the mock config in ?demo (getConfig({demo: true})); every other
    // page keeps asking the backend, exactly as before.
    getConfig: function (opts) {
      if (!USE_BACKEND && opts && opts.demo) return mock(function () { var c = clone(CFG); c.line_map = clone(DEMO_LINE_MAP); return c; });
      return request('GET', '/config');
    },
    putConfig: function (patch) { return request('PUT', '/config', patch); },
    getSuppliers: function () { return request('GET', '/suppliers'); },
    putSupplier: function (code, name, cw) { return request('POST', '/suppliers/' + encodeURIComponent(code), { name: name, cw_code: cw }); },
    deleteSupplier: function (code) { return request('DELETE', '/suppliers/' + encodeURIComponent(code)); }
  };
  /* ---------- who is signed in: GET /auth/me, GET /auth/config, POST /auth/logout ---------- */
  var mePromise = null;
  function authFetch(method, path) {
    var t = timed(TIMEOUT_MS);
    return fetch(API_BASE + path, { method: method, credentials: 'same-origin', cache: 'no-store', signal: t.signal })
      .finally(function () { clearTimeout(t.timer); });
  }
  var auth = {
    user: null,   // {email, name, role} once me() has answered
    /* Once per page (fresh = ask again): resolves with {email, name, role: 'admin' | 'user'}; rejects
       with status 401 (no session, kind 'auth'), 403 (deactivated, kind 'forbidden', the server's
       detail) or kind 'network'. It never navigates: the caller decides. ?demo resolves null. */
    me: function (fresh) {
      if (mePromise && !fresh) return mePromise;
      if (!USE_BACKEND) { mePromise = Promise.resolve(null); return mePromise; }
      mePromise = authFetch('GET', '/auth/me').then(function (res) {
        if (res.ok) return res.json().then(function (u) { auth.user = u; return u; });
        return res.text().then(function (t) {
          auth.user = null;
          if (res.status === 403) deactivated = true;
          throw fail(detailOf(t, res.status), res.status === 401 ? 'auth' : res.status === 403 ? 'forbidden' : 'http', res.status);
        });
      }, netError);
      return mePromise;
    },
    // {auth: 'oidc' | 'off', provider, provider_name} (public): the label of the sign-in button
    config: function () {
      return authFetch('GET', '/auth/config').then(function (res) {
        if (!res.ok) throw fail('The server answered ' + res.status + '.', 'http', res.status);
        return res.json();
      }, netError);
    },
    // where the sign-in starts: a page navigation (location.assign), never a fetch. next: a same-origin
    // path to land on afterwards (the server checks it again); none = index.html#enter
    loginUrl: function (next) { return API_BASE + '/auth/login' + (next ? '?next=' + encodeURIComponent(next) : ''); },
    // ends every session of this user (all browsers); resolves either way, the caller then leaves
    logout: function () {
      auth.user = null; mePromise = null;
      if (!USE_BACKEND) return Promise.resolve(false);
      return authFetch('POST', '/auth/logout').then(function (res) { return res.ok; }, function () { return false; });
    },
    toSignIn: toSignIn
  };
  window.CA.auth = auth;

  window.CA.data = {
    upload: upload,
    USE_BACKEND: USE_BACKEND,
    API_BASE: API_BASE,
    LOCAL: LOCAL,
    isLocalHost: isLocalHost,
    CARRIERS: CARRIERS,
    FIXTURE: FIXTURE,
    source: USE_BACKEND ? 'backend' : 'demo',
    getWeek: function (year, week) {
      if (USE_BACKEND) return getJSON('/reports/allocation-vs-utilization?year=' + year + '&week=' + week);
      return mock(function () { return weekCalc(year, week); });
    },
    getSummary: function (year, fromWeek, toWeek) {
      if (USE_BACKEND) {
        var q = '/reports/weekly-summary?year=' + year +
          (fromWeek != null ? '&from_week=' + fromWeek : '') + (toWeek != null ? '&to_week=' + toWeek : '');
        return getJSON(q);
      }
      return mock(function () { return mockSummary(year, fromWeek, toWeek); });
    }
  };
})();
