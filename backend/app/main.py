from __future__ import annotations

import logging
import math
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.orm import Session
from starlette.middleware.sessions import SessionMiddleware

from seed.suppliers_seed import seed_suppliers

from . import auth
from . import db as dbm
from . import models  # noqa: F401  (register tables)
from .middleware import OriginCheckMiddleware, RequestContextMiddleware, configure_logging
from .routers import config, forecast, reports, stuffing, suppliers, weekly
from .settings import Settings, get_settings

log = logging.getLogger("app")

# Every data router: each of their routes requires a signed-in, active user (auth.current_user); admin-only
# routes add auth.require_admin themselves. Public: /health, /health/ready and the /auth routes.
API_ROUTERS = (suppliers, forecast, stuffing, weekly, reports, config)


@asynccontextmanager
async def lifespan(app: FastAPI):
    s: Settings = app.state.settings
    if s.is_dev:
        # Local development only: build missing tables and seed the 14 MGH suppliers (seed/suppliers_seed.py).
        # Production schema = `alembic upgrade head` (one-shot migrate step); suppliers start empty.
        engine = dbm.get_engine()
        dbm.Base.metadata.create_all(engine)
        with dbm.SessionLocal() as db:
            seed_suppliers(db)
    log.info("started (APP_ENV=%s)", s.app_env)
    yield
    dbm.dispose_engine()


def _clean(v):
    """A NaN/Infinity echoed in a validation error's `input` is sent as text (it is not valid JSON)."""
    if isinstance(v, float) and not math.isfinite(v):
        return str(v)
    if isinstance(v, dict):
        return {k: _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    return v


async def _validation_error(_: Request, exc: RequestValidationError):
    return JSONResponse(status_code=422, content=jsonable_encoder({"detail": _clean(exc.errors())}))


async def _db_busy(_: Request, exc: dbm.DatabaseBusy):
    log.warning("write lock %r not available within lock_timeout", str(exc))
    return JSONResponse(status_code=503,
                        content={"detail": "Someone else is saving the same data right now. Try again in a moment."})


def health():
    """Liveness: the process answers (no database access)."""
    return {"status": "ok"}


def health_ready(db: Session = Depends(dbm.get_db)):
    """Readiness: the database answers `SELECT 1`."""
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        log.exception("readiness check failed")
        return JSONResponse(status_code=503, content={"status": "unavailable"})
    return {"status": "ready"}


def create_app(settings: Settings | None = None, *, oidc_transport=None) -> FastAPI:
    """Build the app. Raises SettingsError (the process refuses to start) on unsafe sign-in settings, see
    auth.build_auth_config. ``oidc_transport`` is a test seam (an httpx transport to a mock identity
    provider); production leaves it None."""
    s = settings or get_settings()
    configure_logging(s.log_level)
    auth_cfg = auth.build_auth_config(s)
    prod = s.is_production
    app = FastAPI(title="Carrier Allocation & Utilization", lifespan=lifespan,
                  docs_url=None if prod else "/docs", redoc_url=None if prod else "/redoc",
                  openapi_url=None if prod else "/openapi.json")
    app.state.settings = s
    app.state.auth = auth_cfg
    app.state.oidc = auth.make_oidc_client(auth_cfg, transport=oidc_transport)
    (log.warning if auth_cfg.mode == "off" or not auth_cfg.configured else log.info)(
        "sign-in: %s", auth.describe(auth_cfg))
    if auth_cfg.random_secret:
        log.warning("SESSION_SECRET not set (dev): using a random one, sessions end when the process restarts")

    for r in API_ROUTERS:
        app.include_router(r.router, dependencies=[Depends(auth.current_user)])
    app.include_router(auth.router)
    app.add_api_route("/health", health, methods=["GET"], tags=["health"])
    app.add_api_route("/health/ready", health_ready, methods=["GET"], tags=["health"])

    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(dbm.DatabaseBusy, _db_busy)

    # Middleware: the last added is the outermost, so the order below is (outer -> inner)
    # CORS -> request context -> cross-site check -> session -> app. CORS stays outside so even a 500 or a
    # cross-site 403 carries CORS headers; the request context logs and stamps the 403 as well.
    app.add_middleware(SessionMiddleware, secret_key=auth_cfg.session_secret, session_cookie=auth_cfg.cookie_name,
                       max_age=auth.SESSION_MAX_AGE, path="/", same_site="lax", https_only=auth_cfg.secure_cookie)
    app.add_middleware(OriginCheckMiddleware, allowed_origins=auth_cfg.allowed_origins,
                       normalize=auth.normalize_origin)
    app.add_middleware(RequestContextMiddleware)
    if s.cors_origins:
        # Production default is none (pages and API share one origin behind the proxy). Dev default: the
        # :5500 pages. Override with APP_CORS_ORIGINS="https://a.example,https://b.example".
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(s.cors_origins),
            allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            allow_headers=["*"],
            expose_headers=["Content-Disposition"],  # lets the page read the .xlsx download file name
        )
    return app


app = create_app()
