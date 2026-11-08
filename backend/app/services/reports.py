"""openpyxl exports laid out like the UTILIZATION sheet.

TEU cells are written as whole numbers, rounded UP (see teu_up), as numbers not text. CBM cells and
percentages stay exact (2dp number format). Calculations everywhere else stay unrounded."""
from __future__ import annotations

import io
import math

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

from ..utils import CARRIERS

NUM = "0.00"
HEAD_FILL = PatternFill("solid", fgColor="DDEBF7")
BOLD = Font(bold=True)

TEU_EPS = 1e-6
BALANCE_BAND = 0.5


def teu_up(x, band: bool = False):
    """The one TEU display rule (same as CA.numbers.teu in frontend/js/numbers.js), display only.

    None / NaN -> None (an empty cell). Positive: ceil(x - 1e-6) (72.66 -> 73, 72.01 -> 73, 72.0 -> 72,
    28.000000000004 -> 28, 0.2 -> 1). Negative: away from zero by the same rule (-11.67 -> -12, -8.0 -> -8).
    band=True (the deficit/surplus figure): |x| <= 0.5 -> 0, so a "balanced" week never shows 1.
    Never returns -0 (always an int)."""
    if x is None:
        return None
    x = float(x)
    if math.isnan(x) or math.isinf(x):
        return None
    a = abs(x)
    if band and a <= BALANCE_BAND:
        return 0
    r = int(math.ceil(a - TEU_EPS))
    if r <= 0:
        return 0
    return -r if x < 0 else r

WEEKLY_HEAD = ["WEEK", "FORECAST", "TOTAL CONFIRMED", "TOTAL UTILIZED", "TO BE ARRIVED",
               "TO BE UTILIZED", "DEFICIT/SURPLUS", "STATUS"]


def _head(ws, row, labels, col=1):
    for i, t in enumerate(labels):
        c = ws.cell(row=row, column=col + i, value=t)
        c.font, c.fill, c.alignment = BOLD, HEAD_FILL, Alignment(horizontal="center")


def _put(ws, row, vals, col=1, bold=False):
    for i, v in enumerate(vals):
        c = ws.cell(row=row, column=col + i, value=v)
        if isinstance(v, float):
            c.number_format = NUM
        elif isinstance(v, int) and not isinstance(v, bool):
            c.number_format = "0"
        if bold:
            c.font = BOLD


def _weekly_block(ws, start_row, rows, total) -> int:
    _head(ws, start_row, WEEKLY_HEAD)
    r = start_row + 1
    for x in rows:
        _put(ws, r, [f"WK{x['week']}", teu_up(x["forecast"]), teu_up(x["total_confirmed"]), teu_up(x["total_utilized"]),
                     teu_up(x["to_be_arrived"]), teu_up(x["to_be_utilized"]), teu_up(x["deficit_surplus"], band=True), x["status"]])
        r += 1
    if total is not None:
        _put(ws, r, ["TOTAL", teu_up(total["forecast"]), teu_up(total["total_confirmed"]), teu_up(total["total_utilized"]),
                     teu_up(total["to_be_arrived"]), teu_up(total["to_be_utilized"]), teu_up(total["deficit_surplus"], band=True),
                     total["status"]], bold=True)
        r += 1
    return r


def _finish(wb: Workbook) -> bytes:
    for ws in wb.worksheets:
        for col in ws.columns:
            ws.column_dimensions[col[0].column_letter].width = 16
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def weekly_summary_xlsx(summary: dict) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "UTILIZATION"
    ws["A1"] = f"WEEKLY SUMMARY {summary['year']}"
    ws["A1"].font = BOLD
    _weekly_block(ws, 3, summary["weeks"], summary["year_total"])
    return _finish(wb)


def allocation_vs_utilization_xlsx(res: dict) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "UTILIZATION"
    ws["A1"] = f"ALLOCATION VS UTILIZATION - {res['year']} WK{res['week']}"
    ws["A1"].font = BOLD
    end = _weekly_block(ws, 3, [res], None)

    # carrier table: forecast / confirmed / utilized / left / % rows (rows = measures, cols = carriers)
    r = end + 1
    _head(ws, r, ["", *CARRIERS, "TOTAL"])
    car = res["carriers"]

    def line(label, key, total=None, teu=True):
        nonlocal r
        r += 1
        vals = [car[c][key] for c in CARRIERS]
        if teu:
            vals, total = [teu_up(v) for v in vals], teu_up(total)
        _put(ws, r, [label, *vals, total])

    line("FORECAST", "forecast", res["forecast"])  # MGH total, excludes FML
    line("CONFIRMED", "confirmed", res["total_confirmed"])
    line("UTILIZED", "utilized", res["total_utilized"])
    line("LEFT", "left", res["to_be_utilized"])
    line("% SHARE OF UTILIZED", "pct_share", 100.0 if res["total_utilized"] else 0.0, teu=False)
    line("% OF CONFIRMED", "pct_of_confirmed",
         (res["total_utilized"] / res["total_confirmed"] * 100.0) if res["total_confirmed"] else None, teu=False)

    # date-wise block
    r += 2
    _head(ws, r, ["DATE", *CARRIERS, "FORECAST CBM", "FORECAST TEUS", "ACTUAL CBM", "ACTUAL TEUS"])
    for d in res["daily"]:
        r += 1
        _put(ws, r, [d["date"].isoformat(), *[teu_up(d["carrier_teus"][c]) for c in CARRIERS],
                     d["forecast_cbm"], teu_up(d["forecast_teu"]),
                     # computed value (typed adjustment, else from stuffing); blank only when source is "none"
                     None if d["actual_cbm_source"] == "none" else d["actual_cbm"],
                     None if d["actual_cbm_source"] == "none" else teu_up(d["actual_teu"])])
    r += 1
    n = len(res["daily"])
    _put(ws, r, ["TOTAL", *[teu_up(car[c]["utilized"]) for c in CARRIERS],
                 sum(d["forecast_cbm"] for d in res["daily"]), teu_up(sum(d["forecast_teu"] for d in res["daily"])),
                 sum(d["actual_cbm"] for d in res["daily"]), teu_up(res["total_actual_teu"])], bold=True)
    for label, key in (("CONFIRMED", "confirmed"), ("UTILIZED", "utilized"), ("LEFT", "left")):
        r += 1
        _put(ws, r, [label, *[teu_up(car[c][key]) for c in CARRIERS]])
    r += 1
    _put(ws, r, ["% UTILIZED", *[car[c]["pct_share"] for c in CARRIERS]])
    r += 1
    _put(ws, r, ["% OF CONFIRMED", *[car[c]["pct_of_confirmed"] for c in CARRIERS]])
    return _finish(wb)
