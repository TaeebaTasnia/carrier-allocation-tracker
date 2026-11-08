"""CORS: the browser front end (served on :5500) must be able to call the API, and nobody else."""

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
