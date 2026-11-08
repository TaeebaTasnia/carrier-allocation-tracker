"""TEU display rule: whole TEU, rounded up (display and .xlsx only; JSON and maths stay exact)."""
import io

import openpyxl
import pytest

from app.services.reports import teu_up
from tests.test_actual_cbm import _setup, _typed_golden

# the same table is checked by the frontend script frontend/tests/teu-check.cjs
CASES = [
    (72.66, False, 73), (72.660565, False, 73), (72.01, False, 73), (72.0, False, 72),
    (28.000000000004, False, 28), (0.2, False, 1), (0, False, 0), (0.0, False, 0),
    (-11.67, False, -12), (-8.66, False, -9), (-8.0, False, -8),
    (-11.673292, True, -12), (-8.660565, True, -9), (-8.0, True, -8),
    (0.3, True, 0), (-0.3, True, 0), (0.5, True, 0), (-0.5, True, 0), (0.51, True, 1), (-0.51, True, -1),
    (1e-9, False, 0), (-1e-9, False, 0),
]


@pytest.mark.parametrize("x,band,want", CASES)
def test_teu_up_table(x, band, want):
    got = teu_up(x, band=band)
    assert got == want and isinstance(got, int)
    assert str(got) != "-0"


def test_teu_up_empty():
    assert teu_up(None) is None
    assert teu_up(float("nan")) is None


def _rows(content):
    ws = openpyxl.load_workbook(io.BytesIO(content)).active
    return [[c.value for c in row] for row in ws.iter_rows()]


def _is_whole(v):
    return isinstance(v, int) and not isinstance(v, bool)


def test_xlsx_teu_cells_are_whole_numbers_and_json_stays_exact(client):
    _setup(client)
    _typed_golden(client)          # week 45: to be arrived 47.673292, deficit -11.673292
    js = client.get("/reports/allocation-vs-utilization", params={"year": 2026, "week": 45}).json()
    assert js["forecast"] == pytest.approx(72.660565, abs=1e-4)          # JSON exact
    assert js["to_be_arrived"] == pytest.approx(47.673292, abs=1e-4)
    assert js["deficit_surplus"] == pytest.approx(-11.673292, abs=1e-4)

    rows = _rows(client.get("/reports/allocation-vs-utilization/download", params={"year": 2026, "week": 45}).content)
    wk = next(x for x in rows if x[0] == "WK45")
    # FORECAST, CONFIRMED, UTILIZED, TO BE ARRIVED, TO BE UTILIZED, DEFICIT/SURPLUS
    assert wk[1:7] == [73, 64, 28, 48, 36, -12]
    assert all(_is_whole(v) for v in wk[1:7])

    head = next(x for x in rows if x[1:2] == ["MAERSK"])
    forecast = next(x for x in rows if x[0] == "FORECAST")
    assert forecast[head.index("TOTAL")] == 73 and all(_is_whole(v) for v in forecast[1:] if v is not None)
    for label in ("CONFIRMED", "UTILIZED", "LEFT"):
        for row in (x for x in rows if x[0] == label):
            assert all(_is_whole(v) for v in row[1:] if v is not None), (label, row)

    # percentages stay exact (not whole TEU)
    pct = next(x for x in rows if x[0] == "% OF CONFIRMED")
    assert any(isinstance(v, float) and v != int(v) for v in pct[1:] if v is not None)

    # date-wise grid: TEU columns whole, CBM columns exact
    dh = next(i for i, x in enumerate(rows) if x[0] == "DATE")
    cols = rows[dh]
    f_cbm, f_teu = cols.index("FORECAST CBM"), cols.index("FORECAST TEUS")
    a_cbm, a_teu = cols.index("ACTUAL CBM"), cols.index("ACTUAL TEUS")
    day_rows = [x for x in rows[dh + 1:] if isinstance(x[0], str) and x[0].startswith("2026-")]
    assert day_rows
    for x in day_rows:
        assert all(_is_whole(v) for v in x[1:6]), x
        assert _is_whole(x[f_teu])
        if x[a_teu] is not None:
            assert _is_whole(x[a_teu])
    nov2 = next(x for x in day_rows if x[0] == "2026-11-02")
    assert nov2[a_cbm] == pytest.approx(276.24) and nov2[a_teu] == 9      # 8.37 TEU rounded up, CBM exact
    total = next(x for x in rows[dh + 1:] if x[0] == "TOTAL")
    assert _is_whole(total[f_teu]) and _is_whole(total[a_teu]) and total[a_teu] == 25    # 824.58 / 33 = 24.99
    assert isinstance(total[a_cbm], float) and total[a_cbm] == pytest.approx(824.58)


def test_weekly_summary_xlsx_whole_teu(client):
    _setup(client)
    _typed_golden(client)
    rows = _rows(client.get("/reports/weekly-summary/download",
                            params={"year": 2026, "from_week": 45, "to_week": 47}).content)
    for x in rows:
        if x[0] and (x[0].startswith("WK") or x[0] == "TOTAL"):
            assert all(_is_whole(v) for v in x[1:7]), x
    wk45 = next(x for x in rows if x[0] == "WK45")
    assert wk45[1] == 73 and wk45[6] == -12
