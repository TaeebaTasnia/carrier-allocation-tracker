# API image: FastAPI app + Alembic migrations + the CLI (python -m app.cli).
# Build context = backend/ (see backend/.dockerignore). Used by deploy/docker-compose.yml for the
# one-shot `migrate` service and the `api` service.
# Exact tag (Python 3.12.16, Debian slim), the version the tests were run with; bump it deliberately.
FROM python:3.12.16-slim

# FORWARDED_ALLOW_IPS: uvicorn trusts X-Forwarded-* only from these addresses. The image default trusts
# nobody outside the container; docker-compose.yml sets it to the subnet of the network shared with Caddy
# (never "*").
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    FORWARDED_ALLOW_IPS=127.0.0.1

WORKDIR /app

# Runtime dependencies only (requirements-dev.txt / pytest are not installed).
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin app

# Code is owned by root and read-only for the app user.
COPY app/ ./app/
COPY migrations/ ./migrations/
COPY seed/ ./seed/
COPY alembic.ini ./
RUN python -m compileall -q app migrations seed

USER app
EXPOSE 8000

# Readiness of THIS container (database answers). Called directly on uvicorn, so the path has no /api prefix.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health/ready', timeout=4).status == 200 else 1)"]

# --root-path /api: Caddy strips /api (handle_path) and uvicorn puts it back into scope["root_path"], so
# routing sees /weekly/... while generated URLs and logs show /api/weekly/...
# --proxy-headers: client IP/scheme from X-Forwarded-*, trusted only from $FORWARDED_ALLOW_IPS.
# Access logging is done by Caddy; the app logs every write with its request id and the user's email.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", \
     "--proxy-headers", "--root-path", "/api", "--no-server-header", "--no-access-log"]
