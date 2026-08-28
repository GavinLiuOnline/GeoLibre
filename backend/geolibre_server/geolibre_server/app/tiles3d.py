"""3D Tiles sidecar endpoints (LAS → 3D Tiles zip).

Path-based like ``/conversion``: the desktop app (or a batch script) points at a
LAS file under ``GEOLIBRE_CONVERSION_ROOTS`` and gets a zip of ``tileset.json``
plus a PNTS tile. Heavy decoding stays out of the browser bundle; the plugin's
client pipeline remains the interactive path for GLB/OBJ and modest LAS files.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from geolibre_server.tiles3d_ops import Tiles3dError, las_to_3dtiles_zip

from .conversion import _validate_input_path

router = APIRouter(prefix="/tiles3d", tags=["tiles3d"])
logger = logging.getLogger(__name__)


class LasToTilesetRequest(BaseModel):
    input_path: str
    longitude: float
    latitude: float
    height: float = 0.0


@router.get("/status")
def status():
    return {"available": True, "formats": ["las"]}


@router.post("/las-to-3dtiles")
def las_to_3dtiles(request: LasToTilesetRequest):
    try:
        input_path = Path(_validate_input_path(request.input_path))
    except HTTPException:
        raise
    except Exception as exc:  # pragma: no cover - conversion helper raises HTTPException
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if input_path.suffix.lower() not in {".las"}:
        raise HTTPException(status_code=400, detail="Only uncompressed .las files are accepted.")
    if not (-180 <= request.longitude <= 180 and -90 <= request.latitude <= 90):
        raise HTTPException(status_code=400, detail="longitude/latitude are out of range.")
    try:
        payload = las_to_3dtiles_zip(
            input_path,
            longitude=request.longitude,
            latitude=request.latitude,
            height=request.height,
        )
    except Tiles3dError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        logger.exception("tiles3d LAS read failed")
        raise HTTPException(status_code=400, detail="Could not read the LAS file.") from exc
    filename = f"{input_path.stem}-3dtiles.zip"
    return Response(
        content=payload,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
