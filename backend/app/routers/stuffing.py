from __future__ import annotations

import datetime as dt
import io
import re
from collections import defaultdict

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..config_service import get_config
from ..db import get_db
from ..models import DailyStuffing
from ..utils import week_dates
from ..services.data import map_line
from ..parsers.stuffing import StuffingParseError, parse_stuffing_ex

router = APIRouter(prefix="/stuffing", tags=["stuffing"])


@router.post("/upload")
async def upload_stuffing(file: UploadFile = File(...), report_date: dt.date | None = None,
                          db: Session = Depends(get_db)):
    try:
        rows, skipped, cbm_found = parse_stuffing_ex(io.BytesIO(await file.read()), report_date)
    except StuffingParseError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(400, f"Cannot read stuffing file: {e}")
    line_map = get_config(db)["line_map"]
    date_set = {r["date"] for r in rows}
    if report_date is not None:
        date_set.add(report_date)  # a zero-valid-row re-upload still clears that date
    dates = sorted(date_set)
    # Re-upload replaces those dates' rows.
    if dates:
        db.query(DailyStuffing).filter(DailyStuffing.date.in_(dates)).delete(synchronize_session=False)
    per_date: dict = defaultdict(lambda: defaultdict(float))
    unmapped: dict = defaultdict(float)
    cbm_per_date: dict = defaultdict(float)
    carrier_cbm: dict = defaultdict(lambda: defaultdict(float))
    for r in rows:
        carrier = map_line(line_map, r["line"])
        db.add(DailyStuffing(date=r["date"], shipping_line=r["line"], carrier=carrier, teus=r["teus"],
                             qty=r["qty"], cbm=r["cbm"], feeder_vessel=r["feeder_vessel"], fvsl_etd=r["fvsl_etd"],
                             fvsl_eta=r["fvsl_eta"], mother_vessel=r["mother_vessel"],
                             mvsl_etd=r["mvsl_etd"], mvsl_eta=r["mvsl_eta"]))
        if r["cbm"] is not None:
            cbm_per_date[r["date"].isoformat()] += r["cbm"]
            if carrier:
                carrier_cbm[r["date"].isoformat()][carrier] += r["cbm"]
        if carrier:
            per_date[r["date"].isoformat()][carrier] += r["teus"]
        else:
            unmapped[r["line"]] += r["teus"]
    db.commit()
    return {
        "rows": len(rows), "dates": [d.isoformat() for d in dates],
        "carrier_teus": {d: dict(v) for d, v in per_date.items()},
        "unmapped_lines": [{"shipping_line": k, "teus": v} for k, v in unmapped.items()],
        "skipped_rows": skipped,
        "cbm_column_found": cbm_found,
        # CBM written in the file (only rows that had a CBM value): per date per mapped carrier, and total per date
        "carrier_cbm": {d: dict(v) for d, v in carrier_cbm.items()},
        "cbm_by_date": dict(cbm_per_date),
    }


# ---------------------------------------------------------------------------
# Typed entry: the day editor in the browser (no Excel file). Rows are stored exactly like uploaded rows.
# ---------------------------------------------------------------------------
_ISO_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _opt_day(v):
    if v is None:
        return None
    if not isinstance(v, str):
        raise ValueError("must be an ISO date string YYYY-MM-DD")
    v = v.strip()
    if not v:
        return None
    if not _ISO_DAY.match(v):
        raise ValueError("must be an ISO date string YYYY-MM-DD")
    try:
        dt.date.fromisoformat(v)
    except ValueError:
        raise ValueError("is not a real calendar date")
    return v


class StuffingRowIn(BaseModel):
    shipping_line: str
    teus: float = Field(ge=0, allow_inf_nan=False)
    qty: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    cbm: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    feeder_vessel: str | None = Field(default=None, max_length=100)
    mother_vessel: str | None = Field(default=None, max_length=100)
    fvsl_etd: str | None = None
    fvsl_eta: str | None = None
    mvsl_etd: str | None = None
    mvsl_eta: str | None = None

    @field_validator("shipping_line", mode="before")
    @classmethod
    def _line(cls, v):
        if not isinstance(v, str):
            raise ValueError("shipping_line must be text")
        v = v.strip()
        if not v:
            raise ValueError("shipping_line must not be blank")
        if len(v) > 100:
            raise ValueError("shipping_line must be at most 100 characters")
        return v

    @field_validator("feeder_vessel", "mother_vessel", mode="before")
    @classmethod
    def _vessel(cls, v):
        if v is None:
            return None
        if not isinstance(v, str):
            raise ValueError("vessel name must be text")
        return v.strip() or None

    @field_validator("fvsl_etd", "fvsl_eta", "mvsl_etd", "mvsl_eta", mode="before")
    @classmethod
    def _days(cls, v):
        return _opt_day(v)


class StuffingDayIn(BaseModel):
    rows: list[StuffingRowIn] = Field(max_length=500)


def _day_str(v: str | None) -> str | None:
    """Stored text -> YYYY-MM-DD when it is an ISO date/datetime (uploads may store 'YYYY-MM-DDTHH:MM:SS')."""
    if not v:
        return None
    return v[:10] if _ISO_DAY.match(v[:10]) else v


def _day_json(db: Session, day: dt.date) -> dict:
    line_map = get_config(db)["line_map"]
    out_rows, unmapped, total = [], defaultdict(float), 0.0
    for r in db.query(DailyStuffing).filter(DailyStuffing.date == day).order_by(DailyStuffing.id).all():
        carrier = map_line(line_map, r.shipping_line)
        teus = r.teus or 0.0
        total += teus
        if not carrier:
            unmapped[r.shipping_line] += teus
        out_rows.append({
            "id": r.id, "shipping_line": r.shipping_line, "qty": r.qty, "teus": teus,
            "feeder_vessel": r.feeder_vessel, "fvsl_etd": _day_str(r.fvsl_etd), "fvsl_eta": _day_str(r.fvsl_eta),
            "mother_vessel": r.mother_vessel, "mvsl_etd": _day_str(r.mvsl_etd), "mvsl_eta": _day_str(r.mvsl_eta),
            "cbm": r.cbm, "carrier": carrier, "mapped": carrier is not None,
        })
    return {"date": day.isoformat(), "rows": out_rows, "total_teus": total,
            "unmapped_lines": [{"shipping_line": k, "teus": v} for k, v in unmapped.items()]}


# NOTE: /dates must be declared BEFORE /{day}, otherwise "dates" would be parsed as a date.
@router.get("/dates")
def stuffing_dates(year: int, week: int, db: Session = Depends(get_db)):
    if not 1 <= week <= 53:
        raise HTTPException(422, "week must be between 1 and 53")
    try:
        days = week_dates(year, week)
    except ValueError:
        raise HTTPException(422, "invalid ISO year/week")
    agg = {d: (n, t) for d, n, t in db.query(DailyStuffing.date, func.count(DailyStuffing.id),
                                             func.coalesce(func.sum(DailyStuffing.teus), 0.0))
           .filter(DailyStuffing.date.in_(days)).group_by(DailyStuffing.date).all()}
    return {"year": year, "week": week,
            "days": [{"date": d.isoformat(), "rows": agg.get(d, (0, 0.0))[0], "teus": float(agg.get(d, (0, 0.0))[1])}
                     for d in days]}


@router.get("/{day}")
def get_stuffing_day(day: dt.date, db: Session = Depends(get_db)):
    return _day_json(db, day)


@router.put("/{day}")
def put_stuffing_day(day: dt.date, body: StuffingDayIn, db: Session = Depends(get_db)):
    line_map = get_config(db)["line_map"]
    try:
        db.query(DailyStuffing).filter(DailyStuffing.date == day).delete(synchronize_session=False)
        for r in body.rows:
            db.add(DailyStuffing(date=day, shipping_line=r.shipping_line, carrier=map_line(line_map, r.shipping_line),
                                 teus=r.teus, qty=r.qty, cbm=r.cbm, feeder_vessel=r.feeder_vessel,
                                 fvsl_etd=r.fvsl_etd, fvsl_eta=r.fvsl_eta, mother_vessel=r.mother_vessel,
                                 mvsl_etd=r.mvsl_etd, mvsl_eta=r.mvsl_eta))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return _day_json(db, day)


@router.delete("/{day}")
def delete_stuffing_day(day: dt.date, db: Session = Depends(get_db)):
    n = db.query(DailyStuffing).filter(DailyStuffing.date == day).delete(synchronize_session=False)
    db.commit()
    return {"date": day.isoformat(), "deleted": n}
