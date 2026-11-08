import io
import pathlib

import openpyxl
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import insert
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import db as dbm
from app import models
from app.db import make_engine
from app.main import app
from app.models import ForecastLine
from app.parsers.forecast import parse_forecast
from seed.suppliers_seed import seed_suppliers

REAL_FORECAST = pathlib.Path(r"E:\c&a-newww\forecast-report\CAREER FORECAST 45-47.xlsx")


@pytest.fixture(scope="session")
def real_rows():
    if not REAL_FORECAST.exists():
        pytest.skip("real forecast workbook not available")
    return parse_forecast(str(REAL_FORECAST))


@pytest.fixture()
def session_factory():
    engine = make_engine("sqlite://", poolclass=StaticPool)
    dbm.Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with Session() as s:
        seed_suppliers(s)
    return Session


@pytest.fixture()
def db(session_factory):
    with session_factory() as s:
        yield s


@pytest.fixture()
def client(session_factory):
    def _get_db():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()
    app.dependency_overrides[dbm.get_db] = _get_db
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture()
def loaded_db(db, real_rows):
    """DB with the real forecast rows loaded directly (fast path)."""
    for i in range(0, len(real_rows), 5000):
        db.execute(insert(ForecastLine), real_rows[i:i + 5000])
    db.commit()
    return db


def make_xlsx(rows, header=None) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    if header:
        ws.append(header)
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
