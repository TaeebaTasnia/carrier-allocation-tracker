"""DB-facing glue: loads inputs from the DB and runs calc.week_calc."""
from __future__ import annotations

import datetime as dt
import re
from collections import defaultdict

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config_service import get_config
from ..db import lock
from ..models import DailyActual, DailyStuffing, ForecastLine, Supplier, WeeklyEntry
from ..utils import CARRIERS, week_dates
from . import calc

_CONF_ATTR = {c: f"conf_{c.lower()}" for c in CARRIERS}


def entry_dict(e: WeeklyEntry | None) -> dict | None:
    if e is None:
        return None
    return {"confirmed": {c: getattr(e, a) or 0.0 for c, a in _CONF_ATTR.items()},
            "fml_forecast": e.fml_forecast}


def mgh_vol_by_date(db: Session, year: int, week: int) -> dict[dt.date, float]:
    q = (select(ForecastLine.rfi, func.sum(ForecastLine.vol_cbm))
         .join(Supplier, Supplier.code == ForecastLine.supplier)
         .where(ForecastLine.iso_year == year, ForecastLine.iso_week == week)
         .group_by(ForecastLine.rfi))
    return {d: float(v or 0.0) for d, v in db.execute(q).all()}


_FML_PREFIX = re.compile(r"^FML[-\s/]")


def map_line(line_map: dict, shipping_line: str | None) -> str | None:
    """Map a raw shipping line to a carrier (case-insensitive, trimmed).

    An explicit line_map entry always wins. Otherwise FML is the main carrier for "FML-<carrier>" bookings:
    a line starting with FML followed by a hyphen, space or slash maps to FML ("FMLX" / "FM" do not match).
    """
    key = (shipping_line or "").strip().upper()
    hit = {str(k).strip().upper(): v for k, v in line_map.items()}.get(key)
    if hit:
        return hit
    return "FML" if _FML_PREFIX.match(key) else None


def stuffing_by_date(db: Session, dates: list[dt.date], line_map: dict) -> dict[dt.date, dict[str, float]]:
    """Carrier TEUs per date, mapped at query time through the current line_map."""
    out: dict = defaultdict(lambda: defaultdict(float))
    rows = db.query(DailyStuffing).filter(DailyStuffing.date.in_(dates)).all()
    for r in rows:
        carrier = map_line(line_map, r.shipping_line)
        if carrier:
            out[r.date][carrier] += r.teus or 0.0
    return {d: dict(v) for d, v in out.items()}


def stuffing_cbm_by_date(db: Session, dates: list[dt.date]) -> dict[dt.date, dict]:
    """Per date, over ALL stuffing rows (mapped or not): CBM of rows that have one, TEUs of rows without."""
    out: dict = {}
    for r in db.query(DailyStuffing).filter(DailyStuffing.date.in_(dates)).all():
        o = out.setdefault(r.date, {"cbm": 0.0, "teu_no_cbm": 0.0, "rows": 0, "rows_with_cbm": 0})
        o["rows"] += 1
        if r.cbm is not None:
            o["cbm"] += r.cbm
            o["rows_with_cbm"] += 1
        else:
            o["teu_no_cbm"] += r.teus or 0.0
    return out


def overrides_for(db: Session, dates: list[dt.date]) -> dict[dt.date, float]:
    """Typed actual-CBM adjustments per date (cleared entries are absent; 0 is a value)."""
    rows = db.query(DailyActual).filter(DailyActual.date.in_(dates), DailyActual.actual_cbm.isnot(None)).all()
    return {r.date: r.actual_cbm for r in rows}


def compute_week(db: Session, year: int, week: int, cfg: dict | None = None) -> dict:
    cfg = cfg or get_config(db)
    dates = week_dates(year, week)
    entry = db.get(WeeklyEntry, (year, week))
    res = calc.week_calc(cfg, mgh_vol_by_date(db, year, week), stuffing_by_date(db, dates, cfg["line_map"]),
                         overrides_for(db, dates), entry_dict(entry),
                         stuffing_cbm_by_date(db, dates))
    res.update({"year": year, "week": week})
    return res


def weeks_with_data(db: Session, year: int) -> list[int]:
    weeks = {w for (w,) in db.query(ForecastLine.iso_week).filter(ForecastLine.iso_year == year).distinct()}
    weeks |= {w for (w,) in db.query(WeeklyEntry.iso_week).filter(WeeklyEntry.iso_year == year)}
    lo, hi = dt.date(year, 1, 1) - dt.timedelta(days=7), dt.date(year, 12, 31) + dt.timedelta(days=7)
    for (d,) in db.query(DailyStuffing.date).filter(DailyStuffing.date.between(lo, hi)).distinct():
        iy, iw = d.isocalendar()[0], d.isocalendar()[1]
        if iy == year:
            weeks.add(iw)
    return sorted(weeks)


def update_entry(db: Session, year: int, week: int, confirmed: dict | None, fml_forecast_set: bool,
                 fml_forecast: float | None) -> WeeklyEntry:
    lock(db, "weekly")  # read-modify-write: concurrent saves must not lose a carrier's value
    e = db.get(WeeklyEntry, (year, week))
    if e is None:
        e = WeeklyEntry(iso_year=year, iso_week=week, conf_maersk=0.0, conf_hapag=0.0,
                        conf_hellman=0.0, conf_one=0.0, conf_fml=0.0)
        db.add(e)
    for c, v in (confirmed or {}).items():
        if v is not None:
            setattr(e, _CONF_ATTR[c], float(v))
    if fml_forecast_set:
        e.fml_forecast = fml_forecast
    db.commit()
    return e


def summary_row(res: dict) -> dict:
    return {k: res[k] for k in ("year", "week", "forecast", "total_confirmed", "total_utilized",
                                "to_be_arrived", "to_be_utilized", "deficit_surplus", "status")}


def weekly_summary(db: Session, year: int, from_week: int | None, to_week: int | None) -> dict:
    cfg = get_config(db)
    weeks = [w for w in weeks_with_data(db, year)
             if (from_week is None or w >= from_week) and (to_week is None or w <= to_week)]
    rows = [summary_row(compute_week(db, year, w, cfg)) for w in weeks]
    keys = ("forecast", "total_confirmed", "total_utilized", "to_be_arrived", "to_be_utilized", "deficit_surplus")
    total = {k: sum(r[k] for r in rows) for k in keys}
    total["status"] = calc.status_of(total["deficit_surplus"])
    return {"year": year, "weeks": rows, "year_total": total}
