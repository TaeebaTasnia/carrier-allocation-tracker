import datetime as dt

import pytest

from app.config_service import ConfigError, get_config, update_config, validate
from app.utils import norm_code
from tests.conftest import make_xlsx

HEAD = ["Shipping Line", "TEUs", "Qty", "Date", "Feeder Vessel"]
DAY = dt.datetime(2026, 11, 5)


@pytest.mark.parametrize("v", ["77534", 77534, 77534.0, "77534.0", " 77534 "])
def test_norm_code(v):
    assert norm_code(v) == "77534"


def test_config_validation(db):
    base = get_config(db)
    bad = dict(base, split={"MAERSK": 30, "HAPAG": 25, "HELLMAN": 20, "ONE": 20})
    with pytest.raises(ConfigError):
        validate(bad)
    with pytest.raises(ConfigError):
        validate(dict(base, cbm_per_teu=0))
    with pytest.raises(ConfigError):
        validate(dict(base, cbm_per_teu=-5))
    assert update_config(db, {"uplift_pct": 25})["uplift_pct"] == 25


def test_config_api(client):
    assert client.get("/config").json()["cbm_per_teu"] == 33
    r = client.put("/config", json={"split": {"MAERSK": 50, "HAPAG": 25, "HELLMAN": 20, "ONE": 25}})
    assert r.status_code == 422
    assert client.put("/config", json={"cbm_per_teu": 0}).status_code == 422
    assert client.put("/config", json={"fml_default": 12}).json()["fml_default"] == 12


def _stuff(client, rows, **params):
    data = make_xlsx(rows, HEAD)
    return client.post("/stuffing/upload", params=params,
                       files={"file": ("s.xlsx", data, "application/octet-stream")})


def test_stuffing_upload_and_replace(client):
    rows = [["FML-ONELINE", 6, 3, DAY, "FV1"], ["ONELINE", 4, 2, DAY, "FV2"],
            ["MAERSK", 4, 2, DAY, "FV3"], ["WEIRDLINE", 2, 1, DAY, "FV4"]]
    r = _stuff(client, rows)
    assert r.status_code == 200, r.text
    body = r.json()
    t = body["carrier_teus"]["2026-11-05"]
    assert (t["FML"], t["ONE"], t["MAERSK"]) == (6, 4, 4)
    assert body["unmapped_lines"] == [{"shipping_line": "WEIRDLINE", "teus": 2.0}]
    wk = client.get("/weekly/2026/45").json()
    assert wk["carriers"]["FML"]["utilized"] == 6 and wk["total_utilized"] == 14
    # re-upload replaces that date
    _stuff(client, [["MAERSK", 1, 1, DAY, "X"]])
    wk = client.get("/weekly/2026/45").json()
    assert wk["total_utilized"] == 1 and wk["carriers"]["ONE"]["utilized"] == 0


def test_stuffing_report_date_param(client):
    data = make_xlsx([["HLC", 3]], ["Line", "TEUs"])
    assert client.post("/stuffing/upload", files={"file": ("s.xlsx", data)}).status_code == 400
    r = client.post("/stuffing/upload", params={"report_date": "2026-11-04"}, files={"file": ("s.xlsx", data)})
    assert r.json()["carrier_teus"]["2026-11-04"]["HAPAG"] == 3


def test_suppliers_api(client):
    assert len(client.get("/suppliers").json()) == 12
    assert client.post("/suppliers/77534.0", json={"name": "X", "cw_code": "Y"}).json()["code"] == "77534"
    assert client.delete("/suppliers/99999").status_code == 404
    up = make_xlsx([[" 90001 ", "Foo", "FOOCW"], [90002.0, "Bar", "BARCW"]], ["SUPPLIER CODE", "SUPPLIER", "CW CODE"])
    r = client.post("/suppliers/upload", files={"file": ("s.xlsx", up)})
    assert r.json()["added"] == 2
    codes = {s["code"] for s in client.get("/suppliers").json()}
    assert {"90001", "90002"} <= codes


def test_weekly_and_daily_api(client):
    r = client.put("/weekly/2026/46", json={"confirmed": {"MAERSK": 5, "FML": 2}})
    assert r.status_code == 200 and r.json()["total_confirmed"] == 7
    assert client.put("/weekly/2026/46", json={"confirmed": {"BAD": 1}}).status_code == 422
    r = client.put("/daily/2026-11-10", json={"actual_cbm": 66})
    assert r.json()["actual_teu"] == 2
    assert client.put("/daily/2026-11-10", json={"actual_cbm": None}).json()["actual_teu"] == 0
