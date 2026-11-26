"""Database engine + sessions (built lazily from settings) and the per-resource write lock. PostgreSQL only.

Nothing here touches a database at import time: the engine is created on first use from
``get_settings().database_url``. Schema changes are Alembic migrations (``backend/migrations``); only
``APP_ENV=dev`` runs ``create_all`` at startup.
"""
from __future__ import annotations

import threading

from sqlalchemy import MetaData, create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .settings import check_database_url, get_settings

# Deterministic constraint/index names, so Alembic autogenerate and later migrations can address them.
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


def make_engine(url: str, *, pool_size: int = 5, max_overflow: int = 5, pool_recycle: int = 1800,
                lock_timeout_ms: int = 30000, **kw) -> Engine:
    """PostgreSQL (psycopg 3) only; any other URL raises SettingsError. Pre-ping pooled connections, a
    bounded pool, and a ``lock_timeout`` so a stuck lock (row, table or advisory) fails the request instead
    of hanging it."""
    url = check_database_url(url)
    kw.setdefault("pool_pre_ping", True)
    if "poolclass" not in kw:
        kw.setdefault("pool_size", pool_size)
        kw.setdefault("max_overflow", max_overflow)
        kw.setdefault("pool_recycle", pool_recycle)
    connect_args = {"options": f"-c lock_timeout={int(lock_timeout_ms)}",
                    "application_name": "carrier-allocation"}
    return create_engine(url, connect_args=connect_args, **kw)


_init_lock = threading.Lock()
_engine: Engine | None = None
_session_factory: sessionmaker | None = None


def get_engine() -> Engine:
    """The process-wide engine, created on first use from the settings."""
    global _engine, _session_factory
    if _engine is None:
        with _init_lock:
            if _engine is None:
                s = get_settings()
                eng = make_engine(s.database_url, pool_size=s.db_pool_size, max_overflow=s.db_max_overflow,
                                  pool_recycle=s.db_pool_recycle, lock_timeout_ms=s.db_lock_timeout_ms)
                _session_factory = sessionmaker(bind=eng, autoflush=False, expire_on_commit=False)
                _engine = eng
    return _engine


def SessionLocal() -> Session:  # noqa: N802 (kept the old name; it is a factory call)
    get_engine()
    return _session_factory()


def dispose_engine() -> None:
    """Close pooled connections and forget the engine (shutdown; tests that change settings)."""
    global _engine, _session_factory
    with _init_lock:
        if _engine is not None:
            _engine.dispose()
        _engine = None
        _session_factory = None


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Write lock: one fixed Postgres advisory-lock key per resource. Never renumber or reuse a key.
# A request takes at most ONE of these, so requests cannot deadlock on them.
# ---------------------------------------------------------------------------
LOCK_KEYS = {
    "forecast": 4_351_001,   # forecast_lines (upload replaces whole weeks)
    "stuffing": 4_351_002,   # daily_stuffing (upload / PUT / DELETE replace whole dates)
    "suppliers": 4_351_003,  # suppliers (upload, upsert, delete)
    "config": 4_351_004,     # config (read-merge-rewrite)
    "weekly": 4_351_005,     # weekly_entries (read-modify-write)
    "daily": 4_351_006,      # daily_actuals (read-modify-write)
}


class DatabaseBusy(Exception):
    """The write lock could not be taken within the lock_timeout (mapped to HTTP 503)."""


def lock(db: Session, name: str) -> None:
    """Serialise writers of one resource until this transaction ends (commit or rollback releases it).

    ``pg_advisory_xact_lock`` on the resource's fixed key. Call it AFTER parsing/validating the request and
    as the first statement before the DELETE / ``db.get`` of the read-modify-write it protects."""
    key = LOCK_KEYS[name]
    try:
        db.execute(text("SELECT pg_advisory_xact_lock(CAST(:k AS bigint))"), {"k": key})
    except OperationalError as e:
        if getattr(e.orig, "sqlstate", None) == "55P03":  # lock_not_available: lock_timeout expired
            db.rollback()
            raise DatabaseBusy(name) from e
        raise
