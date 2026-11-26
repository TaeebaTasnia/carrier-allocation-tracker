"""Small shared helpers."""
from __future__ import annotations

import datetime as dt
import math
import re

CARRIERS = ["MAERSK", "HAPAG", "HELLMAN", "ONE", "FML"]
SPLIT_CARRIERS = ["MAERSK", "HAPAG", "HELLMAN", "ONE"]

# Largest magnitude accepted for any quantity (TEU, CBM, Qty, %). Far above real values, far below the
# float range, so sums of many values can never overflow to inf (which JSON cannot carry).
MAX_ABS_NUM = 1e12
# Calendar range accepted for weeks and dates (ISO years).
YEAR_MIN, YEAR_MAX = 2000, 2100
DATE_MIN, DATE_MAX = dt.date(YEAR_MIN, 1, 1), dt.date(YEAR_MAX, 12, 31)


def finite_num(v) -> float | None:
    """Spreadsheet cell -> float, or None if it is not a number, NaN/Infinity, or beyond +-MAX_ABS_NUM."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) and abs(f) <= MAX_ABS_NUM else None


def strip_nul(s: str) -> str:
    """Remove NUL characters (an .xlsx can encode them as _x0000_; PostgreSQL text cannot store them)."""
    return s.replace("\x00", "") if "\x00" in s else s


def date_in_range(d: dt.date) -> bool:
    return DATE_MIN <= d <= DATE_MAX


def norm_code(value) -> str:
    """Normalize a supplier code to str: strip whitespace, drop trailing '.0'."""
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    s = strip_nul(str(value)).strip()
    if re.fullmatch(r"\d+\.0+", s):
        s = s.split(".")[0]
    return s


def norm_header(value) -> str:
    """Lower-case, trimmed header with separators collapsed, for alias matching."""
    s = str(value or "").strip().lower()
    return re.sub(r"[\s_\-/]+", " ", s)


def iso_key(d: dt.date) -> tuple[int, int]:
    c = d.isocalendar()
    return c[0], c[1]


def week_dates(year: int, week: int) -> list[dt.date]:
    return [dt.date.fromisocalendar(year, week, i) for i in range(1, 8)]
