from __future__ import annotations

from contextlib import asynccontextmanager

import os

import math

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from seed.suppliers_seed import seed_suppliers

from . import db as dbm
from . import models  # noqa: F401  (register tables)
from .routers import config, forecast, reports, stuffing, suppliers, weekly


@asynccontextmanager
async def lifespan(app: FastAPI):
    dbm.Base.metadata.create_all(dbm.engine)
    dbm.migrate_schema(dbm.engine)
    with dbm.SessionLocal() as s:
        seed_suppliers(s)
    yield


app = FastAPI(title="Carrier Allocation & Utilization", lifespan=lifespan)

# The browser front end is served from another port (python -m http.server 5500), so it needs CORS.
# Override with APP_CORS_ORIGINS="https://a.example,https://b.example" when it is hosted elsewhere.
CORS_ORIGINS = [o.strip() for o in os.environ.get(
    "APP_CORS_ORIGINS", "http://127.0.0.1:5500,http://localhost:5500").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],  # lets the page read the .xlsx download file name
)

for r in (suppliers, forecast, stuffing, weekly, reports, config):
    app.include_router(r.router)


@app.exception_handler(RequestValidationError)
async def _validation_error(_: Request, exc: RequestValidationError):
    """Default 422 body, but a NaN/Infinity echoed in an error's `input` is sent as text (it is not valid JSON)."""
    def clean(v):
        if isinstance(v, float) and not math.isfinite(v):
            return str(v)
        if isinstance(v, dict):
            return {k: clean(x) for k, x in v.items()}
        if isinstance(v, (list, tuple)):
            return [clean(x) for x in v]
        return v
    return JSONResponse(status_code=422, content=jsonable_encoder({"detail": clean(exc.errors())}))


@app.get("/health")
def health():
    return {"status": "ok"}
