import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TILES3D_PIPELINE_PLUGIN_ID } from "../packages/plugins/src/plugin-ids";
import { applyMeshOptimize, importScene, normalizeOptimizeOptions, shiftScene, bboxCenter } from "../packages/plugins/src/plugins/tiles3d-pipeline/import-scene";
import { importBundle } from "../packages/plugins/src/plugins/tiles3d-pipeline/import-bundle";
import { parseLas, writePnts } from "../packages/plugins/src/plugins/tiles3d-pipeline/las";
import { computeBBox, parseGlb, parseObj, triangleCount, weldVertices, writeGlb } from "../packages/plugins/src/plugins/tiles3d-pipeline/mesh";
import { buildQaReport } from "../packages/plugins/src/plugins/tiles3d-pipeline/qa";
import { buildTileset, rewriteTilesetUris, tilesetGeographicBounds } from "../packages/plugins/src/plugins/tiles3d-pipeline/tileset";
import {
  bboxDiagonal,
  ecefFromLngLatHeight,
  fitPlacementFromGcps,
  geographicBounds,
  lngLatHeightFromEcef,
  umeyama,
} from "../packages/plugins/src/plugins/tiles3d-pipeline/transforms";
import {
  lngLatToProjected,
  parseCrsInput,
  parseProj4Params,
  placementFromLocalCrs,
  projectedToLngLat,
  settingsFromEpsg,
  serializeProj4Params,
  updateProj4Param,
} from "../packages/plugins/src/plugins/tiles3d-pipeline/crs";
import { applyObliqueMetadata, parseObliqueMetadata } from "../packages/plugins/src/plugins/tiles3d-pipeline/oblique";
import {
  DEFAULT_LOCAL_CRS,
  DEFAULT_OPTIMIZE_OPTIONS,
  DEFAULT_PLACEMENT,
  PIPELINE_STEPS,
  type LocalCrsSettings,
  type MeshData,
  type ModelGcp,
} from "../packages/plugins/src/plugins/tiles3d-pipeline/types";
import { crc32 } from "../packages/plugins/src/plugins/tiles3d-pipeline/crc32";
import { buildZip } from "../packages/plugins/src/plugins/tiles3d-pipeline/zip";

function triangleMesh(): MeshData {
  const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]);
  return {
    positions,
    indices: new Uint32Array([0, 1, 2]),
    bbox: computeBBox(positions),
  };
}

/** Minimal LAS 1.2 header + two point-format-0 records. */
function buildLas(points: { x: number; y: number; z: number }[]): Uint8Array {
  const headerSize = 227;
  const recordLength = 20;
  const offset = headerSize;
  const bytes = new Uint8Array(offset + points.length * recordLength);
  const dv = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("LASF"), 0);
  bytes[24] = 1;
  bytes[25] = 2;
  dv.setUint16(94, headerSize, true);
  dv.setUint32(96, offset, true);
  bytes[104] = 0;
  dv.setUint16(105, recordLength, true);
  dv.setUint32(107, points.length, true);
  dv.setFloat64(131, 0.01, true);
  dv.setFloat64(139, 0.01, true);
  dv.setFloat64(147, 0.01, true);
  dv.setFloat64(155, 0, true);
  dv.setFloat64(163, 0, true);
  dv.setFloat64(171, 0, true);
  for (let i = 0; i < points.length; i++) {
    const at = offset + i * recordLength;
    dv.setInt32(at, Math.round(points[i].x / 0.01), true);
    dv.setInt32(at + 4, Math.round(points[i].y / 0.01), true);
    dv.setInt32(at + 8, Math.round(points[i].z / 0.01), true);
  }
  return bytes;
}

describe("3D Tiles pipeline plugin identity", () => {
  it("uses a stable plugin id", () => {
    assert.equal(TILES3D_PIPELINE_PLUGIN_ID, "geolibre-3d-pipeline");
  });
});

describe("OBJ / GLB mesh codec", () => {
  it("parses a triangulated OBJ", () => {
    const mesh = parseObj("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
    assert.equal(triangleCount(mesh), 1);
    assert.equal(mesh.positions.length, 9);
    assert.deepEqual([...mesh.indices!], [0, 1, 2]);
  });

  it("round-trips a GLB", () => {
    const source = triangleMesh();
    const glb = writeGlb(source);
    assert.equal(new TextDecoder().decode(glb.subarray(0, 4)), "glTF");
    const parsed = parseGlb(glb);
    assert.equal(triangleCount(parsed), 1);
    assert.ok(Math.abs(parsed.positions[3] - 10) < 1e-5);
  });

  it("imports a GLB through importScene", () => {
    const scene = importScene("box.glb", writeGlb(triangleMesh()));
    assert.equal(scene.kind, "mesh");
    assert.equal(scene.triangleCount, 1);
    assert.ok(scene.originalGlb);
  });

  it("welds coincident vertices", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0]);
    const mesh: MeshData = {
      positions,
      indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
      bbox: computeBBox(positions),
    };
    const welded = weldVertices(mesh, 0.01);
    assert.equal(welded.positions.length / 3, 3);
  });
});

describe("LAS point clouds", () => {
  it("parses scale/offset integer records", () => {
    const las = buildLas([
      { x: 10, y: 20, z: 5 },
      { x: 11, y: 21, z: 6 },
    ]);
    const cloud = parseLas(las);
    assert.equal(cloud.positions.length / 3, 2);
    assert.ok(Math.abs(cloud.positions[0] - 10) < 0.02);
    assert.ok(Math.abs(cloud.positions[4] - 21) < 0.02);
  });

  it("writes a PNTS tile with the pnts magic", () => {
    const cloud = parseLas(buildLas([{ x: 1, y: 2, z: 3 }]));
    const pnts = writePnts(cloud);
    assert.equal(new TextDecoder().decode(pnts.subarray(0, 4)), "pnts");
    const dv = new DataView(pnts.buffer, pnts.byteOffset, pnts.byteLength);
    assert.equal(dv.getUint32(4, true), 1);
    assert.equal(dv.getUint32(8, true), pnts.byteLength);
  });

  it("rejects LAZ with a clear error", () => {
    const las = buildLas([{ x: 0, y: 0, z: 0 }]);
    const text = new TextEncoder().encode("laszip encoded");
    las.set(text, 90);
    assert.throws(() => importScene("cloud.laz", las), /LAZ/);
  });
});

describe("geodetic transforms", () => {
  it("round-trips ECEF at Greenwich", () => {
    const [x, y, z] = ecefFromLngLatHeight(0, 0, 0);
    assert.ok(Math.abs(x - 6378137) < 1);
    assert.ok(Math.abs(y) < 1e-6);
    const back = lngLatHeightFromEcef(x, y, z);
    assert.ok(Math.abs(back.longitude) < 1e-6);
    assert.ok(Math.abs(back.latitude) < 1e-6);
    assert.ok(Math.abs(back.height) < 0.01);
  });

  it("fits a translated triangle with Umeyama", () => {
    const src: [number, number, number][] = [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
    ];
    const dst = src.map(([x, y, z]) => [x + 100, y - 40, z + 5] as [number, number, number]);
    const sim = umeyama(src, dst);
    assert.ok(sim);
    assert.ok(Math.abs(sim!.scale - 1) < 1e-6);
    assert.ok(Math.abs(sim!.translation[0] - 100) < 1e-4);
    assert.ok(Math.abs(sim!.translation[1] + 40) < 1e-4);
  });

  it("sets origin from a single GCP", () => {
    const gcps: ModelGcp[] = [
      { id: "a", modelX: 0, modelY: 0, modelZ: 0, longitude: 116.4, latitude: 39.9, height: 50 },
    ];
    const fit = fitPlacementFromGcps(gcps);
    assert.ok(fit);
    assert.equal(fit!.placement.longitude, 116.4);
    assert.equal(fit!.placement.latitude, 39.9);
    assert.equal(fit!.residualRmsMeters, 0);
  });
});

describe("tileset export", () => {
  it("emits tileset.json + glb LOD children as a zip", () => {
    const scene = importScene("tri.obj", new TextEncoder().encode("v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n"));
    const placement = { ...DEFAULT_PLACEMENT, longitude: 12.5, latitude: 41.9, height: 20 };
    const exported = buildTileset(scene, placement, { ...DEFAULT_OPTIMIZE_OPTIONS, lodLevels: 2 });
    const names = exported.files.map((file) => file.path);
    assert.ok(names.includes("tileset.json"));
    assert.ok(names.some((name) => name.endsWith(".glb")));
    const tileset = JSON.parse(new TextDecoder().decode(exported.files[0].bytes)) as {
      asset: { version: string };
      root: { transform: number[]; content: { uri: string } };
    };
    assert.equal(tileset.asset.version, "1.1");
    assert.equal(tileset.root.transform.length, 16);
    const zip = buildZip(exported.files);
    assert.equal(new DataView(zip.buffer).getUint32(0, true), 0x04034b50);
    assert.ok(exported.bounds[0] < exported.bounds[2]);
    assert.ok(crc32(exported.files[0].bytes) >>> 0);
  });

  it("builds a QA report with an origin-unset warning at (0,0)", () => {
    const scene = importScene("tri.obj", new TextEncoder().encode("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"));
    const report = buildQaReport(scene, DEFAULT_PLACEMENT, DEFAULT_OPTIMIZE_OPTIONS, 0, null);
    assert.ok(report.issues.some((issue) => issue.code === "origin-unset"));
    assert.equal(report.triangleCount, 1);
  });

  it("normalizes optimize options", () => {
    assert.equal(normalizeOptimizeOptions({ lodLevels: 99 }).lodLevels, 8);
    assert.equal(normalizeOptimizeOptions({ reduction: 0 }).reduction, 0.05);
    const optimized = applyMeshOptimize(importScene("t.obj", new TextEncoder().encode("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n")), {
      ...DEFAULT_OPTIMIZE_OPTIONS,
      weldEpsilon: 0.5,
    });
    assert.ok(optimized.mesh);
  });

  it("reports a geographic bbox near a known origin", () => {
    const mesh = triangleMesh();
    const bounds = geographicBounds(mesh.bbox, {
      ...DEFAULT_PLACEMENT,
      longitude: 2.35,
      latitude: 48.86,
    });
    assert.ok(bounds[0] <= 2.35 && bounds[2] >= 2.35);
    assert.ok(bounds[1] <= 48.86 && bounds[3] >= 48.86);
    assert.ok(bboxDiagonal(mesh.bbox) > 10);
  });
});

describe("STL / PLY import", () => {
  it("parses an ASCII STL triangle", () => {
    const stl = [
      "solid tri",
      "  facet normal 0 0 1",
      "    outer loop",
      "      vertex 0 0 0",
      "      vertex 1 0 0",
      "      vertex 0 1 0",
      "    endloop",
      "  endfacet",
      "endsolid tri",
      "",
    ].join("\n");
    const scene = importScene("tri.stl", new TextEncoder().encode(stl));
    assert.equal(scene.sourceFormat, "stl");
    assert.equal(scene.triangleCount, 1);
  });

  it("parses an ASCII PLY triangle", () => {
    const ply = [
      "ply",
      "format ascii 1.0",
      "element vertex 3",
      "property float x",
      "property float y",
      "property float z",
      "element face 1",
      "property list uchar int vertex_indices",
      "end_header",
      "0 0 0",
      "1 0 0",
      "0 1 0",
      "3 0 1 2",
      "",
    ].join("\n");
    const scene = importScene("tri.ply", new TextEncoder().encode(ply));
    assert.equal(scene.triangleCount, 1);
    assert.equal(scene.vertexCount, 3);
  });
});

describe("local CRS and oblique metadata", () => {
  it("round-trips Shanghai through CGCS2000 3° Gauss-Kruger zone 40", () => {
    const settings: LocalCrsSettings = {
      ...DEFAULT_LOCAL_CRS,
      preset: "cgcs2000-gk3",
      zone: 40,
      zoneInEasting: false,
      modelIsProjected: true,
    };
    const { easting, northing } = lngLatToProjected(121.47, 31.23, settings);
    assert.ok(easting > 600_000 && easting < 700_000);
    const back = projectedToLngLat(easting, northing, settings);
    assert.ok(Math.abs(back.longitude - 121.47) < 1e-7);
    assert.ok(Math.abs(back.latitude - 31.23) < 1e-7);
    const withPrefix = lngLatToProjected(121.47, 31.23, { ...settings, zoneInEasting: true });
    assert.ok(withPrefix.easting > 40_000_000 && withPrefix.easting < 41_000_000);
  });

  it("maps EPSG:4549 to CGCS2000 3° CM 120E", () => {
    const hint = settingsFromEpsg(4549);
    assert.ok(hint);
    assert.equal(hint!.preset, "cgcs2000-gk3");
    assert.equal(hint!.zone, 40);
    assert.equal(hint!.zoneInEasting, false);
  });

  it("fills WGS84 UTM zone 50 from a pasted proj4 string, including +type=crs", () => {
    const a = parseCrsInput("+proj=utm +zone=50 +datum=WGS84 +units=m +no_defs");
    assert.equal(a?.preset, "wgs84-utm");
    assert.equal(a?.zone, 50);
    const b = parseCrsInput("+proj=utm +zone=50 +datum=WGS84 +units=m +no_defs +type=crs");
    assert.equal(b?.preset, "wgs84-utm");
    assert.equal(b?.zone, 50);
    const c = parseCrsInput("EPSG:32650");
    assert.equal(c?.preset, "wgs84-utm");
    assert.equal(c?.zone, 50);
    const settings: LocalCrsSettings = { ...DEFAULT_LOCAL_CRS, ...a, offsetX: 500000, offsetY: 3_500_000, offsetZ: 0 };
    const placed = placementFromLocalCrs(settings, 0, 0, 0);
    assert.ok(Math.abs(placed.longitude - 117) < 0.01);
    assert.ok(placed.latitude > 31 && placed.latitude < 32);
  });

  it("recognises spherical Web Mercator and converts projected metres", () => {
    const merc =
      "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +no_defs";
    const parsed = parseCrsInput(merc);
    assert.equal(parsed?.preset, "web-mercator");
    assert.equal(parseCrsInput("EPSG:3857")?.preset, "web-mercator");
    const origin = placementFromLocalCrs({ ...DEFAULT_LOCAL_CRS, ...parsed, customProj4: merc }, 0, 0, 0);
    assert.ok(Math.abs(origin.longitude) < 1e-9);
    assert.ok(Math.abs(origin.latitude) < 1e-9);
    const shanghai = placementFromLocalCrs(
      { ...DEFAULT_LOCAL_CRS, preset: "web-mercator", offsetX: 13_523_272, offsetY: 3_662_230, offsetZ: 0, customProj4: merc, modelIsProjected: false },
      0,
      0,
      0,
    );
    assert.ok(shanghai.longitude > 121 && shanghai.longitude < 122);
    assert.ok(shanghai.latitude > 31 && shanghai.latitude < 32);
  });

  it("recognises China Albers and maps grid origin to 105°E, 0°N", () => {
    const aea =
      "+proj=aea +lat_1=25 +lat_2=47 +lat_0=0 +lon_0=105 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs";
    const parsed = parseCrsInput(aea);
    assert.equal(parsed?.preset, "albers-china");
    const origin = placementFromLocalCrs({ ...DEFAULT_LOCAL_CRS, ...parsed, customProj4: aea }, 0, 0, 0);
    assert.ok(Math.abs(origin.longitude - 105) < 1e-6);
    assert.ok(Math.abs(origin.latitude) < 1e-6);
    const beijing = placementFromLocalCrs(
      {
        ...DEFAULT_LOCAL_CRS,
        preset: "albers-china",
        offsetX: 956439.17,
        offsetY: 4_343_540.01,
        offsetZ: 0,
        customProj4: aea,
        modelIsProjected: false,
      },
      0,
      0,
      0,
    );
    assert.ok(beijing.longitude > 116 && beijing.longitude < 117);
    assert.ok(beijing.latitude > 39 && beijing.latitude < 41);
  });

  it("fills an input for every proj4 token, including lat_1 / lat_2", () => {
    const aea =
      "+proj=aea +lat_1=25 +lat_2=47 +lat_0=0 +lon_0=105 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs";
    const params = parseProj4Params(aea);
    const byKey = Object.fromEntries(params.map((param) => [param.key, param]));
    assert.equal(byKey.proj?.value, "aea");
    assert.equal(byKey.lat_1?.value, "25");
    assert.equal(byKey.lat_2?.value, "47");
    assert.equal(byKey.lon_0?.value, "105");
    assert.equal(byKey.datum?.value, "WGS84");
    assert.equal(byKey.no_defs?.flag, true);
    assert.equal(serializeProj4Params(params), aea);
    const updated = updateProj4Param(aea, "lat_1", "26");
    assert.match(updated, /\+lat_1=26\b/);
    assert.match(updated, /\+lat_2=47\b/);
    assert.equal(parseCrsInput(updated)?.preset, "custom");
    assert.equal(parseCrsInput(updateProj4Param(aea, "lat_1", "25"))?.preset, "albers-china");
  });

  it("places a CAD origin from projected offsets", () => {
    const settings: LocalCrsSettings = {
      ...DEFAULT_LOCAL_CRS,
      preset: "cgcs2000-gk3",
      zone: 40,
      zoneInEasting: false,
      offsetX: 640000,
      offsetY: 3_450_000,
      offsetZ: 12,
      modelIsProjected: false,
    };
    const placed = placementFromLocalCrs(settings, 0, 0, 0);
    assert.ok(placed.longitude > 121 && placed.longitude < 122);
    assert.ok(placed.latitude > 31 && placed.latitude < 32);
    assert.equal(placed.height, 12);
  });

  it("parses ContextCapture ENU and EPSG metadata.xml", () => {
    const enu = parseObliqueMetadata(
      `<ModelMetadata version="1"><SRS>ENU:31.23,121.47</SRS><SRSOrigin>0,0,12</SRSOrigin></ModelMetadata>`,
    );
    assert.ok(enu.enu);
    assert.equal(enu.enu!.latitude, 31.23);
    assert.equal(enu.enu!.longitude, 121.47);
    const epsg = parseObliqueMetadata(
      `<ModelMetadata><SRS>EPSG:4549</SRS><SRSOrigin>640123.4,3456789.1,8.5</SRSOrigin></ModelMetadata>`,
    );
    assert.equal(epsg.epsg, 4549);
    assert.deepEqual(epsg.origin, [640123.4, 3456789.1, 8.5]);
    const applied = applyObliqueMetadata(epsg, DEFAULT_PLACEMENT, DEFAULT_LOCAL_CRS);
    assert.equal(applied.applied, "projected");
    assert.equal(applied.crs.preset, "cgcs2000-gk3");
    assert.equal(applied.crs.offsetX, 640123.4);
  });
});

describe("folder / tileset import", () => {
  it("walks four pipeline steps", () => {
    assert.deepEqual(PIPELINE_STEPS, ["import", "register", "optimize", "export"]);
  });

  it("imports a tileset.json folder as a tileset bundle", () => {
    const json = JSON.stringify({
      asset: { version: "1.1" },
      root: {
        boundingVolume: { region: [0, 0, 0.1, 0.1, 0, 10] },
        geometricError: 1,
        content: { uri: "tiles/a.glb" },
      },
    });
    const bundle = importBundle([
      { name: "site/tileset.json", bytes: new TextEncoder().encode(json) },
      { name: "site/tiles/a.glb", bytes: writeGlb(triangleMesh()) },
    ]);
    assert.equal(bundle.kind, "tileset");
    if (bundle.kind === "tileset") {
      assert.equal(bundle.files.length, 2);
      const bounds = tilesetGeographicBounds(json);
      assert.ok(bounds);
      assert.ok(bounds![2] > bounds![0]);
    }
  });

  it("prefers a top-level OBJ over nested OSGB and reads metadata", () => {
    const xml = `<ModelMetadata><SRS>ENU:31.2,121.5</SRS><SRSOrigin>0,0,0</SRSOrigin></ModelMetadata>`;
    const bundle = importBundle([
      { name: "oblique/metadata.xml", bytes: new TextEncoder().encode(xml) },
      { name: "oblique/Data/Tile_0.osgb", bytes: new Uint8Array([1, 2, 3, 4]) },
      { name: "oblique/model.obj", bytes: new TextEncoder().encode("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n") },
    ]);
    assert.equal(bundle.kind, "scene");
    if (bundle.kind === "scene") {
      assert.equal(bundle.scene.sourceFormat, "obj");
      assert.ok(bundle.metadata?.enu);
    }
  });

  it("explains OSGB-only folders", () => {
    assert.throws(
      () =>
        importBundle([
          { name: "Data/Tile.osgb", bytes: new Uint8Array([0, 1, 2, 3]) },
          { name: "metadata.xml", bytes: new TextEncoder().encode("<ModelMetadata><SRS>EPSG:4549</SRS></ModelMetadata>") },
        ]),
      /OSGB/,
    );
  });

  it("rewrites nested tileset uris", () => {
    const json = JSON.stringify({
      root: { content: { uri: "0/0.b3dm" }, children: [{ content: { uri: "1.json" } }] },
    });
    const out = JSON.parse(rewriteTilesetUris(json, (rel) => `blob:${rel}`)) as {
      root: { content: { uri: string }; children: { content: { uri: string } }[] };
    };
    assert.equal(out.root.content.uri, "blob:0/0.b3dm");
    assert.equal(out.root.children[0].content.uri, "blob:1.json");
  });

  it("shifts projected mesh vertices onto a local origin", () => {
    const scene = importScene("cad.obj", new TextEncoder().encode("v 100 200 3\nv 110 200 3\nv 100 210 3\nf 1 2 3\n"));
    const shifted = shiftScene(scene, 100, 200, 3);
    assert.ok(Math.abs(shifted.mesh!.positions[0]) < 1e-6);
    assert.ok(Math.abs(shifted.mesh!.positions[1]) < 1e-6);
    const c = bboxCenter(scene.mesh!.bbox);
    assert.ok(c[0] > 100);
  });
});
