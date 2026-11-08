"""Small shared helpers."""
from __future__ import annotations

import datetime as dt
import re

CARRIERS = ["MAERSK", "HAPAG", "HELLMAN", "ONE", "FML"]
SPLIT_CARRIERS = ["MAERSK", "HAPAG", "HELLMAN", "ONE"]


def norm_code(value) -> str:
    """Normalize a supplier code to str: strip whitespace, drop trailing '.0'."""
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    s = str(value).strip()
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
