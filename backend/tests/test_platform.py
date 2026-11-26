"""Go-live platform behaviour: settings, production defaults, health, headers, 500 handler, migrations."""
import logging
import os
import subprocess
import sys

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect

from app import db as dbm
from app import main as main_mod
from app.db import DatabaseBusy, make_engine
from app.main import app, create_app
from app.settings import DEV_CORS_ORIGINS, Settings, SettingsError, get_settings, reset_settings_cache
from tests.conftest import BACKEND_DIR, PROD_AUTH, TEST_DB_URL, UNUSED_DB_URL, alembic_config, alembic_upgrade

# Production refuses to start without complete sign-in settings (tests/test_auth.py), so give it some.
PROD = Settings(app_env="production", database_url=UNUSED_DB_URL, **PROD_AUTH)
PG = "postgresql+psycopg://u:p@h:5432/d"
# Not PostgreSQL + psycopg 3: refused everywhere (settings, engine, CLI, Alembic, process start).
NOT_POSTGRES = ["sqlite://", "sqlite:///x.db", "mysql://u:p@h/d", "postgresql+psycopg2://u:p@h/d",
                "postgresql+asyncpg://u:p@h/d", "not a url"]


# ---- settings ----
def test_app_env_defaults_to_production_and_requires_database_url():
    with pytest.raises(SettingsError, match="DATABASE_URL"):
        Settings.from_env({})
    s = Settings.from_env({"DATABASE_URL": "postgresql+psycopg://u:p@db/ca"})
    assert s.app_env == "production" and s.is_production and not s.is_dev
    assert s.cors_origins == ()  # no CORS in production unless listed


def test_dev_defaults_and_dev_also_requires_database_url():
    with pytest.raises(SettingsError, match="DATABASE_URL .* is required"):
        Settings.from_env({"APP_ENV": "dev"})  # there is no default database in any mode
    s = Settings.from_env({"APP_ENV": "dev", "DATABASE_URL": PG})
    assert s.is_dev and s.database_url == PG and s.cors_origins == DEV_CORS_ORIGINS


def test_database_url_alias_and_postgres_driver():
    assert Settings.from_env({"APP_DB_URL": PG}).database_url == PG
    for raw in ("postgres://u:p@h:5432/d", "postgresql://u:p@h:5432/d", " postgresql+psycopg://u:p@h:5432/d "):
        assert Settings.from_env({"DATABASE_URL": raw}).database_url == PG
        assert Settings(database_url=raw).database_url == PG  # also when built directly
    # DATABASE_URL wins over the alias
    s = Settings.from_env({"DATABASE_URL": PG, "APP_DB_URL": "postgresql+psycopg://u:p@other:5432/x"})
    assert s.database_url == PG


@pytest.mark.parametrize("app_env", ["dev", "production"])
@pytest.mark.parametrize("url", NOT_POSTGRES)
def test_database_other_than_postgres_refused(app_env, url):
    with pytest.raises(SettingsError, match="must be a PostgreSQL URL") as e:
        Settings.from_env({"APP_ENV": app_env, "DATABASE_URL": url})
    assert "u:p" not in str(e.value)  # the message never echoes the URL (it may hold a password)
    with pytest.raises(SettingsError, match="must be a PostgreSQL URL"):
        Settings(app_env=app_env, database_url=url)
    with pytest.raises(SettingsError, match="must be a PostgreSQL URL"):
        make_engine(url)


@pytest.mark.parametrize("app_env", ["dev", "production"])
def test_process_refuses_to_start_on_a_file_database_and_creates_no_file(app_env, tmp_path):
    """The real start-up path (what uvicorn does: import app.main) with a file database URL: the process
    exits with a clear message before anything could create the file."""
    target = tmp_path / "x.db"
    env = {**os.environ, "APP_ENV": app_env, "APP_AUTH": "off" if app_env == "dev" else "on",
           "DATABASE_URL": f"sqlite:///{target.as_posix()}"}
    env.pop("APP_DB_URL", None)
    p = subprocess.run([sys.executable, "-c", "import app.main"], cwd=str(BACKEND_DIR), env=env,
                       capture_output=True, text=True, timeout=120)
    assert p.returncode != 0 and "must be a PostgreSQL URL" in p.stderr
    assert not target.exists()


def test_bad_app_env_and_numbers_refused():
    with pytest.raises(SettingsError):
        Settings.from_env({"APP_ENV": "staging", "DATABASE_URL": PG})
    with pytest.raises(SettingsError):
        Settings.from_env({"DATABASE_URL": PG, "DB_POOL_SIZE": "many"})


def test_cors_and_auth_fields_from_env():
    s = Settings.from_env({"DATABASE_URL": PG, "APP_CORS_ORIGINS": " https://a.example , ",
                           "APP_ADMIN_EMAILS": "Boss@Example.com, b@example.com", "PUBLIC_URL": "https://ca.example"})
    assert s.cors_origins == ("https://a.example",)
    assert s.admin_emails == ("boss@example.com", "b@example.com") and s.public_url == "https://ca.example"


def test_tests_run_in_dev_against_the_test_database():
    s = get_settings()
    assert s.is_dev and s.database_url == TEST_DB_URL


# ---- production app ----
def test_docs_hidden_in_production():
    c = TestClient(create_app(PROD))
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert c.get(path).status_code == 404, path
    assert c.get("/health").json() == {"status": "ok"}


def test_docs_available_in_dev():
    c = TestClient(app)
    assert c.get("/docs").status_code == 200 and c.get("/openapi.json").status_code == 200


def test_production_startup_does_not_create_tables_or_seed(monkeypatch):
    calls = []
    monkeypatch.setattr(dbm.Base.metadata, "create_all", lambda *a, **k: calls.append("create_all"))
    monkeypatch.setattr(main_mod, "seed_suppliers", lambda *a, **k: calls.append("seed"))
    with TestClient(create_app(PROD)) as c:
        assert c.get("/health").status_code == 200
    assert calls == []


def test_dev_startup_creates_tables_and_seeds(fresh_db_url, monkeypatch, app_overrides):
    """The local dev story: APP_ENV=dev + an empty Postgres database -> tables created and the 14
    suppliers seeded."""
    url = fresh_db_url
    monkeypatch.setenv("DATABASE_URL", url)
    reset_settings_cache()
    dbm.dispose_engine()
    try:
        dev_app = create_app(get_settings())
        dev_app.dependency_overrides.update(app_overrides)
        with TestClient(dev_app) as c:
            assert c.get("/health/ready").json() == {"status": "ready"}
            assert len(c.get("/suppliers").json()) == 14
        with TestClient(dev_app) as c:  # second start: seeding is idempotent
            assert len(c.get("/suppliers").json()) == 14
        eng = create_engine(url)
        assert {"suppliers", "forecast_lines", "daily_stuffing", "weekly_entries", "daily_actuals",
                "config"} <= set(inspect(eng).get_table_names())
        eng.dispose()
    finally:
        dbm.dispose_engine()
        monkeypatch.undo()
        reset_settings_cache()


# ---- health ----
def test_health_and_ready(client):
    assert client.get("/health").json() == {"status": "ok"}
    r = client.get("/health/ready")
    assert r.status_code == 200 and r.json() == {"status": "ready"}


def test_ready_503_when_database_fails(client):
    class Broken:
        def execute(self, *a, **k):
            raise RuntimeError("connection refused")

    app.dependency_overrides[dbm.get_db] = lambda: Broken()
    r = client.get("/health/ready")
    assert r.status_code == 503 and r.json() == {"status": "unavailable"}


# ---- headers, request id, 500 ----
def test_security_headers_and_request_id(client):
    r = client.get("/config")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in r.headers["content-security-policy"]
    assert r.headers["referrer-policy"] == "no-referrer"
    assert len(r.headers["x-request-id"]) == 16
    assert r.headers["x-request-id"] != client.get("/config").headers["x-request-id"]


def _app_with_failing_routes():
    a = create_app(Settings(app_env="dev", database_url=UNUSED_DB_URL, cors_origins=DEV_CORS_ORIGINS))

    @a.get("/boom")
    def boom():
        raise RuntimeError("secret SQL: SELECT * FROM suppliers")

    @a.put("/busy")
    def busy():
        raise DatabaseBusy("stuffing")

    @a.put("/as-user")
    def as_user(request: Request):
        request.state.user_email = "planner@example.com"  # what authentication will set per request
        return {"ok": True}
    return a


def test_write_log_names_the_user_set_on_request_state(caplog):
    c = TestClient(_app_with_failing_routes())
    with caplog.at_level(logging.INFO, logger="app"):
        assert c.put("/as-user").status_code == 200
    assert any(rec.getMessage().startswith("PUT /as-user -> 200") and "user=planner@example.com" in rec.getMessage()
               for rec in caplog.records)


def test_unhandled_error_is_500_with_request_id_and_no_details(caplog):
    c = TestClient(_app_with_failing_routes(), raise_server_exceptions=False)
    with caplog.at_level(logging.ERROR, logger="app"):
        r = c.get("/boom", headers={"Origin": "http://127.0.0.1:5500"})
    assert r.status_code == 500
    body = r.json()
    assert body["detail"] == "Internal server error" and body["request_id"] == r.headers["x-request-id"]
    assert "secret" not in r.text
    assert r.headers["access-control-allow-origin"] == "http://127.0.0.1:5500"  # readable by the dev page
    assert r.headers["x-content-type-options"] == "nosniff"
    assert any(rec.exc_info and "secret SQL" in str(rec.exc_info[1]) for rec in caplog.records)


def test_lock_timeout_is_503():
    c = TestClient(_app_with_failing_routes())
    r = c.put("/busy")
    assert r.status_code == 503 and "Try again" in r.json()["detail"]


def test_writes_are_logged_with_request_id(client, caplog):
    with caplog.at_level(logging.INFO, logger="app"):
        r = client.put("/config", json={"fml_default": 11})
    assert r.status_code == 200
    line = next(rec for rec in caplog.records if rec.getMessage().startswith("PUT /config -> 200"))
    assert getattr(line, "request_id", None) == r.headers["x-request-id"] and "user=-" in line.getMessage()


FAKE_LOG_LINE = "2026-11-26 00:00:00 INFO app [x] PUT /config -> 200 1ms user=boss@example.com"
# percent-encoded in the URL; the app sees them decoded in scope["path"]
LINE_BREAKS = {"%0a": "\\x0a", "%0d%0a": "\\x0d\\x0a", "%0b": "\\x0b", "%0c": "\\x0c", "%1e": "\\x1e",
               "%c2%85": "\\x85", "%e2%80%a8": "\\u2028", "%e2%80%a9": "\\u2029", "%00": "\\x00"}


def test_log_safe_escapes_line_breaks_and_keeps_ordinary_text():
    from app.middleware import log_safe
    assert log_safe("/weekly/2026/45?x=1") == "/weekly/2026/45?x=1"
    assert log_safe("/suppliers/Müller ü") == "/suppliers/Müller ü" and log_safe(None) == "-"
    for ch in "\n\r\x0b\x0c\x1c\x1d\x1e\x85  \x00\x7f\x9b":
        out = log_safe(f"/a{ch}b")
        assert out.splitlines() == [out] and ch not in out


def test_write_log_path_cannot_forge_a_log_line(client, caplog):
    """`PUT /config%0a<fake line>` used to write a second, forged line into the log (reviewer finding 3)."""
    handler_out = []
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s [%(request_id)s] %(message)s")

    class Capture(logging.Handler):
        def emit(self, record):
            record.request_id = getattr(record, "request_id", "-")
            handler_out.append(fmt.format(record))
    h = Capture()
    logging.getLogger("app").addHandler(h)
    try:
        with caplog.at_level(logging.INFO, logger="app"):
            for brk in LINE_BREAKS:
                assert client.put(f"/config{brk}{FAKE_LOG_LINE}", json={}).status_code == 404
    finally:
        logging.getLogger("app").removeHandler(h)
    writes = [m for m in handler_out if " PUT /config" in m]
    assert len(writes) == len(LINE_BREAKS)
    for out, escaped in zip(writes, LINE_BREAKS.values()):
        assert out.splitlines() == [out]  # one physical line per request
        assert f"PUT /config{escaped}{FAKE_LOG_LINE} -> 404" in out


def test_cross_site_refusal_log_escapes_the_path(caplog):
    c = TestClient(create_app(PROD))
    with caplog.at_level(logging.WARNING, logger="app"):
        r = c.put("/config%0aFORGED", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    msgs = [rec.getMessage() for rec in caplog.records if rec.getMessage().startswith("cross-site")]
    assert msgs and all(m.splitlines() == [m] for m in msgs) and "/config\\x0aFORGED" in msgs[0]


# ---- migrations ----
def test_alembic_upgrade_from_empty_equals_models(fresh_db_url):
    """`alembic upgrade head` on an empty database builds exactly the models' schema (`alembic check`)."""
    from alembic import command
    alembic_upgrade(fresh_db_url)
    command.check(alembic_config(fresh_db_url))  # raises AutoGenerateDiffsDetected on any drift


def test_alembic_refuses_to_run_without_explicit_url(monkeypatch):
    from alembic import command
    from alembic.config import Config
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("APP_DB_URL", raising=False)
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.attributes["configure_logger"] = False
    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        command.current(cfg)


def test_alembic_refuses_a_file_database_and_creates_no_file(monkeypatch, tmp_path):
    from alembic import command
    target = tmp_path / "x.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{target.as_posix()}")
    monkeypatch.delenv("APP_DB_URL", raising=False)
    cfg = alembic_config(None)  # no URL attribute: env.py reads DATABASE_URL
    with pytest.raises(SettingsError, match="must be a PostgreSQL URL"):
        command.upgrade(cfg, "head")
    assert not target.exists()
