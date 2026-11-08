"""Pure calculation functions. Everything is unrounded; rounding is for display/export only.

Rules (the product owner's workbook is the reference):
  left (to be utilized) = total confirmed - total utilized      (utilized = stuffed TEUs per carrier)
  to_be_arrived         = max(0, basis - total actual TEU)
  deficit/surplus       = left - to_be_arrived
  basis = sum of daily forecast TEU if any daily forecast exists, else the MGH forecast TEU.

ACTUAL CBM / TEU per day: the CBM comes from the DAILY STUFFING REPORT. In priority order:
  1. a typed adjustment for that date (PUT /daily/{date}, stored in daily_actuals; 0 is valid) -> that value
     (source "entered");
  2. else, if the day has stuffing rows: sum over the rows of (the row's CBM if the report had one, else
     the row's TEUs x cbm_per_teu). Source "stuffing_cbm" if every row had a CBM, "stuffing_teu" if none had
     one, "stuffing_mixed" otherwise;
  3. else 0 (source "none").
actual_teu = actual_cbm / cbm_per_teu. Why: the real report may or may not carry a CBM column, so a row
without one falls back to 1 TEU = cbm_per_teu (33) CBM; a typed value stays available to correct a day.
Confirmed TEUs are what the carrier gave; "utilized" is still the stuffed TEUs of mapped carriers.
"""
from __future__ import annotations

import datetime as dt

from ..utils import CARRIERS, SPLIT_CARRIERS, iso_key

BALANCE_TOL = 0.5


def status_of(deficit: float) -> str:
    if deficit < -BALANCE_TOL:
        return "deficit"
    if deficit > BALANCE_TOL:
        return "surplus"
    return "balanced"


def split_teus(total_teu: float, cfg: dict) -> dict:
    return {c: total_teu * cfg["split"][c] / 100.0 for c in SPLIT_CARRIERS}


def forecast_for_week(vol_by_date: dict[dt.date, float], cfg: dict) -> dict:
    """vol_by_date: raw MGH exp.Vol cbm grouped by Rfi date."""
    mult = 1.0 + cfg["uplift_pct"] / 100.0
    per = cfg["cbm_per_teu"]
    daily = {d: {"cbm": v * mult, "teu": v * mult / per} for d, v in vol_by_date.items()}
    cbm = sum(x["cbm"] for x in daily.values())
    teu = cbm / per
    return {"cbm_plus": cbm, "teu": teu, "carrier_teu": split_teus(teu, cfg), "daily": daily}


def week_calc(cfg: dict, vol_by_date: dict, stuffing: dict, overrides: dict, entry: dict | None,
              stuff_cbm: dict | None = None) -> dict:
    """Compute one week.

    stuffing: {date: {carrier: teus}} (mapped carriers only), already restricted to the week.
    overrides: {date: typed adjustment of the day's actual CBM} (absent = none; 0 is a value).
    entry: {"confirmed": {carrier: x}, "fml_forecast": x|None} or None.
    stuff_cbm: {date: {"cbm": sum of row CBMs, "teu_no_cbm": TEUs of rows without a CBM, "rows": n,
    "rows_with_cbm": n}} over ALL of that day's stuffing rows (mapped or not). If omitted it is derived
    from `stuffing`: every mapped TEU counts as a row without CBM.
    """
    per = cfg["cbm_per_teu"]
    fc = forecast_for_week(vol_by_date, cfg)
    entry = entry or {}
    conf = {c: float((entry.get("confirmed") or {}).get(c) or 0.0) for c in CARRIERS}
    fml_fc = entry.get("fml_forecast")
    fml_fc = cfg["fml_default"] if fml_fc is None else float(fml_fc)
    carrier_fc = {**fc["carrier_teu"], "FML": fml_fc}

    if stuff_cbm is None:
        stuff_cbm = {d: {"cbm": 0.0, "teu_no_cbm": sum(v.values()), "rows": len(v), "rows_with_cbm": 0}
                     for d, v in stuffing.items() if v}
    dates = sorted(set(fc["daily"]) | set(stuffing) | set(overrides) | set(stuff_cbm))
    daily_rows = []
    for d in dates:
        st = {c: float(stuffing.get(d, {}).get(c, 0.0)) for c in CARRIERS}
        stuffed = sum(st.values())
        f = fc["daily"].get(d, {"cbm": 0.0, "teu": 0.0})
        ov = overrides.get(d)
        sc = stuff_cbm.get(d)
        if sc and sc["rows"] > 0:
            comp_cbm = float(sc["cbm"]) + float(sc["teu_no_cbm"]) * per
            comp_src = ("stuffing_cbm" if sc["rows_with_cbm"] == sc["rows"]
                        else "stuffing_teu" if sc["rows_with_cbm"] == 0 else "stuffing_mixed")
        else:
            comp_cbm, comp_src = 0.0, "none"
        # what the day would show without a typed adjustment (lets the page recompute live and show the
        # value that comes back when the adjustment is cleared)
        act_cbm, source = (float(ov), "entered") if ov is not None else (comp_cbm, comp_src)
        act_teu = act_cbm / per
        daily_rows.append({
            "date": d, "carrier_teus": st, "stuffed_teus": stuffed,
            "forecast_cbm": f["cbm"], "forecast_teu": f["teu"],
            "actual_cbm": act_cbm, "actual_teu": act_teu,
            "actual_cbm_override": ov, "actual_cbm_source": source,
            "actual_cbm_computed": comp_cbm, "actual_cbm_computed_source": comp_src,
        })

    utilized = {c: sum(r["carrier_teus"][c] for r in daily_rows) for c in CARRIERS}
    total_conf = sum(conf.values())
    total_util = sum(utilized.values())
    total_actual = sum(r["actual_teu"] for r in daily_rows)
    daily_fc_teu = sum(r["forecast_teu"] for r in daily_rows)
    basis = daily_fc_teu if fc["daily"] else fc["teu"]
    to_be_arrived = max(0.0, basis - total_actual)
    left = total_conf - total_util
    deficit = left - to_be_arrived

    carriers = {}
    for c in CARRIERS:
        carriers[c] = {
            "forecast": carrier_fc[c], "confirmed": conf[c], "utilized": utilized[c],
            "left": conf[c] - utilized[c],
            "pct_share": (utilized[c] / total_util * 100.0) if total_util else 0.0,
            "pct_of_confirmed": (utilized[c] / conf[c] * 100.0) if conf[c] else None,
        }
    return {
        "forecast_cbm_plus": fc["cbm_plus"],
        "forecast": fc["teu"],  # MGH TEU total, excludes FML
        "carrier_forecast": carrier_fc,
        "total_confirmed": total_conf,
        "total_utilized": total_util,
        "to_be_arrived": to_be_arrived,
        "to_be_utilized": left,
        "deficit_surplus": deficit,
        "status": status_of(deficit),
        "carriers": carriers,
        "daily": daily_rows,
        "total_actual_teu": total_actual,
    }


def week_of(d: dt.date) -> tuple[int, int]:
    return iso_key(d)
