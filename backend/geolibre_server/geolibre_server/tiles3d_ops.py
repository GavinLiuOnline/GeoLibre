"""Pure 3D Tiles helpers for the sidecar (LAS → PNTS tileset).

Mirrors the client pipeline's PNTS / tileset.json layout so a desktop batch
conversion of uncompressed LAS lands in the same folder structure the plugin
exports. Stdlib only — no numpy — so the module is testable without extras.
"""

from __future__ import annotations

import json
import math
import struct
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Any

WGS84_A = 6378137.0
WGS84_F = 1 / 298.257223563
WGS84_E2 = WGS84_F * (2 - WGS84_F)


class Tiles3dError(ValueError):
    """User-facing failure (bad LAS, empty cloud, unsupported version)."""


def ecef_from_lng_lat_height(lng: float, lat: float, height: float) -> tuple[float, float, float]:
    lat_r = math.radians(lat)
    lng_r = math.radians(lng)
    sin_lat = math.sin(lat_r)
    cos_lat = math.cos(lat_r)
    n = WGS84_A / math.sqrt(1 - WGS84_E2 * sin_lat * sin_lat)
    return (
        (n + height) * cos_lat * math.cos(lng_r),
        (n + height) * cos_lat * math.sin(lng_r),
        (n * (1 - WGS84_E2) + height) * sin_lat,
    )


def parse_las(path: Path, max_points: int = 2_000_000) -> dict[str, Any]:
    data = path.read_bytes()
    if len(data) < 227 or data[0:4] != b"LASF":
        raise Tiles3dError("Not an uncompressed LAS file.")
    major, minor = data[24], data[25]
    if major != 1 or minor > 4:
        raise Tiles3dError(f"Unsupported LAS version {major}.{minor}.")
    header_size = struct.unpack_from("<H", data, 94)[0]
    offset = struct.unpack_from("<I", data, 96)[0]
    fmt = data[104]
    record_len = struct.unpack_from("<H", data, 105)[0]
    count = struct.unpack_from("<I", data, 107)[0]
    if count == 0 and header_size >= 255 and len(data) >= 255:
        count = struct.unpack_from("<Q", data, 247)[0]
    if record_len == 0:
        raise Tiles3dError("LAS point record length is 0.")
    scale = struct.unpack_from("<ddd", data, 131)
    offset_xyz = struct.unpack_from("<ddd", data, 155)
    available = max(0, (len(data) - offset) // record_len)
    n = min(count or available, available, max_points)
    if n <= 0:
        raise Tiles3dError("LAS file contains no point records.")
    step = count / n if count > n else 1
    xs: list[float] = []
    ys: list[float] = []
    zs: list[float] = []
    for i in range(n):
        rec = offset + min(available - 1, int(i * step)) * record_len
        x_i, y_i, z_i = struct.unpack_from("<iii", data, rec)
        xs.append(x_i * scale[0] + offset_xyz[0])
        ys.append(y_i * scale[1] + offset_xyz[1])
        zs.append(z_i * scale[2] + offset_xyz[2])
    return {
        "x": xs,
        "y": ys,
        "z": zs,
        "count": len(xs),
        "bbox": (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs)),
        "format": fmt,
    }


def _pad(buf: bytes, align: int = 8) -> bytes:
    pad = (align - (len(buf) % align)) % align
    return buf if pad == 0 else buf + b"\0" * pad


def write_pnts(xs: list[float], ys: list[float], zs: list[float]) -> bytes:
    n = len(xs)
    positions = b"".join(struct.pack("<fff", xs[i], ys[i], zs[i]) for i in range(n))
    positions = _pad(positions, 8)
    feature = json.dumps({"POINTS_LENGTH": n, "POSITION": {"byteOffset": 0}}, separators=(",", ":"))
    feature_json = _pad(feature.encode("utf-8"), 8)
    header = struct.pack(
        "<4sIIIIII",
        b"pnts",
        1,
        28 + len(feature_json) + len(positions),
        len(feature_json),
        len(positions),
        0,
        0,
    )
    return header + feature_json + positions


def write_tileset_json(
    *,
    content_uri: str,
    bbox: tuple[float, float, float, float, float, float],
    longitude: float,
    latitude: float,
    height: float,
    geometric_error: float,
) -> str:
    ox, oy, oz = ecef_from_lng_lat_height(longitude, latitude, height)
    lat_r = math.radians(latitude)
    lng_r = math.radians(longitude)
    sin_lat, cos_lat = math.sin(lat_r), math.cos(lat_r)
    sin_lng, cos_lng = math.sin(lng_r), math.cos(lng_r)
    # ENU → ECEF, column-major 4×4 (Z-up local, matching LAS).
    transform = [
        -sin_lng,
        cos_lng,
        0.0,
        0.0,
        -sin_lat * cos_lng,
        -sin_lat * sin_lng,
        cos_lat,
        0.0,
        cos_lat * cos_lng,
        cos_lat * sin_lng,
        sin_lat,
        0.0,
        ox,
        oy,
        oz,
        1.0,
    ]
    west, south = math.radians(longitude - 0.001), math.radians(latitude - 0.001)
    east, north = math.radians(longitude + 0.001), math.radians(latitude + 0.001)
    tileset = {
        "asset": {"version": "1.1", "generator": "GeoLibre tiles3d sidecar"},
        "geometricError": geometric_error,
        "root": {
            "boundingVolume": {"region": [west, south, east, north, bbox[2], bbox[5]]},
            "geometricError": 0,
            "refine": "REPLACE",
            "content": {"uri": content_uri},
            "transform": transform,
        },
    }
    return json.dumps(tileset, indent=2) + "\n"


def las_to_3dtiles_zip(
    input_path: Path,
    *,
    longitude: float,
    latitude: float,
    height: float = 0.0,
) -> bytes:
    cloud = parse_las(input_path)
    pnts = write_pnts(cloud["x"], cloud["y"], cloud["z"])
    dx = cloud["bbox"][3] - cloud["bbox"][0]
    dy = cloud["bbox"][4] - cloud["bbox"][1]
    dz = cloud["bbox"][5] - cloud["bbox"][2]
    error = math.hypot(dx, dy, dz) or 1.0
    tileset = write_tileset_json(
        content_uri="tiles/lod0.pnts",
        bbox=cloud["bbox"],
        longitude=longitude,
        latitude=latitude,
        height=height,
        geometric_error=error,
    )
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED) as zf:
        zf.writestr("tileset.json", tileset)
        zf.writestr("tiles/lod0.pnts", pnts)
    return buf.getvalue()
