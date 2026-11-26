"""Environment-driven settings, read once per process (``get_settings()``).

The app runs on PostgreSQL only. APP_ENV defaults to ``production`` so a forgotten variable fails closed:
production never runs ``create_all``/the supplier seed, hides /docs, and sends no CORS headers unless
APP_CORS_ORIGINS lists origins. Local development and the tests set ``APP_ENV=dev``.

Variables (all optional unless noted):
  APP_ENV            ``production`` (default) or ``dev``.
  DATABASE_URL       REQUIRED in every APP_ENV (alias APP_DB_URL): a PostgreSQL URL,
                     ``postgresql+psycopg://user:pass@host:5432/db``. ``postgres://``/``postgresql://`` are
                     rewritten to ``postgresql+psycopg://`` (psycopg 3 is the installed driver); any other
                     database or driver is refused at startup. There is no default database.
  DB_POOL_SIZE, DB_MAX_OVERFLOW, DB_POOL_RECYCLE   Postgres pool sizing (5, 5, 1800 s).
  DB_LOCK_TIMEOUT_MS Postgres ``lock_timeout`` per connection (30000). Also bounds advisory-lock waits.
  APP_CORS_ORIGINS   comma-separated origins. Default: none in production; the :5500 dev pages in dev.
  LOG_LEVEL          app log level (INFO).
  Sign-in (checked at startup by ``app.auth.build_auth_config``; production refuses to start without them):
  SESSION_SECRET     signs the session cookie; >= 32 characters in production, not a value written in this
                     repository (dev: random per process). Production also refuses a <...> placeholder here,
                     in PUBLIC_URL and in the OIDC_* values.
  PUBLIC_URL         the bare origin users open, e.g. ``https://ca.example.com`` (https in production).
  OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET   the company identity provider (generic OIDC).
  OIDC_PROVIDER_NAME button label ("Sign in with <name>"); default from the issuer.
  OIDC_GOOGLE_HD     Google only: comma-separated Workspace domains accepted in the ``hd`` claim (required).
  APP_ADMIN_EMAILS   comma-separated emails that become admins on their first sign-in (bootstrap).
  APP_AUTH           ``on`` (default) or ``off``; ``off`` (no sign-in, everyone is a dev admin) is only
                     accepted with APP_ENV=dev.
"""
from __future__ import annotations

import dataclasses
import os
from functools import lru_cache
from typing import Mapping

from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError

DEV_CORS_ORIGINS = ("http://127.0.0.1:5500", "http://localhost:5500")
APP_ENVS = ("dev", "production")
AUTH_MODES = ("on", "off")
DB_DRIVER = "postgresql+psycopg"  # the only supported database + driver (psycopg 3)
DB_URL_EXAMPLE = "postgresql+psycopg://user:pass@host:5432/ca"


class SettingsError(RuntimeError):
    """Configuration that must stop the process from starting."""


def _csv(value: str | None) -> tuple[str, ...]:
    return tuple(x.strip() for x in (value or "").split(",") if x.strip())


def _int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        raise SettingsError(f"{name} must be an integer, got {raw!r}") from None


def normalize_db_url(url: str) -> str:
    """Use the psycopg 3 driver for bare Postgres URLs (SQLAlchemy would otherwise pick psycopg2)."""
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


def check_database_url(url: str | None) -> str:
    """The normalized PostgreSQL URL, or SettingsError: the app, the CLI and Alembic run on PostgreSQL
    (psycopg 3) only. The message names the variable and the scheme, never the URL (it holds a password)."""
    raw = (url or "").strip()
    if not raw:
        raise SettingsError(f"DATABASE_URL (or APP_DB_URL) is required: a PostgreSQL URL such as {DB_URL_EXAMPLE}")
    raw = normalize_db_url(raw)
    try:
        driver = make_url(raw).drivername
    except ArgumentError:
        driver = None
    if driver != DB_DRIVER:
        scheme = raw.split("://", 1)[0] if "://" in raw else "(not a URL)"
        raise SettingsError(f"DATABASE_URL (or APP_DB_URL) must be a PostgreSQL URL such as {DB_URL_EXAMPLE}; "
                            f"got scheme {scheme!r} (only PostgreSQL with psycopg 3 is supported)")
    return raw


@dataclasses.dataclass(frozen=True)
class Settings:
    app_env: str = "production"
    database_url: str = ""
    db_pool_size: int = 5
    db_max_overflow: int = 5
    db_pool_recycle: int = 1800
    db_lock_timeout_ms: int = 30000
    cors_origins: tuple[str, ...] = ()
    log_level: str = "INFO"
    # --- sign-in (validated by app.auth.build_auth_config when the app is created) ---
    auth_mode: str = "on"
    session_secret: str | None = None
    public_url: str | None = None
    admin_emails: tuple[str, ...] = ()
    oidc_issuer: str | None = None
    oidc_client_id: str | None = None
    oidc_client_secret: str | None = None
    oidc_provider_name: str | None = None
    oidc_google_hd: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        # Every Settings (also one built directly, e.g. create_app(Settings(...))) holds a PostgreSQL URL.
        object.__setattr__(self, "database_url", check_database_url(self.database_url))

    @property
    def is_dev(self) -> bool:
        return self.app_env == "dev"

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        env = os.environ if env is None else env
        app_env = (env.get("APP_ENV") or "production").strip().lower()
        if app_env not in APP_ENVS:
            raise SettingsError(f"APP_ENV must be one of {APP_ENVS}, got {app_env!r}")
        url = check_database_url(env.get("DATABASE_URL") or env.get("APP_DB_URL"))
        auth_mode = (env.get("APP_AUTH") or "on").strip().lower()
        if auth_mode not in AUTH_MODES:
            raise SettingsError(f"APP_AUTH must be one of {AUTH_MODES}, got {auth_mode!r}")
        cors_raw = env.get("APP_CORS_ORIGINS")
        if cors_raw is not None:
            cors = _csv(cors_raw)
        else:
            cors = DEV_CORS_ORIGINS if app_env == "dev" else ()
        return cls(
            app_env=app_env,
            database_url=url,
            db_pool_size=_int(env, "DB_POOL_SIZE", 5),
            db_max_overflow=_int(env, "DB_MAX_OVERFLOW", 5),
            db_pool_recycle=_int(env, "DB_POOL_RECYCLE", 1800),
            db_lock_timeout_ms=_int(env, "DB_LOCK_TIMEOUT_MS", 30000),
            cors_origins=cors,
            log_level=(env.get("LOG_LEVEL") or "INFO").strip().upper(),
            auth_mode=auth_mode,
            session_secret=env.get("SESSION_SECRET") or None,
            public_url=(env.get("PUBLIC_URL") or "").strip() or None,
            admin_emails=tuple(e.lower() for e in _csv(env.get("APP_ADMIN_EMAILS"))),
            oidc_issuer=(env.get("OIDC_ISSUER") or "").strip() or None,
            oidc_client_id=(env.get("OIDC_CLIENT_ID") or "").strip() or None,
            oidc_client_secret=env.get("OIDC_CLIENT_SECRET") or None,
            oidc_provider_name=(env.get("OIDC_PROVIDER_NAME") or "").strip() or None,
            oidc_google_hd=tuple(d.lower() for d in _csv(env.get("OIDC_GOOGLE_HD"))),
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings.from_env()


def reset_settings_cache() -> None:
    """Tests only: re-read the environment on the next get_settings()."""
    get_settings.cache_clear()
