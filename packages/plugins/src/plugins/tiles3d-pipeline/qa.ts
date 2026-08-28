/**
 * Quality-assurance report for a pipeline run: counts, geographic extent,
 * registration residuals, LOD pyramid stats, and actionable warnings.
 */

import { triangleCount, vertexCount } from "./mesh";
import { buildMeshLod, buildPointLod, meshLodStats, pointLodStats } from "./lod";
import { geographicBounds } from "./transforms";
import type { ImportedScene, OptimizeOptions, Placement, QaIssue, QaReport } from "./types";
import { sceneIsYUp } from "./types";

export function buildQaReport(
  scene: ImportedScene,
  placement: Placement,
  options: OptimizeOptions,
  gcpCount: number,
  residualRmsMeters: number | null,
): QaReport {
  const issues: QaIssue[] = [];
  const yUp = sceneIsYUp(scene.sourceFormat);
  const bbox = scene.kind === "mesh" ? scene.mesh!.bbox : scene.points!.bbox;
  const bounds = geographicBounds(bbox, placement, yUp);

  if (Math.abs(placement.longitude) < 1e-9 && Math.abs(placement.latitude) < 1e-9 && gcpCount === 0) {
    issues.push({
      level: "warning",
      code: "origin-unset",
      message: "Origin is still (0, 0). Apply a local CRS or GCPs so the data does not appear in the Atlantic.",
    });
  }
  if (scene.kind === "mesh" && scene.triangleCount === 0) {
    issues.push({ level: "error", code: "empty-mesh", message: "The mesh has no triangles." });
  }
  if (scene.kind === "points" && scene.vertexCount === 0) {
    issues.push({ level: "error", code: "empty-points", message: "The point cloud has no points." });
  }
  if (scene.kind === "mesh" && !scene.originalGlb && scene.sourceFormat === "glb") {
    issues.push({
      level: "info",
      code: "untextured-lod",
      message: "LOD children are re-encoded without materials. The finest level keeps the original GLB when reduction is 100% and LOD levels is 1.",
    });
  }
  if (residualRmsMeters !== null && residualRmsMeters > 5) {
    issues.push({
      level: "warning",
      code: "high-residual",
      message: `GCP residual RMS is ${residualRmsMeters.toFixed(2)} m. Check that model and map points refer to the same features.`,
    });
  }
  if (options.lodLevels > 1 && options.reduction >= 1 && scene.kind === "mesh") {
    issues.push({
      level: "info",
      code: "lod-from-cluster",
      message: "Coarser LOD levels are built by vertex clustering. Lower Reduction to also thin the finest level.",
    });
  }

  const lodLevels =
    scene.kind === "mesh" && scene.mesh
      ? meshLodStats(buildMeshLod(scene.mesh, options))
      : scene.points
        ? pointLodStats(buildPointLod(scene.points, options))
        : [];

  return {
    name: scene.name,
    kind: scene.kind,
    sourceFormat: scene.sourceFormat,
    vertexCount: scene.kind === "mesh" && scene.mesh ? vertexCount(scene.mesh) : scene.vertexCount,
    triangleCount: scene.kind === "mesh" && scene.mesh ? triangleCount(scene.mesh) : 0,
    bbox,
    geographicBounds: bounds,
    placement,
    gcpCount,
    residualRmsMeters,
    lodLevels,
    issues,
  };
}
