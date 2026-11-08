# Carrier Allocation & Utilization backend

FastAPI + SQLite (`data/app.db`, created on first start; the 12 screenshot suppliers are seeded when the table is empty).

## Run

From `E:\c&a-newww\backend` (do not activate the venv; the `&` in the path breaks it):

```
.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

Docs at http://127.0.0.1:8000/docs. Tests:

```
.venv\Scripts\python.exe -m pytest tests -q
```

## Rules (all values stored unrounded; JSON stays exact)

- The two .xlsx reports write TEU cells as whole numbers rounded UP (`teu_up` in `app/services/reports.py`: ceil(x - 1e-6), away from zero for negatives, deficit/surplus within 0.5 shows 0, never -0). CBM cells and percentages stay exact. The frontend uses the same rule for what it shows. `POST /suppliers/upload` still exists, but no page uses it (the supplier list is fixed; new suppliers are added in Settings).

- CBM+30% = exp.Vol cbm x (1 + uplift/100); TEU = CBM+30% / cbm_per_teu (33); split MAERSK 30 / HAPAG 25 / HELLMAN 20 / ONE 25.
- FML is separate (default 10 TEU/week, overridable per week). Weekly forecast excludes FML.
- Left = total confirmed (5 carriers) - total utilized; To be arrived = max(0, sum daily forecast TEU - sum actual TEU);
  Deficit/Surplus = Left - To be arrived (deficit < -0.5, surplus > 0.5, else balanced).
- Shipping lines: explicit `line_map` entries win; otherwise a line starting with `FML` + hyphen/space/slash (e.g. `FML-MAERSK`) maps to FML (FML is the main for those bookings). `FMLX`/`FM` do not match.
- Actual CBM per day comes from the DAILY STUFFING report, in priority order: (1) a typed adjustment for that date (`PUT /daily/{date}`, 0 is valid, null clears it) -> that value, source `entered`; (2) else, if the day has stuffing rows, the sum over its rows of (the row's CBM if the report has one, else the row's TEUs x cbm_per_teu = TEU x 33) -> source `stuffing_cbm` (every row had a CBM), `stuffing_teu` (none had one) or `stuffing_mixed`; (3) else 0, source `none`. Actual TEU = actual CBM / cbm_per_teu. Unmapped shipping lines still count as arrived (they are only left out of the carriers' utilized). In the daily JSON, `actual_cbm_override` is the typed adjustment (null = none) and `actual_cbm_source` is the source. Utilized stays the stuffed TEUs per carrier; confirmed TEUs are what the carrier gave.
- Optional CBM column in the stuffing file (header, case/space-insensitive): `CBM`, `Total CBM`, `CBM Total`, `Volume`, `Vol`, `Volume CBM`, `Vol CBM`, `M3`, `Cube`. Blank or non-numeric = no CBM for that row. The TEUs and Qty columns are never read as CBM. Stored in `daily_stuffing.cbm`; existing databases get the column automatically at startup (idempotent `ALTER TABLE`, no data touched).
- Weeks are keyed by (ISO year, ISO week) of the Rfi date.

## Endpoints

- `POST /suppliers/upload` (`?replace=true`), `GET /suppliers`, `POST /suppliers/{code}`, `DELETE /suppliers/{code}`
- `POST /forecast/upload`, `GET /forecast/weeks/{year}/{week}`
- `POST /stuffing/upload?report_date=YYYY-MM-DD` (date only needed if the file has no date column; the response adds `cbm_column_found`, `carrier_cbm` and `cbm_by_date`)
- Typed daily stuffing (the browser day editor; no Excel file). Rows are stored exactly like uploaded rows (same `daily_stuffing` table; vessel dates as `YYYY-MM-DD` text; `carrier` = the shipping line mapped through the config `line_map` + the `FML-` prefix rule at save time). Figures (`/daily`, `/weekly`, `/reports/*`, the .xlsx exports) read the same rows, so typed and uploaded days behave identically.
  - `GET /stuffing/dates?year=&week=` (ISO week, 422 if invalid) -> `{"year":2026,"week":45,"days":[{"date":"2026-11-02","rows":2,"teus":8.0}, ... 7 days Mon-Sun, rows 0 / teus 0 when empty]}`. Declared before `/stuffing/{date}`.
  - `GET /stuffing/{date}` (YYYY-MM-DD, otherwise 422) -> `{"date","rows":[{"id","shipping_line","qty","teus","feeder_vessel","fvsl_etd","fvsl_eta","mother_vessel","mvsl_etd","mvsl_eta","cbm","carrier","mapped"}],"total_teus","unmapped_lines":[{"shipping_line","teus"}]}`. Rows ordered by id; an empty day is 200 with `rows: []`. `carrier`/`mapped` are computed now from the current `line_map` (explicit entry wins, then `FML-`/`FML ` prefix -> FML), so a Settings change shows immediately.
  - `PUT /stuffing/{date}` body `{"rows":[{"shipping_line":"MAERSK","qty":3,"teus":6,"feeder_vessel":"FEEDER","fvsl_etd":"2026-11-05","fvsl_eta":"2026-11-08","mother_vessel":"MOTHER","mvsl_etd":"2026-11-10","mvsl_eta":"2026-12-01","cbm":120.5}]}` REPLACES all rows of that date in one transaction (an empty list clears the day) and returns the same JSON as GET. Validation (422): `shipping_line` required, trimmed, 1-100 chars; `teus` required, finite number >= 0 (TEUs is authoritative; a 40' HC is 2 TEU, the browser may pre-fill 2 x Qty); `qty`/`cbm` optional numbers >= 0; the four vessel dates optional ISO `YYYY-MM-DD` (null or "" = none); vessel names optional, max 100; at most 500 rows. A rejected save changes nothing.
  - `DELETE /stuffing/{date}` -> `{"date":"2026-11-04","deleted":2}` (0 is fine).
- `GET|PUT /weekly/{year}/{week}` (PUT body: `{"confirmed": {"MAERSK":20,...,"FML":0}, "fml_forecast": null}`)
- `GET /daily?year=&week=`, `GET|PUT /daily/{date}` (PUT body: `{"actual_cbm": 66}` = typed adjustment of that day's actual CBM; 0 is valid; null clears it and the computed value returns)
- `GET /reports/weekly-summary?year=&from_week=&to_week=` and `/reports/weekly-summary/download` (.xlsx)
- `GET /reports/allocation-vs-utilization?year=&week=` and `/reports/allocation-vs-utilization/download` (.xlsx)
- `GET|PUT /config` (uplift_pct, cbm_per_teu, split totalling 100, fml_default, line_map)
