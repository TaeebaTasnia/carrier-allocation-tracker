import io

import openpyxl
import pytest

from tests.conftest import REAL_FORECAST, make_xlsx


def test_end_to_end(client, real_rows):
    with open(REAL_FORECAST, "rb") as f:
        r = client.post("/forecast/upload", files={"file": ("f.xlsx", f)})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mgh_rows"] > 0 and body["unmatched_supplier_codes"]
    wk = {(w["year"], w["week"]): w for w in body["week_totals"]}
    assert wk[(2026, 45)]["teu"] == pytest.approx(72.660565, abs=1e-4)

    # re-upload is idempotent (replaces weeks, no duplicates)
    with open(REAL_FORECAST, "rb") as f:
        client.post("/forecast/upload", files={"file": ("f.xlsx", f)})
    g = client.get("/forecast/weeks/2026/45").json()
    assert g["cbm_plus"] == pytest.approx(2397.79865, abs=1e-4)
    assert any(d["date"] == "2026-11-02" and abs(d["forecast_cbm"] - 353.19245) < 1e-4 for d in g["daily"])

    conf = {46: {"MAERSK": 20, "HAPAG": 20, "HELLMAN": 10, "ONE": 20, "FML": 0},
            47: {"MAERSK": 15, "HAPAG": 20, "HELLMAN": 0, "ONE": 20, "FML": 0},
            45: {"MAERSK": 20, "HAPAG": 20, "HELLMAN": 10, "ONE": 20, "FML": 10}}
    for w, c in conf.items():
        assert client.put(f"/weekly/2026/{w}", json={"confirmed": c}).status_code == 200
    # forecast re-upload must not touch confirmed
    assert client.get("/weekly/2026/46").json()["total_confirmed"] == 70
    assert client.get("/weekly/2026/46").json()["deficit_surplus"] == pytest.approx(-17.766920, abs=1e-4)
    assert client.get("/weekly/2026/47").json()["deficit_surplus"] == pytest.approx(7.569331, abs=1e-4)

    st = make_xlsx([["FML-ONELINE", 6, 1, "2026-11-05"], ["ONELINE", 4, 1, "2026-11-05"]],
                   ["Shipping Line", "TEUs", "Qty", "Date"])
    assert client.post("/stuffing/upload", files={"file": ("s.xlsx", st)}).status_code == 200

    s = client.get("/reports/weekly-summary", params={"year": 2026, "from_week": 45, "to_week": 47}).json()
    assert [w["week"] for w in s["weeks"]] == [45, 46, 47]
    assert s["weeks"][1]["status"] == "deficit" and s["weeks"][2]["status"] == "surplus"

    r = client.get("/reports/weekly-summary/download", params={"year": 2026, "from_week": 45, "to_week": 47})
    assert r.status_code == 200 and "spreadsheetml" in r.headers["content-type"]
    ws = openpyxl.load_workbook(io.BytesIO(r.content)).active
    vals = [[c.value for c in row] for row in ws.iter_rows()]
    assert ["WEEK", "FORECAST", "TOTAL CONFIRMED", "TOTAL UTILIZED", "TO BE ARRIVED",
            "TO BE UTILIZED", "DEFICIT/SURPLUS", "STATUS"] in vals
    assert any(row[0] == "WK46" for row in vals) and any(row[0] == "TOTAL" for row in vals)

    r = client.get("/reports/allocation-vs-utilization/download", params={"year": 2026, "week": 45})
    assert r.status_code == 200
    ws = openpyxl.load_workbook(io.BytesIO(r.content)).active
    flat = [str(c.value) for row in ws.iter_rows() for c in row if c.value is not None]
    for label in ("DATE", "FORECAST CBM", "FORECAST TEUS", "ACTUAL CBM", "ACTUAL TEUS", "CONFIRMED",
                  "UTILIZED", "LEFT", "2026-11-02", "2026-11-05"):
        assert label in flat, label
    js = client.get("/reports/allocation-vs-utilization", params={"year": 2026, "week": 45}).json()
    assert js["carriers"]["FML"]["utilized"] == 6 and js["carriers"]["ONE"]["utilized"] == 4
    assert js["carriers"]["FML"]["pct_of_confirmed"] == pytest.approx(60.0)
