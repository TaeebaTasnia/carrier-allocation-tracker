"""Typed stuffing entry: GET/PUT/DELETE /stuffing/{date} and GET /stuffing/dates."""
import io

import openpyxl
import pytest

from tests.conftest import make_xlsx

D = "2026-11-04"
FULL = {
    "shipping_line": "MAERSK", "qty": 3, "teus": 6, "feeder_vessel": "FEEDER ONE", "fvsl_etd": "2026-11-05",
    "fvsl_eta": "2026-11-08", "mother_vessel": "MOTHER ONE", "mvsl_etd": "2026-11-10", "mvsl_eta": "2026-12-01",
    "cbm": 120.5,
}


def put(client, day, rows):
    return client.put(f"/stuffing/{day}", json={"rows": rows})


def test_get_empty_day(client):
    r = client.get(f"/stuffing/{D}")
    assert r.status_code == 200
    assert r.json() == {"date": D, "rows": [], "total_teus": 0.0, "unmapped_lines": []}


def test_put_get_round_trip(client):
    r = put(client, D, [FULL, {"shipping_line": "  hapag  ", "teus": 4}])
    assert r.status_code == 200
    body = r.json()
    assert body == client.get(f"/stuffing/{D}").json()
    a, b = body["rows"]
    assert a["id"] < b["id"]
    for k, v in FULL.items():
        assert a[k] == v
    assert a["carrier"] == "MAERSK" and a["mapped"] is True
    assert b["shipping_line"] == "hapag" and b["carrier"] == "HAPAG" and b["qty"] is None
    assert b["fvsl_etd"] is None and b["cbm"] is None and b["feeder_vessel"] is None
    assert body["total_teus"] == 10 and body["unmapped_lines"] == []


def test_empty_strings_become_none(client):
    r = put(client, D, [{"shipping_line": "ONE", "teus": 1, "fvsl_etd": "", "mvsl_eta": None, "feeder_vessel": "  "}])
    row = r.json()["rows"][0]
    assert row["fvsl_etd"] is None and row["mvsl_eta"] is None and row["feeder_vessel"] is None


def test_put_replaces(client):
    put(client, D, [FULL, {"shipping_line": "HAPAG", "teus": 4}, {"shipping_line": "ONE", "teus": 2}])
    r = put(client, D, [{"shipping_line": "ONE", "teus": 9}])
    assert [x["shipping_line"] for x in r.json()["rows"]] == ["ONE"]
    assert client.get(f"/stuffing/{D}").json()["total_teus"] == 9


def test_empty_list_clears(client):
    put(client, D, [FULL])
    r = put(client, D, [])
    assert r.status_code == 200 and r.json()["rows"] == []
    assert client.get(f"/stuffing/{D}").json()["rows"] == []


def test_delete(client):
    put(client, D, [FULL, {"shipping_line": "HAPAG", "teus": 4}])
    put(client, "2026-11-05", [{"shipping_line": "ONE", "teus": 1}])
    assert client.delete(f"/stuffing/{D}").json() == {"date": D, "deleted": 2}
    assert client.get(f"/stuffing/{D}").json()["rows"] == []
    assert client.delete(f"/stuffing/{D}").json() == {"date": D, "deleted": 0}
    assert len(client.get("/stuffing/2026-11-05").json()["rows"]) == 1


@pytest.mark.parametrize("row", [
    {"teus": 1},
    {"shipping_line": "", "teus": 1},
    {"shipping_line": "   ", "teus": 1},
    {"shipping_line": "X" * 101, "teus": 1},
    {"shipping_line": "A"},
    {"shipping_line": "A", "teus": -1},
    {"shipping_line": "A", "teus": "abc"},
    {"shipping_line": "A", "teus": 1, "qty": -2},
    {"shipping_line": "A", "teus": 1, "cbm": -0.1},
    {"shipping_line": "A", "teus": 1, "fvsl_etd": "05/11/2026"},
    {"shipping_line": "A", "teus": 1, "mvsl_eta": "2026-13-45"},
    {"shipping_line": "A", "teus": 1, "feeder_vessel": "V" * 101},
    {"shipping_line": "A", "teus": 1, "mother_vessel": "V" * 101},
])
def test_validation_422(client, row):
    put(client, D, [{"shipping_line": "KEEP", "teus": 1}])
    r = put(client, D, [row])
    assert r.status_code == 422
    # a rejected save leaves the day untouched
    assert [x["shipping_line"] for x in client.get(f"/stuffing/{D}").json()["rows"]] == ["KEEP"]


@pytest.mark.parametrize("raw", ["NaN", "Infinity", "-Infinity"])
def test_nan_inf_teus_rejected(client, raw):
    r = client.put(f"/stuffing/{D}", content='{"rows":[{"shipping_line":"A","teus":%s}]}' % raw,
                   headers={"content-type": "application/json"})
    assert r.status_code == 422


def test_row_limit(client):
    ok = [{"shipping_line": "A", "teus": 1}] * 500
    assert put(client, D, ok).status_code == 200
    assert put(client, D, ok + [{"shipping_line": "A", "teus": 1}]).status_code == 422
    assert client.get(f"/stuffing/{D}").json()["rows"].__len__() == 500


def test_bad_body_and_date_path(client):
    assert client.put(f"/stuffing/{D}", json={}).status_code == 422
    assert client.put(f"/stuffing/{D}", json={"rows": "x"}).status_code == 422
    for m in ("get", "put", "delete"):
        kw = {"json": {"rows": []}} if m == "put" else {}
        assert getattr(client, m)("/stuffing/not-a-date", **kw).status_code == 422
        assert getattr(client, m)("/stuffing/2026-02-30", **kw).status_code == 422


def test_carrier_mapping(client):
    rows = [{"shipping_line": "FML-ONELINE", "teus": 6}, {"shipping_line": "FML-MAERSK", "teus": 2},
            {"shipping_line": "ONELINE", "teus": 4}, {"shipping_line": "MYSTERY LINE", "teus": 3},
            {"shipping_line": "MYSTERY LINE", "teus": 1}]
    body = put(client, D, rows).json()
    got = {(x["shipping_line"], x["teus"]): (x["carrier"], x["mapped"]) for x in body["rows"]}
    assert got[("FML-ONELINE", 6)] == ("FML", True)
    assert got[("FML-MAERSK", 2)] == ("FML", True)
    assert got[("ONELINE", 4)] == ("ONE", True)
    assert got[("MYSTERY LINE", 3)] == (None, False)
    assert body["unmapped_lines"] == [{"shipping_line": "MYSTERY LINE", "teus": 4}]
    assert body["total_teus"] == 16


def test_explicit_line_map_wins_and_is_applied_now(client):
    put(client, D, [{"shipping_line": "FML-ONELINE", "teus": 6}, {"shipping_line": "NEWCO", "teus": 2}])
    cfg = client.get("/config").json()
    lm = dict(cfg["line_map"])
    lm["FML-ONELINE"] = "ONE"
    lm["NEWCO"] = "HAPAG"
    assert client.put("/config", json={"line_map": lm}).status_code == 200
    rows = client.get(f"/stuffing/{D}").json()["rows"]
    assert [(r["carrier"], r["mapped"]) for r in rows] == [("ONE", True), ("HAPAG", True)]
    assert client.get(f"/stuffing/{D}").json()["unmapped_lines"] == []


WEEK45 = {
    "2026-11-02": [("MAERSK", 2), ("ONELINE", 6)],
    "2026-11-03": [("ONELINE", 4)],
    "2026-11-04": [("HAPAG", 4), ("HAPAG", 8)],
    "2026-11-05": [("FML-ONELINE", 6), ("ONELINE", 4), ("MAERSK", 4)],
}


def _type_week45(client):
    for day, rows in WEEK45.items():
        assert put(client, day, [{"shipping_line": s, "teus": t} for s, t in rows]).status_code == 200


def test_consistency_reports_and_daily(client, loaded_db):
    _type_week45(client)
    rep = client.get("/reports/allocation-vs-utilization", params={"year": 2026, "week": 45}).json()
    used = {c: v["utilized"] for c, v in rep["carriers"].items()}
    assert used == {"MAERSK": 6, "HAPAG": 12, "HELLMAN": 0, "ONE": 14, "FML": 6}
    assert rep["total_utilized"] == 38
    daily = {d["date"]: d for d in client.get("/daily", params={"year": 2026, "week": 45}).json()["days"]}
    assert daily["2026-11-04"]["stuffed_teus"] == 12
    assert daily["2026-11-04"]["carrier_teus"]["HAPAG"] == 12
    # actual CBM = TEUs x cbm_per_teu (no row CBM typed)
    assert daily["2026-11-04"]["actual_cbm"] == pytest.approx(12 * 33)
    wk = client.get("/weekly/2026/45").json()
    assert wk["total_utilized"] == 38
    summ = client.get("/reports/weekly-summary", params={"year": 2026}).json()
    assert [w for w in summ["weeks"] if w["week"] == 45][0]["total_utilized"] == 38
    x = client.get("/reports/allocation-vs-utilization/download", params={"year": 2026, "week": 45})
    assert x.status_code == 200
    flat = [c.value for row in openpyxl.load_workbook(io.BytesIO(x.content)).active.iter_rows() for c in row]
    assert 38 in flat


def test_typed_row_cbm_used_for_actual(client, loaded_db):
    put(client, "2026-11-03", [{"shipping_line": "ONELINE", "teus": 4, "cbm": 100}])
    d = {x["date"]: x for x in client.get("/daily", params={"year": 2026, "week": 45}).json()["days"]}
    assert d["2026-11-03"]["actual_cbm"] == 100 and d["2026-11-03"]["actual_cbm_source"] == "stuffing_cbm"


def test_typed_and_uploaded_days_coexist_and_upload_replaces(client):
    put(client, "2026-11-02", [{"shipping_line": "MAERSK", "teus": 2}])
    up = make_xlsx([["HAPAG", 5, 1]], ["Shipping Line", "TEUs", "Qty"])
    r = client.post("/stuffing/upload", params={"report_date": "2026-11-03"}, files={"file": ("s.xlsx", up)})
    assert r.status_code == 200
    assert client.get("/stuffing/2026-11-02").json()["total_teus"] == 2
    u = client.get("/stuffing/2026-11-03").json()
    assert u["total_teus"] == 5 and u["rows"][0]["carrier"] == "HAPAG"
    # the upload route replaces a date that was typed earlier
    up2 = make_xlsx([["ONELINE", 7, 1]], ["Shipping Line", "TEUs", "Qty"])
    client.post("/stuffing/upload", params={"report_date": "2026-11-02"}, files={"file": ("s.xlsx", up2)})
    rows = client.get("/stuffing/2026-11-02").json()["rows"]
    assert [(r["shipping_line"], r["teus"]) for r in rows] == [("ONELINE", 7)]
    # and a typed save replaces an uploaded day
    put(client, "2026-11-03", [{"shipping_line": "MAERSK", "teus": 1}])
    assert [r["shipping_line"] for r in client.get("/stuffing/2026-11-03").json()["rows"]] == ["MAERSK"]


def test_uploaded_datetime_vessel_dates_read_as_day(client):
    import datetime as dt
    up = make_xlsx([["HAPAG", 5, dt.datetime(2026, 11, 3), dt.datetime(2026, 11, 9, 14, 30)]],
                   ["Shipping Line", "TEUs", "Date", "FVSL ETD"])
    client.post("/stuffing/upload", files={"file": ("s.xlsx", up)})
    assert client.get("/stuffing/2026-11-03").json()["rows"][0]["fvsl_etd"] == "2026-11-09"


def test_dates_for_week(client):
    _type_week45(client)
    r = client.get("/stuffing/dates", params={"year": 2026, "week": 45})
    assert r.status_code == 200
    j = r.json()
    assert (j["year"], j["week"]) == (2026, 45)
    assert [d["date"] for d in j["days"]] == [f"2026-11-0{i}" for i in range(2, 9)]
    by = {d["date"]: (d["rows"], d["teus"]) for d in j["days"]}
    assert by["2026-11-02"] == (2, 8) and by["2026-11-03"] == (1, 4) and by["2026-11-04"] == (2, 12)
    assert by["2026-11-05"] == (3, 14) and by["2026-11-06"] == (0, 0) and by["2026-11-08"] == (0, 0)


@pytest.mark.parametrize("q", [{"year": 2026, "week": 0}, {"year": 2026, "week": 54}, {"year": 2026}, {"year": 2026, "week": "x"}])
def test_dates_bad_week(client, q):
    assert client.get("/stuffing/dates", params=q).status_code == 422


def test_routing_dates_and_upload_still_work(client):
    assert client.get("/stuffing/dates", params={"year": 2026, "week": 45}).status_code == 200
    up = make_xlsx([["HAPAG", 5, 1]], ["Shipping Line", "TEUs", "Qty"])
    assert client.post("/stuffing/upload", params={"report_date": D}, files={"file": ("s.xlsx", up)}).status_code == 200
