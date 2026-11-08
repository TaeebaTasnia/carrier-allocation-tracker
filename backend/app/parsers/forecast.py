"""Forecast workbook parser: header-by-name, sheet 'Forecast' else first sheet."""
from __future__ import annotations

import datetime as dt
from typing import BinaryIO

import openpyxl

from ..utils import iso_key, norm_code, norm_header


class ParseError(ValueError):
    pass


def _find_cols(header) -> dict:
    cols = {}
    for i, h in enumerate(header):
        n = norm_header(h).rstrip(". ")
        if n == "rfi":
            cols["rfi"] = i
        elif n == "supplier":
            cols["supplier"] = i
        elif n.replace(" ", "").startswith("exp.volcbm") or n == "exp vol cbm":
            cols.setdefault("vol", i)
        elif n == "order":
            cols["order"] = i
    missing = [k for k in ("rfi", "supplier", "vol") if k not in cols]
    if missing:
        raise ParseError(f"Forecast sheet is missing required columns: {missing} (need Rfi, Supplier, exp.Vol cbm)")
    return cols


def _to_date(v):
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    if isinstance(v, str) and v.strip():
        try:
            return dt.datetime.fromisoformat(v.strip()).date()
        except ValueError:
            return None
    return None


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def parse_forecast(source: str | BinaryIO) -> list[dict]:
    """Return raw rows: iso_year, iso_week, rfi, supplier, order_no, vol_cbm.

    Rows without a valid Rfi (e.g. the totals row) are skipped.
    """
    wb = openpyxl.load_workbook(source, read_only=True, data_only=True)
    try:
        ws = wb["Forecast"] if "Forecast" in wb.sheetnames else wb[wb.sheetnames[0]]
        it = ws.iter_rows(values_only=True)
        header = next(it, None)
        if header is None:
            raise ParseError("Forecast sheet is empty")
        cols = _find_cols(header)
        out = []
        for r in it:
            if r is None or len(r) <= max(cols.values()):
                continue
            rfi = _to_date(r[cols["rfi"]])
            if rfi is None:
                continue
            y, w = iso_key(rfi)
            out.append({
                "iso_year": y, "iso_week": w, "rfi": rfi,
                "supplier": norm_code(r[cols["supplier"]]),
                "order_no": str(r[cols["order"]]) if "order" in cols and r[cols["order"]] is not None else "",
                "vol_cbm": _num(r[cols["vol"]]),
            })
        return out
    finally:
        wb.close()
