"""Forecast workbook parser: header-by-name, sheet 'Forecast' else first sheet."""
from __future__ import annotations

import datetime as dt
from typing import BinaryIO

import openpyxl

from ..utils import date_in_range, finite_num, iso_key, norm_code, norm_header, strip_nul
from .common import FileParseError, capped_rows


MAX_PREAMBLE_ROWS = 10  # title / blank rows allowed above the header row


class ParseError(FileParseError):
    pass


def _find_cols(header) -> dict:
    cols = {}
    for i, h in enumerate(header):
        n = norm_header(h).rstrip(". ")
        if n == "rfi":
            cols["rfi"] = i
        elif n == "supplier":
            # The newer export has two "Supplier" columns: the numeric supplier code first, then the
            # alpha CW/forwarder code. Only the first (numeric) one matches suppliers.code.
            cols.setdefault("supplier", i)
        elif n.replace(" ", "").startswith("exp.volcbm") or n == "exp vol cbm":
            cols.setdefault("vol", i)
        elif n == "order":
            cols["order"] = i
    missing = [k for k in ("rfi", "supplier", "vol") if k not in cols]
    if missing:
        raise ParseError(f"Forecast sheet is missing required columns: {missing} (need Rfi, Supplier, exp.Vol cbm)")
    return cols


def _to_date(v):
    """Cell -> date, or None if unreadable or outside the supported calendar range (2000-2100)."""
    d = _cell_date(v)
    return d if d is not None and date_in_range(d) else None


def _cell_date(v):
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
    """Non-numeric, NaN/Infinity or absurdly large cells count as 0 (same NaN-safe rule as stuffing)."""
    f = finite_num(v)
    return 0.0 if f is None else f


def parse_forecast(source: str | BinaryIO) -> list[dict]:
    """Return raw rows: iso_year, iso_week, rfi, supplier, order_no, vol_cbm.

    Rows without a valid Rfi (e.g. the totals row) are skipped.
    """
    wb = openpyxl.load_workbook(source, read_only=True, data_only=True)
    try:
        ws = wb["Forecast"] if "Forecast" in wb.sheetnames else wb[wb.sheetnames[0]]
        it = capped_rows(ws, "forecast file")
        first = next(it, None)
        if first is None:
            raise ParseError("Forecast sheet is empty")
        # The system's own export puts a title line and a blank row above the column names,
        # so look for the header in the first few rows (the data starts right after it).
        cols = None
        try:
            cols = _find_cols(first)
        except ParseError:
            for _ in range(MAX_PREAMBLE_ROWS):
                row = next(it, None)
                if row is None:
                    break
                try:
                    cols = _find_cols(row)
                    break
                except ParseError:
                    continue
        if cols is None:
            _find_cols(first)  # raises the "missing required columns" error for the first row
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
                "order_no": strip_nul(str(r[cols["order"]])) if "order" in cols and r[cols["order"]] is not None else "",
                "vol_cbm": _num(r[cols["vol"]]),
            })
        return out
    finally:
        wb.close()
