"""Old-vs-new regression: the current code must give the same business answers as the PRE-go-live backend.

tests/golden/old_vs_new/scenario.json.gz holds the answers of the old backend (git 2c6f3f1: SQLite, no sign-in)
to one scenario, captured on 2026-11-26 by driving the old and the new server over HTTP with identical inputs
and the same 14-supplier list (seed/suppliers_seed.py; the old code's own seed has 12, so before the first
recorded request the harness added 77591 and 84894 through the old code's POST /suppliers/{code}; the old code
itself was not changed). The inputs are: the real forecast workbook, confirmed TEUs (golden weeks 45-47, fractions, fml_forecast override/clear, large
values, zeros), typed daily stuffing, stuffing .xlsx uploads (aliases, CBM column or not, report_date,
replace / zero-row re-upload, bad rows, header position), actual-CBM adjustments, ISO week 53 / year change,
config changes + restore, supplier add/delete/upload. This test replays every write in the same order and
compares the read battery at 10 checkpoints (weekly, daily, forecast, both reports, stuffing, config,
suppliers, both .xlsx downloads cell by cell).

Rules: strings, ints, bools, None, key sets, list lengths and status codes must be identical. Floats may differ
only by SQL SUM order (SQLite sums with compensation, Postgres left to right: at most a few ULP), so a float
passes when abs diff <= 1e-9 or rel diff <= 1e-12. Stuffing row ids are compared by order only (SQLite reuses
rowids). Entries with ``intended_new`` are documented intended changes (readable upload errors). Bad-input
behaviour is deliberately different (validation hardening) and is not part of this snapshot.
"""
from __future__ import annotations

import gzip
import io
import json
import math
import pathlib

import openpyxl
import pytest

from tests.conftest import REAL_FORECAST, REQUIRE_GOLDEN

GOLDEN = pathlib.Path(__file__).resolve().parent / "golden" / "old_vs_new"
ABS_TOL, REL_TOL = 1e-9, 1e-12
XLSX_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _load():
    with gzip.open(GOLDEN / "scenario.json.gz", "rt", encoding="ascii") as fh:
        return json.load(fh)


def _xlsx_dump(content: bytes) -> dict:
    wb = openpyxl.load_workbook(io.BytesIO(content))
    out = {"sheets": wb.sheetnames, "data": {}}
    for ws in wb.worksheets:
        cells = {}
        for row in ws.iter_rows():
            for c in row:
                if c.value is None and not c.has_style:
                    continue
                cells[c.coordinate] = {
                    "v": c.value if not hasattr(c.value, "isoformat") else c.value.isoformat(),
                    "t": type(c.value).__name__,
                    "fmt": c.number_format,
                    "bold": bool(c.font and c.font.b),
                    "fill": (c.fill.fgColor.rgb if c.fill and c.fill.fill_type else None),
                    "align": (c.alignment.horizontal if c.alignment else None),
                }
        out["data"][ws.title] = {
            "dims": ws.dimensions, "max_row": ws.max_row, "max_col": ws.max_column,
            "merged": sorted(str(m) for m in ws.merged_cells.ranges),
            "freeze": ws.freeze_panes,
            "widths": {k: v.width for k, v in sorted(ws.column_dimensions.items()) if v.width},
            "cells": cells,
        }
    return out


def _strip_ids(obj):
    """Stuffing row ids: strictly increasing in each rows list (the API order), then blanked."""
    if isinstance(obj, dict):
        rows = obj.get("rows")
        if isinstance(rows, list) and rows and isinstance(rows[0], dict) and "id" in rows[0]:
            ids = [r["id"] for r in rows]
            assert ids == sorted(set(ids)), f"stuffing row ids not strictly increasing: {ids}"
            obj = {**obj, "rows": [{**r, "id": "<id>"} for r in rows]}
        return {k: (_strip_ids(v) if k != "rows" else v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_strip_ids(x) for x in obj]
    return obj


def _answer(r) -> dict:
    ct = r.headers.get("content-type", "")
    if "spreadsheetml" in ct:
        return {"kind": "xlsx", "disposition": r.headers.get("content-disposition"), "xlsx": _xlsx_dump(r.content)}
    if "json" in ct:
        return {"kind": "json", "json": _strip_ids(r.json())}
    return {"kind": "text", "ct": ct.split(";")[0], "text": r.text[:2000]}


def _compare(old, new, where, problems):
    if isinstance(old, dict) and isinstance(new, dict):
        if set(old) != set(new):
            problems.append(f"{where}: keys old-only={sorted(set(old) - set(new))} new-only={sorted(set(new) - set(old))}")
            return
        for k in old:
            _compare(old[k], new[k], f"{where}.{k}", problems)
        return
    if isinstance(old, list) and isinstance(new, list):
        if len(old) != len(new):
            problems.append(f"{where}: list length old={len(old)} new={len(new)}")
            return
        for i, (a, b) in enumerate(zip(old, new)):
            _compare(a, b, f"{where}[{i}]", problems)
        return
    if type(old) is not type(new):
        problems.append(f"{where}: type old={old!r} new={new!r}")
        return
    if isinstance(old, float):
        if old == new:
            if math.copysign(1, old) != math.copysign(1, new):
                problems.append(f"{where}: sign of zero old={old!r} new={new!r}")
            return
        diff = abs(old - new)
        if not (diff <= ABS_TOL or diff / max(abs(old), abs(new)) <= REL_TOL):
            problems.append(f"{where}: old={old!r} new={new!r} (diff {diff:.3g})")
        return
    if old != new:
        problems.append(f"{where}: old={old!r} new={new!r}")


def _send(client, req: dict):
    kw = {"params": req["params"], "headers": dict(req["headers"] or {})}
    if req["raw"] is not None:
        kw["content"] = req["raw"].encode("utf-8")
        kw["headers"]["content-type"] = "application/json"
    elif req["json"] is not None:
        kw["json"] = req["json"]
    if req["file"]:
        name, ref = req["file"]
        content = REAL_FORECAST.read_bytes() if ref == "@WORKBOOK" else (GOLDEN / "inputs" / ref).read_bytes()
        kw["files"] = {"file": (name, content, XLSX_CT)}
    return client.request(req["method"], req["path"], **kw)


def test_golden_snapshot_is_the_old_codes_golden_numbers():
    """Provenance check: the snapshot holds the business golden numbers of the 14-supplier list (wk45 132.399505
    TEU, wk46 -36.913398 with 70 confirmed, wk47 -17.004274 with 55 confirmed) as answered by the old code.
    (12-supplier list: 72.660565, -17.766920, +7.569331.)"""
    weekly = {e["req"]["path"]: e["answer"]["json"] for e in _load()["entries"]
              if e["battery"] == 2 and e["req"]["path"].startswith("/weekly/2026/")}
    assert abs(weekly["/weekly/2026/45"]["forecast"] - 132.399505) < 1e-6
    assert abs(weekly["/weekly/2026/46"]["deficit_surplus"] - -36.913398) < 1e-6
    assert abs(weekly["/weekly/2026/47"]["deficit_surplus"] - -17.004274) < 1e-6
    assert weekly["/weekly/2026/46"]["status"] == "deficit" and weekly["/weekly/2026/47"]["status"] == "deficit"
    suppliers = next(e["answer"]["json"] for e in _load()["entries"] if e["battery"] == 1 and e["req"]["path"] == "/suppliers")
    assert len(suppliers) == 14 and {"77591", "84894"} <= {s["code"] for s in suppliers}


def test_replay_matches_pre_golive_code(client):
    if not REAL_FORECAST.exists():
        if REQUIRE_GOLDEN:
            pytest.fail(f"golden workbook missing: {REAL_FORECAST}")
        pytest.skip("real forecast workbook not available")
    entries = _load()["entries"]
    problems, checked = [], 0
    for e in entries:
        r = _send(client, e["req"])
        where = f"#{e['seq']} [{e['step']}] {e['label']}"
        if "intended_new" in e:
            want = e["intended_new"]
            if r.status_code != want["status"] or r.json().get("detail") != want["detail"]:
                problems.append(f"{where}: intended answer {want}, got {r.status_code} {r.text[:200]}")
            continue
        if r.status_code != e["status"]:
            problems.append(f"{where}: status old={e['status']} new={r.status_code} {r.text[:200]}")
            continue
        _compare(e["answer"], _answer(r), where, problems)
        checked += 1
    assert not problems, f"{len(problems)} differences from the pre-go-live code:\n" + "\n".join(problems[:25])
    assert checked == len(entries) - sum(1 for e in entries if "intended_new" in e)
