"""Checks every uploaded workbook passes before it is parsed.

The hard request-size cap belongs to the reverse proxy (Starlette spools the multipart body to disk before
the handler runs); these checks stop wrong or oversized files from reaching openpyxl. The limits are read at
call time, so tests can monkeypatch them.
"""
from __future__ import annotations

import io
import zipfile

from fastapi import HTTPException, UploadFile

MAX_UPLOAD_BYTES = 25 * 1024 * 1024          # the .xlsx file itself
MAX_UNPACKED_BYTES = 250 * 1024 * 1024       # all parts of the .xlsx (a ZIP) once unpacked
ZIP_MAGIC = b"PK\x03\x04"                    # every .xlsx is a ZIP archive


def read_xlsx_upload(file: UploadFile, what: str) -> io.BytesIO:
    """Return the upload as a BytesIO after checking name, size and ZIP structure (400/413 otherwise)."""
    name = (file.filename or "").strip()
    if not name.lower().endswith(".xlsx"):
        raise HTTPException(400, f"The {what} must be an Excel .xlsx file.")
    limit = MAX_UPLOAD_BYTES
    data = file.file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(413, f"The {what} is too large (the limit is {limit // (1024 * 1024)} MB).")
    if not data.startswith(ZIP_MAGIC):
        raise HTTPException(400, f"The {what} is not a valid .xlsx file.")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            unpacked = sum(i.file_size for i in zf.infolist())
    except (zipfile.BadZipFile, ValueError):
        raise HTTPException(400, f"The {what} is not a valid .xlsx file.") from None
    if unpacked > MAX_UNPACKED_BYTES:
        raise HTTPException(413, f"The {what} is too large once unpacked.")
    return io.BytesIO(data)
