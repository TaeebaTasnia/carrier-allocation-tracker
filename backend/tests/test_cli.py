"""Operator CLI (app/cli.py) against a freshly migrated, new Postgres database."""
import subprocess
import sys

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app import cli
from app.models import Supplier, User
from app.settings import normalize_db_url
from tests.conftest import BACKEND_DIR, alembic_upgrade


@pytest.fixture()
def cli_db(fresh_db_url, monkeypatch):
    alembic_upgrade(fresh_db_url)
    monkeypatch.setenv("DATABASE_URL", fresh_db_url)
    monkeypatch.delenv("APP_DB_URL", raising=False)
    eng = create_engine(normalize_db_url(fresh_db_url))
    yield eng
    eng.dispose()


def run(capsys, *argv):
    code = cli.main(list(argv))
    out = capsys.readouterr()
    return code, out.out.strip(), out.err.strip()


def user(eng, email):
    with Session(eng) as s:
        return s.scalar(select(User).where(User.email == email))


def test_add_user_list_and_role_change(cli_db, capsys):
    assert run(capsys, "add-user", " Alice@Example.COM ", "--role", "user", "--name", "Alice") == \
        (0, "added alice@example.com (user)", "")
    u = user(cli_db, "alice@example.com")
    assert (u.role, u.active, u.session_epoch, u.name, u.sub) == ("user", True, 0, "Alice", None)
    assert run(capsys, "add-user", "alice@example.com", "--role", "admin")[1] == "updated alice@example.com (admin)"
    assert user(cli_db, "alice@example.com").role == "admin" and user(cli_db, "alice@example.com").name == "Alice"
    code, out, _ = run(capsys, "list")
    assert code == 0 and "alice@example.com" in out and "admin" in out and "active" in out


def test_deactivate_activate_unbind(cli_db, capsys):
    run(capsys, "add-user", "bob@example.com", "--role", "user")
    assert run(capsys, "deactivate", "BOB@example.com")[1] == "deactivated bob@example.com; their sessions ended"
    u = user(cli_db, "bob@example.com")
    assert u.active is False and u.session_epoch == 1
    assert "DEACTIVATED" in run(capsys, "add-user", "bob@example.com", "--role", "user")[1]
    assert run(capsys, "activate", "bob@example.com")[1] == "activated bob@example.com"
    u = user(cli_db, "bob@example.com")
    assert u.active is True and u.session_epoch == 1  # old sessions stay ended
    with Session(cli_db) as s:
        s.get(User, u.id).sub = "sub-bob"
        s.commit()
    assert run(capsys, "unbind", "bob@example.com")[0] == 0
    u = user(cli_db, "bob@example.com")
    assert u.sub is None and u.oid is None and u.session_epoch == 2


def test_errors(cli_db, capsys):
    code, _, err = run(capsys, "deactivate", "nobody@example.com")
    assert code == 1 and "no user nobody@example.com" in err
    code, _, err = run(capsys, "add-user", "not-an-email", "--role", "user")
    assert code == 1 and "not a valid email" in err
    with pytest.raises(SystemExit) as e:  # argparse: role must be admin|user
        cli.main(["add-user", "a@example.com", "--role", "root"])
    assert e.value.code == 2


def test_seed_suppliers_is_idempotent(cli_db, capsys):
    assert run(capsys, "seed-suppliers") == (0, "inserted 14 suppliers", "")
    assert run(capsys, "seed-suppliers") == (0, "inserted 0 suppliers (the supplier table is not empty)", "")
    with Session(cli_db) as s:
        assert len(s.scalars(select(Supplier)).all()) == 14


def test_refuses_without_database_url(monkeypatch, capsys):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("APP_DB_URL", raising=False)
    code, _, err = run(capsys, "list")
    assert code == 2 and "DATABASE_URL" in err


@pytest.mark.parametrize("url", ["mysql://u:p@127.0.0.1/ca", "postgresql+psycopg2://u:p@127.0.0.1/ca_test",
                                 "not a url"])
def test_refuses_a_database_other_than_postgres(url, monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL", url)
    code, _, err = run(capsys, "list")
    assert code == 2 and "must be a PostgreSQL URL" in err and "u:p" not in err  # never echoes the URL


def test_refuses_a_file_database_and_creates_no_file(tmp_path, monkeypatch, capsys):
    target = tmp_path / "x.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{target.as_posix()}")
    code, _, err = run(capsys, "seed-suppliers")
    assert code == 2 and "must be a PostgreSQL URL" in err and not target.exists()


def test_unmigrated_database_gives_a_hint(fresh_db_url, monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL", fresh_db_url)  # an empty database: no `alembic upgrade head` yet
    monkeypatch.delenv("APP_DB_URL", raising=False)
    code, _, err = run(capsys, "list")
    assert code == 1 and "alembic upgrade head" in err


def test_module_entry_point(cli_db, fresh_db_url):
    """`python -m app.cli` works as a process (what the compose migrate step runs)."""
    env = {"DATABASE_URL": fresh_db_url, "SYSTEMROOT": __import__("os").environ.get("SYSTEMROOT", "")}
    p = subprocess.run([sys.executable, "-m", "app.cli", "seed-suppliers"], cwd=str(BACKEND_DIR), env=env,
                       capture_output=True, text=True, timeout=120)
    assert p.returncode == 0 and p.stdout.strip() == "inserted 14 suppliers", p.stderr
    assert p.stderr == ""  # no warnings: the CLI does not import Authlib/httpx
