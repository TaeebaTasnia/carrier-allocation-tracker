import datetime as dt
import io

import openpyxl
import pytest

from tests.conftest import REAL_FORECAST, make_xlsx

FC_HEAD = ["Rfi", "Supplier", "exp.Vol cbm"]


def _fc(rows, header=FC_HEAD):
    return make_xlsx(rows, header)


def _up_fc(client, rows, header=FC_HEAD):
    return client.post("/forecast/upload", files={"file": ("f.xlsx", _fc(rows, header))})


def _cells(content):
    ws = openpyxl.load_workbook(io.BytesIO(content)).active
    return [[c.value for c in row] for row in ws.iter_rows()]


# (a) + (b)
def test_confirmed_untouched_and_partial_reupload(client):
    d45, d46, d47 = dt.datetime(2026, 11, 3), dt.datetime(2026, 11, 10), dt.datetime(2026, 11, 17)
    assert _up_fc(client, [[d45, "77534", 1000], [d46, "77534", 2000], [d47, "77534", 3000]]).status_code == 200
    client.put("/weekly/2026/46", json={"confirmed": {"MAERSK": 12, "ONE": 3}})
    before46 = client.get("/weekly/2026/46").json()
    before47 = client.get("/forecast/weeks/2026/47").json()
    # re-upload only wk45 with a different volume
    assert _up_fc(client, [[d45, "77534", 500]]).status_code == 200
    assert client.get("/weekly/2026/46").json() == before46
    assert client.get("/weekly/2026/46").json()["total_confirmed"] == 15
    assert client.get("/forecast/weeks/2026/47").json() == before47
    assert client.get("/forecast/weeks/2026/45").json()["cbm_plus"] == pytest.approx(650.0)


# (c)
def test_mapping_added_after_upload_counts(client):
    day = dt.datetime(2026, 11, 5)
    data = make_xlsx([["NEWLINE", 5, 1, day]], ["Shipping Line", "TEUs", "Qty", "Date"])
    r = client.post("/stuffing/upload", files={"file": ("s.xlsx", data)})
    assert r.json()["unmapped_lines"] == [{"shipping_line": "NEWLINE", "teus": 5.0}]
    assert client.get("/weekly/2026/45").json()["total_utilized"] == 0
    r = client.put("/config", json={"line_map": {" newline ": "ONE"}})
    assert r.status_code == 200 and r.json()["line_map"]["NEWLINE"] == "ONE"
    wk = client.get("/weekly/2026/45").json()
    assert wk["carriers"]["ONE"]["utilized"] == 5 and wk["total_utilized"] == 5
    # removing the mapping un-counts it again
    client.put("/config", json={"line_map": {"NEWLINE": None}})
    assert client.get("/weekly/2026/45").json()["total_utilized"] == 0


# (d)
def test_duplicate_supplier_codes_no_500(client):
    up = make_xlsx([[77534, "A", "X"], ["77534.0", "B", "Y"], ["90001", "C", "Z"], [90001.0, "D", "W"]],
                   ["SUPPLIER CODE", "SUPPLIER", "CW CODE"])
    r = client.post("/suppliers/upload", files={"file": ("s.xlsx", up)})
    assert r.status_code == 200, r.text
    sup = {s["code"]: s for s in client.get("/suppliers").json()}
    assert sup["77534"]["name"] == "B" and sup["90001"]["name"] == "D"
    assert r.json()["added"] == 1 and r.json()["updated"] == 1
    r = client.post("/suppliers/upload", params={"replace": True}, files={"file": ("s.xlsx", up)})
    assert r.status_code == 200 and r.json()["total"] == 2


# (e)
def test_empty_stuffing_reupload_clears_date(client):
    day = dt.datetime(2026, 11, 5)
    d = make_xlsx([["MAERSK", 4, 1, day]], ["Shipping Line", "TEUs", "Qty", "Date"])
    client.post("/stuffing/upload", files={"file": ("s.xlsx", d)})
    assert client.get("/weekly/2026/45").json()["total_utilized"] == 4
    empty = make_xlsx([], ["Shipping Line", "TEUs"])
    r = client.post("/stuffing/upload", params={"report_date": "2026-11-05"}, files={"file": ("s.xlsx", empty)})
    assert r.status_code == 200 and r.json()["rows"] == 0
    assert client.get("/weekly/2026/45").json()["total_utilized"] == 0


# (f)
def test_partial_line_map_merge_and_delete(client):
    default = client.get("/config").json()["line_map"]
    r = client.put("/config", json={"line_map": {"Hapag Lloyd": "HAPAG"}})
    lm = r.json()["line_map"]
    assert lm["HAPAG LLOYD"] == "HAPAG"
    assert all(lm[k] == v for k, v in default.items())
    r = client.put("/config", json={"line_map": {"HAPAG LLOYD": None, "MSK": None}})
    lm = r.json()["line_map"]
    assert "HAPAG LLOYD" not in lm and "MSK" not in lm and lm["MAERSK"] == "MAERSK"
    assert client.get("/config").json()["line_map"] == lm
    assert client.put("/config", json={"line_map": {"X": "NOPE"}}).status_code == 422


# (g)
@pytest.mark.parametrize("path", ["/forecast/upload", "/stuffing/upload", "/suppliers/upload"])
def test_non_xlsx_upload_400(client, path):
    r = client.post(path, files={"file": ("x.xlsx", b"this is not an excel file")})
    assert r.status_code == 400


@pytest.mark.parametrize("missing", ["Rfi", "Supplier", "exp.Vol cbm"])
def test_forecast_missing_columns_400(client, missing):
    values = {"Rfi": dt.datetime(2026, 11, 3), "Supplier": "77534", "exp.Vol cbm": 10}
    header = [h for h in FC_HEAD if h != missing]
    r = _up_fc(client, [[values[h] for h in header]], header)
    assert r.status_code == 400 and "missing required columns" in r.text


def test_forecast_no_rfi_rows_400(client):
    assert _up_fc(client, [["notadate", "77534", 10]]).status_code == 400


@pytest.mark.parametrize("url", [
    "/forecast/weeks/2026/0", "/forecast/weeks/2026/54", "/weekly/2026/0", "/weekly/2026/99",
    "/daily?year=2026&week=60", "/reports/allocation-vs-utilization?year=2026&week=0",
    "/reports/allocation-vs-utilization/download?year=2026&week=54",
    "/reports/weekly-summary?year=2026&from_week=0", "/reports/weekly-summary?year=2026&to_week=54",
    "/reports/weekly-summary?year=2026&from_week=10&to_week=5",
    "/reports/weekly-summary/download?year=2026&from_week=10&to_week=5",
])
def test_bad_week_numbers(client, url):
    assert client.get(url).status_code in (400, 422)


def test_valid_week_still_ok(client):
    assert client.get("/forecast/weeks/2026/53").status_code == 200
    assert client.get("/reports/weekly-summary?year=2026&from_week=1&to_week=53").status_code == 200


# (h)
def test_year_boundary_iso(client):
    r = _up_fc(client, [[dt.datetime(2027, 1, 1), "77534", 330]])
    assert r.status_code == 200
    assert r.json()["weeks"] == [{"year": 2026, "week": 53}]
    g = client.get("/forecast/weeks/2026/53").json()
    assert g["cbm_plus"] == pytest.approx(429.0) and g["daily"][0]["date"] == "2027-01-01"
    assert client.get("/forecast/weeks/2027/1").json()["cbm_plus"] == 0


# (i)
def test_clamp_and_actual_override(client):
    # clamp: received more than forecast -> to_be_arrived = 0, never negative
    _up_fc(client, [[dt.datetime(2026, 11, 3), "77534", 330]])  # 429 cbm+ -> 13 TEU
    st = make_xlsx([["MAERSK", 20, 1, dt.datetime(2026, 11, 3)]], ["Shipping Line", "TEUs", "Qty", "Date"])
    client.post("/stuffing/upload", files={"file": ("s.xlsx", st)})
    client.put("/weekly/2026/45", json={"confirmed": {"MAERSK": 25}})
    # no CBM column: arrived = stuffed 20 TEU x 33 = 20 TEU > forecast 13 -> clamp at 0
    wk = client.get("/weekly/2026/45").json()
    assert wk["total_actual_teu"] == pytest.approx(20.0) and wk["to_be_arrived"] == 0.0
    assert wk["deficit_surplus"] == pytest.approx(5.0)  # left 5 - 0
    # a typed adjustment of 66 cbm (2 TEU) replaces the computed value -> to_be_arrived = 11
    client.put("/daily/2026-11-03", json={"actual_cbm": 66})
    wk = client.get("/weekly/2026/45").json()
    assert wk["to_be_arrived"] == pytest.approx(11.0) and wk["deficit_surplus"] == pytest.approx(5.0 - 11.0)
    # 500 cbm (15.15 TEU) > forecast 13 -> clamp
    client.put("/daily/2026-11-03", json={"actual_cbm": 500})
    wk = client.get("/weekly/2026/45").json()
    assert wk["to_be_arrived"] == 0.0
    assert wk["deficit_surplus"] == pytest.approx(5.0)
    # adjust actual cbm on a day with no stuffing: lowers actual -> raises to_be_arrived
    _up_fc(client, [[dt.datetime(2026, 11, 10), "77534", 330]])
    client.put("/weekly/2026/46", json={"confirmed": {"MAERSK": 20}})
    base = client.get("/weekly/2026/46").json()
    assert base["deficit_surplus"] == pytest.approx(20 - 13)
    client.put("/daily/2026-11-10", json={"actual_cbm": 66})  # 2 TEU actually arrived
    ov = client.get("/weekly/2026/46").json()
    assert ov["to_be_arrived"] == pytest.approx(11.0)
    assert ov["deficit_surplus"] == pytest.approx(20 - 11)
    assert ov["deficit_surplus"] != base["deficit_surplus"]


# (j)
def test_stuffing_date_fallback(client):
    rows = [["MAERSK", 3, "garbage"], ["ONELINE", 2, dt.datetime(2026, 11, 5)]]
    data = make_xlsx(rows, ["Shipping Line", "TEUs", "Date"])
    r = client.post("/stuffing/upload", params={"report_date": "2026-11-04"}, files={"file": ("s.xlsx", data)})
    body = r.json()
    assert body["carrier_teus"]["2026-11-04"]["MAERSK"] == 3 and body["skipped_rows"] == []
    assert body["carrier_teus"]["2026-11-05"]["ONE"] == 2
    r = client.post("/stuffing/upload", files={"file": ("s.xlsx", data)})
    body = r.json()
    assert r.status_code == 200 and len(body["skipped_rows"]) == 1 and "unreadable date" in body["skipped_rows"][0]
    assert body["rows"] == 1


# (k) numeric xlsx cells
def test_xlsx_numeric_values(client, real_rows):
    with open(REAL_FORECAST, "rb") as f:
        assert client.post("/forecast/upload", files={"file": ("f.xlsx", f)}).status_code == 200
    client.put("/weekly/2026/45", json={"confirmed": {"MAERSK": 20, "HAPAG": 20, "HELLMAN": 10, "ONE": 20, "FML": 10}})
    r = client.get("/reports/allocation-vs-utilization/download", params={"year": 2026, "week": 45})
    rows = _cells(r.content)
    head = rows[2]
    assert head[:8] == ["WEEK", "FORECAST", "TOTAL CONFIRMED", "TOTAL UTILIZED", "TO BE ARRIVED",
                        "TO BE UTILIZED", "DEFICIT/SURPLUS", "STATUS"]
    wkrow = rows[3]
    assert wkrow[0] == "WK45" and wkrow[1] == 73  # TEU cells are whole TEU, rounded up (72.660565 -> 73)
    assert wkrow[7] in ("deficit", "surplus", "balanced")
    forecast_row = next(x for x in rows if x[0] == "FORECAST")
    car_head = next(x for x in rows if x[:2] == [None, "MAERSK"] or x[1:2] == ["MAERSK"])
    total_col = car_head.index("TOTAL")
    assert forecast_row[total_col] == 73  # MGH total, no FML (72.660565 rounded up)
    assert forecast_row[car_head.index("FML")] == 10
    assert forecast_row[car_head.index("MAERSK")] == 22  # 21.798170 rounded up

    r = client.get("/reports/weekly-summary/download", params={"year": 2026, "from_week": 45, "to_week": 45})
    rows = _cells(r.content)
    assert rows[2][1] == "FORECAST" and rows[2][7] == "STATUS"
    wk = next(x for x in rows if x[0] == "WK45")
    tot = next(x for x in rows if x[0] == "TOTAL")
    assert wk[1] == 73 and tot[1] == 73  # 72.660565 rounded up
    assert wk[7] in ("deficit", "surplus", "balanced") and tot[7] == wk[7]


# FML is the main carrier for "FML-<carrier>" bookings
@pytest.mark.parametrize("line", ["FML-ONELINE", "FML-MAERSK", "fml one", "FML/HAPAG", " fml-hapag "])
def test_fml_prefix_maps_to_fml(line):
    from app.services.data import map_line
    assert map_line({}, line) == "FML"


def test_fml_prefix_non_matches():
    from app.services.data import map_line
    lm = {"ONELINE": "ONE", "MAERSK": "MAERSK"}
    assert map_line(lm, "FMLX") is None and map_line(lm, "FM") is None and map_line(lm, "FML") is None
    assert map_line(lm, "ONELINE") == "ONE" and map_line(lm, "maersk") == "MAERSK"


def test_explicit_entry_beats_fml_prefix(client):
    from app.services.data import map_line
    assert map_line({"FML-ONELINE": "ONE"}, "fml-oneline") == "ONE"
    day = dt.datetime(2026, 11, 5)
    rows = [["FML-ONELINE", 6, 1, day], ["FML-MAERSK", 3, 1, day], ["fml one", 1, 1, day], ["FMLX", 2, 1, day]]
    data = make_xlsx(rows, ["Shipping Line", "TEUs", "Qty", "Date"])
    body = client.post("/stuffing/upload", files={"file": ("s.xlsx", data)}).json()
    assert body["carrier_teus"]["2026-11-05"] == {"FML": 10}
    assert body["unmapped_lines"] == [{"shipping_line": "FMLX", "teus": 2.0}]
    assert client.get("/weekly/2026/45").json()["carriers"]["FML"]["utilized"] == 10
    # explicit mapping overrides the prefix rule at upload time and at query time
    client.put("/config", json={"line_map": {"FML-MAERSK": "ONE"}})
    wk = client.get("/weekly/2026/45").json()
    assert wk["carriers"]["ONE"]["utilized"] == 3 and wk["carriers"]["FML"]["utilized"] == 7
    body = client.post("/stuffing/upload", files={"file": ("s.xlsx", data)}).json()
    assert body["carrier_teus"]["2026-11-05"] == {"ONE": 3, "FML": 7}

