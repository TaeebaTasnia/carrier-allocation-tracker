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
 * Test fixtures (query string, demo data only):
 *   ?fixture=overflow  week 45 with ONE stuffed 4 TEU over its confirmed space
 *   ?fixture=error     the request fails
 *   ?fixture=slow      the request takes 2.5 s (shows the loading state)
 *   ?fixture=uploaderror  every demo upload fails
 *
 * Uploads: upload(kind, file, {report_date}) -> POST /forecast/upload, /stuffing/upload?report_date=.
 * Demo mode answers with the same response shapes (see mockUpload).
 */
(function () {
  'use strict';

  // Real data from the FastAPI backend. Add ?demo to the page URL to see the built-in demo weeks instead.
  var USE_BACKEND = !/[?&]demo(=|&|$)/.test(location.search);
  var API_BASE = 'http://127.0.0.1:8000';
  // DEV ONLY: ?api=http://127.0.0.1:8001 points this tab at a throwaway test backend. It is kept in
  // sessionStorage (this tab only) so links between pages keep it; ?api=default clears it.
  try {
    var apiParam = new URLSearchParams(location.search).get('api');
    if (apiParam === 'default') sessionStorage.removeItem('ca.api');
    else if (apiParam && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiParam)) sessionStorage.setItem('ca.api', apiParam);
    var apiKept = sessionStorage.getItem('ca.api');
    if (apiKept) API_BASE = apiKept;
  } catch (e) {}
  var TIMEOUT_MS = 8000;

  var CARRIERS = ['MAERSK', 'HAPAG', 'HELLMAN', 'ONE', 'FML'];
  var SPLIT_CARRIERS = ['MAERSK', 'HAPAG', 'HELLMAN', 'ONE'];

  // Mirrors the backend defaults (GET /config).
  var CFG = { uplift_pct: 30, cbm_per_teu: 33, split: { MAERSK: 30, HAPAG: 25, HELLMAN: 20, ONE: 25 }, fml_default: 10 };
  var BALANCE_TOL = 0.5;

  var params = new URLSearchParams(location.search);
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
      // forecast total 72.660565 TEU (backend golden test value)
      fcTeu: { '2026-11-02': 20.10, '2026-11-03': 18.40, '2026-11-04': 16.20, '2026-11-05': 17.960565 },
      stuff: {
        '2026-11-02': { MAERSK: 2, ONE: 6 },
        '2026-11-03': { ONE: 4 },
        '2026-11-04': { HAPAG: 4 },
        '2026-11-05': { HAPAG: 12 }
      },
      // The demo stuffing report has no CBM column, so every day's actual CBM is stuffed TEU x 33:
      // 28 TEU arrived. Week 45: forecast 72.66, confirmed 64, utilized 28, to be arrived 44.66,
      // left 36, deficit -8.66.
      ovr: {},
      conf: { MAERSK: 20, HAPAG: 24, HELLMAN: 0, ONE: 10, FML: 10 }
    },
    '2026-46': {
      // forecast total 87.766920 TEU
      fcTeu: { '2026-11-09': 22.40, '2026-11-10': 21.10, '2026-11-11': 19.80, '2026-11-12': 24.46692 },
      stuff: {}, ovr: {},
      conf: { MAERSK: 20, HAPAG: 20, HELLMAN: 10, ONE: 20, FML: 0 }
    },
    '2026-47': {
      // forecast total 47.430669 TEU
      fcTeu: { '2026-11-16': 12.30, '2026-11-17': 11.90, '2026-11-18': 10.70, '2026-11-19': 12.530669 },
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

  function getJSON(path) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
    return fetch(API_BASE + path, ctrl ? { signal: ctrl.signal } : {})
      .then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) {
            var detail = t;
            try { detail = JSON.parse(t).detail || t; } catch (x) {}
            var e = new Error('The backend answered ' + res.status + ': ' + detail);
            e.kind = 'http';
            throw e;
          });
        }
        return res.json();
      }, function (err) {
        var e = new Error(err && err.name === 'AbortError'
          ? 'The backend at ' + API_BASE + ' did not answer within ' + (TIMEOUT_MS / 1000) + ' s.'
          : 'Could not reach the backend at ' + API_BASE + '. Check that it is running and that it allows requests from this page (CORS).');
        e.kind = 'network';
        throw e;
      })
      .finally(function () { clearTimeout(timer); });
  }

  /* ---------- uploads ---------- */

  function isoKeyOf(dateStr) {
    var d = new Date(dateStr + 'T00:00:00Z');
    var day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    var y = d.getUTCFullYear();
    return { year: y, week: Math.ceil(((d - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7) };
  }

  function uploadError(detail) {
    var e = new Error(detail);
    e.kind = 'http';
    return e;
  }

  /* Demo uploads cannot read the workbook in the browser. They answer with the backend's response
   * shape. The stuffing demo also books 4 TEU on the chosen date (replacing that date), so the jars
   * and figures visibly refresh. */
  function mockUpload(kind, file, opts) {
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
    if (kind === 'stuffing') {
      var date = opts.report_date || opts.fallbackDate;
      var key = isoKeyOf(date), wk = key.year + '-' + key.week;
      if (!WEEKS[wk]) WEEKS[wk] = { fcTeu: {}, stuff: {}, ovr: {}, conf: zeros() };
      WEEKS[wk].stuff[date] = { MAERSK: 2, HAPAG: 2 };
      var ct = {}; ct[date] = { MAERSK: 2, HAPAG: 2 };
      return delay(1000, {
        rows: 3, dates: [date], carrier_teus: ct,
        unmapped_lines: [{ shipping_line: 'CMA CGM', teus: 1 }],
        skipped_rows: 0,
        cbm_column_found: false, carrier_cbm: {}, cbm_by_date: {}
      });
    }
    return delay(800, null, uploadError('Cannot read ' + kind + ' file: that kind of upload does not exist.'));
  }

  function postFile(path, file) {
    var fd = new FormData();
    fd.append('file', file, file.name);
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 60000);
    return fetch(API_BASE + path, { method: 'POST', body: fd, signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        return res.text().then(function (t) {
          var body = null;
          try { body = JSON.parse(t); } catch (x) {}
          if (!res.ok) throw uploadError((body && body.detail) ? String(body.detail) : 'The backend answered ' + res.status + '.');
          return body;
        });
      }, function () {
        var e = new Error('Could not reach the backend at ' + API_BASE + '. Check that it is running and that it allows requests from this page (CORS).');
        e.kind = 'network';
        throw e;
      })
      .finally(function () { clearTimeout(timer); });
  }

  function upload(kind, file, opts) {
    opts = opts || {};
    if (!USE_BACKEND) return mockUpload(kind, file, opts);
    if (kind === 'forecast') return postFile('/forecast/upload', file);
    if (kind === 'stuffing') return postFile('/stuffing/upload' + (opts.report_date ? '?report_date=' + encodeURIComponent(opts.report_date) : ''), file);
    return Promise.reject(uploadError('Cannot upload ' + kind + ': only the forecast and the daily stuffing report are uploaded here.'));
  }

  /* ---------- JSON requests for the data-entry, report and settings pages (backend only) ---------- */

  function errorFrom(res) {
    return res.text().then(function (t) {
      var detail = t;
      try {
        var j = JSON.parse(t);
        detail = j.detail;
        // FastAPI validation errors: a list of {loc, msg}
        if (Array.isArray(detail)) detail = detail.map(function (d) { return (d.loc ? d.loc.slice(1).join('.') + ': ' : '') + d.msg; }).join('; ');
      } catch (x) {}
      var e = new Error(String(detail || ('The backend answered ' + res.status + '.')));
      e.kind = 'http'; e.status = res.status;
      throw e;
    });
  }
  function netError(err) {
    var e = new Error(err && err.name === 'AbortError'
      ? 'The backend at ' + API_BASE + ' did not answer within ' + (TIMEOUT_MS / 1000) + ' s.'
      : 'Could not reach the backend at ' + API_BASE + '. Check that it is running.');
    e.kind = 'network';
    throw e;
  }
  function request(method, path, body) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
    var init = { method: method, signal: ctrl ? ctrl.signal : undefined };
    if (body !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
    return fetch(API_BASE + path, init)
      .then(function (res) { return res.ok ? res.json() : errorFrom(res); }, netError)
      .finally(function () { clearTimeout(timer); });
  }
  /* GET a file and hand it to the browser as a download, named by Content-Disposition */
  function download(path, fallbackName) {
    return fetch(API_BASE + path)
      .then(function (res) {
        if (!res.ok) return errorFrom(res);
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
  window.CA.data = {
    upload: upload,
    isoKeyOf: isoKeyOf,
    USE_BACKEND: USE_BACKEND,
    API_BASE: API_BASE,
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
