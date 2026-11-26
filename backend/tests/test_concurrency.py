"""Replace-style writes are serialised by the per-resource advisory lock.

Deterministic version of the race: session A takes the lock and writes rows for a date/week but has not
committed yet (another request in mid-save). A request B for the same date/week must WAIT (not run its
DELETE against A's still-invisible rows), and after A commits B must replace A's rows: the result holds B's
rows only, never A's + B's.
"""
import datetime as dt
import threading

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, insert, select
from sqlalchemy.orm import sessionmaker

from app import db as dbm
from app.db import lock, make_engine
from app.main import app
from app.models import DailyStuffing, ForecastLine
from tests.conftest import TEST_DB_URL, make_xlsx

DAY = dt.date(2026, 11, 4)
WAIT = 0.8  # seconds B must still be blocked while A holds the lock


def _start(fn):
    out = {}

    def run():
        try:
            out["r"] = fn()
        except Exception as e:  # pragma: no cover - surfaced by the assertion below
            out["e"] = e
    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t, out


def test_put_stuffing_day_waits_and_does_not_double_rows(session_factory, client):
    a = session_factory()
    try:
        lock(a, "stuffing")
        a.add_all([DailyStuffing(date=DAY, shipping_line=f"A{i}", carrier=None, teus=1.0) for i in range(3)])
        a.flush()
        t, out = _start(lambda: client.put(f"/stuffing/{DAY}", json={"rows": [
            {"shipping_line": "B1", "teus": 2}, {"shipping_line": "B2", "teus": 3}]}))
        t.join(WAIT)
        assert t.is_alive(), "PUT /stuffing/{day} did not wait for the stuffing lock"
        a.commit()
    finally:
        a.close()
    t.join(30)
    assert not t.is_alive() and "e" not in out and out["r"].status_code == 200, out
    rows = client.get(f"/stuffing/{DAY}").json()["rows"]
    assert [r["shipping_line"] for r in rows] == ["B1", "B2"]


def test_forecast_upload_waits_and_does_not_double_rows(session_factory, client):
    a = session_factory()
    try:
        lock(a, "forecast")
        a.execute(insert(ForecastLine), [{"iso_year": 2026, "iso_week": 45, "rfi": dt.date(2026, 11, 3),
                                          "supplier": "77534", "order_no": "", "vol_cbm": 1000.0}] * 4)
        a.flush()
        f = make_xlsx([[dt.datetime(2026, 11, 3), "77534", 10]] * 2, ["Rfi", "Supplier", "exp.Vol cbm"])
        t, out = _start(lambda: client.post("/forecast/upload", files={"file": ("f.xlsx", f)}))
        t.join(WAIT)
        assert t.is_alive(), "POST /forecast/upload did not wait for the forecast lock"
        a.commit()
    finally:
        a.close()
    t.join(30)
    assert not t.is_alive() and "e" not in out and out["r"].status_code == 200, out
    with session_factory() as s:
        n = s.scalar(select(func.count()).select_from(ForecastLine).where(ForecastLine.iso_week == 45))
    assert n == 2
    assert client.get("/forecast/weeks/2026/45").json()["cbm_plus"] == pytest.approx(26.0)


def test_parallel_requests_same_day_end_with_one_set_of_rows(client):
    """Two real requests racing for the same day: the day ends with exactly one request's rows."""
    barrier = threading.Barrier(2)

    def put(tag):
        def go():
            barrier.wait(5)
            return client.put(f"/stuffing/{DAY}", json={"rows": [{"shipping_line": f"{tag}{i}", "teus": 1}
                                                                 for i in range(50)]})
        return go
    runs = [_start(put("X")), _start(put("Y"))]
    for t, out in runs:
        t.join(30)
        assert "e" not in out and out["r"].status_code == 200, out
    lines = [r["shipping_line"] for r in client.get(f"/stuffing/{DAY}").json()["rows"]]
    assert len(lines) == 50 and len({x[0] for x in lines}) == 1


def test_lock_wait_beyond_lock_timeout_is_503(session_factory, app_overrides):
    """A writer stuck behind the lock longer than lock_timeout gets a friendly 503, not a 500 or a hang."""
    short = make_engine(TEST_DB_URL, pool_size=2, max_overflow=0, lock_timeout_ms=300)
    Short = sessionmaker(bind=short, autoflush=False, expire_on_commit=False)

    def _get_db():
        s = Short()
        try:
            yield s
        finally:
            s.close()
    app.dependency_overrides[dbm.get_db] = _get_db
    app.dependency_overrides.update(app_overrides)
    a = session_factory()
    try:
        lock(a, "stuffing")
        r = TestClient(app).put(f"/stuffing/{DAY}", json={"rows": [{"shipping_line": "B", "teus": 1}]})
        assert r.status_code == 503 and "Try again" in r.json()["detail"]
    finally:
        a.rollback()
        a.close()
        app.dependency_overrides.clear()
        short.dispose()
