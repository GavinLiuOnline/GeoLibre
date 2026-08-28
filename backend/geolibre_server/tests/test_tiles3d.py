"""Tests for the 3D Tiles sidecar helpers (LAS → PNTS zip)."""

from __future__ import annotations

import json
import struct
import zipfile
from io import BytesIO
from pathlib import Path

from geolibre_server.tiles3d_ops import (
    ecef_from_lng_lat_height,
    las_to_3dtiles_zip,
    parse_las,
    write_pnts,
)


def _build_las(path: Path, points: list[tuple[float, float, float]]) -> None:
    header_size = 227
    record_len = 20
    offset = header_size
    data = bytearray(offset + len(points) * record_len)
    data[0:4] = b"LASF"
    data[24] = 1
    data[25] = 2
    struct.pack_into("<H", data, 94, header_size)
    struct.pack_into("<I", data, 96, offset)
    data[104] = 0
    struct.pack_into("<H", data, 105, record_len)
    struct.pack_into("<I", data, 107, len(points))
    struct.pack_into("<ddd", data, 131, 0.01, 0.01, 0.01)
    struct.pack_into("<ddd", data, 155, 0.0, 0.0, 0.0)
    for i, (x, y, z) in enumerate(points):
        at = offset + i * record_len
        struct.pack_into(
            "<iii",
            data,
            at,
            int(round(x / 0.01)),
            int(round(y / 0.01)),
            int(round(z / 0.01)),
        )
    path.write_bytes(data)


def test_ecef_greenwich():
    x, y, z = ecef_from_lng_lat_height(0, 0, 0)
    assert abs(x - 6378137) < 1
    assert abs(y) < 1e-6
    assert abs(z) < 1e-6


def test_parse_las_and_pnts(tmp_path: Path):
    las = tmp_path / "cloud.las"
    _build_las(las, [(10.0, 20.0, 5.0), (11.0, 21.0, 6.0)])
    cloud = parse_las(las)
    assert cloud["count"] == 2
    assert abs(cloud["x"][0] - 10) < 0.02
    pnts = write_pnts(cloud["x"], cloud["y"], cloud["z"])
    assert pnts[:4] == b"pnts"
    assert struct.unpack_from("<I", pnts, 4)[0] == 1


def test_las_to_zip(tmp_path: Path):
    las = tmp_path / "cloud.las"
    _build_las(las, [(0.0, 0.0, 0.0), (5.0, 0.0, 1.0), (0.0, 5.0, 2.0)])
    payload = las_to_3dtiles_zip(las, longitude=116.4, latitude=39.9, height=40)
    with zipfile.ZipFile(BytesIO(payload)) as zf:
        names = zf.namelist()
        assert "tileset.json" in names
        assert "tiles/lod0.pnts" in names
        tileset = json.loads(zf.read("tileset.json"))
        assert tileset["asset"]["version"] == "1.1"
        assert len(tileset["root"]["transform"]) == 16
        assert zf.read("tiles/lod0.pnts")[:4] == b"pnts"
