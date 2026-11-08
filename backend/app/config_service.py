from __future__ import annotations

import json

from sqlalchemy.orm import Session

from .models import Config
from .utils import SPLIT_CARRIERS

DEFAULTS = {
    "uplift_pct": 30.0,
    "cbm_per_teu": 33.0,
    "split": {"MAERSK": 30.0, "HAPAG": 25.0, "HELLMAN": 20.0, "ONE": 25.0},
    "fml_default": 10.0,
    # PROVISIONAL defaults, editable via PUT /config
    "line_map": {
        "FML-ONELINE": "FML",
        "ONELINE": "ONE", "ONE": "ONE",
        "MAERSK": "MAERSK", "MSK": "MAERSK",
        "HAPAG": "HAPAG", "HLC": "HAPAG", "HAPAG-LLOYD": "HAPAG",
        "HELLMANN": "HELLMAN", "HELLMAN": "HELLMAN",
    },
}
VALID_TARGETS = {"MAERSK", "HAPAG", "HELLMAN", "ONE", "FML"}


class ConfigError(ValueError):
    pass


def validate(cfg: dict) -> dict:
    out = {}
    try:
        out["uplift_pct"] = float(cfg["uplift_pct"])
        out["cbm_per_teu"] = float(cfg["cbm_per_teu"])
        out["fml_default"] = float(cfg["fml_default"])
    except (TypeError, ValueError, KeyError):
        raise ConfigError("uplift_pct, cbm_per_teu, fml_default must be numbers")
    if out["cbm_per_teu"] <= 0:
        raise ConfigError("cbm_per_teu must be > 0")
    if out["uplift_pct"] <= -100:
        raise ConfigError("uplift_pct must be > -100")
    if out["fml_default"] < 0:
        raise ConfigError("fml_default must be >= 0")
    split = cfg.get("split") or {}
    if set(split) != set(SPLIT_CARRIERS):
        raise ConfigError(f"split must have exactly keys {SPLIT_CARRIERS}")
    try:
        split = {k: float(v) for k, v in split.items()}
    except (TypeError, ValueError):
        raise ConfigError("split values must be numbers")
    if any(v < 0 for v in split.values()):
        raise ConfigError("split values must be >= 0")
    if abs(sum(split.values()) - 100.0) > 1e-9:
        raise ConfigError(f"split must total 100 (got {sum(split.values())})")
    out["split"] = split
    norm = {}
    for k, v in (cfg.get("line_map") or {}).items():
        v = str(v).strip().upper()
        if v not in VALID_TARGETS:
            raise ConfigError(f"line_map target {v!r} must be one of {sorted(VALID_TARGETS)}")
        norm[str(k).strip().upper()] = v
    out["line_map"] = norm
    return out


def get_config(db: Session) -> dict:
    cfg = json.loads(json.dumps(DEFAULTS))
    for row in db.query(Config).all():
        cfg[row.key] = json.loads(row.value)
    return cfg


def update_config(db: Session, patch: dict) -> dict:
    merged = get_config(db)
    patch = dict(patch)
    lm_patch = patch.pop("line_map", None)
    merged.update({k: v for k, v in patch.items() if v is not None})
    if lm_patch is not None:
        lm = {str(k).strip().upper(): v for k, v in (merged.get("line_map") or {}).items()}
        for k, v in lm_patch.items():
            key = str(k).strip().upper()
            if v is None:
                lm.pop(key, None)  # null deletes the entry
            else:
                lm[key] = v
        merged["line_map"] = lm
    clean = validate(merged)
    for k, v in clean.items():
        row = db.get(Config, k)
        if row:
            row.value = json.dumps(v)
        else:
            db.add(Config(key=k, value=json.dumps(v)))
    db.commit()
    return clean
