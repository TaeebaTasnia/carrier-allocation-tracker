from __future__ import annotations

import io

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Supplier
from ..parsers.suppliers import parse_suppliers
from ..utils import norm_code

router = APIRouter(prefix="/suppliers", tags=["suppliers"])


class SupplierIn(BaseModel):
    name: str = ""
    cw_code: str = ""


def _out(s: Supplier) -> dict:
    return {"code": s.code, "name": s.name, "cw_code": s.cw_code}


@router.get("")
def list_suppliers(db: Session = Depends(get_db)):
    return [_out(s) for s in db.query(Supplier).order_by(Supplier.code)]


@router.post("/upload")
async def upload_suppliers(file: UploadFile = File(...), replace: bool = False, db: Session = Depends(get_db)):
    try:
        rows = parse_suppliers(io.BytesIO(await file.read()))
    except Exception as e:
        raise HTTPException(400, f"Cannot read supplier file: {e}")
    by_code = {}
    for r in rows:  # last occurrence wins; codes are already normalized by the parser
        by_code[norm_code(r["code"])] = {**r, "code": norm_code(r["code"])}
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
    except IntegrityError as e:
        db.rollback()
        raise HTTPException(400, f"Supplier upload violates a uniqueness constraint: {e.orig}")
    return {"added": added, "updated": updated, "total": db.query(Supplier).count()}


@router.post("/{code}")
def upsert_supplier(code: str, body: SupplierIn, db: Session = Depends(get_db)):
    code = norm_code(code)
    if not code:
        raise HTTPException(400, "empty supplier code")
    s = db.get(Supplier, code)
    if s:
        s.name, s.cw_code = body.name, body.cw_code
    else:
        s = Supplier(code=code, name=body.name, cw_code=body.cw_code)
        db.add(s)
    db.commit()
    return _out(s)


@router.delete("/{code}")
def delete_supplier(code: str, db: Session = Depends(get_db)):
    s = db.get(Supplier, norm_code(code))
    if not s:
        raise HTTPException(404, "supplier not found")
    db.delete(s)
    db.commit()
    return {"deleted": s.code}
