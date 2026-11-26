"""Actual CBM per day comes from the daily stuffing report (row CBM, else TEUs x 33); a typed adjustment wins."""
import datetime as dt
import io

import openpyxl
import pytest
from sqlalchemy import create_engine, inspect, text

from app.parsers.stuffing import parse_stuffing, parse_stuffing_ex
from tests.conftest import REAL_FORECAST, alembic_upgrade, make_xlsx

TOL = 1e-4
CONF = {"MAERSK": 20, "HAPAG": 24, "HELLMAN": 0, "ONE": 10, "FML": 10}
STUFF = [  # (line, teus, date)
    ("MAERSK", 2, "2026-11-02"), ("ONELINE", 6, "2026-11-02"), ("ONELINE", 4, "2026-11-03"),
    ("HAPAG", 4, "2026-11-04"), ("HAPAG", 12, "2026-11-05"),
]
HDR = ["Shipping Line", "TEUs", "Qty", "Date"]


def _fc(client):
    with open(REAL_FORECAST, "rb") as f:
        assert client.post("/forecast/upload", files={"file": ("f.xlsx", f)}).status_code == 200


def _setup(client, stuffing=True, confirmed=True):
    _fc(client)
    if confirmed:
        client.put("/weekly/2026/45", json={"confirmed": CONF})
    if stuffing:
        rows = [[ln, t, 1, dt.datetime.fromisoformat(d)] for ln, t, d in STUFF]
        r = client.post("/stuffing/upload", files={"file": ("s.xlsx", make_xlsx(rows, HDR))})
        assert r.status_code == 200
        return r.json()


def _upload(client, rows, header):
    r = client.post("/stuffing/upload", files={"file": ("s.xlsx", make_xlsx(rows, header))})
    assert r.status_code == 200
    return r.json()


def _day(client, d):
    return client.get("/daily/" + d).json()


def _grid(client):
    r = client.get("/reports/allocation-vs-utilization/download", params={"year": 2026, "week": 45})
    ws = openpyxl.load_workbook(io.BytesIO(r.content)).active
    return {row[0].value: [c.value for c in row] for row in ws.iter_rows()
            if isinstance(row[0].value, str) and row[0].value.startswith("2026-11-")}, \
           [[c.value for c in row] for row in ws.iter_rows()]


def _typed_golden(client):
    for d, v in (("2026-11-02", 276.24), ("2026-11-03", 137.65), ("2026-11-04", 410.69), ("2026-11-05", 0)):
        assert client.put("/daily/" + d, json={"actual_cbm": v}).status_code == 200


# ---- workbook golden via the "entered" path ----
def test_workbook_week45_golden_entered(client):
    _setup(client)
    _typed_golden(client)
    w = client.get("/weekly/2026/45").json()
    # 14-supplier list (12 suppliers before 2026-11-26: forecast 72.660565, to be arrived 47.673292,
    # deficit -11.673292)
    assert w["forecast"] == pytest.approx(132.399505, abs=TOL)
    assert w["total_confirmed"] == 64 and w["total_utilized"] == 28
    assert w["total_actual_teu"] == pytest.approx(824.58 / 33, abs=TOL)
    assert w["to_be_arrived"] == pytest.approx(132.399505 - 824.58 / 33, abs=TOL)
    assert w["to_be_arrived"] == pytest.approx(107.412232, abs=TOL)
    assert w["to_be_utilized"] == 36
    assert w["deficit_surplus"] == pytest.approx(-71.412232, abs=TOL)
    assert w["status"] == "deficit"
    days = {d["date"]: d for d in client.get("/daily", params={"year": 2026, "week": 45}).json()["days"]}
    assert sum(d["actual_cbm"] for d in days.values()) == pytest.approx(824.58)
    assert days["2026-11-05"]["actual_cbm"] == 0 and days["2026-11-05"]["actual_cbm_override"] == 0
    assert all(d["actual_cbm_source"] == "entered" for d in days.values() if d["date"] <= "2026-11-05")
    assert days["2026-11-04"]["actual_cbm_override"] == pytest.approx(410.69)


# ---- no CBM column: stuffed TEU x 33 ----
def test_no_cbm_column_uses_teu_x_33(client):
    up = _setup(client)
    assert up["cbm_column_found"] is False and up["carrier_cbm"] == {} and up["cbm_by_date"] == {}
    w = client.get("/weekly/2026/45").json()
    assert w["total_actual_teu"] == pytest.approx(28.0)
    assert w["to_be_arrived"] == pytest.approx(132.399505 - 28, abs=TOL)  # 14 suppliers (12: 72.660565 - 28)
    assert w["to_be_arrived"] == pytest.approx(104.399505, abs=TOL)
    assert w["to_be_utilized"] == 36
    assert w["deficit_surplus"] == pytest.approx(36 - 104.399505, abs=TOL)
    assert w["deficit_surplus"] == pytest.approx(-68.399505, abs=TOL)
    days = {d["date"]: d for d in client.get("/daily", params={"year": 2026, "week": 45}).json()["days"]}
    for d, teu in (("2026-11-02", 8), ("2026-11-03", 4), ("2026-11-04", 4), ("2026-11-05", 12)):
        assert days[d]["actual_cbm"] == pytest.approx(teu * 33) and days[d]["actual_teu"] == pytest.approx(teu)
        assert days[d]["actual_cbm_source"] == "stuffing_teu" and days[d]["actual_cbm_override"] is None
    assert days["2026-11-06"]["actual_cbm_source"] == "none" and days["2026-11-06"]["actual_cbm"] == 0


# ---- with a CBM column ----
def test_cbm_column_is_used(client):
    _fc(client)
    client.put("/weekly/2026/45", json={"confirmed": CONF})
    rows = [["MAERSK", 2, 1, dt.datetime(2026, 11, 2), 70.5], ["ONELINE", 6, 1, dt.datetime(2026, 11, 2), 205.74],
            ["ONELINE", 4, 1, dt.datetime(2026, 11, 3), 137.65]]
    up = _upload(client, rows, HDR + ["CBM"])
    assert up["cbm_column_found"] is True
    assert up["cbm_by_date"] == {"2026-11-02": pytest.approx(276.24), "2026-11-03": pytest.approx(137.65)}
    assert up["carrier_cbm"]["2026-11-02"] == {"MAERSK": pytest.approx(70.5), "ONE": pytest.approx(205.74)}
    assert up["carrier_teus"]["2026-11-02"] == {"MAERSK": 2, "ONE": 6}  # unchanged semantics
    d = _day(client, "2026-11-02")
    assert d["actual_cbm"] == pytest.approx(276.24) and d["actual_cbm_source"] == "stuffing_cbm"
    assert d["stuffed_teus"] == 8  # utilized unaffected by the CBM
    w = client.get("/weekly/2026/45").json()
    assert w["total_actual_teu"] == pytest.approx((276.24 + 137.65) / 33, abs=TOL)
    assert w["total_utilized"] == 12


def test_mixed_rows(client):
    _fc(client)
    rows = [["MAERSK", 2, 1, dt.datetime(2026, 11, 2), 70.5], ["ONELINE", 6, 1, dt.datetime(2026, 11, 2), None],
            ["HAPAG", 3, 1, dt.datetime(2026, 11, 3), "n/a"], ["HAPAG", 1, 1, dt.datetime(2026, 11, 4), 40]]
    up = _upload(client, rows, HDR + ["CBM"])
    d2, d3, d4 = (_day(client, "2026-11-0" + str(i)) for i in (2, 3, 4))
    assert d2["actual_cbm"] == pytest.approx(70.5 + 6 * 33) and d2["actual_cbm_source"] == "stuffing_mixed"
    assert d3["actual_cbm"] == pytest.approx(99) and d3["actual_cbm_source"] == "stuffing_teu"  # non-numeric = no CBM
    assert d4["actual_cbm"] == pytest.approx(40) and d4["actual_cbm_source"] == "stuffing_cbm"
    assert up["cbm_by_date"] == {"2026-11-02": pytest.approx(70.5), "2026-11-04": pytest.approx(40)}


def test_unmapped_line_still_counts_as_arrived(client):
    _fc(client)
    _upload(client, [["WEIRDLINE", 5, 1, dt.datetime(2026, 11, 3)]], HDR)
    d = _day(client, "2026-11-03")
    assert d["stuffed_teus"] == 0 and d["actual_cbm"] == pytest.approx(165)


# ---- typed adjustment ----
def test_adjustment_overrides_and_clearing_restores(client):
    _setup(client)
    base = client.get("/weekly/2026/45").json()
    r = client.put("/daily/2026-11-03", json={"actual_cbm": 66}).json()
    assert r["actual_cbm"] == 66 and r["actual_teu"] == 2 and r["actual_cbm_override"] == 66
    assert r["actual_cbm_source"] == "entered" and r["stuffed_teus"] == 4
    assert r["actual_cbm_computed"] == pytest.approx(132) and r["actual_cbm_computed_source"] == "stuffing_teu"
    w = client.get("/weekly/2026/45").json()
    assert w["to_be_arrived"] == pytest.approx(base["to_be_arrived"] + 2)
    r = client.put("/daily/2026-11-03", json={"actual_cbm": 0}).json()  # 0 is a value
    assert r["actual_cbm"] == 0 and r["actual_cbm_source"] == "entered"
    r = client.put("/daily/2026-11-03", json={"actual_cbm": None}).json()
    assert r["actual_cbm"] == pytest.approx(132) and r["actual_cbm_override"] is None
    assert r["actual_cbm_source"] == "stuffing_teu"
    assert client.get("/weekly/2026/45").json()["to_be_arrived"] == pytest.approx(base["to_be_arrived"])


def test_adjustment_on_day_without_stuffing_and_source_none(client):
    _setup(client)
    assert _day(client, "2026-11-06")["actual_cbm_source"] == "none"
    r = client.put("/daily/2026-11-06", json={"actual_cbm": 33}).json()
    assert r["actual_cbm_source"] == "entered" and r["actual_teu"] == 1
    r = client.put("/daily/2026-11-06", json={"actual_cbm": None}).json()
    assert r["actual_cbm_source"] == "none" and r["actual_cbm"] == 0


def test_reupload_changes_actual(client):
    _setup(client)
    st = make_xlsx([["MAERSK", 30, 1, dt.datetime(2026, 11, 3)]], HDR)
    client.post("/stuffing/upload", files={"file": ("s.xlsx", st)})
    d3 = _day(client, "2026-11-03")
    assert d3["stuffed_teus"] == 30 and d3["actual_cbm"] == pytest.approx(990)


# ---- xlsx ----
def test_xlsx_cells(client):
    _setup(client)
    cols = lambda row: (row[-2], row[-1])  # ACTUAL CBM, ACTUAL TEUS
    days, rows = _grid(client)
    assert cols(days["2026-11-03"]) == (pytest.approx(132), pytest.approx(4))
    assert cols(days["2026-11-06"]) == (None, None)  # source none -> empty
    client.put("/daily/2026-11-06", json={"actual_cbm": 0})
    days, _ = _grid(client)
    assert cols(days["2026-11-06"]) == (0, 0)  # an entered 0 shows
    client.put("/daily/2026-11-04", json={"actual_cbm": 66})
    days, rows = _grid(client)
    assert cols(days["2026-11-04"]) == (66, 2)
    total = next(r for r in rows if r[0] == "TOTAL")
    assert total[-1] == pytest.approx(8 + 4 + 2 + 12)


# ---- parser ----
@pytest.mark.parametrize("alias", ["CBM", "Total CBM", "cbm total", " VOLUME ", "Vol", "Volume CBM", "vol_cbm", "M3", "Cube"])
def test_parser_cbm_aliases(alias):
    data = make_xlsx([["MAERSK", 2, 1, 55.5]], ["Shipping Line", "TEUs", "Qty", alias])
    rows, _, found = parse_stuffing_ex(io.BytesIO(data), dt.date(2026, 11, 2))
    assert found is True and rows[0]["cbm"] == 55.5 and rows[0]["teus"] == 2 and rows[0]["qty"] == 1


def test_parser_no_cbm_column_and_never_teus_or_qty():
    data = make_xlsx([["MAERSK", 2, 7]], ["Shipping Line", "TEUs", "Qty"])
    rows, skipped, found = parse_stuffing_ex(io.BytesIO(data), dt.date(2026, 11, 2))
    assert found is False and rows[0]["cbm"] is None and rows[0]["teus"] == 2 and rows[0]["qty"] == 7
    assert parse_stuffing(io.BytesIO(data), dt.date(2026, 11, 2))[0] == rows


def test_parser_blank_and_text_cbm_is_none():
    data = make_xlsx([["MAERSK", 2, 1, None], ["HAPAG", 1, 1, "abc"], ["ONE", 1, 1, 0]],
                     ["Shipping Line", "TEUs", "Qty", "CBM"])
    rows, _, found = parse_stuffing_ex(io.BytesIO(data), dt.date(2026, 11, 2))
    assert found and [r["cbm"] for r in rows] == [None, None, 0.0]


# ---- migration ----
def test_baseline_migration_has_cbm_column_and_is_repeatable(fresh_db_url):
    """Replaces the old startup `ALTER TABLE ... ADD COLUMN cbm` test: the schema now comes from the Alembic
    baseline. Upgrading an empty database creates daily_stuffing with a nullable `cbm` column; running the
    upgrade again changes nothing; a row without CBM reads back as None."""
    alembic_upgrade(fresh_db_url)
    alembic_upgrade(fresh_db_url)  # idempotent: already at head
    eng = create_engine(fresh_db_url)
    try:
        cols = {c["name"]: c for c in inspect(eng).get_columns("daily_stuffing")}
        assert list(cols).count("cbm") == 1 and cols["cbm"]["nullable"] is True
        with eng.begin() as c:
            c.execute(text("INSERT INTO daily_stuffing (date, shipping_line, carrier, teus, qty) "
                           "VALUES ('2026-11-03', 'MAERSK', 'MAERSK', 4.0, 1.0)"))
        with eng.connect() as c:
            row = c.execute(text("SELECT shipping_line, teus, qty, cbm FROM daily_stuffing")).one()
        assert tuple(row) == ("MAERSK", 4.0, 1.0, None)
    finally:
        eng.dispose()
