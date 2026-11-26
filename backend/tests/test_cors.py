"""CORS.

Dev (APP_ENV=dev, what the tests and the local :5500 pages use): the :5500 front end may call the API, nobody
else. Production: pages and API share one origin behind the proxy, so by default NO CORS headers at all;
APP_CORS_ORIGINS lists extra origins explicitly.
"""
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings
from tests.conftest import PROD_AUTH_ENV, UNUSED_DB_URL  # production refuses to start without sign-in settings

ALLOWED = ["http://127.0.0.1:5500", "http://localhost:5500"]


def test_preflight_allowed_for_frontend_origins(client):
    for origin in ALLOWED:
        r = client.options(
            "/forecast/upload",
            headers={"Origin": origin, "Access-Control-Request-Method": "POST",
                     "Access-Control-Request-Headers": "content-type"},
        )
        assert r.status_code == 200, origin
        assert r.headers["access-control-allow-origin"] == origin
        assert "POST" in r.headers["access-control-allow-methods"]


def test_simple_request_carries_cors_header(client):
    r = client.get("/reports/weekly-summary", params={"year": 2026},
                   headers={"Origin": "http://127.0.0.1:5500"})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "http://127.0.0.1:5500"


def test_download_filename_header_is_exposed(client):
    r = client.get("/health", headers={"Origin": "http://localhost:5500"})
    assert "content-disposition" in r.headers.get("access-control-expose-headers", "").lower()


def test_other_origin_is_not_allowed(client):
    r = client.options(
        "/forecast/upload",
        headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "POST"},
    )
    assert r.status_code == 400
    assert "access-control-allow-origin" not in r.headers


def test_production_default_sends_no_cors_headers():
    c = TestClient(create_app(Settings.from_env({"DATABASE_URL": UNUSED_DB_URL, **PROD_AUTH_ENV})))
    for origin in ALLOWED + ["http://evil.example"]:
        r = c.options("/forecast/upload", headers={"Origin": origin, "Access-Control-Request-Method": "POST"})
        assert "access-control-allow-origin" not in r.headers, origin
        r = c.get("/health", headers={"Origin": origin})
        assert "access-control-allow-origin" not in r.headers, origin


def test_production_cors_only_for_listed_origins():
    s = Settings.from_env({"DATABASE_URL": UNUSED_DB_URL, "APP_CORS_ORIGINS": "https://ca.example", **PROD_AUTH_ENV})
    c = TestClient(create_app(s))
    ok = c.options("/forecast/upload", headers={"Origin": "https://ca.example", "Access-Control-Request-Method": "POST"})
    assert ok.status_code == 200 and ok.headers["access-control-allow-origin"] == "https://ca.example"
    bad = c.options("/forecast/upload", headers={"Origin": "http://127.0.0.1:5500", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in bad.headers
