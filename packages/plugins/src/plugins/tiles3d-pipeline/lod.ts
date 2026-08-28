/**
 * Build a REPLACE-refined LOD pyramid: each coarser level is a clustered mesh
 * or voxel-downsampled point cloud covering the same volume, with geometricError
 * derived from the local AABB diagonal.
 */

import { clusterMesh, triangleCount, vertexCount } from "./mesh";
import { voxelDownsample } from "./las";
import { bboxDiagonal } from "./transforms";
import type { MeshData, OptimizeOptions, PointCloudData } from "./types";

export interface LodMeshLevel {
  level: number;
  mesh: MeshData;
  geometricError: number;
}

export interface LodPointsLevel {
  level: number;
  points: PointCloudData;
  geometricError: number;
}

function cellsForReduction(reduction: number, levels: number, level: number): number {
  // Finest level uses a dense grid; each coarser level halves the cell count.
  const finest = Math.max(4, Math.round(64 * Math.sqrt(Math.max(reduction, 0.05))));
  return Math.max(4, Math.round(finest / 2 ** level));
}

function voxelForReduction(diagonal: number, reduction: number, level: number): number {
  const base = Math.max(diagonal / 200, 1e-3) / Math.max(reduction, 0.05);
  return base * 2 ** level;
}

/** Mesh LOD, finest-first. Level 0 is the (optionally reduced) source. */
export function buildMeshLod(mesh: MeshData, options: OptimizeOptions): LodMeshLevel[] {
  const levels = Math.max(1, Math.min(8, Math.round(options.lodLevels)));
  const diagonal = bboxDiagonal(mesh.bbox);
  const out: LodMeshLevel[] = [];
  let current = mesh;
  if (options.reduction < 1) {
    current = clusterMesh(current, cellsForReduction(options.reduction, levels, 0));
  }
  for (let level = 0; level < levels; level++) {
    const data = level === 0 ? current : clusterMesh(mesh, cellsForReduction(options.reduction, levels, level));
    out.push({
      level,
      mesh: data,
      geometricError: level === 0 ? 0 : diagonal * 0.25 * 2 ** (level - 1),
    });
  }
  return out;
}

/** Point-cloud LOD, finest-first. */
export function buildPointLod(points: PointCloudData, options: OptimizeOptions): LodPointsLevel[] {
  const levels = Math.max(1, Math.min(8, Math.round(options.lodLevels)));
  const diagonal = bboxDiagonal(points.bbox);
  const out: LodPointsLevel[] = [];
  for (let level = 0; level < levels; level++) {
    const cell = voxelForReduction(diagonal, options.reduction, level);
    const data = level === 0 && options.reduction >= 1 ? points : voxelDownsample(points, cell);
    out.push({
      level,
      points: data,
      geometricError: level === 0 ? 0 : diagonal * 0.25 * 2 ** (level - 1),
    });
  }
  return out;
}

export function meshLodStats(levels: readonly LodMeshLevel[]) {
  return levels.map((level) => ({
    level: level.level,
    vertices: vertexCount(level.mesh),
    triangles: triangleCount(level.mesh),
    geometricError: level.geometricError,
  }));
}

export function pointLodStats(levels: readonly LodPointsLevel[]) {
  return levels.map((level) => ({
    level: level.level,
    vertices: level.points.positions.length / 3,
    triangles: 0,
    geometricError: level.geometricError,
  }));
}
