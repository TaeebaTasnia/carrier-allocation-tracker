"""Shared parser pieces: the row caps and the error type whose message is safe to show to the user."""
from __future__ import annotations

# At most this many non-empty rows are read from a sheet; a bigger sheet is rejected while it is being read
# (read_only streaming), so it never has to fit in memory. Read at call time (tests monkeypatch it).
MAX_ROWS = 100_000
# At most this many rows in all (empty ones included) are scanned. Excel sheets end at row 1,048,576, so no
# real export reaches it; only a crafted file (a row number far beyond Excel's last row, which openpyxl pads
# with empty rows) does, and it is rejected in seconds instead of keeping a worker busy for minutes.
MAX_SCANNED_ROWS = 1_100_000
# A sheet that DECLARES a used range wider than this many columns (its <dimension>, e.g. A1:XFD1048576 from
# one stray cell or formatting far to the right) is read only up to this column: openpyxl builds every row
# as wide as the declared range (up to 16,384 cells), so a small crafted file with many rows would otherwise
# cost minutes. Cells right of column 256 (IV, the full width of an Excel 97-2003 sheet) are then not read:
# the parsers only use the columns of their header row, and real exports have a few dozen columns (the
# forecast workbook: 26). A sheet without a declared range is read as before. Read at call time (tests
# monkeypatch it).
MAX_COLS = 256


class FileParseError(ValueError):
    """A problem with the uploaded file's content. The message is written by us and shown to the user."""


def capped_rows(ws, what: str):
    """Yield every row of ``ws.iter_rows(values_only=True)`` (empty ones included, so row numbers stay
    right), at most MAX_COLS wide when the sheet declares a wider range; raise FileParseError once more than
    MAX_ROWS non-empty rows, or more than MAX_SCANNED_ROWS rows in all, have been read. Empty rows (e.g.
    formatting only) do not count towards MAX_ROWS.

    Speed: read-only openpyxl pads every row to the sheet's declared width and yields one shared object for
    every missing row. The last all-empty row object is remembered, so that padding row costs O(1); other
    rows are checked with ``tuple.count``, which compares None by identity at C speed (no cell value
    openpyxl returns compares equal to None, so this is ``any(c is not None for c in r)``)."""
    limit, scan_limit, max_cols = MAX_ROWS, MAX_SCANNED_ROWS, MAX_COLS
    declared = ws.max_column  # the declared range (no scan); None when the sheet has no <dimension>
    width = {"max_col": max_cols} if declared and declared > max_cols else {}
    n = scanned = 0
    empty = None  # the last all-empty row object seen (openpyxl's shared padding row for missing rows)
    for r in ws.iter_rows(values_only=True, **width):
        scanned += 1
        if scanned > scan_limit:
            raise FileParseError(f"The {what} has more than {scan_limit:,} rows (empty rows included). "
                                 "Split it into smaller files.")
        if r is not None and r is not empty:
            if r.count(None) != len(r):
                n += 1
                if n > limit:
                    raise FileParseError(f"The {what} has more than {limit:,} rows. Split it into smaller files.")
            else:
                empty = r
        yield r
