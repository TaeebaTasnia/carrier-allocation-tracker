from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config_service import get_config
from ..db import get_db
from ..models import DailyActual
from ..services import calc, data
from ..utils import CARRIERS, week_dates

router = APIRouter(tags=["weekly"])


def _check_week(year: int, week: int):
    if not 1 <= week <= 53:
        raise HTTPException(422, "week must be between 1 and 53")
    try:
        week_dates(year, week)
    except ValueError:
        raise HTTPException(422, "invalid ISO year/week")


def _week_json(res: dict) -> dict:
    out = {k: v for k, v in res.items() if k != "daily"}
    return out


def _daily_json(d: dict) -> dict:
    return {**d, "date": d["date"].isoformat()}


class WeeklyIn(BaseModel):
    confirmed: dict[str, float] | None = Field(default=None, description="carrier -> confirmed TEUs")
    fml_forecast: float | None = None  # explicit null clears the override


@router.get("/weekly/{year}/{week}")
def get_weekly(year: int, week: int, db: Session = Depends(get_db)):
    _check_week(year, week)
    return _week_json(data.compute_week(db, year, week))


@router.put("/weekly/{year}/{week}")
def put_weekly(year: int, week: int, body: WeeklyIn, db: Session = Depends(get_db)):
    _check_week(year, week)
    if body.confirmed:
        bad = [k for k in body.confirmed if k not in CARRIERS]
        if bad:
            raise HTTPException(422, f"unknown carriers {bad}; expected {CARRIERS}")
        if any(v < 0 for v in body.confirmed.values()):
            raise HTTPException(422, "confirmed TEUs must be >= 0")
    data.update_entry(db, year, week, body.confirmed, "fml_forecast" in body.model_fields_set, body.fml_forecast)
    return _week_json(data.compute_week(db, year, week))


class DailyIn(BaseModel):
    actual_cbm: float | None = None  # typed adjustment of that day's actual CBM; 0 is valid; null clears it (the computed value returns)


@router.get("/daily")
def list_daily(year: int, week: int, db: Session = Depends(get_db)):
    _check_week(year, week)
    res = data.compute_week(db, year, week)
    return {"year": year, "week": week, "days": [_daily_json(d) for d in res["daily"]]}


@router.get("/daily/{day}")
def get_daily(day: dt.date, db: Session = Depends(get_db)):
    y, w = calc.week_of(day)
    res = data.compute_week(db, y, w)
    row = next((d for d in res["daily"] if d["date"] == day), None)
    if row is None:
        cfg = get_config(db)
        row = {"date": day, "carrier_teus": {c: 0.0 for c in CARRIERS}, "stuffed_teus": 0.0,
               "forecast_cbm": 0.0, "forecast_teu": 0.0, "actual_cbm": 0.0, "actual_teu": 0.0,
               "actual_cbm_override": None, "actual_cbm_source": "none",
               "actual_cbm_computed": 0.0, "actual_cbm_computed_source": "none"}
    return _daily_json(row)


@router.put("/daily/{day}")
def put_daily(day: dt.date, body: DailyIn, db: Session = Depends(get_db)):
    if body.actual_cbm is not None and body.actual_cbm < 0:
        raise HTTPException(422, "actual_cbm must be >= 0")
    row = db.get(DailyActual, day)
    if row is None:
        row = DailyActual(date=day)
        db.add(row)
    row.actual_cbm = body.actual_cbm
    db.commit()
    return get_daily(day, db)
