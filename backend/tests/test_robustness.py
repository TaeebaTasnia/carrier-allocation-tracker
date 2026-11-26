"""WP3 robustness: NaN/Infinity/huge/NUL inputs, year/date bounds, upload checks and caps."""
import datetime as dt
import inspect
import io
import logging
import zipfile

import pytest

from app import uploads
from app.config_service import ConfigError, get_config, validate
from app.parsers import common
from app.parsers.stuffing import _text
from app.routers import forecast as forecast_router
from app.routers import stuffing as stuffing_router
from app.routers import suppliers as suppliers_router
from app.utils import norm_code
from tests.conftest import make_xlsx

JSON = {"content-type": "application/json"}
FC_HEAD = ["Rfi", "Supplier", "exp.Vol cbm"]
ST_HEAD = ["Shipping Line", "TEUs", "Qty", "Date"]
D45 = dt.datetime(2026, 11, 3)


def raw_put(client, url, body):
    return client.put(url, content=body, headers=JSON)


# ---- non-finite / huge numbers -> 422, nothing stored ----
@pytest.mark.parametrize("v", ["NaN", "Infinity", "-Infinity", "1e308", "-1e308"])
@pytest.mark.parametrize("url,tmpl", [
    ("/weekly/2026/45", '{"confirmed": {"MAERSK": %s}}'),
    ("/weekly/2026/45", '{"confirmed": {"MAERSK": 1e308, "HAPAG": %s}}'),
    ("/weekly/2026/45", '{"fml_forecast": %s}'),
    ("/daily/2026-11-03", '{"actual_cbm": %s}'),
    ("/config", '{"uplift_pct": %s}'),
    ("/config", '{"cbm_per_teu": %s}'),
    ("/config", '{"fml_default": %s}'),
    ("/config", '{"split": {"MAERSK": %s, "HAPAG": 25, "HELLMAN": 20, "ONE": 25}}'),
    ("/stuffing/2026-11-03", '{"rows": [{"shipping_line": "A", "teus": %s}]}'),
    ("/stuffing/2026-11-03", '{"rows": [{"shipping_line": "A", "teus": 1, "qty": %s}]}'),
    ("/stuffing/2026-11-03", '{"rows": [{"shipping_line": "A", "teus": 1, "cbm": %s}]}'),
])
def test_non_finite_and_huge_numbers_422(client, url, tmpl, v):
    before = client.get("/config").json()
    r = raw_put(client, url, tmpl % v)
    assert r.status_code == 422, r.text
    assert client.get("/config").json() == before
    wk = client.get("/weekly/2026/45").json()
    assert wk["total_confirmed"] == 0 and wk["carrier_forecast"]["FML"] == before["fml_default"]
    assert client.get("/daily/2026-11-03").json()["actual_cbm_source"] == "none"
    assert client.get("/stuffing/2026-11-03").json()["rows"] == []


def test_config_validate_rejects_non_finite_directly(db):
    base = get_config(db)
    for bad in (dict(base, uplift_pct=float("nan")), dict(base, cbm_per_teu=float("inf")),
                dict(base, fml_default=float("nan")), dict(base, cbm_per_teu=1e-300),
                dict(base, uplift_pct=1e6),
                dict(base, split={"MAERSK": float("nan"), "HAPAG": 25, "HELLMAN": 20, "ONE": 25})):
        with pytest.raises(ConfigError):
            validate(bad)
    assert validate(dict(base))["cbm_per_teu"] == 33


def test_reasonable_values_still_accepted(client):
    assert client.put("/weekly/2026/45", json={"confirmed": {"MAERSK": 1e6}, "fml_forecast": 0}).status_code == 200
    assert client.put("/daily/2026-11-03", json={"actual_cbm": 123456.5}).status_code == 200
    assert client.put("/config", json={"uplift_pct": -50, "cbm_per_teu": 67.5}).status_code == 200
    assert client.put("/weekly/2026/45", json={"fml_forecast": -1}).status_code == 422  # a forecast is >= 0


# ---- NUL characters ----
@pytest.mark.parametrize("url,body", [
    ("/stuffing/2026-11-03", {"rows": [{"shipping_line": "MAER\u0000SK", "teus": 1}]}),
    ("/stuffing/2026-11-03", {"rows": [{"shipping_line": "MAERSK", "teus": 1, "feeder_vessel": "F\u0000V"}]}),
    ("/stuffing/2026-11-03", {"rows": [{"shipping_line": "MAERSK", "teus": 1, "mother_vessel": "\u0000"}]}),
    ("/config", {"line_map": {"BAD\u0000LINE": "ONE"}}),
])
def test_nul_in_text_422(client, url, body):
    assert client.put(url, json=body).status_code == 422
    assert client.get("/stuffing/2026-11-03").json()["rows"] == []
    assert "BAD\u0000LINE" not in client.get("/config").json()["line_map"]


def test_nul_in_supplier_422(client):
    assert client.post("/suppliers/90001", json={"name": "A\u0000B"}).status_code == 422
    assert client.post("/suppliers/90001", json={"cw_code": "\u0000"}).status_code == 422
    assert client.post("/suppliers/900%0001", json={"name": "X"}).status_code == 422
    assert client.delete("/suppliers/775%0034").status_code == 422
    assert client.post("/suppliers/" + "9" * 51, json={"name": "X"}).status_code == 422
    assert "90001" not in {s["code"] for s in client.get("/suppliers").json()}


SUP_HEAD = ["SUPPLIER CODE", "SUPPLIER", "CW CODE"]


def test_supplier_upload_applies_the_single_supplier_limits(client):
    """An uploaded supplier code over 50 characters could never be removed (DELETE /suppliers/{code} refuses
    it): the upload now applies the same 50 (code) / 200 (name) / 50 (CW code) limits, per row."""
    code50 = "C" * 50
    ok = make_xlsx([["77534", "Comfit", "CW"], [f" {code50} ", "N" * 200, "W" * 50]], SUP_HEAD)
    r = client.post("/suppliers/upload", files={"file": ("s.xlsx", ok)})
    assert r.status_code == 200, r.text
    assert {"code": code50, "name": "N" * 200, "cw_code": "W" * 50} in client.get("/suppliers").json()
    assert client.delete(f"/suppliers/{code50}").status_code == 200  # an uploaded code can be removed
    before = client.get("/suppliers").json()
    for rows, message in [([["C" * 51, "x", ""]], "row 2: the supplier code is longer than 50 characters"),
                          ([["77534", "x", ""], ["90001", "N" * 201, ""]],
                           "row 3: the supplier name is longer than 200 characters"),
                          ([["90001", "x", "W" * 51]], "row 2: the CW code is longer than 50 characters")]:
        for replace in (False, True):
            r = client.post("/suppliers/upload", params={"replace": replace},
                            files={"file": ("s.xlsx", make_xlsx(rows, SUP_HEAD))})
            assert r.status_code == 400 and r.json()["detail"].startswith(message), r.text
            assert client.get("/suppliers").json() == before  # nothing added, updated or replaced
    # the same limits as the single-supplier routes
    assert client.post("/suppliers/" + "C" * 51, json={"name": "x"}).status_code == 422
    assert client.delete("/suppliers/" + "C" * 51).status_code == 422
    assert client.post("/suppliers/90001", json={"name": "N" * 201}).status_code == 422
    assert client.post("/suppliers/90001", json={"cw_code": "W" * 51}).status_code == 422


def test_parsers_strip_nul_from_file_text():
    assert _text("MAER\x00SK ") == "MAERSK" and norm_code("77\x00534") == "77534"


# ---- line_map size ----
def test_line_map_size_and_name_limits(client):
    big = {f"LINE{i}": "ONE" for i in range(501)}
    assert client.put("/config", json={"line_map": big}).status_code == 422
    assert client.put("/config", json={"line_map": {"X" * 101: "ONE"}}).status_code == 422
    assert client.put("/config", json={"line_map": {"X" * 100: "ONE"}}).status_code == 200
    # the merged map is limited too (many small patches)
    lm = client.get("/config").json()["line_map"]
    room = 500 - len(lm)
    assert client.put("/config", json={"line_map": {f"L{i}": "ONE" for i in range(room)}}).status_code == 200
    assert client.put("/config", json={"line_map": {"ONE MORE": "ONE"}}).status_code == 422


# ---- year / date bounds ----
@pytest.mark.parametrize("url", [
    "/weekly/1999/10", "/weekly/2101/1", "/forecast/weeks/2200/1", "/daily?year=1990&week=1",
    "/stuffing/dates?year=1900&week=1", "/reports/weekly-summary?year=9999",
    "/reports/weekly-summary/download?year=1", "/reports/allocation-vs-utilization?year=3000&week=1",
    "/stuffing/1999-12-31", "/daily/2101-01-01", "/daily/0001-01-01",
])
def test_out_of_range_year_or_date_422(client, url):
    assert client.get(url).status_code == 422


def test_out_of_range_dates_on_writes_422(client):
    assert client.put("/daily/1999-12-31", json={"actual_cbm": 1}).status_code == 422
    assert client.put("/stuffing/2101-01-01", json={"rows": []}).status_code == 422
    assert client.delete("/stuffing/1999-01-01").status_code == 422
    row = {"shipping_line": "A", "teus": 1, "fvsl_etd": "1999-12-31"}
    assert client.put("/stuffing/2026-11-03", json={"rows": [row]}).status_code == 422
    up = make_xlsx([["MAERSK", 1]], ["Shipping Line", "TEUs"])
    r = client.post("/stuffing/upload", params={"report_date": "1999-01-01"}, files={"file": ("s.xlsx", up)})
    assert r.status_code == 422


def test_year_bounds_inclusive(client):
    assert client.get("/weekly/2000/1").status_code == 200
    assert client.get("/weekly/2100/52").status_code == 200
    assert client.get("/reports/weekly-summary", params={"year": 2100}).status_code == 200


# ---- spreadsheet numbers and dates ----
def test_forecast_file_nan_inf_huge_count_as_zero_and_bad_dates_skipped(client):
    rows = [[D45, "77534", "nan"], [D45, "77534", "inf"], [D45, "77534", 1e308], [D45, "77534", 1e308],
            [D45, "77534", "1e400"], [D45, "77534", 100], [dt.datetime(1999, 12, 31), "77534", 50],
            [dt.datetime(2150, 1, 1), "77534", 50]]
    r = client.post("/forecast/upload", files={"file": ("f.xlsx", make_xlsx(rows, FC_HEAD))})
    assert r.status_code == 200, r.text
    assert r.json()["weeks"] == [{"year": 2026, "week": 45}] and r.json()["rows"] == 6
    assert client.get("/forecast/weeks/2026/45").json()["cbm_plus"] == pytest.approx(130.0)
    wk = client.get("/weekly/2026/45")
    assert wk.status_code == 200 and wk.json()["forecast"] == pytest.approx(130.0 / 33)
    assert client.get("/reports/weekly-summary", params={"year": 2026}).status_code == 200


def test_stuffing_file_nan_huge_teus_skipped(client):
    rows = [["MAERSK", "nan", 1, D45], ["HAPAG", 1e308, 1, D45], ["ONELINE", 4, 1, D45],
            ["MAERSK", 2, 1, dt.datetime(1999, 1, 1)]]
    r = client.post("/stuffing/upload", files={"file": ("s.xlsx", make_xlsx(rows, ST_HEAD))})
    body = r.json()
    assert r.status_code == 200 and body["rows"] == 1
    assert body["skipped_rows"] == ["row 2: missing shipping line or numeric TEUs",
                                    "row 3: missing shipping line or numeric TEUs", "row 5: unreadable date"]
    assert client.get("/weekly/2026/45").json()["total_utilized"] == 4


# ---- upload checks ----
UPLOADS = ["/forecast/upload", "/stuffing/upload", "/suppliers/upload"]


def _valid_file(path, n=3):
    if path == "/forecast/upload":
        return make_xlsx([[D45, "77534", 10]] * n, FC_HEAD)
    if path == "/stuffing/upload":
        return make_xlsx([["MAERSK", 1, 1, D45]] * n, ST_HEAD)
    return make_xlsx([[90000 + i, f"S{i}", "CW"] for i in range(n)], ["SUPPLIER CODE", "SUPPLIER", "CW CODE"])


def test_upload_handlers_are_sync():
    """Blocking parse + DB work must run in the threadpool, not on the event loop."""
    for fn in (forecast_router.upload_forecast, stuffing_router.upload_stuffing, suppliers_router.upload_suppliers):
        assert not inspect.iscoroutinefunction(fn)


@pytest.mark.parametrize("path", UPLOADS)
@pytest.mark.parametrize("name", ["data.csv", "data.xls", "data.xlsx.exe", "", "noext"])
def test_upload_requires_xlsx_name(client, path, name):
    r = client.post(path, files={"file": (name, _valid_file(path))})
    assert r.status_code in (400, 422), r.text
    if r.status_code == 400:
        assert ".xlsx" in r.json()["detail"]


@pytest.mark.parametrize("path", UPLOADS)
def test_upload_requires_zip_content(client, path):
    r = client.post(path, files={"file": ("x.xlsx", b"PK\x03\x04 but not really a zip")})
    assert r.status_code == 400 and "not a valid .xlsx" in r.json()["detail"]


@pytest.mark.parametrize("path", UPLOADS)
def test_upload_size_caps(client, path, monkeypatch):
    data = _valid_file(path)
    monkeypatch.setattr(uploads, "MAX_UPLOAD_BYTES", len(data) - 1)
    r = client.post(path, files={"file": ("x.xlsx", data)})
    assert r.status_code == 413 and "too large" in r.json()["detail"]
    monkeypatch.setattr(uploads, "MAX_UPLOAD_BYTES", len(data))
    monkeypatch.setattr(uploads, "MAX_UNPACKED_BYTES", 1000)
    r = client.post(path, files={"file": ("x.xlsx", data)})
    assert r.status_code == 413 and "unpacked" in r.json()["detail"]


@pytest.mark.parametrize("path", UPLOADS)
def test_upload_row_cap_rejects_and_changes_nothing(client, path, monkeypatch):
    before = {"sup": client.get("/suppliers").json(), "wk": client.get("/forecast/weeks/2026/45").json(),
              "st": client.get("/stuffing/2026-11-03").json()}
    monkeypatch.setattr(common, "MAX_ROWS", 4)  # header + 3 data rows fit
    assert client.post(path, files={"file": ("x.xlsx", _valid_file(path, 3))}).status_code == 200
    r = client.post(path, files={"file": ("x.xlsx", _valid_file(path, 4))})
    assert r.status_code == 400 and "more than 4 rows" in r.json()["detail"]
    monkeypatch.setattr(common, "MAX_ROWS", 100_000)
    after = {"sup": client.get("/suppliers").json(), "wk": client.get("/forecast/weeks/2026/45").json(),
             "st": client.get("/stuffing/2026-11-03").json()}
    # only the accepted (3-row) upload changed something
    changed = [k for k in before if before[k] != after[k]]
    assert len(changed) == 1


def test_row_cap_ignores_empty_rows(client, monkeypatch):
    """Rows that hold only formatting (common at the bottom of exported sheets) do not count."""
    import openpyxl
    from openpyxl.styles import Font
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(FC_HEAD)
    ws.append([D45, "77534", 10])
    for row in range(3, 9):  # 6 styled but empty rows
        for col in (1, 2, 3):
            ws.cell(row=row, column=col).font = Font(bold=True)
    ws.cell(row=9, column=1, value=D45), ws.cell(row=9, column=2, value="77534"), ws.cell(row=9, column=3, value=5)
    buf = io.BytesIO()
    wb.save(buf)
    monkeypatch.setattr(common, "MAX_ROWS", 3)  # header + 2 data rows
    r = client.post("/forecast/upload", files={"file": ("f.xlsx", buf.getvalue())})
    assert r.status_code == 200, r.text
    assert r.json()["rows"] == 2


# ---- sparse / crafted sheets (reviewer finding 2: one far cell made the parsers scan 16,384 Nones per row) ----
def _sparse_xlsx(rows, header, far="XFD1048576") -> bytes:
    """The same sheet as make_xlsx(rows, header) plus one cell at `far`: read-only openpyxl then pads every row
    to 16,384 columns and yields ~1M padding rows (the file is still ~5 KB)."""
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(header)
    for r in rows:
        ws.append(r)
    ws[far] = "y"
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _row_beyond_excel(xlsx: bytes, row: int = 5_000_000) -> bytes:
    """A crafted sheet: a row number past Excel's last row (1,048,576), which openpyxl does not refuse and
    pads with empty rows."""
    import re
    src = zipfile.ZipFile(io.BytesIO(xlsx))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename == "xl/worksheets/sheet1.xml":
                data = re.sub(rb'<dimension ref="[^"]*"\s*/>', f'<dimension ref="A1:D{row}"/>'.encode(), data)
                data = data.replace(b"</sheetData>", f'<row r="{row}"><c r="A{row}" t="inlineStr"><is><t>y</t>'
                                                     f'</is></c></row></sheetData>'.encode())
            z.writestr(item, data)
    return out.getvalue()


def _within(seconds, fn, *args):
    """fn(*args) in a daemon thread; fails (instead of hanging the run) when it takes longer than `seconds`."""
    import threading
    import time
    box = {}

    def run():
        try:
            box["value"] = fn(*args)
        except Exception as e:  # noqa: BLE001 - re-raised in the test thread
            box["error"] = e
    t0 = time.perf_counter()
    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(seconds)
    assert not t.is_alive(), f"{getattr(fn, '__name__', fn)} still running after {seconds} s"
    if "error" in box:
        raise box["error"]
    return box["value"], time.perf_counter() - t0


SPARSE_CASES = {
    "forecast": (FC_HEAD, [[D45, "77534", 10], [D45, "77566", 5.5], ["Total", None, 15.5]]),
    "stuffing": (ST_HEAD, [["MAERSK", 2, 1, D45], ["", 5, 1, D45], ["ONE", 3, 2, "03/11/2026"]]),
    "suppliers": (["SUPPLIER CODE", "SUPPLIER", "CW CODE"], [["77534", "Comfit", "CW1"], [90001.0, "New", ""]]),
}


def _parse(kind, data: bytes):
    from app.parsers.forecast import parse_forecast
    from app.parsers.stuffing import parse_stuffing_ex
    from app.parsers.suppliers import parse_suppliers
    if kind == "forecast":
        return parse_forecast(io.BytesIO(data))
    if kind == "stuffing":
        return parse_stuffing_ex(io.BytesIO(data), None)
    return parse_suppliers(io.BytesIO(data))


@pytest.mark.parametrize("kind", SPARSE_CASES)
def test_sparse_sheet_parses_fast_and_like_the_dense_sheet(kind):
    header, rows = SPARSE_CASES[kind]
    dense = _parse(kind, make_xlsx(rows, header))
    assert dense  # the case has data
    sparse, seconds = _within(60, _parse, kind, _sparse_xlsx(rows, header))  # was > 60 s (est. minutes)
    assert sparse == dense
    assert seconds < 30, f"{kind}: {seconds:.1f} s"


@pytest.mark.parametrize("path", UPLOADS)
def test_row_number_beyond_excel_is_rejected_quickly(client, path):
    def state():
        return {"sup": client.get("/suppliers").json(), "wk": client.get("/forecast/weeks/2026/45").json(),
                "st": client.get("/stuffing/2026-11-03").json()}
    before = state()
    data = _row_beyond_excel(_valid_file(path))
    r, seconds = _within(60, lambda: client.post(path, files={"file": ("x.xlsx", data)}))
    assert r.status_code == 400 and "more than 1,100,000 rows (empty rows included)" in r.json()["detail"], r.text
    assert seconds < 30
    assert state() == before


def _explicit_empty_rows(xlsx: bytes, n: int) -> bytes:
    """A crafted sheet: n explicit empty <row r=".."/> elements under a declared A1:XFD range. openpyxl builds
    a NEW row tuple as wide as the declared range for each one (16,384 cells: minutes for ~1M rows)."""
    import re
    src = zipfile.ZipFile(io.BytesIO(xlsx))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename == "xl/worksheets/sheet1.xml":
                last = 1 + n + 3  # header + data rows of _valid_file + the empty rows
                data = re.sub(rb'<dimension ref="[^"]*"\s*/>', f'<dimension ref="A1:XFD{last}"/>'.encode(), data)
                rows = "".join(f'<row r="{i}"/>' for i in range(5, last + 1)).encode()
                data = data.replace(b"</sheetData>", rows + b"</sheetData>")
            z.writestr(item, data)
    return out.getvalue()


def test_declared_width_is_capped_only_when_wider_than_max_cols():
    import openpyxl

    def widths(data):
        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        try:
            return {len(r) for r in common.capped_rows(wb.worksheets[0], "test file")}
        finally:
            wb.close()
    assert widths(_sparse_xlsx([[D45, "77534", 10]], FC_HEAD)) == {common.MAX_COLS}        # declared A1:XFD...
    assert widths(_sparse_xlsx([[D45, "77534", 10]], FC_HEAD, far="IV20")) == {256}         # declared = the cap
    assert widths(make_xlsx([[D45, "77534", 10]], FC_HEAD)) == {3}                          # narrow: as before
    assert common.MAX_COLS == 256


@pytest.mark.parametrize("path", UPLOADS)
def test_many_explicit_empty_rows_on_a_wide_sheet_upload_fast(client, path):
    """About 250K explicit empty rows under a declared XFD range: openpyxl's own per-row cost was the
    problem (HEAD took ~1.5 minutes for ~1M such rows); with the width cap it stays a few seconds."""
    data = _explicit_empty_rows(_valid_file(path), 250_000)
    r, seconds = _within(60, lambda: client.post(path, files={"file": ("x.xlsx", data)}))
    assert r.status_code == 200, r.text
    assert seconds < 15, f"{path}: {seconds:.1f} s"


def test_scan_cap_counts_empty_rows_and_is_read_at_call_time(client, monkeypatch):
    assert common.MAX_SCANNED_ROWS > 1_048_576  # no real sheet (Excel's last row) can reach the default
    data = _sparse_xlsx([[D45, "77534", 10]], FC_HEAD, far="A20")  # 20 rows, 2 of them data + 1 far cell
    monkeypatch.setattr(common, "MAX_SCANNED_ROWS", 19)
    r = client.post("/forecast/upload", files={"file": ("f.xlsx", data)})
    assert r.status_code == 400 and r.json()["detail"] == (
        "The forecast file has more than 19 rows (empty rows included). Split it into smaller files.")
    monkeypatch.setattr(common, "MAX_SCANNED_ROWS", 20)
    r = client.post("/forecast/upload", files={"file": ("f.xlsx", data)})
    assert r.status_code == 200 and r.json()["rows"] == 1, r.text


def _with_doctype(xlsx: bytes) -> bytes:
    """Rewrite the sheet XML with an entity declaration (billion-laughs style)."""
    src = zipfile.ZipFile(io.BytesIO(xlsx))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename == "xl/worksheets/sheet1.xml":
                data = (b'<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>'
                        + data.replace(b"MAERSK", b"&lol2;"))
            z.writestr(item, data)
    return out.getvalue()


def test_xml_entities_rejected_with_friendly_400(client, caplog):
    import openpyxl.xml
    assert openpyxl.xml.DEFUSEDXML is True  # openpyxl parses through defusedxml
    bomb = _with_doctype(make_xlsx([["MAERSK", 1, 1, D45]], ST_HEAD))
    with caplog.at_level(logging.ERROR, logger="app"):
        r = client.post("/stuffing/upload", files={"file": ("s.xlsx", bomb)})
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert detail.startswith("Cannot read the stuffing file") and "Forbidden" not in detail and "lol" not in detail
    assert any(rec.exc_info for rec in caplog.records)  # the real exception is logged, not returned
    assert client.get("/stuffing/2026-11-03").json()["rows"] == []


def test_corrupt_workbook_message_does_not_echo_exception(client):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:  # a real ZIP, but without the workbook parts
        z.writestr("hello.txt", "not a workbook")
    r = client.post("/forecast/upload", files={"file": ("f.xlsx", out.getvalue())})
    assert r.status_code == 400
    assert r.json()["detail"] == "Cannot read the forecast file. Check that it is the forecast .xlsx export."


# ---------- forecast export with a title line above the header ----------

def _forecast_with_preamble(preamble_rows: int):
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Forecast"
    ws.append(["Ldd From: 2026-11-26   Ldd To: 2026-12-31   WoT: SEA, INTERRAIL   NoP: 15"])
    for _ in range(preamble_rows - 1):
        ws.append([])
    ws.append(["Rfi", "Edd", "Ldd", "Order", "Supplier", "exp.Vol cbm."])
    ws.append(["2026-11-30", "2026-11-30", "2026-12-03", "73066-202-43-580-007", 73066, 11.5])
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


@pytest.mark.parametrize("preamble_rows", [2, 5, 10])
def test_forecast_header_found_below_title_rows(preamble_rows):
    from app.parsers.forecast import parse_forecast
    rows = parse_forecast(io.BytesIO(_forecast_with_preamble(preamble_rows)))
    assert len(rows) == 1
    assert rows[0]["supplier"] == "73066" and rows[0]["vol_cbm"] == 11.5
    assert (rows[0]["iso_year"], rows[0]["iso_week"]) == (2026, 49)


# ---------- forecast export with two "Supplier" columns (numeric code, then the alpha CW code) ----------
TWO_SUPPLIER_HEAD = ["Rfi", "Order", "Supplier", "SUPPLIER", "exp.Vol cbm."]
D48 = dt.datetime(2026, 11, 26)  # ISO 2026-W48


def test_forecast_first_supplier_column_wins_over_alpha_code_column():
    from app.parsers.forecast import parse_forecast
    data = make_xlsx([[D48, "77523-202-48-001", 77523, "WAC", 40.0],
                      [D48, "84833-202-48-002", 84833, "FLAFASGAZ", 2.5]], TWO_SUPPLIER_HEAD)
    rows = parse_forecast(io.BytesIO(data))
    assert [r["supplier"] for r in rows] == ["77523", "84833"]
    assert [r["vol_cbm"] for r in rows] == [40.0, 2.5]
    assert {(r["iso_year"], r["iso_week"]) for r in rows} == {(2026, 48)}


def test_forecast_upload_with_two_supplier_columns_reaches_weekly(client):
    data = make_xlsx([[D48, "77523-202-48-001", 77523, "WAC", 100]], TWO_SUPPLIER_HEAD)
    r = client.post("/forecast/upload", files={"file": ("f.xlsx", data)})
    assert r.status_code == 200, r.text
    wk = client.get("/weekly/2026/48")
    assert wk.status_code == 200
    assert wk.json()["forecast"] > 0
    assert wk.json()["forecast"] == pytest.approx(130.0 / 33)


def test_forecast_without_header_still_reports_missing_columns():
    from app.parsers.forecast import ParseError, parse_forecast
    data = make_xlsx([["a", "b"], [1, 2]], ["x", "y"])
    with pytest.raises(ParseError, match="missing required columns"):
        parse_forecast(io.BytesIO(data))
