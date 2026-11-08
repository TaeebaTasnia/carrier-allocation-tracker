from __future__ import annotations

import datetime as dt

from sqlalchemy import Date, Float, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class Supplier(Base):
    __tablename__ = "suppliers"
    code: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, default="")
    cw_code: Mapped[str] = mapped_column(String, default="")


class ForecastLine(Base):
    """Raw forecast row. MGH-ness is decided at query time from the supplier table."""
    __tablename__ = "forecast_lines"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    iso_year: Mapped[int] = mapped_column(Integer)
    iso_week: Mapped[int] = mapped_column(Integer)
    rfi: Mapped[dt.date] = mapped_column(Date)
    supplier: Mapped[str] = mapped_column(String)
    order_no: Mapped[str] = mapped_column(String, default="")
    vol_cbm: Mapped[float] = mapped_column(Float, default=0.0)
    __table_args__ = (Index("ix_fc_week", "iso_year", "iso_week"),)


class WeeklyEntry(Base):
    """Manual weekly entry: confirmed TEUs per carrier + optional FML forecast override."""
    __tablename__ = "weekly_entries"
    iso_year: Mapped[int] = mapped_column(Integer, primary_key=True)
    iso_week: Mapped[int] = mapped_column(Integer, primary_key=True)
    conf_maersk: Mapped[float] = mapped_column(Float, default=0.0)
    conf_hapag: Mapped[float] = mapped_column(Float, default=0.0)
    conf_hellman: Mapped[float] = mapped_column(Float, default=0.0)
    conf_one: Mapped[float] = mapped_column(Float, default=0.0)
    conf_fml: Mapped[float] = mapped_column(Float, default=0.0)
    fml_forecast: Mapped[float | None] = mapped_column(Float, nullable=True)


class DailyStuffing(Base):
    __tablename__ = "daily_stuffing"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    date: Mapped[dt.date] = mapped_column(Date, index=True)
    shipping_line: Mapped[str] = mapped_column(String)
    carrier: Mapped[str | None] = mapped_column(String, nullable=True)  # None = unmapped
    teus: Mapped[float] = mapped_column(Float, default=0.0)
    qty: Mapped[float | None] = mapped_column(Float, nullable=True)
    cbm: Mapped[float | None] = mapped_column(Float, nullable=True)  # row CBM from the report, if it has one
    feeder_vessel: Mapped[str | None] = mapped_column(String, nullable=True)
    fvsl_etd: Mapped[str | None] = mapped_column(String, nullable=True)
    fvsl_eta: Mapped[str | None] = mapped_column(String, nullable=True)
    mother_vessel: Mapped[str | None] = mapped_column(String, nullable=True)
    mvsl_etd: Mapped[str | None] = mapped_column(String, nullable=True)
    mvsl_eta: Mapped[str | None] = mapped_column(String, nullable=True)


class DailyActual(Base):
    """Optional typed adjustment of the day's actual CBM (replaces the value computed from stuffing)."""
    __tablename__ = "daily_actuals"
    date: Mapped[dt.date] = mapped_column(Date, primary_key=True)
    actual_cbm: Mapped[float | None] = mapped_column(Float, nullable=True)


class Config(Base):
    __tablename__ = "config"
    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[str] = mapped_column(Text)  # JSON
