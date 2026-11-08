from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from ..db import get_db
from ..services import data, reports
from .weekly import _check_week, _daily_json

router = APIRouter(prefix="/reports", tags=["reports"])
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _alloc_json(res: dict) -> dict:
    out = {k: v for k, v in res.items() if k != "daily"}
    out["daily"] = [_daily_json(d) for d in res["daily"]]
    return out


def _xlsx(content: bytes, name: str) -> Response:
    return Response(content, media_type=XLSX, headers={"Content-Disposition": f'attachment; filename="{name}"'})


def _check_range(from_week, to_week):
    for w in (from_week, to_week):
        if w is not None and not 1 <= w <= 53:
            raise HTTPException(422, "from_week/to_week must be between 1 and 53")
    if from_week is not None and to_week is not None and from_week > to_week:
        raise HTTPException(422, "from_week must be <= to_week")


@router.get("/weekly-summary")
def weekly_summary(year: int, from_week: int | None = None, to_week: int | None = None,
                   db: Session = Depends(get_db)):
    _check_range(from_week, to_week)
    return data.weekly_summary(db, year, from_week, to_week)


@router.get("/weekly-summary/download")
def weekly_summary_download(year: int, from_week: int | None = None, to_week: int | None = None,
                            db: Session = Depends(get_db)):
    _check_range(from_week, to_week)
    s = data.weekly_summary(db, year, from_week, to_week)
    return _xlsx(reports.weekly_summary_xlsx(s), f"weekly-summary-{year}.xlsx")


@router.get("/allocation-vs-utilization")
def alloc(year: int, week: int, db: Session = Depends(get_db)):
    _check_week(year, week)
    return _alloc_json(data.compute_week(db, year, week))


@router.get("/allocation-vs-utilization/download")
def alloc_download(year: int, week: int, db: Session = Depends(get_db)):
    _check_week(year, week)
    res = data.compute_week(db, year, week)
    return _xlsx(reports.allocation_vs_utilization_xlsx(res), f"allocation-vs-utilization-{year}-wk{week}.xlsx")
