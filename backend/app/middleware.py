"""Request context (request id, security headers, write logging, catch-all 500) and the cross-site check."""
from __future__ import annotations

import contextvars
import logging
import re
import sys
import time
import uuid
from collections.abc import Callable, Iterable

from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import JSONResponse

log = logging.getLogger("app")
request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")

# HSTS and the page CSP are set by the reverse proxy (Caddy); these are safe for every API response.
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
}
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
# C0/C1 control characters (incl. CR, LF, VT, FF, FS/GS/RS, NEL) and the Unicode line/paragraph separators:
# everything str.splitlines() breaks a line on.
_LOG_UNSAFE = re.compile("[\x00-\x1f\x7f-\x9f  ]")


def log_safe(value) -> str:
    """``value`` for a log line, with control characters and line breaks written as ``\\xNN``/``\\uNNNN``:
    a client-chosen string (the request path, e.g. ``/config%0a<fake log line>``) can never start a new
    log line. Ordinary text is returned unchanged."""
    s = "-" if value is None else str(value)
    return _LOG_UNSAFE.sub(lambda m: f"\\x{ord(m[0]):02x}" if ord(m[0]) < 0x100 else f"\\u{ord(m[0]):04x}", s)


class _RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "request_id"):
            record.request_id = request_id_var.get()
        return True


def configure_logging(level: str = "INFO") -> None:
    """Log the ``app`` logger to stdout with the request id (idempotent)."""
    logger = logging.getLogger("app")
    logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    if not any(getattr(h, "_ca_handler", False) for h in logger.handlers):
        h = logging.StreamHandler(sys.stdout)
        h._ca_handler = True  # type: ignore[attr-defined]
        h.addFilter(_RequestIdFilter())
        h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s [%(request_id)s] %(message)s"))
        logger.addHandler(h)


class RequestContextMiddleware:
    """Pure ASGI middleware.

    - gives every request an id (``request.state.request_id``, ``X-Request-ID`` response header, log lines);
    - adds SECURITY_HEADERS to every response;
    - logs every write (method, path, status, duration, user email once authentication sets
      ``request.state.user_email``);
    - turns an unhandled exception into ``500 {"detail", "request_id"}`` and logs the traceback (the client
      never sees exception text or SQL).
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        rid = uuid.uuid4().hex[:16]
        state = scope.setdefault("state", {})
        state["request_id"] = rid
        token = request_id_var.set(rid)
        started = False
        status = 500
        t0 = time.perf_counter()

        async def send_wrapper(message):
            nonlocal started, status
            if message["type"] == "http.response.start":
                started = True
                status = message["status"]
                headers = MutableHeaders(scope=message)
                for k, v in SECURITY_HEADERS.items():
                    if k not in headers:
                        headers[k] = v
                headers["X-Request-ID"] = rid
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            log.exception("unhandled error in %s %s", log_safe(scope.get("method")), log_safe(scope.get("path")))
            if started:
                raise
            await JSONResponse({"detail": "Internal server error", "request_id": rid},
                               status_code=500)(scope, receive, send_wrapper)
        finally:
            if scope.get("method") in WRITE_METHODS:
                log.info("%s %s -> %s %.0fms user=%s", log_safe(scope.get("method")), log_safe(scope.get("path")),
                         status, (time.perf_counter() - t0) * 1000, log_safe(state.get("user_email") or "-"))
            request_id_var.reset(token)


SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
SAME_ORIGIN_FETCH = {"same-origin", "none"}


class OriginCheckMiddleware:
    """CSRF defence in depth (the session cookie is also SameSite=Lax) for every non-GET/HEAD/OPTIONS request:

    - an ``Origin`` header must be one of ``allowed_origins`` (PUBLIC_URL's origin; in dev also the CORS
      origins). ``Origin: null`` or anything unparsable is refused;
    - without ``Origin``, ``Sec-Fetch-Site`` must be ``same-origin`` or ``none`` when present;
    - a request with neither header (curl, scripts, the test client) passes; it carries no browser cookies
      unless its author put them there.
    Refusal: 403 ``{"detail": "Cross-site request refused."}``.
    """

    def __init__(self, app, allowed_origins: Iterable[str], normalize: Callable[[str], str | None]):
        self.app = app
        self.allowed = frozenset(allowed_origins)
        self.normalize = normalize

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope.get("method") not in SAFE_METHODS:
            headers = Headers(scope=scope)
            origin = headers.get("origin")
            reason = None
            if origin is not None:
                if self.normalize(origin) not in self.allowed:
                    reason = f"origin {origin[:100]!r}"
            else:
                site = headers.get("sec-fetch-site")
                if site is not None and site.lower() not in SAME_ORIGIN_FETCH:
                    reason = f"sec-fetch-site {site[:30]!r}"
            if reason:
                log.warning("cross-site %s %s refused (%s)", log_safe(scope.get("method")),
                            log_safe(scope.get("path")), reason)
                await JSONResponse({"detail": "Cross-site request refused."}, status_code=403)(scope, receive, send)
                return
        await self.app(scope, receive, send)
