"""Supplier list parser: headers SUPPLIER CODE / SUPPLIER / CW CODE (case-insensitive)."""
from __future__ import annotations

from typing import BinaryIO

import openpyxl

from ..utils import norm_code, norm_header

CODE = {"supplier code", "code", "supplier no", "supplier id"}
NAME = {"supplier", "supplier name", "name"}
CW = {"cw code", "cwcode", "cw"}


def parse_suppliers(source: str | BinaryIO) -> list[dict]:
    wb = openpyxl.load_workbook(source, read_only=True, data_only=True)
    try:
        ws = wb[wb.sheetnames[0]]
        rows = list(ws.iter_rows(values_only=True))
    finally:
        wb.close()
    for hi, row in enumerate(rows[:15]):
        heads = [norm_header(c) for c in row]
        ci = next((i for i, h in enumerate(heads) if h in CODE), None)
        if ci is None:
            continue
        ni = next((i for i, h in enumerate(heads) if h in NAME), None)
        wi = next((i for i, h in enumerate(heads) if h in CW), None)
        out = []
        for r in rows[hi + 1:]:
            code = norm_code(r[ci]) if ci < len(r) else ""
            if not code:
                continue
            out.append({
                "code": code,
                "name": str(r[ni]).strip() if ni is not None and ni < len(r) and r[ni] is not None else "",
                "cw_code": str(r[wi]).strip() if wi is not None and wi < len(r) and r[wi] is not None else "",
            })
        return out
    raise ValueError("Supplier file needs a 'SUPPLIER CODE' header column")
