/**
 * ContextCapture / SuperMap / Bentley 3MX oblique-photography metadata.
 *
 * `metadata.xml` (OSGB) and `.3mx` carry the SRS of the local Cartesian frame
 * so a mesh whose vertices are metres from a site origin can be placed on the
 * ellipsoid without picking GCPs.
 */

import type { LocalCrsSettings, Placement } from "./types";
import { DEFAULT_LOCAL_CRS } from "./types";
import { settingsFromEpsg } from "./crs";

export interface ObliqueEnu {
  latitude: number;
  longitude: number;
  height: number;
}

export interface ObliqueMetadata {
  srs: string | null;
  enu: ObliqueEnu | null;
  epsg: number | null;
  proj4: string | null;
  origin: [number, number, number] | null;
}

function xmlTag(text: string, names: readonly string[]): string | null {
  for (const name of names) {
    const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i");
    const match = text.match(re);
    if (match) return match[1].trim();
  }
  return null;
}

function parseOrigin(raw: string | null): [number, number, number] | null {
  if (!raw) return null;
  const parts = raw.split(/[,\s]+/).map((p) => Number(p)).filter((n) => Number.isFinite(n));
  if (parts.length < 2) return null;
  return [parts[0], parts[1], parts[2] ?? 0];
}

function parseEnu(srs: string): ObliqueEnu | null {
  const match = srs.match(/^ENU:\s*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?:\s*,\s*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?))?/i);
  if (!match) return null;
  const a = Number(match[1]);
  const b = Number(match[2]);
  const h = match[3] !== undefined ? Number(match[3]) : 0;
  // ContextCapture writes ENU:lat,lng (latitude first).
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
    return { latitude: a, longitude: b, height: h };
  }
  if (Math.abs(b) <= 90 && Math.abs(a) <= 180) {
    return { latitude: b, longitude: a, height: h };
  }
  return { latitude: a, longitude: b, height: h };
}

function parseEpsg(srs: string): number | null {
  const match = srs.match(/EPSG\s*:\s*(\d{4,5})/i);
  return match ? Number(match[1]) : null;
}

function parseProj4(srs: string): string | null {
  const trimmed = srs.trim();
  if (trimmed.includes("+proj=")) return trimmed;
  return null;
}

/**
 * Parse a ContextCapture `metadata.xml`, Bentley `.3mx`, or similar SRS blob.
 */
export function parseObliqueMetadata(text: string): ObliqueMetadata {
  const srs = xmlTag(text, ["SRS", "Srs", "srs", "SpatialReference"]) ?? text.trim();
  const origin = parseOrigin(
    xmlTag(text, ["SRSOrigin", "SrsOrigin", "Origin", "origin", "SRSORIGIN"]),
  );
  const enu = srs ? parseEnu(srs) : null;
  const epsg = srs ? parseEpsg(srs) : null;
  const proj4 = srs && !enu && !epsg ? parseProj4(srs) : null;
  return {
    srs: srs || null,
    enu,
    epsg,
    proj4,
    origin,
  };
}

/** Apply parsed metadata onto placement + CRS fields. */
export function applyObliqueMetadata(
  meta: ObliqueMetadata,
  placement: Placement,
  crs: LocalCrsSettings,
): { placement: Placement; crs: LocalCrsSettings; applied: "enu" | "projected" | null } {
  if (meta.enu) {
    return {
      placement: {
        ...placement,
        longitude: meta.enu.longitude,
        latitude: meta.enu.latitude,
        height: meta.enu.height,
      },
      crs: { ...crs, preset: "enu" },
      applied: "enu",
    };
  }
  const next: LocalCrsSettings = { ...crs };
  let canProject = false;
  if (meta.epsg) {
    const hint = settingsFromEpsg(meta.epsg);
    if (hint) {
      next.preset = hint.preset;
      next.zone = hint.zone;
      next.zoneInEasting = hint.zoneInEasting;
      canProject = true;
    }
  } else if (meta.proj4) {
    next.preset = "custom";
    next.customProj4 = meta.proj4;
    canProject = true;
  } else if (!meta.origin) {
    return { placement, crs, applied: null };
  }
  if (meta.origin) {
    next.offsetX = meta.origin[0];
    next.offsetY = meta.origin[1];
    next.offsetZ = meta.origin[2];
    next.modelIsProjected = false;
  }
  return { placement, crs: next, applied: canProject ? "projected" : null };
}

export function emptyObliqueMetadata(): ObliqueMetadata {
  return { srs: null, enu: null, epsg: null, proj4: null, origin: null };
}

/** Default CRS used when metadata only names an EPSG we already mapped. */
export function crsFromMetadata(meta: ObliqueMetadata): LocalCrsSettings {
  return applyObliqueMetadata(meta, { longitude: 0, latitude: 0, height: 0, heading: 0, pitch: 0, roll: 0, scale: 1 }, { ...DEFAULT_LOCAL_CRS }).crs;
}
