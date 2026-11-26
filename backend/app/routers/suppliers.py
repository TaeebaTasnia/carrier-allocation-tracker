from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..auth import require_admin
from ..db import get_db, lock
from ..models import Supplier
from ..parsers.common import FileParseError
from ..parsers.suppliers import CODE_MAX, CW_MAX, NAME_MAX, parse_suppliers
from ..uploads import read_xlsx_upload
from ..utils import norm_code
from ..validation import check_text, no_nul

router = APIRouter(prefix="/suppliers", tags=["suppliers"])
log = logging.getLogger("app.suppliers")
# CODE_MAX (50), NAME_MAX (200), CW_MAX (50): shared with the upload parser, which applies them per row.


class SupplierIn(BaseModel):
    name: str = Field(default="", max_length=NAME_MAX)
    cw_code: str = Field(default="", max_length=CW_MAX)

    @field_validator("name", "cw_code")
    @classmethod
    def _text(cls, v):
        return no_nul(v)


def _out(s: Supplier) -> dict:
    return {"code": s.code, "name": s.name, "cw_code": s.cw_code}


def _code(raw: str) -> str:
    check_text("supplier code", raw, CODE_MAX)
    return norm_code(raw)


@router.get("")
def list_suppliers(db: Session = Depends(get_db)):
    return [_out(s) for s in db.query(Supplier).order_by(Supplier.code)]


@router.post("/upload", dependencies=[Depends(require_admin)])
def upload_suppliers(file: UploadFile = File(...), replace: bool = False, db: Session = Depends(get_db)):
    # sync def: parsing and the writes run in the threadpool, not on the event loop
    buf = read_xlsx_upload(file, "supplier file")
    try:
        rows = parse_suppliers(buf)
    except FileParseError as e:
        raise HTTPException(400, str(e))
    except Exception:
        log.exception("supplier upload: cannot read %r", file.filename)
        raise HTTPException(400, "Cannot read the supplier file. Check that it is the supplier list .xlsx.")
    by_code = {}
    for r in rows:  # last occurrence wins; codes are already normalized by the parser
        by_code[norm_code(r["code"])] = {**r, "code": norm_code(r["code"])}
    lock(db, "suppliers")
    if replace:
        db.query(Supplier).delete()
    added = updated = 0
    for r in by_code.values():
        s = db.get(Supplier, r["code"])
        if s:
            s.name, s.cw_code = r["name"], r["cw_code"]
            updated += 1
        else:
            db.add(Supplier(**r))
            added += 1
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        log.exception("supplier upload: integrity error")
        raise HTTPException(400, "The supplier list could not be saved (duplicate supplier codes).")
    log.info("supplier upload: added %d, updated %d, replace=%s", added, updated, replace)
    return {"added": added, "updated": updated, "total": db.query(Supplier).count()}


@router.post("/{code}", dependencies=[Depends(require_admin)])
def upsert_supplier(code: str, body: SupplierIn, db: Session = Depends(get_db)):
    code = _code(code)
    if not code:
        raise HTTPException(400, "empty supplier code")
    lock(db, "suppliers")
    s = db.get(Supplier, code)
    if s:
        s.name, s.cw_code = body.name, body.cw_code
    else:
        s = Supplier(code=code, name=body.name, cw_code=body.cw_code)
        db.add(s)
    db.commit()
    return _out(s)


@router.delete("/{code}", dependencies=[Depends(require_admin)])
def delete_supplier(code: str, db: Session = Depends(get_db)):
    code = _code(code)
    lock(db, "suppliers")
    s = db.get(Supplier, code)
    if not s:
        raise HTTPException(404, "supplier not found")
    db.delete(s)
    db.commit()
    return {"deleted": s.code}
