/**
 * 3D Tiles 1.1 tileset builder. Mesh LODs become glTF content (`.glb`); point
 * clouds become PNTS. The root `transform` places local meters into ECEF so
 * Cesium and MapLibre 3D Tiles viewers land the dataset on the ellipsoid.
 */

import { writeGlb } from "./mesh";
import { writePnts } from "./las";
import { buildMeshLod, buildPointLod } from "./lod";
import { bboxDiagonal, regionBoundingVolume, tilesetTransform } from "./transforms";
import type { ImportedScene, OptimizeOptions, Placement, TilesetExport, TilesetFile } from "./types";
import { sceneIsYUp } from "./types";

interface TileJson {
  boundingVolume: { region: number[] };
  geometricError: number;
  refine?: "REPLACE" | "ADD";
  content?: { uri: string };
  children?: TileJson[];
  transform?: number[];
}

function padJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Build a 3D Tiles 1.1 tileset from an imported scene, placement, and LOD
 * options. LOD 0 (finest) is a leaf with geometricError 0; coarser levels wrap
 * it as REPLACE parents, SuperMap-style pyramid.
 */
export function buildTileset(
  scene: ImportedScene,
  placement: Placement,
  options: OptimizeOptions,
): TilesetExport {
  const yUp = sceneIsYUp(scene.sourceFormat);
  const bbox = scene.kind === "mesh" ? scene.mesh!.bbox : scene.points!.bbox;
  const region = regionBoundingVolume(bbox, placement, yUp);
  const files: TilesetFile[] = [];
  const transform = tilesetTransform(placement, yUp);

  let leaf: TileJson;
  if (scene.kind === "mesh" && scene.mesh) {
    const levels = buildMeshLod(scene.mesh, options);
    // Finest first in `levels`; write coarsest as the root content.
    const ordered = [...levels].reverse();
    let child: TileJson | undefined;
    for (const level of ordered) {
      const passThrough = level.level === 0 && scene.originalGlb && options.reduction >= 1 && options.lodLevels <= 1;
      const bytes = passThrough ? scene.originalGlb! : writeGlb(level.mesh);
      const name = `tiles/lod${level.level}.glb`;
      files.push({ path: name, bytes });
      const tile: TileJson = {
        boundingVolume: { region: [...region] },
        geometricError: level.geometricError,
        refine: "REPLACE",
        content: { uri: name },
      };
      if (child) tile.children = [child];
      child = tile;
    }
    leaf = child!;
  } else if (scene.points) {
    const levels = buildPointLod(scene.points, options);
    const ordered = [...levels].reverse();
    let child: TileJson | undefined;
    for (const level of ordered) {
      const name = `tiles/lod${level.level}.pnts`;
      files.push({ path: name, bytes: writePnts(level.points) });
      const tile: TileJson = {
        boundingVolume: { region: [...region] },
        geometricError: level.geometricError,
        refine: "REPLACE",
        content: { uri: name },
      };
      if (child) tile.children = [child];
      child = tile;
    }
    leaf = child!;
  } else {
    throw new Error("Nothing to export: import a mesh or point cloud first.");
  }

  leaf.transform = [...transform];
  const rootError = Math.max(leaf.geometricError, bboxDiagonal(bbox) * (options.lodLevels > 1 ? 0.5 : 0.01));
  const tileset = {
    asset: { version: "1.1", generator: "GeoLibre 3D Tiles pipeline" },
    geometricError: rootError,
    root: leaf,
  };
  files.unshift({ path: "tileset.json", bytes: new TextEncoder().encode(padJson(tileset)) });
  const west = region[0] * (180 / Math.PI);
  const south = region[1] * (180 / Math.PI);
  const east = region[2] * (180 / Math.PI);
  const north = region[3] * (180 / Math.PI);
  return { files, bounds: [west, south, east, north], geometricError: rootError };
}

/** Read a geographic WGS84 bbox from a tileset.json `region` volume, if present. */
export function tilesetGeographicBounds(tilesetJson: string): [number, number, number, number] | null {
  try {
    const doc = JSON.parse(tilesetJson) as { root?: { boundingVolume?: { region?: number[] } } };
    const region = doc.root?.boundingVolume?.region;
    if (!Array.isArray(region) || region.length < 4) return null;
    const toDeg = 180 / Math.PI;
    return [region[0] * toDeg, region[1] * toDeg, region[2] * toDeg, region[3] * toDeg];
  } catch {
    return null;
  }
}

/** Rewrite relative `uri` fields anywhere in a tileset JSON to absolute URLs. */
export function rewriteTilesetUris(tilesetJson: string, resolve: (relative: string) => string): string {
  const doc = JSON.parse(tilesetJson) as unknown;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const rec = node as Record<string, unknown>;
    if (typeof rec.uri === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(rec.uri) && !rec.uri.startsWith("data:")) {
      rec.uri = resolve(rec.uri);
    }
    for (const value of Object.values(rec)) walk(value);
  };
  walk(doc);
  return padJson(doc);
}
