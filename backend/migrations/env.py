"""Alembic environment (PostgreSQL only). The URL comes from DATABASE_URL / APP_DB_URL (or, in tests, from
``config.attributes["database_url"]``); there is no default database and any non-PostgreSQL URL is refused."""
from __future__ import annotations

import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool

from app import models  # noqa: F401  (register tables on Base.metadata)
from app.db import Base, make_engine
from app.settings import check_database_url

config = context.config
if config.config_file_name is not None and config.attributes.get("configure_logger", True):
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _url() -> str:
    """Raises SettingsError (a RuntimeError) when the URL is missing or not PostgreSQL."""
    return check_database_url(config.attributes.get("database_url") or os.environ.get("DATABASE_URL")
                              or os.environ.get("APP_DB_URL"))


def _configure(**kw) -> None:
    context.configure(target_metadata=target_metadata, compare_type=True, **kw)


def run_migrations_offline() -> None:
    _configure(url=_url(), literal_binds=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connection = config.attributes.get("connection")
    if connection is not None:
        _configure(connection=connection)
        with context.begin_transaction():
            context.run_migrations()
        return
    engine = make_engine(_url(), poolclass=pool.NullPool)
    try:
        with engine.connect() as conn:
            _configure(connection=conn)
            with context.begin_transaction():
                context.run_migrations()
    finally:
        engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
