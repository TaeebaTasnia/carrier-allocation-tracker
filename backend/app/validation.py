"""Shared request validation: bounded finite numbers, NUL-free text, year/date ranges, emails."""
from __future__ import annotations

import datetime as dt
import re
from typing import Annotated

from fastapi import HTTPException
from pydantic import Field, FiniteFloat

from .utils import DATE_MAX, DATE_MIN, MAX_ABS_NUM, YEAR_MAX, YEAR_MIN, date_in_range

# A finite float within +-MAX_ABS_NUM (rejects NaN, Infinity and 1e308 with a 422).
BoundedFloat = Annotated[FiniteFloat, Field(ge=-MAX_ABS_NUM, le=MAX_ABS_NUM)]
# A finite float within 0..MAX_ABS_NUM.
NonNegFloat = Annotated[FiniteFloat, Field(ge=0, le=MAX_ABS_NUM)]


_EMAIL_OK = re.compile(r"^[^@\s\x00-\x1f\x7f]+@[^@\s\x00-\x1f\x7f]+$")


def normalize_email(value) -> str | None:
    """Trimmed, lowercased email (one @, no whitespace/control characters, <= 320 chars), or None.
    Emails are stored and compared in this form (users table, sign-in, CLI)."""
    if not isinstance(value, str):
        return None
    email = value.strip().lower()
    if not email or len(email) > 320 or not _EMAIL_OK.match(email):
        return None
    return email


def no_nul(v):
    """Pydantic validator body: reject text containing NUL characters (PostgreSQL cannot store them)."""
    if isinstance(v, str) and "\x00" in v:
        raise ValueError("must not contain NUL characters")
    return v


def check_year(year: int) -> None:
    if not YEAR_MIN <= year <= YEAR_MAX:
        raise HTTPException(422, f"year must be between {YEAR_MIN} and {YEAR_MAX}")


def check_day(day: dt.date | None) -> None:
    if day is not None and not date_in_range(day):
        raise HTTPException(422, f"date must be between {DATE_MIN.isoformat()} and {DATE_MAX.isoformat()}")


def check_text(name: str, value: str, max_len: int) -> None:
    if "\x00" in value:
        raise HTTPException(422, f"{name} must not contain NUL characters")
    if len(value) > max_len:
        raise HTTPException(422, f"{name} must be at most {max_len} characters")
