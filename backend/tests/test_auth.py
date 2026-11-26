"""Sign-in and access control (app/auth.py).

The OpenID Connect flow runs against tests/mock_idp.py through Authlib's real client (discovery, JWKS,
PKCE, token endpoint, ID-token signature/nonce/aud/exp checks), in-process and offline: the app gets
``oidc_transport=httpx.ASGITransport(app=idp.app)``. Flow apps are built like production behind the proxy:
APP_ENV=production, PUBLIC_URL https, and a TestClient with ``root_path="/api"`` requesting ``/api/...``
paths (uvicorn --root-path /api behind Caddy's ``handle_path /api/*``).
"""
import base64
import json
import logging
import re
import secrets
import subprocess
import sys
import time
import uuid
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi.routing import iter_route_contexts
from fastapi.testclient import TestClient
from itsdangerous import TimestampSigner
from joserfc.jwk import RSAKey
from sqlalchemy import select

from app import cli
from app import db as dbm
from app.auth import (DEFAULT_NEXT, SESSION_MAX_AGE, build_auth_config, normalize_origin, provider_for_issuer,
                      safe_next)
from app.main import app, create_app
from app.models import User
from app.settings import Settings, SettingsError
from tests.conftest import (BACKEND_DIR, PROD_AUTH, PROD_AUTH_ENV, TEST_SESSION_SECRET, UNUSED_DB_URL,
                            make_xlsx)
from tests.mock_idp import DROP, MockIdP

PUBLIC = "https://ca.example.test"
CLIENT_ID, CLIENT_SECRET = "ca-client", "ca-client-secret"
FLOW_SECRET = __import__("secrets").token_hex(32)  # new per run: production refuses secrets written in the repo
TID = "11111111-2222-3333-4444-555555555555"  # FAKE placeholder tenant id (GUID format only; not a real tenant)
ISSUERS = {"generic": "https://idp.example.test",
           "google": "https://accounts.google.com",
           "entra": f"https://login.microsoftonline.com/{TID}/v2.0"}
HOME = f"{PUBLIC}/index.html#enter"


def err(code):
    return f"{PUBLIC}/index.html?auth_error={code}"


@pytest.fixture()
def app_overrides():
    """This module tests the REAL current_user (no signed-in override)."""
    return {}


# ---------------------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------------------
def sign_cookie(secret: str, data: dict) -> str:
    """A session cookie exactly as Starlette's SessionMiddleware writes it."""
    return TimestampSigner(secret).sign(base64.b64encode(json.dumps(data).encode())).decode()


def read_cookie(secret: str, value: str) -> dict:
    return json.loads(base64.b64decode(TimestampSigner(secret).unsign(value, max_age=SESSION_MAX_AGE)))


def set_session(client, value, name="ca_session", domain="testserver.local"):
    """Put a cookie in the client's jar under the domain the jar files server cookies (http.cookiejar
    appends .local to dotless hosts), so a server-side clear removes it as it would in a browser."""
    client.cookies.set(name, value, domain=domain, path="/")


def db_override(session_factory):
    """A get_db replacement (a generator dependency, one session per request) on the test database."""
    def _get_db():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()
    return _get_db


@pytest.fixture()
def add_user(session_factory):
    def _add(email, role="user", active=True, **kw):
        with session_factory() as s:
            u = User(email=email, role=role, active=active, name=kw.pop("name", ""), session_epoch=0, **kw)
            s.add(u)
            s.commit()
            return u.id
    return _add


@pytest.fixture()
def get_user(session_factory):
    def _get(email):
        with session_factory() as s:
            return s.scalar(select(User).where(User.email == email))
    return _get


@pytest.fixture()
def login_as(client, add_user):
    """Sign the shared `client` in as a new user of `role` (cookie as the callback writes it)."""
    def _login(role="user", email=None):
        email = email or f"{role}@example.com"
        uid = add_user(email, role=role)
        set_session(client, sign_cookie(TEST_SESSION_SECRET, {"uid": uid, "epoch": 0, "exp": int(time.time()) + 3600}))
        return uid
    return _login


class Flow:
    """A production-like app wired to a mock identity provider, plus a browser for both."""

    def __init__(self, session_factory, provider="generic", transport=None, **settings):
        issuer = ISSUERS[provider]
        self.idp = MockIdP(issuer, CLIENT_ID, CLIENT_SECRET)
        kw = dict(app_env="production", database_url=UNUSED_DB_URL, session_secret=FLOW_SECRET, public_url=PUBLIC,
                  oidc_issuer=issuer, oidc_client_id=CLIENT_ID, oidc_client_secret=CLIENT_SECRET)
        if provider == "google":
            kw["oidc_google_hd"] = ("example.com",)
        kw.update(settings)
        self.app = create_app(Settings(**kw), oidc_transport=transport or httpx.ASGITransport(app=self.idp.app))
        self.app.dependency_overrides[dbm.get_db] = db_override(session_factory)
        self.client = TestClient(self.app, base_url=PUBLIC, root_path="/api", follow_redirects=False)
        self.idp_browser = TestClient(self.idp.app, follow_redirects=False)

    def start(self, next_path=None):
        return self.client.get("/api/auth/login", params={"next": next_path} if next_path is not None else None)

    def to_callback(self, claims, next_path=None):
        """Sign-in up to (not including) the callback: returns the callback URL the IdP sends the browser to."""
        self.idp.next_claims = claims
        r = self.start(next_path)
        assert r.status_code == 302, r.text
        r2 = self.idp_browser.get(r.headers["location"])
        assert r2.status_code == 302, r2.text
        return r2.headers["location"]

    def login(self, claims, next_path=None):
        return self.client.get(self.to_callback(claims, next_path))

    def cookie(self):
        return self.client.cookies.get("__Host-ca_session")

    def me(self):
        return self.client.get("/api/auth/me")


@pytest.fixture()
def flow(session_factory):
    return lambda provider="generic", **kw: Flow(session_factory, provider, **kw)


def generic_claims(email="alice@example.com", sub="sub-alice", **extra):
    return {"sub": sub, "email": email, "email_verified": True, "name": "Alice Planner", **extra}


def entra_claims(email="alice@example.com", oid="oid-alice", sub="pairwise-alice", **extra):
    return {"sub": sub, "oid": oid, "tid": TID, "preferred_username": email, "name": "Alice Planner", **extra}


def google_claims(email="alice@example.com", sub="g-alice", **extra):
    return {"sub": sub, "email": email, "email_verified": True, "hd": "example.com", "name": "Alice", **extra}


# ---------------------------------------------------------------------------------------------------------
# every route needs a session (parametrized from the live route table)
# ---------------------------------------------------------------------------------------------------------
PUBLIC_ROUTES = {("GET", "/health"), ("GET", "/health/ready"), ("GET", "/auth/config"), ("GET", "/auth/login"),
                 ("GET", "/auth/callback"), ("POST", "/auth/logout")}
DOC_PATHS = {"/docs", "/docs/oauth2-redirect", "/redoc", "/openapi.json"}  # dev only; 404 in production
SAMPLE_PARAMS = {"year": "2026", "week": "45", "day": "2026-11-03", "code": "77523"}


def protected_routes(application):
    """(method, path) of every route the app serves except the public ones. FastAPI 0.16x keeps included
    routers nested (``_IncludedRouter``); ``iter_route_contexts`` yields their effective full paths."""
    out = []
    for r in iter_route_contexts(application.routes):
        if r.path is None or r.path in DOC_PATHS:
            continue
        for m in sorted(r.methods or ()):
            if m not in ("HEAD", "OPTIONS") and (m, r.path) not in PUBLIC_ROUTES:
                out.append((m, r.path))
    return sorted(set(out))


def sample_url(path):
    return re.sub(r"\{(\w+)(:[^}]*)?\}", lambda m: SAMPLE_PARAMS.get(m.group(1), "1"), path)


PROTECTED = protected_routes(app)


def test_route_table_guard():
    """The parametrization below really covers the data routes (a new route is picked up automatically)."""
    assert len(PROTECTED) >= 23  # 22 data routes + /auth/me when this was written
    for route in [("PUT", "/config"), ("POST", "/forecast/upload"), ("DELETE", "/stuffing/{day}"),
                  ("GET", "/reports/weekly-summary/download"), ("GET", "/auth/me")]:
        assert route in PROTECTED


@pytest.mark.parametrize("method,path", PROTECTED, ids=[f"{m} {p}" for m, p in PROTECTED])
def test_every_non_public_route_answers_401_without_a_session(client, method, path):
    r = client.request(method, sample_url(path))
    assert r.status_code == 401, r.text
    assert r.json() == {"detail": "Not authenticated"}
    assert "location" not in r.headers  # JSON, never a redirect


def test_production_app_protects_the_same_routes_and_hides_docs(session_factory):
    prod = create_app(Settings(app_env="production", database_url=UNUSED_DB_URL, **PROD_AUTH))
    prod.dependency_overrides[dbm.get_db] = db_override(session_factory)
    c = TestClient(prod)
    assert protected_routes(prod) == PROTECTED
    for method, path in protected_routes(prod):
        assert c.request(method, sample_url(path)).status_code == 401, (method, path)
    for path in DOC_PATHS:
        assert c.get(path).status_code == 404, path
    assert c.get("/health").status_code == 200
    assert c.get("/auth/config").json() == {"auth": "oidc", "provider": "generic", "provider_name": "SSO"}


def test_health_endpoints_stay_open(client):
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/health/ready").json() == {"status": "ready"}


def test_invalid_body_still_401_first(client):
    assert client.put("/config", json={"uplift_pct": "nan-text"}).status_code == 401
    assert client.post("/forecast/upload").status_code == 401  # no file: still 401, not 422


# ---------------------------------------------------------------------------------------------------------
# roles
# ---------------------------------------------------------------------------------------------------------
def test_me_and_role_user_can_use_the_app_but_not_admin_routes(client, login_as):
    login_as("user", "planner@example.com")
    assert client.get("/auth/me").json() == {"email": "planner@example.com", "name": "", "role": "user"}
    assert client.get("/suppliers").status_code == 200
    assert client.get("/config").status_code == 200
    assert client.put("/weekly/2026/45", json={"confirmed": {"MAERSK": 2}}).status_code == 200
    assert client.put("/stuffing/2026-11-03", json={"rows": [{"shipping_line": "MAERSK", "teus": 2}]}).status_code == 200
    forbidden = {"detail": "Only an administrator can do this."}
    for r in (client.put("/config", json={"fml_default": 11}),
              client.post("/suppliers/99999", json={"name": "X"}),
              client.delete("/suppliers/77523"),
              client.post("/suppliers/upload", files={"file": ("s.xlsx", make_xlsx([["1", "A", "B"]], ["Code", "Name", "CW"]))})):
        assert r.status_code == 403 and r.json() == forbidden, r.text
    assert len(client.get("/suppliers").json()) == 14  # nothing changed


def test_role_admin_can_use_admin_routes(client, login_as):
    login_as("admin")
    assert client.put("/config", json={"fml_default": 11}).status_code == 200
    assert client.post("/suppliers/99999", json={"name": "New"}).status_code == 200
    assert client.delete("/suppliers/99999").status_code == 200
    up = client.post("/suppliers/upload",
                     files={"file": ("s.xlsx", make_xlsx([["88888", "Eight", "EIG"]], ["Supplier Code", "Supplier Name", "CW Code"]))})
    assert up.status_code == 200, up.text


def test_write_log_names_the_signed_in_user(client, login_as, caplog):
    login_as("admin", "boss@example.com")
    with caplog.at_level(logging.INFO, logger="app"):
        assert client.put("/config", json={"fml_default": 12}).status_code == 200
    assert any(rec.getMessage().startswith("PUT /config -> 200") and "user=boss@example.com" in rec.getMessage()
               for rec in caplog.records)


def test_deactivated_user_is_rejected_immediately(client, login_as, session_factory):
    login_as("user", "gone@example.com")
    assert client.get("/auth/me").status_code == 200
    with session_factory() as s:
        cli.set_active(s, "gone@example.com", False)
    r = client.get("/weekly/2026/45")
    assert r.status_code == 403 and r.json() == {"detail": "Your account has been deactivated. Ask an administrator."}
    assert "ca_session=null" in r.headers["set-cookie"]  # the cookie is cleared
    assert client.get("/auth/me").status_code == 401
    with session_factory() as s:  # re-activation does not revive the old cookie
        cli.set_active(s, "gone@example.com", True)
    assert client.get("/auth/me").status_code == 401


def test_session_epoch_revokes_replayed_cookie_after_logout(client, login_as, get_user):
    uid = login_as("user", "tab@example.com")
    cookie = client.cookies.get("ca_session")
    other_browser = sign_cookie(TEST_SESSION_SECRET, {"uid": uid, "epoch": 0, "exp": int(time.time()) + 3600})
    assert client.get("/auth/me").status_code == 200
    r = client.post("/auth/logout")
    assert r.status_code == 200 and r.json() == {"status": "signed_out"}
    assert "ca_session=null" in r.headers["set-cookie"] and "expires=Thu, 01 Jan 1970" in r.headers["set-cookie"]
    assert client.get("/auth/me").status_code == 401
    for replay in (cookie, other_browser):  # the copied cookie and another browser's session are both dead
        set_session(client, replay)
        assert client.get("/auth/me").status_code == 401
        set_session(client, replay)
        assert client.post("/auth/logout").status_code == 200  # a dead cookie cannot bump the epoch again
    assert get_user("tab@example.com").session_epoch == 1


def test_logout_without_session_is_harmless(client):
    r = client.post("/auth/logout")
    assert r.status_code == 200 and r.json() == {"status": "signed_out"}


def test_bad_session_cookies_are_401(client, add_user):
    uid = add_user("x@example.com")
    now = int(time.time())
    cases = [
        sign_cookie(TEST_SESSION_SECRET, {"uid": uid, "epoch": 0, "exp": now - 1}),          # expired
        sign_cookie(TEST_SESSION_SECRET, {"uid": uid, "epoch": 5, "exp": now + 99}),         # wrong epoch
        sign_cookie(TEST_SESSION_SECRET, {"uid": 999, "epoch": 0, "exp": now + 99}),         # no such user
        sign_cookie(TEST_SESSION_SECRET, {"uid": str(uid), "epoch": 0, "exp": now + 99}),    # wrong type
        sign_cookie("another-secret-another-secret-another", {"uid": uid, "epoch": 0, "exp": now + 99}),  # forged
        "garbage",
    ]
    for value in cases:
        set_session(client, value)
        assert client.get("/auth/me").status_code == 401, value


# ---------------------------------------------------------------------------------------------------------
# cross-site (CSRF) check
# ---------------------------------------------------------------------------------------------------------
REFUSED = {"detail": "Cross-site request refused."}


@pytest.mark.parametrize("headers", [
    {"Origin": "https://evil.example"},
    {"Origin": "null"},
    {"Origin": "http://testserver.evil.example"},
    {"Origin": "https://testserver"},             # scheme matters
    {"Sec-Fetch-Site": "cross-site"},
    {"Sec-Fetch-Site": "same-site"},
])
def test_cross_site_writes_are_refused(client, login_as, headers):
    login_as("admin")
    for r in (client.put("/config", json={"fml_default": 13}, headers=headers),
              client.post("/auth/logout", headers=headers)):
        assert r.status_code == 403 and r.json() == REFUSED
    assert client.get("/auth/me").status_code == 200  # the session survived the refused logout
    assert client.get("/config").json()["fml_default"] != 13


@pytest.mark.parametrize("headers", [
    {},                                            # no Origin, no Sec-Fetch-Site (scripts, TestClient)
    {"Origin": "http://testserver"},              # PUBLIC_URL of the test app
    {"Origin": "HTTP://TESTSERVER:80"},           # normalised
    {"Origin": "http://127.0.0.1:5500"},          # dev CORS origin (dev only)
    {"Sec-Fetch-Site": "same-origin"},
    {"Sec-Fetch-Site": "none"},
])
def test_same_origin_writes_pass(client, login_as, headers):
    login_as("admin")
    assert client.put("/config", json={"fml_default": 13}, headers=headers).status_code == 200


def test_reads_are_not_origin_checked(client, login_as):
    login_as("user")
    assert client.get("/config", headers={"Origin": "https://evil.example"}).status_code == 200


def test_production_accepts_only_public_url_origin(session_factory):
    prod = create_app(Settings(app_env="production", database_url=UNUSED_DB_URL, cors_origins=("http://127.0.0.1:5500",),
                               **PROD_AUTH))
    prod.dependency_overrides[dbm.get_db] = db_override(session_factory)
    c = TestClient(prod)
    assert c.post("/auth/logout", headers={"Origin": "https://ca.example"}).status_code == 200
    assert c.post("/auth/logout", headers={"Origin": "http://127.0.0.1:5500"}).json() == REFUSED


# ---------------------------------------------------------------------------------------------------------
# the OpenID Connect flow (mock identity provider)
# ---------------------------------------------------------------------------------------------------------
def test_generic_sign_in_end_to_end_behind_api_prefix(flow, add_user, get_user):
    f = flow()
    add_user("alice@example.com", role="user")
    f.idp.next_claims = generic_claims()
    r = f.start()
    assert r.status_code == 302 and r.headers["cache-control"] == "no-store"
    auth_url = urlsplit(r.headers["location"])
    assert f"{auth_url.scheme}://{auth_url.netloc}{auth_url.path}" == "https://idp.example.test/authorize"
    q = {k: v[0] for k, v in parse_qs(auth_url.query).items()}
    assert q["redirect_uri"] == f"{PUBLIC}/api/auth/callback"  # from PUBLIC_URL, no /api/api
    assert q["response_type"] == "code" and q["response_mode"] == "query"
    assert q["scope"] == "openid email profile" and q["client_id"] == CLIENT_ID
    assert q["code_challenge_method"] == "S256" and len(q["code_challenge"]) >= 43 and q["nonce"] and q["state"]
    pending = r.headers["set-cookie"]
    assert pending.startswith("__Host-ca_session=") and "path=/;" in pending and "httponly" in pending
    assert "samesite=lax" in pending and "secure" in pending and "Max-Age=43200" in pending

    r2 = f.idp_browser.get(r.headers["location"])
    r3 = f.client.get(r2.headers["location"])
    assert r3.status_code == 302 and r3.headers["location"] == HOME
    assert f.idp.token_requests[-1]["code_verifier"]  # PKCE verifier sent to the token endpoint
    assert set(read_cookie(FLOW_SECRET, f.cookie())) == {"uid", "epoch", "exp"}

    assert f.me().json() == {"email": "alice@example.com", "name": "Alice Planner", "role": "user"}
    assert f.client.get("/api/suppliers").status_code == 200
    assert f.client.get("/api/health").json() == {"status": "ok"}
    u = get_user("alice@example.com")
    assert u.sub == "sub-alice" and u.oid is None and u.last_login_at is not None and u.name == "Alice Planner"

    out = f.client.post("/api/auth/logout", headers={"Origin": PUBLIC})
    assert out.status_code == 200 and "__Host-ca_session=null" in out.headers["set-cookie"]
    assert f.me().status_code == 401


def test_next_path_is_kept_for_same_origin_paths(flow, add_user):
    f = flow()
    add_user("alice@example.com")
    r = f.login(generic_claims(), next_path="/weekly.html?year=2026&week=45")
    assert r.headers["location"] == f"{PUBLIC}/weekly.html?year=2026&week=45"


@pytest.mark.parametrize("bad", ["https://evil.example/x", "//evil.example", "/\\evil.example", "@evil.example",
                                 "javascript:alert(1)", "evil.example", "/ok\r\nSet-Cookie: x=1", "/a b",
                                 "/api/auth/login", "/" + "a" * 600, ""])
def test_open_redirect_attempts_land_on_the_default_page(flow, add_user, bad):
    f = flow()
    add_user("alice@example.com")
    r = f.login(generic_claims(), next_path=bad)
    assert r.status_code == 302 and r.headers["location"] == HOME


def test_safe_next_unit():
    assert safe_next(None) == DEFAULT_NEXT == "/index.html#enter"
    assert safe_next("/dashboard.html") == "/dashboard.html"
    for bad in ("//x", "/\\x", "http://x", "x", "/x\ny", "/\x00", "/api", "/api/x", "\\\\x"):
        assert safe_next(bad) == DEFAULT_NEXT, bad


def test_session_fixation_old_session_content_is_dropped(flow, add_user):
    f = flow()
    add_user("alice@example.com")
    set_session(f.client, sign_cookie(FLOW_SECRET, {"uid": 4242, "epoch": 0, "exp": 9e9, "planted": "x"}),
                name="__Host-ca_session", domain="ca.example.test")
    assert f.login(generic_claims()).headers["location"] == HOME
    data = read_cookie(FLOW_SECRET, f.cookie())
    assert set(data) == {"uid", "epoch", "exp"} and data["uid"] != 4242
    assert 0 < data["exp"] - time.time() <= SESSION_MAX_AGE


def test_unknown_email_is_refused_and_not_created(flow, get_user):
    f = flow()
    r = f.login(generic_claims(email="stranger@example.com"))
    assert r.headers["location"] == err("not_allowed")
    assert get_user("stranger@example.com") is None
    assert f.me().status_code == 401


def test_inactive_user_is_refused(flow, add_user):
    f = flow()
    add_user("alice@example.com", active=False)
    assert f.login(generic_claims()).headers["location"] == err("inactive")
    assert f.me().status_code == 401


def test_admin_emails_bootstrap_creates_an_admin_once(flow, add_user, get_user):
    f = flow(admin_emails=("boss@example.com",))
    r = f.login(generic_claims(email="Boss@Example.COM", sub="sub-boss"))
    assert r.headers["location"] == HOME
    u = get_user("boss@example.com")
    assert u.role == "admin" and u.sub == "sub-boss" and u.active
    assert f.me().json()["role"] == "admin"
    assert f.login(generic_claims(email="boss@example.com", sub="sub-boss")).headers["location"] == HOME
    # APP_ADMIN_EMAILS only creates missing rows: an existing user keeps the role given with the CLI
    add_user("lead@example.com", role="user")
    g = flow(admin_emails=("lead@example.com",))
    assert g.login(generic_claims(email="lead@example.com", sub="sub-lead")).headers["location"] == HOME
    assert get_user("lead@example.com").role == "user"
    # ... and deactivation wins over the list
    add_user("old@example.com", role="admin", active=False)
    h = flow(admin_emails=("old@example.com",))
    assert h.login(generic_claims(email="old@example.com", sub="sub-old")).headers["location"] == err("inactive")


@pytest.mark.parametrize("claims,expected", [
    (generic_claims(email_verified=False), "not_allowed"),
    ({"sub": "sub-alice", "email": "alice@example.com"}, "not_allowed"),          # no email_verified
    (generic_claims(email_verified="false"), "not_allowed"),
    (generic_claims(email_verified="true"), None),                                # string true accepted
    ({"sub": "sub-alice", "email_verified": True}, "not_allowed"),               # no email
    (generic_claims(email="not-an-email"), "not_allowed"),
    (generic_claims(email="ALICE@EXAMPLE.COM"), None),                            # case-insensitive
])
def test_generic_claim_rules(flow, add_user, claims, expected):
    f = flow()
    add_user("alice@example.com")
    assert f.login(claims).headers["location"] == (err(expected) if expected else HOME)


@pytest.mark.parametrize("claims,expected", [
    (google_claims(), None),
    (google_claims(hd="EXAMPLE.com"), None),
    (google_claims(hd="other.com"), "not_allowed"),
    ({k: v for k, v in google_claims().items() if k != "hd"}, "not_allowed"),   # personal gmail account
    (google_claims(email_verified=False), "not_allowed"),
])
def test_google_claim_rules(flow, add_user, claims, expected):
    f = flow("google")
    add_user("alice@example.com")
    assert f.login(claims).headers["location"] == (err(expected) if expected else HOME)


def test_google_specifics(flow, add_user):
    f = flow("google")
    add_user("alice@example.com")
    f.idp.token_overrides = {"iss": "accounts.google.com"}  # Google may omit the scheme in ID tokens
    assert f.login(google_claims()).headers["location"] == HOME
    assert "response_mode" not in f.idp.authorize_requests[-1]
    assert f.client.get("/api/auth/config").json() == {"auth": "oidc", "provider": "google", "provider_name": "Google"}


@pytest.mark.parametrize("claims,expected", [
    (entra_claims(), None),
    (entra_claims(email="ALICE@example.com"), None),                    # UPN case differs
    ({**entra_claims(), "preferred_username": None, "email": "Alice@example.com"}, None),  # email claim only
    (entra_claims(tid="99999999-2222-3333-4444-555555555555"), "not_allowed"),
    ({k: v for k, v in entra_claims().items() if k != "tid"}, "not_allowed"),
    (entra_claims(idp="https://sts.windows.net/other-tenant/"), "not_allowed"),  # guest account
    (entra_claims(idp="live.com"), "not_allowed"),                                # personal Microsoft account
    (entra_claims(idp=ISSUERS["entra"]), None),                                   # idp = issuer: member
    (entra_claims(idp=f"https://sts.windows.net/{TID}/"), None),                  # same tenant, v1 form
    (entra_claims(email_verified=False), "not_allowed"),
    ({k: v for k, v in entra_claims().items() if k != "oid"}, "failed"),
])
def test_entra_claim_rules(flow, add_user, claims, expected):
    f = flow("entra")
    add_user("alice@example.com")
    claims = {k: v for k, v in claims.items() if v is not None}
    assert f.login(claims).headers["location"] == (err(expected) if expected else HOME)


def test_entra_binds_oid_and_matches_on_it(flow, add_user, get_user):
    f = flow("entra")
    add_user("alice@example.com", role="admin")
    assert f.login(entra_claims()).headers["location"] == HOME
    u = get_user("alice@example.com")
    assert (u.oid, u.sub) == ("oid-alice", "pairwise-alice")
    assert f.client.get("/api/auth/config").json() == {"auth": "oidc", "provider": "entra", "provider_name": "Microsoft"}
    # renamed mailbox, same oid: still Alice; a new app registration (new pairwise sub) updates sub
    assert f.login(entra_claims(email="alice.new@example.com", sub="pairwise-2")).headers["location"] == HOME
    assert f.me().json()["email"] == "alice@example.com"
    assert get_user("alice@example.com").sub == "pairwise-2"
    # another directory object claiming Alice's email is refused
    assert f.login(entra_claims(oid="oid-mallory", sub="pairwise-m")).headers["location"] == err("not_allowed")


def test_generic_sub_binding(flow, add_user, get_user, session_factory):
    f = flow()
    add_user("alice@example.com")
    assert f.login(generic_claims(sub="sub-1")).headers["location"] == HOME
    assert get_user("alice@example.com").sub == "sub-1"
    # another account at the provider with the same email: refused
    assert f.login(generic_claims(sub="sub-2")).headers["location"] == err("not_allowed")
    # the bound account with a changed email is still the same user
    assert f.login(generic_claims(email="alice@new.example", sub="sub-1")).headers["location"] == HOME
    assert f.me().json()["email"] == "alice@example.com"
    # after `unbind` the next sign-in binds again
    with session_factory() as s:
        cli.unbind(s, "alice@example.com")
    assert f.me().status_code == 401  # unbind ends sessions
    assert f.login(generic_claims(sub="sub-2")).headers["location"] == HOME
    assert get_user("alice@example.com").sub == "sub-2"


@pytest.mark.parametrize("override,expected", [
    ({"nonce": "not-the-nonce"}, "failed"),
    ({"nonce": DROP}, "failed"),
    ({"iss": "https://evil.example"}, "failed"),
    ({"aud": "someone-else"}, "failed"),
    ({"exp": int(time.time()) - 3600}, "failed"),
    ({"sub": DROP}, "failed"),
])
def test_id_token_checks(flow, add_user, override, expected):
    f = flow()
    add_user("alice@example.com")
    f.idp.token_overrides = override
    assert f.login(generic_claims()).headers["location"] == err(expected)
    assert f.me().status_code == 401


def test_bad_signature_is_refused(flow, add_user):
    f = flow()
    add_user("alice@example.com")
    f.idp.sign_key = RSAKey.generate_key(2048, parameters={"kid": "mock-1"})
    assert f.login(generic_claims()).headers["location"] == err("failed")


def test_discovery_issuer_must_equal_oidc_issuer(flow, add_user):
    f = flow()
    add_user("alice@example.com")
    f.idp.metadata_issuer = "https://other-idp.example"
    f.idp.token_overrides = {"iss": "https://other-idp.example"}
    r = f.start()
    assert r.headers["location"] == err("unavailable") and f.idp.authorize_requests == []


def test_state_mismatch_and_code_replay(flow, add_user):
    f = flow()
    add_user("alice@example.com")
    cb = f.to_callback(generic_claims())
    tampered = re.sub(r"state=[^&]+", "state=forged", cb)
    assert f.client.get(tampered).headers["location"] == err("failed")
    # a callback the browser did not start (no pending sign-in in its cookie)
    cb2 = f.to_callback(generic_claims())
    stranger = TestClient(f.app, base_url=PUBLIC, root_path="/api", follow_redirects=False)
    assert stranger.get(cb2).headers["location"] == err("failed")
    # the legitimate browser completes once; replaying the same callback fails
    assert f.client.get(cb2).headers["location"] == HOME
    assert f.client.get(cb2).headers["location"] == err("failed")
    assert f.me().status_code == 401  # the failed replay cleared the session


def test_pending_sign_in_expires(flow, add_user, monkeypatch):
    f = flow()
    add_user("alice@example.com")
    cb = f.to_callback(generic_claims())
    real = time.time
    monkeypatch.setattr("app.auth.time.time", lambda: real() + 3700)  # Authlib keeps it for 1 h
    assert f.client.get(cb).headers["location"] == err("failed")


@pytest.mark.parametrize("error,expected", [("access_denied", "cancelled"), ("server_error", "failed"),
                                            ("interaction_required", "failed")])
def test_identity_provider_errors_are_not_echoed(flow, error, expected):
    f = flow()
    f.idp.deny = error
    r = f.login({})
    assert r.headers["location"] == err(expected)
    assert "provider" not in r.headers["location"] and "<b>" not in r.text


def test_identity_provider_unreachable(flow):
    def down(request):
        raise httpx.ConnectError("connection refused", request=request)
    f = flow(transport=httpx.MockTransport(down))
    assert f.start().headers["location"] == err("unavailable")


def test_token_endpoint_rejects_wrong_client_secret(flow, add_user):
    f = flow(oidc_client_secret="wrong-secret")
    add_user("alice@example.com")
    assert f.login(generic_claims()).headers["location"] == err("failed")


# ---------------------------------------------------------------------------------------------------------
# configuration and startup refusals
# ---------------------------------------------------------------------------------------------------------
def prod(**kw):
    base = dict(app_env="production", database_url=UNUSED_DB_URL, **PROD_AUTH)
    base.update(kw)
    return Settings(**base)


@pytest.mark.parametrize("change,message", [
    ({"session_secret": None}, "SESSION_SECRET"),
    ({"session_secret": "short-secret"}, "SESSION_SECRET"),
    ({"session_secret": "a" * 64}, "SESSION_SECRET"),                     # not random
    ({"oidc_issuer": None}, "OIDC_ISSUER"),
    ({"oidc_client_id": None}, "OIDC_CLIENT_ID"),
    ({"oidc_client_secret": None}, "OIDC_CLIENT_SECRET"),
    ({"public_url": None}, "PUBLIC_URL"),
    ({"public_url": "http://ca.example"}, "https"),
    ({"public_url": "https://ca.example/app"}, "bare origin"),
    ({"oidc_issuer": "http://idp.example"}, "https"),
    ({"auth_mode": "off"}, "APP_AUTH=off"),
    ({"oidc_issuer": "https://login.microsoftonline.com/common/v2.0"}, "single tenant"),
    ({"oidc_issuer": f"https://login.microsoftonline.com/{TID}"}, "single tenant"),
    ({"oidc_issuer": "https://accounts.google.com"}, "OIDC_GOOGLE_HD"),
    ({"oidc_issuer": "https://accounts.google.com/x", "oidc_google_hd": ("example.com",)}, "Google"),
])
def test_production_refuses_to_start(change, message):
    with pytest.raises(SettingsError, match=message):
        create_app(prod(**change))


def test_dev_refuses_partial_oidc_settings():
    with pytest.raises(SettingsError, match="incomplete"):
        create_app(Settings(app_env="dev", database_url=UNUSED_DB_URL, oidc_issuer="https://idp.example"))
    with pytest.raises(SettingsError, match="PUBLIC_URL"):
        create_app(Settings(app_env="dev", database_url=UNUSED_DB_URL, oidc_issuer="https://idp.example",
                            oidc_client_id="a", oidc_client_secret="b"))


def test_app_auth_values():
    assert Settings.from_env({"DATABASE_URL": UNUSED_DB_URL, "APP_AUTH": "OFF"}).auth_mode == "off"
    with pytest.raises(SettingsError, match="APP_AUTH"):
        Settings.from_env({"DATABASE_URL": UNUSED_DB_URL, "APP_AUTH": "maybe"})
    with pytest.raises(SettingsError, match="APP_AUTH=off"):
        create_app(Settings.from_env({"DATABASE_URL": UNUSED_DB_URL, "APP_AUTH": "off", **PROD_AUTH_ENV}))


def test_production_process_refuses_to_start_without_secret():
    """The real start-up path: importing app.main (what uvicorn does) fails with a clear message."""
    env = {"APP_ENV": "production", "DATABASE_URL": UNUSED_DB_URL, "PUBLIC_URL": "https://ca.example",
           "OIDC_ISSUER": "https://idp.example", "OIDC_CLIENT_ID": "x", "OIDC_CLIENT_SECRET": "y",
           "SYSTEMROOT": __import__("os").environ.get("SYSTEMROOT", "")}
    p = subprocess.run([sys.executable, "-c", "import app.main"], cwd=str(BACKEND_DIR), env=env,
                       capture_output=True, text=True, timeout=120)
    assert p.returncode != 0 and "SESSION_SECRET" in p.stderr


# --- values shipped in the repository (deploy/.env.example, deploy/dev.env, the test harness) -------------
DEPLOY_DIR = BACKEND_DIR.parent / "deploy"


def read_env_file(path) -> dict:
    """KEY=VALUE lines of a compose --env-file (comments and blank lines skipped), read from the real file."""
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            out[key.strip()] = value.strip()
    return out


ENV_EXAMPLE = read_env_file(DEPLOY_DIR / ".env.example")
DEV_ENV = read_env_file(DEPLOY_DIR / "dev.env")


def real_looking_prod(**kw) -> Settings:
    """Production settings as an operator fills them in: random secrets, https, an Entra-shaped issuer with a
    RANDOM GUID (no real tenant / client anywhere)."""
    base = dict(app_env="production", database_url=UNUSED_DB_URL, session_secret=secrets.token_hex(32),
                public_url="https://ca.example.com",
                oidc_issuer=f"https://login.microsoftonline.com/{uuid.uuid4()}/v2.0",
                oidc_client_id=str(uuid.uuid4()), oidc_client_secret=secrets.token_urlsafe(30))
    base.update(kw)
    return Settings(**base)


def test_production_starts_with_a_random_secret_and_real_looking_values():
    a = create_app(real_looking_prod())
    assert a.state.auth.configured and a.state.auth.provider == "entra"
    assert a.state.auth.cookie_name == "__Host-ca_session"


SHIPPED_VALUES = [
    pytest.param({"session_secret": ENV_EXAMPLE["SESSION_SECRET"]}, "SESSION_SECRET", id="env.example-secret"),
    pytest.param({"public_url": f"https://{ENV_EXAMPLE['DOMAIN']}"}, "PUBLIC_URL", id="env.example-domain"),
    pytest.param({"oidc_issuer": ENV_EXAMPLE["OIDC_ISSUER"]}, "OIDC_ISSUER", id="env.example-issuer"),
    pytest.param({"oidc_client_id": ENV_EXAMPLE["OIDC_CLIENT_ID"]}, "OIDC_CLIENT_ID", id="env.example-client-id"),
    pytest.param({"oidc_client_secret": ENV_EXAMPLE["OIDC_CLIENT_SECRET"]}, "OIDC_CLIENT_SECRET",
                 id="env.example-client-secret"),
    pytest.param({"session_secret": DEV_ENV["SESSION_SECRET"]}, "published", id="dev.env-secret"),
    pytest.param({"session_secret": TEST_SESSION_SECRET}, "published", id="conftest-secret"),
    pytest.param({"session_secret": ENV_EXAMPLE["SESSION_SECRET"].strip("<>")}, "published",
                 id="env.example-secret-without-brackets"),
    pytest.param({"session_secret": "X" + DEV_ENV["SESSION_SECRET"].upper() + "-2"}, "published",
                 id="dev.env-secret-inside-a-longer-value"),
]


@pytest.mark.parametrize("change,message", SHIPPED_VALUES)
def test_production_refuses_values_shipped_in_the_repository(change, message):
    """A placeholder left in deploy/.env (copied from .env.example) or a secret from dev.env / the tests:
    production does not start, and the message never contains the value."""
    with pytest.raises(SettingsError, match=message) as exc:
        create_app(real_looking_prod(**change))
    (value,) = change.values()
    assert value not in str(exc.value)


def test_env_example_holds_only_values_that_refuse_to_start():
    """Every value in deploy/.env.example is either a <...> placeholder the API refuses (test above) or empty:
    compose refuses an empty POSTGRES_PASSWORD (${...:?}); APP_ADMIN_EMAILS may stay empty."""
    with_placeholder = {k for k, v in ENV_EXAMPLE.items() if "<" in v or ">" in v}
    assert with_placeholder == {"DOMAIN", "SESSION_SECRET", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"}
    assert {k: v for k, v in ENV_EXAMPLE.items() if k not in with_placeholder} == {
        "POSTGRES_PASSWORD": "", "APP_ADMIN_EMAILS": ""}
    assert "${POSTGRES_PASSWORD:?" in (DEPLOY_DIR / "docker-compose.yml").read_text(encoding="utf-8")


def test_production_refuses_the_dev_env_file_as_compose_passes_it():
    env = {"DATABASE_URL": UNUSED_DB_URL, "PUBLIC_URL": f"https://{DEV_ENV['DOMAIN']}",
           **{k: DEV_ENV[k] for k in ("SESSION_SECRET", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET")}}
    with pytest.raises(SettingsError):
        create_app(Settings.from_env(env))


def test_dev_still_accepts_the_dev_env_and_test_secrets():
    for secret in (DEV_ENV["SESSION_SECRET"], TEST_SESSION_SECRET):
        cfg = build_auth_config(Settings(
            app_env="dev", database_url=UNUSED_DB_URL, session_secret=secret, public_url="http://127.0.0.1:8180",
            oidc_issuer=DEV_ENV["OIDC_ISSUER"], oidc_client_id=DEV_ENV["OIDC_CLIENT_ID"],
            oidc_client_secret=DEV_ENV["OIDC_CLIENT_SECRET"]))
        assert cfg.configured and cfg.session_secret == secret


@pytest.mark.parametrize("secret", [ENV_EXAMPLE["SESSION_SECRET"], DEV_ENV["SESSION_SECRET"]],
                         ids=["env.example-placeholder", "dev.env"])
def test_production_process_refuses_a_shipped_secret_without_printing_it(secret):
    env = {"APP_ENV": "production", "DATABASE_URL": UNUSED_DB_URL, "PUBLIC_URL": "https://ca.example.com",
           "OIDC_ISSUER": "https://idp.example.com", "OIDC_CLIENT_ID": "x", "OIDC_CLIENT_SECRET": "y",
           "SESSION_SECRET": secret, "SYSTEMROOT": __import__("os").environ.get("SYSTEMROOT", "")}
    p = subprocess.run([sys.executable, "-c", "import app.main"], cwd=str(BACKEND_DIR), env=env,
                       capture_output=True, text=True, timeout=120)
    assert p.returncode != 0 and "SESSION_SECRET" in p.stderr
    assert secret not in p.stderr and secret not in p.stdout


def test_dev_without_identity_provider_fails_closed(session_factory):
    a = create_app(Settings(app_env="dev", database_url=UNUSED_DB_URL))
    a.dependency_overrides[dbm.get_db] = db_override(session_factory)
    c = TestClient(a, follow_redirects=False)
    assert c.get("/auth/config").json() == {"auth": "oidc", "provider": None, "provider_name": None}
    assert c.get("/auth/login").headers["location"] == "/index.html?auth_error=unavailable"
    assert c.get("/suppliers").status_code == 401


def test_dev_auth_off_acts_as_dev_admin(session_factory, caplog):
    a = create_app(Settings(app_env="dev", database_url=UNUSED_DB_URL, auth_mode="off"))
    a.dependency_overrides[dbm.get_db] = db_override(session_factory)
    c = TestClient(a, follow_redirects=False)
    assert c.get("/auth/config").json() == {"auth": "off", "provider": None, "provider_name": None}
    assert c.get("/auth/me").json() == {"email": "dev@localhost", "name": "Developer (APP_AUTH=off)", "role": "admin"}
    with caplog.at_level(logging.INFO, logger="app"):
        assert c.put("/config", json={"fml_default": 9}).status_code == 200
    assert any("user=dev@localhost" in rec.getMessage() for rec in caplog.records)
    assert c.get("/auth/login").headers["location"] == "/index.html#enter"


def test_provider_names_and_detection():
    assert provider_for_issuer(ISSUERS["entra"]) == "entra"
    assert provider_for_issuer("https://ACCOUNTS.google.com") == "google"
    assert provider_for_issuer("https://login.microsoftonline.com.evil.example/x/v2.0") == "generic"
    cfg = build_auth_config(prod(oidc_provider_name="Acme SSO"))
    assert cfg.provider_name == "Acme SSO" and cfg.cookie_name == "__Host-ca_session" and cfg.secure_cookie
    assert cfg.redirect_uri == "https://ca.example/api/auth/callback"
    assert build_auth_config(prod(public_url="https://CA.example:443/")).public_origin == "https://ca.example"


def test_normalize_origin():
    assert normalize_origin("https://A.example:443") == "https://a.example"
    assert normalize_origin("http://127.0.0.1:5500") == "http://127.0.0.1:5500"
    for bad in ("null", "", "file://x", "https://a.example/path", "https://u:p@a.example", "https://a.example:99999"):
        assert normalize_origin(bad) is None, bad
