"""Operator commands. Run from the backend folder:  python -m app.cli <command> ...

  add-user EMAIL --role admin|user [--name NAME]   allow EMAIL to sign in (an existing user: new role/name)
  deactivate EMAIL      refuse sign-in and end every session of EMAIL immediately
  activate EMAIL        allow a deactivated EMAIL again (they sign in again; old sessions stay ended)
  unbind EMAIL          forget the identity-provider account bound at the first sign-in (use when the
                        person's account was re-created); ends their sessions; the next sign-in binds again
  list                  all users
  seed-suppliers        insert the 14 MGH suppliers when the supplier table is empty (idempotent)

Database: DATABASE_URL (alias APP_DB_URL) is REQUIRED and must be PostgreSQL, as for the app and Alembic.
The schema must exist (``alembic upgrade head``). Exit codes: 0 ok, 1 error, 2 usage.
Users are managed only here (there is no users API or screen). Emails are stored lowercased.
"""
from __future__ import annotations

import argparse
import os
import sys

from sqlalchemy import select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from .db import make_engine
from .models import ROLES, User
from .settings import SettingsError, check_database_url
from .validation import normalize_email  # not from .auth: the CLI must not import Authlib/httpx


class CliError(Exception):
    pass


def _email(raw: str) -> str:
    email = normalize_email(raw)
    if email is None:
        raise CliError(f"not a valid email address: {raw!r}")
    return email


def _get(db: Session, raw_email: str) -> User:
    email = _email(raw_email)
    user = db.scalar(select(User).where(User.email == email))
    if user is None:
        raise CliError(f"no user {email} (add it with: add-user {email} --role user)")
    return user


def add_user(db: Session, raw_email: str, role: str, name: str | None = None) -> str:
    email = _email(raw_email)
    if role not in ROLES:
        raise CliError(f"role must be one of {', '.join(ROLES)}")
    if name is not None:
        name = name.strip()
        if "\x00" in name or len(name) > 200:
            raise CliError("name must be at most 200 characters without NUL")
    user = db.scalar(select(User).where(User.email == email))
    if user is None:
        db.add(User(email=email, role=role, name=name or "", active=True, session_epoch=0))
        db.commit()
        return f"added {email} ({role})"
    user.role = role
    if name is not None:
        user.name = name
    db.commit()
    note = "" if user.active else "; the user is DEACTIVATED (run: activate " + email + ")"
    return f"updated {email} ({role}){note}"


def set_active(db: Session, raw_email: str, active: bool) -> str:
    user = _get(db, raw_email)
    values = {"active": active}
    if not active:
        values["session_epoch"] = User.session_epoch + 1  # every existing session cookie stops working now
    db.execute(update(User).where(User.id == user.id).values(**values).execution_options(synchronize_session=False))
    db.commit()
    return f"{'activated' if active else 'deactivated'} {user.email}" + ("" if active else "; their sessions ended")


def unbind(db: Session, raw_email: str) -> str:
    user = _get(db, raw_email)
    db.execute(update(User).where(User.id == user.id)
               .values(sub=None, oid=None, session_epoch=User.session_epoch + 1)
               .execution_options(synchronize_session=False))
    db.commit()
    return f"unbound {user.email}; the next sign-in binds their account again"


def list_users(db: Session) -> str:
    users = db.scalars(select(User).order_by(User.email)).all()
    if not users:
        return "no users (add one with: add-user EMAIL --role admin)"
    lines = [f"{'email':40} {'role':5} {'status':8} {'bound':5} last sign-in"]
    for u in users:
        last = u.last_login_at.strftime("%Y-%m-%d %H:%M") if u.last_login_at else "-"
        lines.append(f"{u.email:40} {u.role:5} {'active' if u.active else 'inactive':8} "
                     f"{'yes' if (u.sub or u.oid) else 'no':5} {last}")
    return "\n".join(lines)


def seed_suppliers_cmd(db: Session) -> str:
    from seed.suppliers_seed import seed_suppliers
    n = seed_suppliers(db)
    return f"inserted {n} suppliers" if n else "inserted 0 suppliers (the supplier table is not empty)"


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m app.cli", description="Manage sign-in users and seed data.")
    sub = p.add_subparsers(dest="command", required=True)
    a = sub.add_parser("add-user", help="allow EMAIL to sign in, or change an existing user's role/name")
    a.add_argument("email")
    a.add_argument("--role", required=True, choices=ROLES)
    a.add_argument("--name")
    a.set_defaults(run=lambda db, ns: add_user(db, ns.email, ns.role, ns.name))
    for cmd, active, text in (("deactivate", False, "refuse sign-in and end the user's sessions"),
                              ("activate", True, "allow a deactivated user again")):
        c = sub.add_parser(cmd, help=text)
        c.add_argument("email")
        c.set_defaults(run=lambda db, ns, active=active: set_active(db, ns.email, active))
    u = sub.add_parser("unbind", help="forget the identity-provider account bound to EMAIL")
    u.add_argument("email")
    u.set_defaults(run=lambda db, ns: unbind(db, ns.email))
    sub.add_parser("list", help="list users").set_defaults(run=lambda db, ns: list_users(db))
    sub.add_parser("seed-suppliers", help="insert the 14 MGH suppliers if the table is empty").set_defaults(
        run=lambda db, ns: seed_suppliers_cmd(db))
    return p


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="backslashreplace")
        except Exception:
            pass
    ns = build_parser().parse_args(argv)
    try:
        url = check_database_url(os.environ.get("DATABASE_URL") or os.environ.get("APP_DB_URL"))
    except SettingsError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    engine = make_engine(url, poolclass=NullPool)
    try:
        with Session(engine) as db:
            print(ns.run(db, ns))
        return 0
    except CliError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except SQLAlchemyError as e:
        detail = str(getattr(e, "orig", None) or e).splitlines()[0][:200]
        print(f"error: database: {detail} (is the schema migrated? run: alembic upgrade head)", file=sys.stderr)
        return 1
    finally:
        engine.dispose()


if __name__ == "__main__":
    sys.exit(main())
