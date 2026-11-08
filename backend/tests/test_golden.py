import datetime as dt

import pytest

from app.config_service import get_config
from app.services import calc, data

TOL = 1e-4


def test_golden_weeks(loaded_db):
    cfg = get_config(loaded_db)
    vols = lambda w: data.mgh_vol_by_date(loaded_db, 2026, w)
    w45 = calc.forecast_for_week(vols(45), cfg)
    assert w45["cbm_plus"] == pytest.approx(2397.79865, abs=TOL)
    assert w45["teu"] == pytest.approx(72.660565, abs=TOL)
    exp = {"MAERSK": 21.798170, "HAPAG": 18.165141, "HELLMAN": 14.532113, "ONE": 18.165141}
    for k, v in exp.items():
        assert w45["carrier_teu"][k] == pytest.approx(v, abs=TOL)
    w46 = calc.forecast_for_week(vols(46), cfg)
    assert w46["cbm_plus"] == pytest.approx(2896.30835, abs=TOL)
    assert w46["teu"] == pytest.approx(87.766920, abs=TOL)
    w47 = calc.forecast_for_week(vols(47), cfg)
    assert w47["cbm_plus"] == pytest.approx(1565.21209, abs=TOL)
    assert w47["teu"] == pytest.approx(47.430669, abs=TOL)


def test_daily_forecast_by_rfi_date(loaded_db):
    # Excel serial 46328 -> calendar date
    d = dt.date(1899, 12, 30) + dt.timedelta(days=46328)
    assert d == dt.date(2026, 11, 2)
    cfg = get_config(loaded_db)
    fc = calc.forecast_for_week(data.mgh_vol_by_date(loaded_db, 2026, 45), cfg)
    assert fc["daily"][d]["cbm"] == pytest.approx(353.19245, abs=TOL)


def test_deficits_wk46_wk47(loaded_db):
    cfg = get_config(loaded_db)
    for wk, conf, expected in ((46, (20, 20, 10, 20, 0), -17.766920), (47, (15, 20, 0, 20, 0), 7.569331)):
        entry = {"confirmed": dict(zip(["MAERSK", "HAPAG", "HELLMAN", "ONE", "FML"], conf)), "fml_forecast": None}
        res = calc.week_calc(cfg, data.mgh_vol_by_date(loaded_db, 2026, wk), {}, {}, entry)
        assert res["total_confirmed"] == sum(conf)
        assert res["deficit_surplus"] == pytest.approx(expected, abs=TOL)


def test_wk45_share_of_utilized(loaded_db):
    cfg = get_config(loaded_db)
    day = dt.date(2026, 11, 3)
    stuff = {day: {"MAERSK": 2.0, "HAPAG": 16.0, "HELLMAN": 0.0, "ONE": 10.0, "FML": 0.0}}
    res = calc.week_calc(cfg, data.mgh_vol_by_date(loaded_db, 2026, 45), stuff, {}, None)
    pct = [res["carriers"][c]["pct_share"] for c in ("MAERSK", "HAPAG", "HELLMAN", "ONE", "FML")]
    assert pct == pytest.approx([7.142857, 57.142857, 0, 35.714286, 0], abs=1e-4)


def test_override_changes_actuals(loaded_db):
    cfg = get_config(loaded_db)
    day = dt.date(2026, 11, 3)
    base = calc.week_calc(cfg, data.mgh_vol_by_date(loaded_db, 2026, 45), {day: {"ONE": 10.0}}, {}, None)
    ov = calc.week_calc(cfg, data.mgh_vol_by_date(loaded_db, 2026, 45), {day: {"ONE": 10.0}}, {day: 33.0}, None)
    # no typed value -> computed from stuffing (10 TEU x 33); a typed value replaces it
    assert base["daily"][1]["actual_cbm"] == pytest.approx(330.0) and base["total_actual_teu"] == pytest.approx(10.0)
    assert base["daily"][1]["actual_cbm_override"] is None and base["daily"][1]["actual_cbm_source"] == "stuffing_teu"
    assert ov["daily"][1]["actual_cbm"] == pytest.approx(33.0) and ov["daily"][1]["actual_teu"] == pytest.approx(1.0)
    assert ov["daily"][1]["actual_cbm_source"] == "entered"
    assert ov["to_be_arrived"] == pytest.approx(base["to_be_arrived"] + 9.0)


def test_all_12_seed_suppliers_match(loaded_db, real_rows):
    """Diagnostic: which workbook supplier codes are MGH (match the 12 seeds)."""
    from app.models import Supplier
    seeds = {s.code for s in loaded_db.query(Supplier)}
    codes = {r["supplier"] for r in real_rows}
    assert len(seeds) == 12
    matched = seeds & codes
    assert matched == seeds - {"77580"}  # 77580 is absent from the workbook
