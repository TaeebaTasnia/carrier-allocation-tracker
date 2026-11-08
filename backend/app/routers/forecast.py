from __future__ import annotations

import io

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import insert, tuple_
from sqlalchemy.orm import Session

from ..config_service import get_config
from ..db import get_db
from ..models import ForecastLine, Supplier
from ..parsers.forecast import ParseError, parse_forecast
from ..services import calc, data
from ..services.data import mgh_vol_by_date
from .weekly import _check_week

router = APIRouter(prefix="/forecast", tags=["forecast"])


@router.post("/upload")
async def upload_forecast(file: UploadFile = File(...), db: Session = Depends(get_db)):
    try:
        rows = parse_forecast(io.BytesIO(await file.read()))
    except ParseError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(400, f"Cannot read forecast file: {e}")
    if not rows:
        raise HTTPException(400, "No forecast rows with an Rfi date found")
    weeks = sorted({(r["iso_year"], r["iso_week"]) for r in rows})
    # Replace forecast data only for the weeks present in this file; confirmed entries are untouched.
    db.query(ForecastLine).filter(tuple_(ForecastLine.iso_year, ForecastLine.iso_week).in_(weeks)).delete(
        synchronize_session=False)
    for i in range(0, len(rows), 5000):
        db.execute(insert(ForecastLine), rows[i:i + 5000])
    db.commit()
    codes = {r["supplier"] for r in rows}
    known = {c for (c,) in db.query(Supplier.code)}
    cfg = get_config(db)
    per_week = []
    mgh_rows = sum(1 for r in rows if r["supplier"] in known)
    for y, w in weeks:
        fc = calc.forecast_for_week(mgh_vol_by_date(db, y, w), cfg)
        per_week.append({"year": y, "week": w, "cbm_plus": fc["cbm_plus"], "teu": fc["teu"],
                         "carrier_teu": fc["carrier_teu"]})
    return {
        "rows": len(rows), "mgh_rows": mgh_rows,
        "weeks": [{"year": y, "week": w} for y, w in weeks],
        "unmatched_supplier_codes": sorted(codes - known),
        "week_totals": per_week,
    }


@router.get("/weeks/{year}/{week}")
def forecast_week(year: int, week: int, db: Session = Depends(get_db)):
    _check_week(year, week)
    cfg = get_config(db)
    vols = mgh_vol_by_date(db, year, week)
    fc = calc.forecast_for_week(vols, cfg)
    return {
        "year": year, "week": week, "cbm_plus": fc["cbm_plus"], "teu": fc["teu"],
        "carrier_teu": fc["carrier_teu"],
        "daily": [{"date": d.isoformat(), "forecast_cbm": v["cbm"], "forecast_teu": v["teu"]}
                  for d, v in sorted(fc["daily"].items())],
    }
