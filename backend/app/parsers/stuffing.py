"""Daily-stuffing export parser with header aliases."""
from __future__ import annotations

import datetime as dt
import math
from typing import BinaryIO

import openpyxl

from ..utils import norm_header

ALIASES = {
    "line": {"shipping line", "shippingline", "line", "carrier"},
    "teus": {"teus", "teu"},
    "qty": {"qty", "quantity"},
    # optional: volume of the row in CBM (never the TEUs / Qty columns)
    "cbm": {"cbm", "total cbm", "cbm total", "volume", "vol", "volume cbm", "vol cbm", "m3", "cube"},
    "date": {"date", "stuffing date", "stuffingdate"},
    "feeder_vessel": {"feeder vessel", "feeder", "fvsl"},
    "fvsl_etd": {"fvsl etd", "feeder etd"},
    "fvsl_eta": {"fvsl eta", "feeder eta"},
    "mother_vessel": {"mother vessel", "mother", "mvsl"},
    "mvsl_etd": {"mvsl etd", "mother etd"},
    "mvsl_eta": {"mvsl eta", "mother eta"},
}


class StuffingParseError(ValueError):
    pass


def _to_date(v):
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    if isinstance(v, str) and v.strip():
        s = v.strip()
        for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d-%b-%Y", "%d %b %Y", "%m/%d/%Y"):
            try:
                return dt.datetime.strptime(s, fmt).date()
            except ValueError:
                pass
    return None


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _text(v):
    if v is None:
        return None
    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat()
    s = str(v).strip()
    return s or None


def parse_stuffing(source: str | BinaryIO, report_date: dt.date | None) -> tuple[list[dict], list[str]]:
    """Return (rows, skipped_notes). Each row has date, line, teus, qty, cbm and vessel fields.

    `cbm` is None for a row whose CBM cell is blank/non-numeric or when the file has no CBM column.
    `parse_stuffing_ex` additionally reports whether the file has a CBM column at all.
    """
    return parse_stuffing_ex(source, report_date)[:2]


def parse_stuffing_ex(source: str | BinaryIO, report_date: dt.date | None) -> tuple[list[dict], list[str], bool]:
    """Like parse_stuffing but also returns whether the file has a CBM column."""
    wb = openpyxl.load_workbook(source, read_only=True, data_only=True)
    try:
        rows = list(wb[wb.sheetnames[0]].iter_rows(values_only=True))
    finally:
        wb.close()
    hdr_i, cols = None, {}
    for i, row in enumerate(rows[:20]):
        found = {}
        for ci, c in enumerate(row):
            n = norm_header(c)
            for key, al in ALIASES.items():
                if n in al and key not in found:
                    found[key] = ci
        if "line" in found and "teus" in found:
            hdr_i, cols = i, found
            break
    if hdr_i is None:
        raise StuffingParseError("Could not find header row with a shipping line column and a TEUs column")
    if "date" not in cols and report_date is None:
        raise StuffingParseError("No date column in file; supply the report_date query parameter")
    out, skipped = [], []
    for ri, r in enumerate(rows[hdr_i + 1:], start=hdr_i + 2):
        def g(k):
            ci = cols.get(k)
            return r[ci] if ci is not None and ci < len(r) else None
        line = _text(g("line"))
        teus = _num(g("teus"))
        if line is None and teus is None:
            continue
        if line is None or teus is None:
            skipped.append(f"row {ri}: missing shipping line or numeric TEUs")
            continue
        if "date" in cols:
            d = _to_date(g("date"))
            if d is None:
                if report_date is None:
                    skipped.append(f"row {ri}: unreadable date")
                    continue
                d = report_date
        else:
            d = report_date
        out.append({
            "date": d, "line": line, "teus": teus, "qty": _num(g("qty")), "cbm": _num(g("cbm")),
            **{k: _text(g(k)) for k in ("feeder_vessel", "fvsl_etd", "fvsl_eta",
                                        "mother_vessel", "mvsl_etd", "mvsl_eta")},
        })
    return out, skipped, "cbm" in cols
