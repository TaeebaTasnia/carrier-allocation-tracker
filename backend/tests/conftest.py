"""Test harness.

Database: TEST_DATABASE_URL is REQUIRED and must be a throwaway PostgreSQL database whose name contains
``test`` (the run stops at once otherwise, see MISSING_DB). The schema is built once per run from the
models and every table is TRUNCATEd ... RESTART IDENTITY (one statement) before each test. The environment
is set BEFORE any ``app`` import, so the app only ever sees the test database.

Golden workbook: GOLDEN_WORKBOOK (path) or <repo>/forecast-report/CAREER FORECAST 45-47.xlsx.
REQUIRE_GOLDEN=1 turns a missing workbook into a failure instead of a skip (use it in CI).

Sign-in: the shared ``app`` has sign-in ON (a generic test issuer that is never contacted). The ``client``
fixture signs every request in as TEST_ADMIN through ``app_overrides``; tests of the real sign-in override
``app_overrides`` with ``{}`` (see tests/test_auth.py, which drives a mock identity provider).
"""
import os
import pathlib
import sys

BACKEND_DIR = pathlib.Path(__file__).resolve().parents[1]
REPO_DIR = BACKEND_DIR.parent

MISSING_DB = """\
ERROR: the tests need TEST_DATABASE_URL, a THROWAWAY PostgreSQL database whose name contains 'test'
({problem}). The harness drops and truncates its tables. Start one (Docker), run, then remove it:

  docker run -d --name ca-pg-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=ca_test -e POSTGRES_INITDB_ARGS=--locale=C.UTF-8 -p 127.0.0.1:55432:5432 postgres:16
  $env:TEST_DATABASE_URL = "postgresql+psycopg://postgres:test@127.0.0.1:55432/ca_test"
  .venv\\Scripts\\python.exe -m pytest tests -q -rs
  docker rm -f -v ca-pg-test
"""


def _stop(problem: str):
    """Stop the run before anything is imported or collected: one message, exit code 4 (usage error).
    SystemExit is used because pytest wraps an Exception raised while importing a conftest in an
    "ImportError while loading conftest" traceback."""
    sys.stderr.write(MISSING_DB.format(problem=problem))
    raise SystemExit(4)


TEST_DB_URL = (os.environ.get("TEST_DATABASE_URL") or "").strip()
if not TEST_DB_URL:
    _stop("it is not set")
os.environ["APP_ENV"] = "dev"
os.environ["DATABASE_URL"] = TEST_DB_URL
os.environ.pop("APP_DB_URL", None)
os.environ.pop("APP_CORS_ORIGINS", None)  # tests expect the dev CORS default
# Sign-in for the shared test app (dev, plain http test server, never-contacted issuer).
TEST_SESSION_SECRET = "test-session-secret-0123456789-abcdefghijklmnop"
os.environ.update({"SESSION_SECRET": TEST_SESSION_SECRET, "PUBLIC_URL": "http://testserver",
                   "OIDC_ISSUER": "https://idp.example.test", "OIDC_CLIENT_ID": "ca-test-client",
                   "OIDC_CLIENT_SECRET": "ca-test-client-secret"})
for _var in ("APP_AUTH", "APP_ADMIN_EMAILS", "OIDC_PROVIDER_NAME", "OIDC_GOOGLE_HD"):
    os.environ.pop(_var, None)

import io  # noqa: E402

import openpyxl  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import insert, text  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from app.settings import SettingsError, check_database_url, get_settings, reset_settings_cache  # noqa: E402

try:
    TEST_DB_URL = check_database_url(TEST_DB_URL)
except SettingsError as e:
    _stop(f"it is not a PostgreSQL URL: {str(e).split('; ', 1)[-1]}")
_url = make_url(TEST_DB_URL)
# The harness drops and truncates every table: only a database named like a test database.
if "test" not in (_url.database or ""):
    _stop(f"the database name {_url.database!r} does not contain 'test'")
reset_settings_cache()
assert get_settings().database_url == TEST_DB_URL

from app import db as dbm  # noqa: E402
from app import models  # noqa: E402,F401
from app.auth import CurrentUser, current_user  # noqa: E402
from app.db import make_engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import ForecastLine  # noqa: E402
from app.parsers.forecast import parse_forecast  # noqa: E402
from seed.suppliers_seed import seed_suppliers  # noqa: E402

REAL_FORECAST = pathlib.Path(os.environ.get("GOLDEN_WORKBOOK")
                             or REPO_DIR / "forecast-report" / "CAREER FORECAST 45-47.xlsx")
REQUIRE_GOLDEN = os.environ.get("REQUIRE_GOLDEN") == "1"

# The signed-in user of the shared `client` fixture (an admin, so admin-only routes work in old tests).
TEST_ADMIN = CurrentUser(id=1, email="admin@example.com", name="Test Admin", role="admin")

# A complete, valid production sign-in configuration (production refuses to start without one). The secret
# is new per run: production refuses secrets written in the repository (app.auth.PUBLISHED_SECRETS).
PROD_AUTH_ENV = {
    "SESSION_SECRET": __import__("secrets").token_hex(32),
    "PUBLIC_URL": "https://ca.example",
    "OIDC_ISSUER": "https://idp.example",
    "OIDC_CLIENT_ID": "ca-prod-client",
    "OIDC_CLIENT_SECRET": "ca-prod-client-secret",
}
PROD_AUTH = {"session_secret": PROD_AUTH_ENV["SESSION_SECRET"], "public_url": PROD_AUTH_ENV["PUBLIC_URL"],
             "oidc_issuer": PROD_AUTH_ENV["OIDC_ISSUER"], "oidc_client_id": PROD_AUTH_ENV["OIDC_CLIENT_ID"],
             "oidc_client_secret": PROD_AUTH_ENV["OIDC_CLIENT_SECRET"]}

# A valid PostgreSQL URL for Settings whose database is never used (apps built only to check routes,
# headers or refusals; their requests use the test database through get_db). Port 1 is closed: anything
# that did connect would fail at once.
UNUSED_DB_URL = "postgresql+psycopg://ca:unused@127.0.0.1:1/ca_never_connected"


def pytest_sessionstart(session):
    if REQUIRE_GOLDEN and not REAL_FORECAST.exists():
        raise pytest.UsageError(f"REQUIRE_GOLDEN=1 but the golden workbook is missing: {REAL_FORECAST}")


def pytest_report_header(config):
    return [f"test database: {_url.render_as_string(hide_password=True)}",
            f"golden workbook: {REAL_FORECAST} ({'found' if REAL_FORECAST.exists() else 'MISSING'})"
            f"{', required' if REQUIRE_GOLDEN else ''}"]


@pytest.fixture(scope="session")
def real_rows():
    if not REAL_FORECAST.exists():
        if REQUIRE_GOLDEN:
            pytest.fail(f"golden workbook missing: {REAL_FORECAST}")
        pytest.skip("real forecast workbook not available")
    return parse_forecast(str(REAL_FORECAST))


@pytest.fixture(scope="session")
def pg_engine():
    """One engine for the run; the schema is rebuilt from the models at the start (the migrations are
    checked against the models separately: test_alembic_upgrade_from_empty_equals_models)."""
    eng = make_engine(TEST_DB_URL, pool_size=5, max_overflow=5, lock_timeout_ms=15000)
    dbm.Base.metadata.drop_all(eng)
    dbm.Base.metadata.create_all(eng)
    yield eng
    eng.dispose()


TRUNCATE_ALL = text("TRUNCATE TABLE {} RESTART IDENTITY CASCADE".format(
    ", ".join(t.name for t in dbm.Base.metadata.sorted_tables)))


@pytest.fixture()
def session_factory(pg_engine):
    """Every table emptied (one TRUNCATE, ids restart at 1) and the 14 suppliers seeded."""
    with pg_engine.begin() as c:
        c.execute(TRUNCATE_ALL)
    Session = sessionmaker(bind=pg_engine, autoflush=False, expire_on_commit=False)
    with Session() as s:
        seed_suppliers(s)
    return Session


@pytest.fixture()
def db(session_factory):
    with session_factory() as s:
        yield s


@pytest.fixture()
def app_overrides():
    """Extra FastAPI dependency overrides applied to every `client`.

    Default: every request is signed in as TEST_ADMIN (a plain override that does not touch
    request.state, so write logs show `user=-`). Override this fixture with `{}` to test the real
    `current_user` (tests/test_auth.py)."""
    return {current_user: lambda: TEST_ADMIN}


@pytest.fixture()
def client(session_factory, app_overrides):
    def _get_db():
        s = session_factory()  # a new session per request, as in production
        try:
            yield s
        finally:
            s.close()
    app.dependency_overrides[dbm.get_db] = _get_db
    app.dependency_overrides.update(app_overrides)
    yield TestClient(app)
    app.dependency_overrides.clear()


def alembic_config(url: str):
    """Alembic config for `url` (passed via attributes, never via the ini: no ConfigParser % issues)."""
    from alembic.config import Config
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = url
    cfg.attributes["configure_logger"] = False
    return cfg


def alembic_upgrade(url: str, rev: str = "head") -> None:
    from alembic import command
    command.upgrade(alembic_config(url), rev)


@pytest.fixture()
def fresh_db_url():
    """URL of a new, EMPTY Postgres database next to the test database (dropped afterwards)."""
    from sqlalchemy.pool import NullPool
    name = f"{_url.database}_fresh"
    admin = make_engine(TEST_DB_URL, poolclass=NullPool, isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
            c.execute(text(f'CREATE DATABASE "{name}"'))
        yield _url.set(database=name).render_as_string(hide_password=False)
        with admin.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
    finally:
        admin.dispose()


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
