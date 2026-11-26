"""Sign-in through the company identity provider (generic OpenID Connect via Authlib) and access control.

Everything is driven by environment variables (see app/settings.py); nothing here is provider specific
except the claim rules below, chosen by the HOST of ``OIDC_ISSUER``:

  login.microsoftonline.com -> "entra"   issuer must be https://login.microsoftonline.com/<tenant-guid>/v2.0
                                         (single tenant). The ``tid`` claim must be that tenant, guest and
                                         personal accounts (an ``idp`` claim other than the issuer or
                                         https://sts.windows.net/<tenant>/) are refused, the
                                         email is ``email`` else ``preferred_username``. Entra sends no
                                         ``email_verified``; an explicit false is still refused. The account is
                                         bound by ``oid`` (stable across app registrations).
  accounts.google.com       -> "google"  ``email_verified`` must be true and ``hd`` must be one of
                                         OIDC_GOOGLE_HD (Workspace accounts only). Bound by ``sub``.
  anything else             -> "generic" ``email`` present and ``email_verified`` true (boolean, or the string
                                         "true" some providers send). Bound by ``sub``.

Common rules: the ID token is verified by Authlib (signature from the provider's JWKS, ``aud`` = client id,
``exp``, ``nonce``); its ``iss`` and the discovery document's ``issuer`` must both equal OIDC_ISSUER;
emails are compared lowercased. Allow-list only: a person signs in when their email is a row in ``users``
(added with ``python -m app.cli add-user``) that is active and not bound to a different account, or when the
email is listed in APP_ADMIN_EMAILS and has no row yet (the row is created as an admin). Nobody else is
ever created.

Session: Starlette's signed cookie (itsdangerous), HttpOnly, SameSite=Lax, path "/", 12 hours, Secure when
PUBLIC_URL is https (cookie name ``__Host-ca_session``; ``ca_session`` over plain http in dev). It holds only
``uid``, ``epoch`` and ``exp`` once signed in (during sign-in also Authlib's state/nonce/PKCE verifier and
the ``next`` path). The user row is read on every request; raising ``users.session_epoch`` (sign-out,
deactivation, unbind) invalidates every cookie issued before, so a copied/replayed cookie dies with it.

Routes (inside the app; behind the proxy the browser sees them under /api):
  GET  /auth/config, GET /auth/login, GET /auth/callback, POST /auth/logout, GET /auth/me.
The full contract the pages code against is in backend/README.md, "Authentication contract".
"""
from __future__ import annotations

import dataclasses
import logging
import re
import secrets
import time
from urllib.parse import urlsplit

import httpx
from authlib.integrations.base_client import OAuthError
from authlib.integrations.starlette_client import OAuth
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from joserfc.errors import JoseError
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from .db import get_db
from .models import User, utcnow
from .settings import Settings, SettingsError
from .validation import normalize_email

log = logging.getLogger("app.auth")

SESSION_MAX_AGE = 12 * 60 * 60          # seconds; absolute (the cookie is not re-signed on normal requests)
SECURE_COOKIE_NAME = "__Host-ca_session"  # https: the __Host- prefix forbids Domain= and requires Secure + path /
PLAIN_COOKIE_NAME = "ca_session"          # plain http (dev only)
DEFAULT_NEXT = "/index.html#enter"
ERROR_PAGE = "/index.html"
# The only values ever put in ?auth_error= (identity-provider text is never echoed).
AUTH_ERRORS = ("not_allowed", "inactive", "cancelled", "failed", "unavailable")
SCOPE = "openid email profile"
MIN_SECRET_LEN = 32
ENTRA_HOST = "login.microsoftonline.com"
GOOGLE_HOST = "accounts.google.com"
GOOGLE_ISSUER = "https://accounts.google.com"
PROVIDER_NAMES = {"entra": "Microsoft", "google": "Google", "generic": "SSO"}
NEXT_KEY = "login_next"
STATE_PREFIX = "_state_oidc_"  # Authlib's session key for the pending sign-in (client name "oidc")

# Production refuses a SESSION_SECRET that contains one of these (case-insensitive): they are public because
# they are written in this repository. tests/test_auth.py reads deploy/dev.env, deploy/.env.example and the
# test harness and fails when one of their secrets is not refused.
PUBLISHED_SECRETS = (
    "generate-with-openssl-rand-hex-32",                       # deploy/.env.example placeholder text
    "dev-only-session-secret-for-the-local-stack-0123456789",  # deploy/dev.env (local stack only)
    "test-session-secret-0123456789-abcdefghijklmnop",         # backend/tests/conftest.py
)
# A value still holding a .env.example placeholder such as <domain> or <client-id>.
_PLACEHOLDER = re.compile(r"[<>]")
_GUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
# A same-origin page path: starts with one "/", then URL characters only (no backslash, space, control chars).
_NEXT_OK = re.compile(r"^/(?![/\\])[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]*$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


# ---------------------------------------------------------------------------------------------------------
# Configuration (validated once, when the app is created: a bad production config refuses to start)
# ---------------------------------------------------------------------------------------------------------
@dataclasses.dataclass(frozen=True)
class AuthConfig:
    mode: str                         # "oidc" (sign-in required) or "off" (dev only)
    configured: bool                  # issuer, client id/secret and PUBLIC_URL are all set
    provider: str | None = None       # "entra" | "google" | "generic"
    provider_name: str | None = None
    issuer: str | None = None
    client_id: str | None = None
    client_secret: str | None = dataclasses.field(default=None, repr=False)
    tenant_id: str | None = None
    google_hd: tuple[str, ...] = ()
    admin_emails: frozenset[str] = frozenset()
    public_origin: str | None = None
    session_secret: str = dataclasses.field(default="", repr=False)
    random_secret: bool = False
    secure_cookie: bool = False
    cookie_name: str = PLAIN_COOKIE_NAME
    allowed_origins: frozenset[str] = frozenset()

    @property
    def redirect_uri(self) -> str:
        # Built from PUBLIC_URL, never from the request (url_for would miss the proxy's /api prefix).
        return f"{self.public_origin}/api/auth/callback"


def normalize_origin(value: str | None) -> str | None:
    """``scheme://host[:port]`` lowercased without a default port, or None if ``value`` is not a bare
    http(s) origin (a path other than "/", query, fragment or user info make it invalid; so does "null")."""
    if not value:
        return None
    try:
        p = urlsplit(value.strip())
        port = p.port
    except ValueError:
        return None
    if p.scheme not in ("http", "https") or not p.hostname:
        return None
    if p.username or p.password or p.path not in ("", "/") or p.query or p.fragment:
        return None
    host = p.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    default = 443 if p.scheme == "https" else 80
    return f"{p.scheme}://{host}" + (f":{port}" if port and port != default else "")


def safe_next(value: str | None) -> str:
    """The page to land on after sign-in: a same-origin relative path, else DEFAULT_NEXT.

    Allowed: "/" followed by URL characters (``/weekly.html?year=2026&week=45``). Refused: absolute URLs,
    ``//host``, ``/\\host``, backslashes, spaces/control characters (CRLF), anything not starting with "/",
    API paths (``/api/...``) and values over 512 characters."""
    if not value or len(value) > 512 or not _NEXT_OK.match(value):
        return DEFAULT_NEXT
    if value == "/api" or value.startswith(("/api/", "/api?", "/api#")):
        return DEFAULT_NEXT
    return value


def provider_for_issuer(issuer: str) -> str:
    host = (urlsplit(issuer).hostname or "").lower()
    if host == ENTRA_HOST:
        return "entra"
    if host == GOOGLE_HOST:
        return "google"
    return "generic"


def build_auth_config(s: Settings) -> AuthConfig:
    """Validate the sign-in settings. Raises SettingsError (the app refuses to start) when:
    production has APP_AUTH=off, a missing/weak SESSION_SECRET or one published in this repository
    (PUBLISHED_SECRETS), a <...> placeholder left in SESSION_SECRET / PUBLIC_URL / OIDC_ISSUER /
    OIDC_CLIENT_ID / OIDC_CLIENT_SECRET, no PUBLIC_URL / OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET, or
    a non-https PUBLIC_URL/issuer; in any mode when the OIDC values are partial, an Entra issuer is not
    single-tenant, or a Google issuer has no OIDC_GOOGLE_HD. Messages name the variable, never its value."""
    prod = not s.is_dev
    if s.auth_mode == "off" and prod:
        raise SettingsError("APP_AUTH=off is only accepted with APP_ENV=dev; production always requires sign-in")
    if prod:
        placeholders = [name for name, value in (
            ("SESSION_SECRET", s.session_secret), ("PUBLIC_URL", s.public_url), ("OIDC_ISSUER", s.oidc_issuer),
            ("OIDC_CLIENT_ID", s.oidc_client_id), ("OIDC_CLIENT_SECRET", s.oidc_client_secret),
        ) if value and _PLACEHOLDER.search(value)]
        if placeholders:
            raise SettingsError("a placeholder from deploy/.env.example (a value with < or >) is still set in: "
                                + ", ".join(placeholders)
                                + (" (PUBLIC_URL is built from DOMAIN)" if "PUBLIC_URL" in placeholders else "")
                                + "; set the real values")

    public_origin = None
    if s.public_url:
        public_origin = normalize_origin(s.public_url)
        if public_origin is None:
            raise SettingsError(f"PUBLIC_URL must be a bare origin such as https://ca.example.com (no path), "
                                f"got {s.public_url!r}")
        if prod and not public_origin.startswith("https://"):
            raise SettingsError("PUBLIC_URL must use https in production (the session cookie is Secure)")

    secret = s.session_secret or ""
    random_secret = False
    if prod:
        if len(secret) < MIN_SECRET_LEN or len(set(secret)) < 8:
            raise SettingsError(f"SESSION_SECRET must be a random value of at least {MIN_SECRET_LEN} characters in "
                                "production, e.g. python -c \"import secrets; print(secrets.token_urlsafe(48))\"")
        if any(p in secret.lower() for p in PUBLISHED_SECRETS):
            raise SettingsError("SESSION_SECRET is a value published in this repository (deploy/dev.env, the tests "
                                "or deploy/.env.example), so anyone could sign session cookies; generate a new one, "
                                "e.g. openssl rand -hex 32")
    elif not secret:
        secret, random_secret = secrets.token_urlsafe(48), True  # dev: sessions end when the process restarts

    secure = bool(public_origin and public_origin.startswith("https://"))
    origins = set()
    if public_origin:
        origins.add(public_origin)
    if s.is_dev:
        origins.update(o for o in (normalize_origin(x) for x in s.cors_origins) if o)
    common = dict(public_origin=public_origin, session_secret=secret, random_secret=random_secret,
                  secure_cookie=secure, cookie_name=SECURE_COOKIE_NAME if secure else PLAIN_COOKIE_NAME,
                  allowed_origins=frozenset(origins), admin_emails=frozenset(s.admin_emails))

    if s.auth_mode == "off":
        return AuthConfig(mode="off", configured=False, **common)

    needed = {"OIDC_ISSUER": s.oidc_issuer, "OIDC_CLIENT_ID": s.oidc_client_id,
              "OIDC_CLIENT_SECRET": s.oidc_client_secret}
    missing = [k for k, v in needed.items() if not v]
    if prod and (missing or not public_origin):
        raise SettingsError("production requires sign-in settings; missing: "
                            + ", ".join(missing + ([] if public_origin else ["PUBLIC_URL"])))
    if len(missing) == len(needed):  # dev without an identity provider: start, but nobody can sign in
        return AuthConfig(mode="oidc", configured=False, **common)
    if missing:
        raise SettingsError("incomplete OIDC settings; missing: " + ", ".join(missing))
    if not public_origin:
        raise SettingsError("PUBLIC_URL is required when OIDC is configured (it builds the callback URL)")

    issuer = s.oidc_issuer.strip().rstrip("/")
    try:
        p = urlsplit(issuer)
    except ValueError:
        raise SettingsError(f"OIDC_ISSUER is not a URL: {issuer!r}") from None
    if p.scheme not in ("http", "https") or not p.hostname or p.query or p.fragment:
        raise SettingsError(f"OIDC_ISSUER must be an http(s) URL without query/fragment, got {issuer!r}")
    if prod and p.scheme != "https":
        raise SettingsError("OIDC_ISSUER must use https in production")
    provider = provider_for_issuer(issuer)
    tenant_id = None
    if provider == "entra":
        m = re.fullmatch(r"/([^/]+)/v2\.0", p.path or "")
        if not m or not _GUID.match(m.group(1)):
            raise SettingsError("OIDC_ISSUER for Microsoft Entra must be https://login.microsoftonline.com/"
                                "<tenant-id GUID>/v2.0 (single tenant; 'common'/'organizations' are refused)")
        tenant_id = m.group(1).lower()
    elif provider == "google":
        if issuer != GOOGLE_ISSUER:
            raise SettingsError(f"OIDC_ISSUER for Google must be exactly {GOOGLE_ISSUER}")
        if not s.oidc_google_hd:
            raise SettingsError("OIDC_GOOGLE_HD (the company's Google Workspace domain) is required with Google "
                                "sign-in; personal Google accounts are refused")
    return AuthConfig(mode="oidc", configured=True, provider=provider,
                      provider_name=s.oidc_provider_name or PROVIDER_NAMES[provider], issuer=issuer,
                      client_id=s.oidc_client_id, client_secret=s.oidc_client_secret, tenant_id=tenant_id,
                      google_hd=tuple(s.oidc_google_hd), **common)


def describe(cfg: AuthConfig) -> str:
    if cfg.mode == "off":
        return "OFF (APP_AUTH=off, dev only): every request acts as a dev admin"
    if not cfg.configured:
        return "NOT CONFIGURED (dev): API answers 401 and sign-in reports auth_error=unavailable"
    return (f"OIDC {cfg.provider} issuer={cfg.issuer} redirect_uri={cfg.redirect_uri} "
            f"cookie={cfg.cookie_name} admins_bootstrap={len(cfg.admin_emails)}")


def make_oidc_client(cfg: AuthConfig, transport: httpx.AsyncBaseTransport | None = None):
    """One Authlib client per app (it caches the discovery document and JWKS). ``transport`` is the test
    seam: the tests pass ``httpx.ASGITransport`` wrapping a mock identity provider; production passes None."""
    if cfg.mode != "oidc" or not cfg.configured:
        return None
    client_kwargs = {"scope": SCOPE, "code_challenge_method": "S256", "timeout": 10.0}
    if transport is not None:
        client_kwargs["transport"] = transport
    oauth = OAuth()
    return oauth.register(
        name="oidc",
        client_id=cfg.client_id,
        client_secret=cfg.client_secret,  # sent with HTTP Basic (client_secret_basic) to the token endpoint
        server_metadata_url=f"{cfg.issuer}/.well-known/openid-configuration",
        client_kwargs=client_kwargs,
        # response_mode=query is the default for the code flow; sent explicitly except to Google, whose
        # documented parameter list does not include it.
        authorize_params=None if cfg.provider == "google" else {"response_mode": "query"},
    )


# ---------------------------------------------------------------------------------------------------------
# Claims -> identity -> allow-listed user
# ---------------------------------------------------------------------------------------------------------
class SignInRefused(Exception):
    def __init__(self, code: str, reason: str):
        assert code in AUTH_ERRORS
        super().__init__(reason)
        self.code, self.reason = code, reason


@dataclasses.dataclass(frozen=True)
class Identity:
    email: str
    name: str
    sub: str
    oid: str | None


@dataclasses.dataclass(frozen=True)
class CurrentUser:
    id: int
    email: str
    name: str
    role: str

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


DEV_USER = CurrentUser(id=0, email="dev@localhost", name="Developer (APP_AUTH=off)", role="admin")


def _clean_name(value) -> str:
    return _CONTROL.sub("", value).strip()[:200] if isinstance(value, str) else ""


def allowed_issuers(cfg: AuthConfig) -> list[str]:
    # Google may put the issuer without the scheme in ID tokens (documented by Google).
    return [cfg.issuer, "accounts.google.com"] if cfg.provider == "google" else [cfg.issuer]


def check_claims(cfg: AuthConfig, claims: dict) -> Identity:
    """Apply the provider rules (module docstring) to verified ID-token claims. Raises SignInRefused."""
    if claims.get("iss") not in allowed_issuers(cfg):
        raise SignInRefused("failed", f"issuer {claims.get('iss')!r} is not OIDC_ISSUER")
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub or len(sub) > 255 or _CONTROL.search(sub):
        raise SignInRefused("failed", "ID token has no usable sub")
    verified = claims.get("email_verified")
    if verified is not None and verified not in (True, "true"):
        raise SignInRefused("not_allowed", "email_verified is false")
    oid = None
    if cfg.provider == "entra":
        if str(claims.get("tid") or "").lower() != cfg.tenant_id:
            raise SignInRefused("not_allowed", f"tenant {claims.get('tid')!r} is not the configured tenant")
        idp = claims.get("idp")  # only set when the account's home is elsewhere (guest / personal account)
        if idp is not None and idp not in (claims.get("iss"), f"https://sts.windows.net/{cfg.tenant_id}/"):
            raise SignInRefused("not_allowed", f"guest/external account (idp {str(idp)[:100]!r}) is not accepted")
        oid = claims.get("oid")
        if not isinstance(oid, str) or not oid or len(oid) > 255 or _CONTROL.search(oid):
            raise SignInRefused("failed", "ID token has no usable oid")
        raw_email = claims.get("email") or claims.get("preferred_username")
    else:
        if verified not in (True, "true"):
            raise SignInRefused("not_allowed", "email_verified is not true")
        if cfg.provider == "google":
            hd = claims.get("hd")
            if not isinstance(hd, str) or hd.lower() not in cfg.google_hd:
                raise SignInRefused("not_allowed", f"hosted domain {hd!r} is not in OIDC_GOOGLE_HD")
        raw_email = claims.get("email")
    email = normalize_email(raw_email)
    if email is None:
        raise SignInRefused("not_allowed", "ID token has no usable email")
    return Identity(email=email, name=_clean_name(claims.get("name")), sub=sub, oid=oid)


def resolve_user(db: Session, cfg: AuthConfig, ident: Identity) -> User:
    """Find the allow-listed user for ``ident``; bind sub/oid on the first sign-in; record the sign-in.
    Raises SignInRefused. Every write is a single atomic statement or insert, so no advisory lock."""
    entra = cfg.provider == "entra"
    key_col = User.oid if entra else User.sub
    key = ident.oid if entra else ident.sub
    user = db.scalar(select(User).where(key_col == key))
    if user is None:
        user = db.scalar(select(User).where(User.email == ident.email))
        if user is None:
            if ident.email not in cfg.admin_emails:
                raise SignInRefused("not_allowed", f"{ident.email} is not on the allow-list")
            user = _create_bootstrap_admin(db, ident)
        bound = user.oid if entra else user.sub
        if bound is not None:
            raise SignInRefused("not_allowed", f"{ident.email} is bound to a different account")
        if not user.active:
            raise SignInRefused("inactive", f"{ident.email} is deactivated")
        try:  # first sign-in wins: bind only while still unbound
            res = db.execute(update(User).where(User.id == user.id, key_col.is_(None))
                             .values(sub=ident.sub, oid=ident.oid if entra else None)
                             .execution_options(synchronize_session=False))
            if res.rowcount != 1:
                raise SignInRefused("not_allowed", f"{ident.email} was bound to another account meanwhile")
            db.flush()
        except IntegrityError:
            db.rollback()
            raise SignInRefused("not_allowed", f"the account of {ident.email} is already bound to another user")
        log.info("bound %s to its identity-provider account on first sign-in", ident.email)
        db.refresh(user)
    elif not user.active:
        raise SignInRefused("inactive", f"{user.email} is deactivated")
    elif entra and user.sub != ident.sub:  # same person (oid), new app registration: keep sub current
        user.sub = ident.sub
    user.last_login_at = utcnow()
    if ident.name and not user.name:
        user.name = ident.name
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise SignInRefused("failed", f"could not record the sign-in of {user.email}")
    return user


def _create_bootstrap_admin(db: Session, ident: Identity) -> User:
    user = User(email=ident.email, name=ident.name, role="admin", active=True, session_epoch=0)
    db.add(user)
    try:
        db.flush()
    except IntegrityError:  # a concurrent first sign-in created it
        db.rollback()
        user = db.scalar(select(User).where(User.email == ident.email))
        if user is None:
            raise SignInRefused("failed", f"could not create the admin {ident.email}")
        return user
    log.info("created admin %s from APP_ADMIN_EMAILS on first sign-in", ident.email)
    return user


# ---------------------------------------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------------------------------------
def _cfg(request: Request) -> AuthConfig:
    return request.app.state.auth


def current_user(request: Request, db: Session = Depends(get_db)) -> CurrentUser:
    """Every /api data route depends on this. 401 {"detail": "Not authenticated"} without a valid session
    (never a redirect); 403 for a deactivated account. Sets request.state.user_email for the write log."""
    cfg = _cfg(request)
    if cfg.mode == "off":
        request.state.user_email = DEV_USER.email
        return DEV_USER
    sess = request.session
    uid, epoch, exp = sess.get("uid"), sess.get("epoch"), sess.get("exp")
    if uid is None:
        raise HTTPException(401, "Not authenticated")
    if (not isinstance(uid, int) or not isinstance(epoch, int) or not isinstance(exp, (int, float))
            or exp < time.time()):
        sess.clear()
        raise HTTPException(401, "Not authenticated")
    user = db.get(User, uid)
    if user is None:
        sess.clear()
        raise HTTPException(401, "Not authenticated")
    if not user.active:
        sess.clear()
        raise HTTPException(403, "Your account has been deactivated. Ask an administrator.")
    if user.session_epoch != epoch:  # signed out / revoked: this cookie is dead
        sess.clear()
        raise HTTPException(401, "Not authenticated")
    request.state.user_email = user.email
    return CurrentUser(id=user.id, email=user.email, name=user.name, role=user.role)


def require_admin(user: CurrentUser = Depends(current_user)) -> CurrentUser:
    if not user.is_admin:
        raise HTTPException(403, "Only an administrator can do this.")
    return user


# ---------------------------------------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------------------------------------
router = APIRouter(prefix="/auth", tags=["auth"])


def _public(cfg: AuthConfig, path: str) -> str:
    # Absolute on PUBLIC_URL; relative only when there is none (dev with APP_AUTH=off).
    return f"{cfg.public_origin or ''}{path}"


def _redirect(url: str) -> RedirectResponse:
    return RedirectResponse(url, status_code=302, headers={"Cache-Control": "no-store"})


def _refuse(request: Request, cfg: AuthConfig, code: str, reason: str) -> RedirectResponse:
    log.warning("sign-in refused (%s): %s", code, reason)
    request.session.clear()
    return _redirect(_public(cfg, f"{ERROR_PAGE}?auth_error={code}"))


async def _metadata_ok(client, cfg: AuthConfig) -> bool:
    """OIDC Discovery 4.3: the advertised issuer must be exactly the configured one."""
    metadata = await client.load_server_metadata()
    return isinstance(metadata, dict) and metadata.get("issuer") == cfg.issuer


@router.get("/config")
def auth_config(request: Request):
    cfg = _cfg(request)
    return {"auth": cfg.mode, "provider": cfg.provider, "provider_name": cfg.provider_name}


@router.get("/login")
async def login(request: Request, next: str | None = None):
    cfg = _cfg(request)
    target = safe_next(next)
    if cfg.mode == "off":
        return _redirect(_public(cfg, target))
    client = request.app.state.oidc
    if client is None:
        log.warning("sign-in requested but OIDC is not configured")
        return _redirect(_public(cfg, f"{ERROR_PAGE}?auth_error=unavailable"))
    try:
        if not await _metadata_ok(client, cfg):
            log.error("discovery document issuer differs from OIDC_ISSUER %s", cfg.issuer)
            return _redirect(_public(cfg, f"{ERROR_PAGE}?auth_error=unavailable"))
        resp = await client.authorize_redirect(request, cfg.redirect_uri)
    except Exception as e:  # identity provider unreachable or its discovery document unusable
        log.warning("sign-in start failed: %s: %s", type(e).__name__, e)
        return _redirect(_public(cfg, f"{ERROR_PAGE}?auth_error=unavailable"))
    request.session[NEXT_KEY] = target
    resp.headers["Cache-Control"] = "no-store"
    return resp


@router.get("/callback")
async def callback(request: Request, db: Session = Depends(get_db)):
    cfg = _cfg(request)
    client = request.app.state.oidc
    if cfg.mode != "oidc" or client is None:
        return _refuse(request, cfg, "unavailable", "callback while sign-in is not configured")
    target = safe_next(request.session.get(NEXT_KEY))
    idp_error = request.query_params.get("error")
    if idp_error:
        code = "cancelled" if idp_error == "access_denied" else "failed"
        return _refuse(request, cfg, code, f"identity provider returned error={idp_error[:64]!r}")
    pending = request.session.get(f"{STATE_PREFIX}{request.query_params.get('state', '')}")
    if isinstance(pending, dict) and pending.get("exp", 0) < time.time():
        return _refuse(request, cfg, "failed", "the sign-in attempt expired")
    try:
        if not await _metadata_ok(client, cfg):
            return _refuse(request, cfg, "failed", "discovery document issuer differs from OIDC_ISSUER")
        token = await client.authorize_access_token(
            request, claims_options={"iss": {"essential": True, "values": allowed_issuers(cfg)}})
    except httpx.HTTPError as e:
        return _refuse(request, cfg, "unavailable", f"identity provider unreachable: {type(e).__name__}")
    except (OAuthError, JoseError) as e:  # state mismatch, token endpoint error, bad signature/nonce/aud/exp
        return _refuse(request, cfg, "failed", f"{type(e).__name__}: {getattr(e, 'error', '')} {e}")
    except Exception as e:
        log.exception("unexpected sign-in error")
        return _refuse(request, cfg, "failed", type(e).__name__)
    claims = token.get("userinfo")
    if not claims:
        return _refuse(request, cfg, "failed", "the token response has no ID token")
    try:
        ident = check_claims(cfg, dict(claims))
        user = await run_in_threadpool(resolve_user, db, cfg, ident)
    except SignInRefused as e:
        return _refuse(request, cfg, e.code, e.reason)
    request.session.clear()  # nothing from before the sign-in survives (session fixation)
    request.session.update({"uid": user.id, "epoch": user.session_epoch,
                            "exp": int(time.time()) + SESSION_MAX_AGE})
    log.info("signed in: %s (%s)", user.email, user.role)
    return _redirect(_public(cfg, target))


@router.post("/logout")
def logout(request: Request, db: Session = Depends(get_db)):
    """Always 200. With a valid session, raises users.session_epoch: this cookie (and every other session
    of the same user, in any browser) stops working even if it is replayed."""
    cfg = _cfg(request)
    uid, epoch = request.session.get("uid"), request.session.get("epoch")
    if cfg.mode == "oidc" and isinstance(uid, int) and isinstance(epoch, int):
        user = db.get(User, uid)
        if user is not None and user.session_epoch == epoch:
            request.state.user_email = user.email
            db.execute(update(User).where(User.id == uid, User.session_epoch == epoch)
                       .values(session_epoch=User.session_epoch + 1)
                       .execution_options(synchronize_session=False))
            db.commit()
            log.info("signed out: %s", user.email)
    request.session.clear()
    return {"status": "signed_out"}


@router.get("/me")
def me(user: CurrentUser = Depends(current_user)):
    return {"email": user.email, "name": user.name, "role": user.role}
