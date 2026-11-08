from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DB_URL = os.environ.get("APP_DB_URL", f"sqlite:///{DATA_DIR / 'app.db'}")


class Base(DeclarativeBase):
    pass


def make_engine(url: str = DB_URL, **kw):
    if url.startswith("sqlite:///") and ":memory:" not in url:
        Path(url.replace("sqlite:///", "")).parent.mkdir(parents=True, exist_ok=True)
    return create_engine(url, connect_args={"check_same_thread": False}, **kw)


engine = make_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def migrate_schema(eng=None) -> None:
    """Tiny, idempotent startup migration: add columns that create_all cannot add to existing tables.

    Currently: daily_stuffing.cbm (nullable FLOAT). Touches no data; safe to run repeatedly.
    """
    from sqlalchemy import text
    eng = eng or engine
    with eng.begin() as conn:
        cols = {row[1] for row in conn.execute(text("PRAGMA table_info(daily_stuffing)"))}
        if cols and "cbm" not in cols:
            conn.execute(text("ALTER TABLE daily_stuffing ADD COLUMN cbm FLOAT"))


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
