from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import config_service as cs
from ..auth import require_admin
from ..db import get_db
from ..validation import BoundedFloat

router = APIRouter(prefix="/config", tags=["config"])


class ConfigIn(BaseModel):
    # finite and within +-1e12 here; the business ranges (cbm_per_teu > 0, split totals 100, ...) are checked
    # by config_service.validate, which answers with a readable message.
    uplift_pct: BoundedFloat | None = None
    cbm_per_teu: BoundedFloat | None = None
    split: dict[str, BoundedFloat] | None = Field(default=None, max_length=10)
    fml_default: BoundedFloat | None = None
    line_map: dict[str, str | None] | None = Field(default=None, max_length=cs.MAX_LINE_MAP)


@router.get("")
def get_config(db: Session = Depends(get_db)):
    return cs.get_config(db)


@router.put("", dependencies=[Depends(require_admin)])
def put_config(body: ConfigIn, db: Session = Depends(get_db)):
    try:
        return cs.update_config(db, body.model_dump(exclude_unset=True))
    except cs.ConfigError as e:
        raise HTTPException(422, str(e))
