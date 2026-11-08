from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import config_service as cs
from ..db import get_db

router = APIRouter(prefix="/config", tags=["config"])


class ConfigIn(BaseModel):
    uplift_pct: float | None = None
    cbm_per_teu: float | None = None
    split: dict[str, float] | None = None
    fml_default: float | None = None
    line_map: dict[str, str | None] | None = None


@router.get("")
def get_config(db: Session = Depends(get_db)):
    return cs.get_config(db)


@router.put("")
def put_config(body: ConfigIn, db: Session = Depends(get_db)):
    try:
        return cs.update_config(db, body.model_dump(exclude_unset=True))
    except cs.ConfigError as e:
        raise HTTPException(422, str(e))
