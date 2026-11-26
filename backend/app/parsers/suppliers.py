"""Supplier list parser: headers SUPPLIER CODE / SUPPLIER / CW CODE (case-insensitive)."""
from __future__ import annotations

from typing import BinaryIO

import openpyxl

from ..utils import norm_code, norm_header, strip_nul
from .common import FileParseError, capped_rows

CODE = {"supplier code", "code", "supplier no", "supplier id"}
NAME = {"supplier", "supplier name", "name"}
CW = {"cw code", "cwcode", "cw"}
# The same limits as POST/DELETE /suppliers/{code} (routers/suppliers.py), so every uploaded supplier can
# also be edited and removed one by one.
CODE_MAX, NAME_MAX, CW_MAX = 50, 200, 50


class SupplierParseError(FileParseError):
    pass


def _cell_text(r, i) -> str:
    return strip_nul(str(r[i])).strip() if i is not None and i < len(r) and r[i] is not None else ""


def parse_suppliers(source: str | BinaryIO) -> list[dict]:
    wb = openpyxl.load_workbook(source, read_only=True, data_only=True)
    try:
        # One streaming pass: header in the first 15 rows, then the data rows from the same iterator.
        it = capped_rows(wb[wb.sheetnames[0]], "supplier file")
        for hi, row in enumerate(it):
            if hi >= 15:
                break
            heads = [norm_header(c) for c in row]
            ci = next((i for i, h in enumerate(heads) if h in CODE), None)
            if ci is None:
                continue
            ni = next((i for i, h in enumerate(heads) if h in NAME), None)
            wi = next((i for i, h in enumerate(heads) if h in CW), None)
            out = []
            for ri, r in enumerate(it, start=hi + 2):  # ri = the row number in Excel
                code = norm_code(r[ci]) if ci < len(r) else ""
                if not code:
                    continue
                row = {"code": code, "name": _cell_text(r, ni), "cw_code": _cell_text(r, wi)}
                for key, label, limit in (("code", "supplier code", CODE_MAX), ("name", "supplier name", NAME_MAX),
                                          ("cw_code", "CW code", CW_MAX)):
                    if len(row[key]) > limit:
                        raise SupplierParseError(f"row {ri}: the {label} is longer than {limit} characters. "
                                                 "Nothing was saved; fix the row and upload the file again.")
                out.append(row)
            return out
    finally:
        wb.close()
    raise SupplierParseError("Supplier file needs a 'SUPPLIER CODE' header column")
