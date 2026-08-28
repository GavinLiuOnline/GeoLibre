/**
 * Local / projected CRS → WGS84 for engineering drawings and RTK-surveyed sites.
 *
 * CAD and handheld RTK typically store metres in a Gauss-Kruger or UTM grid
 * (CGCS2000, Beijing 1954, WGS84). The model origin is either the projected
 * coordinate of local (0,0,0), or the vertices themselves are already easting /
 * northing. Either way we invert to longitude / latitude for Placement.
 */

import proj4 from "proj4";
import type { LocalCrsSettings, Placement } from "./types";
import { DEFAULT_LOCAL_CRS, DEFAULT_PLACEMENT } from "./types";
import { normalizePlacement } from "./transforms";

export const WEB_MERCATOR_PROJ4 =
  "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +no_defs";

/** Albers equal-area conic commonly used for China (standard parallels 25°/47°, CM 105°E). */
export const CHINA_ALBERS_PROJ4 =
  "+proj=aea +lat_1=25 +lat_2=47 +lat_0=0 +lon_0=105 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs";

/** Approximate Krasovsky 1940 (Beijing 1954) → WGS84 three-parameter shift. */
const KRASS_TO_WGS84 = "15.8,-154.4,-82.3,0,0,0,0";

function gkProj4(ellps: "GRS80" | "WGS84" | "krass", lon0: number, x0: number): string {
  const datum = ellps === "krass" ? ` +towgs84=${KRASS_TO_WGS84}` : "";
  return `+proj=tmerc +lat_0=0 +lon_0=${lon0} +k=1 +x_0=${x0} +y_0=0 +ellps=${ellps}${datum} +units=m +no_defs`;
}

function zoneEasting(zone: number, zoneInEasting: boolean): number {
  return zoneInEasting ? zone * 1_000_000 + 500_000 : 500_000;
}

/** 3° Gauss-Kruger central meridian for zone 25–45 (CM = 3 × zone). */
export function gk3CentralMeridian(zone: number): number {
  return 3 * zone;
}

/** 6° Gauss-Kruger central meridian for zone 13–23 (CM = 6 × zone − 3). */
export function gk6CentralMeridian(zone: number): number {
  return 6 * zone - 3;
}

const PROJ6_NOISE = /\+(?:type\s*=\s*crs|usage\s*=[^\s]+)\b/gi;

/** Drop PROJ 6 tokens (`+type=crs`) that some QGIS/pyproj copies include. */
export function sanitizeProj4(raw: string): string {
  return raw.replace(PROJ6_NOISE, "").replace(/\s+/g, " ").trim();
}

export interface Proj4Param {
  key: string;
  value: string;
  /** Bare flag such as `+no_defs` or `+south`. */
  flag: boolean;
}

const FLAG_KEYS = new Set(["no_defs", "south", "wktext", "over", "no_off", "no_uoff", "geoc", "R_A", "R_V", "R_a", "R_lat_a", "R_lat_g"]);

/** Split a proj4 string into ordered `+key[=value]` tokens. */
export function parseProj4Params(raw: string): Proj4Param[] {
  const cleaned = sanitizeProj4(raw);
  const out: Proj4Param[] = [];
  const re = /\+([A-Za-z][\w.]*)(?:\s*=\s*([^\s+]+))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cleaned))) {
    const key = match[1];
    const value = match[2];
    out.push({
      key,
      value: value ?? "",
      flag: value === undefined || FLAG_KEYS.has(key),
    });
  }
  return out;
}

/** Rebuild a proj4 string from parsed tokens, preserving order. */
export function serializeProj4Params(params: readonly Proj4Param[]): string {
  return params
    .map((param) => (param.flag ? `+${param.key}` : `+${param.key}=${param.value}`))
    .join(" ");
}

export function updateProj4Param(raw: string, key: string, value: string, asFlag = false): string {
  const params = parseProj4Params(raw);
  const index = params.findIndex((param) => param.key.toLowerCase() === key.toLowerCase());
  const next: Proj4Param = { key, value, flag: asFlag };
  if (index >= 0) params[index] = next;
  else params.push(next);
  return serializeProj4Params(params);
}

export function removeProj4Param(raw: string, key: string): string {
  return serializeProj4Params(
    parseProj4Params(raw).filter((param) => param.key.toLowerCase() !== key.toLowerCase()),
  );
}

/** Prefer the pasted proj4 tokens; fall back to the preset-generated definition. */
export function proj4StringForParams(settings: LocalCrsSettings): string {
  const raw = sanitizeProj4(settings.customProj4);
  if (parseProj4Params(raw).length > 0) return raw;
  return proj4FromLocalCrs(settings) || raw;
}

function proj4Param(def: string, key: string): string | null {
  const found = parseProj4Params(def).find((param) => param.key.toLowerCase() === key.toLowerCase());
  if (!found) return null;
  return found.flag ? found.key : found.value;
}

/**
 * Build a proj4 definition for the CRS settings. Returns null for ENU / geodetic
 * origin mode, where longitude and latitude are entered directly.
 */
export function proj4FromLocalCrs(settings: LocalCrsSettings): string | null {
  const zone = Math.round(settings.zone);
  const x0 = zoneEasting(zone, settings.zoneInEasting);
  switch (settings.preset) {
    case "enu":
      return null;
    case "wgs84-utm": {
      const utm = Math.min(60, Math.max(1, zone));
      return `+proj=utm +zone=${utm} +datum=WGS84 +units=m +no_defs`;
    }
    case "web-mercator":
      return WEB_MERCATOR_PROJ4;
    case "albers-china":
      return sanitizeProj4(settings.customProj4) || CHINA_ALBERS_PROJ4;
    case "cgcs2000-gk3":
      return gkProj4("GRS80", gk3CentralMeridian(Math.min(45, Math.max(25, zone))), x0);
    case "cgcs2000-gk6":
      return gkProj4("GRS80", gk6CentralMeridian(Math.min(23, Math.max(13, zone))), x0);
    case "bj54-gk3":
      return gkProj4("krass", gk3CentralMeridian(Math.min(45, Math.max(25, zone))), x0);
    case "bj54-gk6":
      return gkProj4("krass", gk6CentralMeridian(Math.min(23, Math.max(13, zone))), x0);
    case "custom": {
      const def = sanitizeProj4(settings.customProj4);
      return def || null;
    }
    default:
      return null;
  }
}

/** Inverse-project easting / northing (metres) to WGS84 lon/lat. */
export function projectedToLngLat(
  easting: number,
  northing: number,
  settings: LocalCrsSettings,
): { longitude: number; latitude: number } {
  const def = proj4FromLocalCrs(settings);
  if (!def) {
    return { longitude: easting, latitude: northing };
  }
  const [longitude, latitude] = proj4(def, "EPSG:4326", [easting, northing]) as [number, number];
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    throw new Error("The projected coordinates could not be converted to longitude/latitude. Check the CRS, zone, and offsets.");
  }
  return { longitude, latitude };
}

/** Forward-project WGS84 lon/lat to easting / northing (metres). */
export function lngLatToProjected(
  longitude: number,
  latitude: number,
  settings: LocalCrsSettings,
): { easting: number; northing: number } {
  const def = proj4FromLocalCrs(settings);
  if (!def) {
    return { easting: longitude, northing: latitude };
  }
  const [easting, northing] = proj4("EPSG:4326", def, [longitude, latitude]) as [number, number];
  return { easting, northing };
}

/**
 * Convert a model-space point through the local CRS into a geographic Placement.
 * `modelX/Y/Z` is the model origin to pin (usually (0,0,0) or the bbox centre).
 */
export function placementFromLocalCrs(
  settings: LocalCrsSettings,
  modelX = 0,
  modelY = 0,
  modelZ = 0,
  base: Placement = DEFAULT_PLACEMENT,
): Placement {
  if (settings.preset === "enu") {
    return normalizePlacement(base, base);
  }
  const easting = (settings.modelIsProjected ? modelX : 0) + settings.offsetX;
  const northing = (settings.modelIsProjected ? modelY : 0) + settings.offsetY;
  const height = (settings.modelIsProjected ? modelZ : 0) + settings.offsetZ;
  const { longitude, latitude } = projectedToLngLat(easting, northing, settings);
  return normalizePlacement({ ...base, longitude, latitude, height }, base);
}

export function normalizeLocalCrsSettings(value: unknown, base: LocalCrsSettings = DEFAULT_LOCAL_CRS): LocalCrsSettings {
  const c = (value ?? {}) as Partial<LocalCrsSettings>;
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const preset = typeof c.preset === "string" ? c.preset : base.preset;
  const allowed: LocalCrsSettings["preset"][] = [
    "enu",
    "wgs84-utm",
    "web-mercator",
    "albers-china",
    "cgcs2000-gk3",
    "cgcs2000-gk6",
    "bj54-gk3",
    "bj54-gk6",
    "custom",
  ];
  return {
    preset: allowed.includes(preset as LocalCrsSettings["preset"]) ? (preset as LocalCrsSettings["preset"]) : base.preset,
    zone: num(c.zone, base.zone),
    zoneInEasting: typeof c.zoneInEasting === "boolean" ? c.zoneInEasting : base.zoneInEasting,
    offsetX: num(c.offsetX, base.offsetX),
    offsetY: num(c.offsetY, base.offsetY),
    offsetZ: num(c.offsetZ, base.offsetZ),
    customProj4: typeof c.customProj4 === "string" ? c.customProj4 : base.customProj4,
    modelIsProjected: typeof c.modelIsProjected === "boolean" ? c.modelIsProjected : base.modelIsProjected,
  };
}

export interface EpsgCrsHint {
  preset: LocalCrsSettings["preset"];
  zone: number;
  zoneInEasting: boolean;
}

/**
 * Map a well-known Chinese / WGS84 projected EPSG code onto pipeline CRS fields.
 * Returns null when the code is not a Gauss-Kruger / UTM grid we can invert.
 */
export function settingsFromEpsg(code: number): EpsgCrsHint | null {
  if (code >= 4513 && code <= 4533) {
    return { preset: "cgcs2000-gk3", zone: 25 + (code - 4513), zoneInEasting: true };
  }
  if (code >= 4534 && code <= 4554) {
    return { preset: "cgcs2000-gk3", zone: 25 + (code - 4534), zoneInEasting: false };
  }
  if (code >= 4491 && code <= 4501) {
    return { preset: "cgcs2000-gk6", zone: 13 + (code - 4491), zoneInEasting: true };
  }
  if (code >= 4502 && code <= 4512) {
    return { preset: "cgcs2000-gk6", zone: 13 + (code - 4502), zoneInEasting: false };
  }
  if (code >= 21413 && code <= 21423) {
    return { preset: "bj54-gk6", zone: code - 21400, zoneInEasting: true };
  }
  if (code >= 21473 && code <= 21483) {
    return { preset: "bj54-gk6", zone: code - 21460, zoneInEasting: false };
  }
  if (code >= 2401 && code <= 2421) {
    return { preset: "bj54-gk3", zone: 25 + (code - 2401), zoneInEasting: true };
  }
  if (code >= 2422 && code <= 2442) {
    return { preset: "bj54-gk3", zone: 25 + (code - 2422), zoneInEasting: false };
  }
  if (code >= 32601 && code <= 32660) {
    return { preset: "wgs84-utm", zone: code - 32600, zoneInEasting: false };
  }
  if (code === 3857 || code === 900913 || code === 3785 || code === 102100) {
    return { preset: "web-mercator", zone: 0, zoneInEasting: false };
  }
  return null;
}

export function parseEpsgInput(raw: string): number | null {
  const m = raw.trim().match(/^(?:EPSG\s*:\s*)?(\d{4,5})$/i);
  if (!m) return null;
  return Number(m[1]);
}

/**
 * Parse a pasted proj4 string or EPSG code into pipeline CRS fields.
 * Recognises WGS84 UTM (`+proj=utm +zone=50`), Gauss-Kruger `tmerc`, and
 * `EPSG:32650`. Returns null when the text is not a CRS definition yet.
 */
export function parseCrsInput(raw: string): Partial<LocalCrsSettings> | null {
  const text = raw.trim();
  if (!text) return null;
  const epsgMatch = text.match(/EPSG\s*:\s*(\d{4,5})/i);
  const epsg = parseEpsgInput(text) ?? (epsgMatch ? Number(epsgMatch[1]) : null);
  if (epsg) {
    const hint = settingsFromEpsg(epsg);
    if (hint) return { ...hint, customProj4: text };
  }
  const cleaned = sanitizeProj4(text);
  if (!/\+proj\s*=/i.test(cleaned)) return null;

  const proj = (proj4Param(cleaned, "proj") ?? "").toLowerCase();
  if (proj === "merc" || proj === "webmerc" || proj === "mercator") {
    return {
      preset: isSphericalWebMercator(cleaned) ? "web-mercator" : "custom",
      zoneInEasting: false,
      customProj4: cleaned,
    };
  }
  if (proj === "aea" || proj === "leac") {
    const lat1 = Number(proj4Param(cleaned, "lat_1"));
    const lat2 = Number(proj4Param(cleaned, "lat_2"));
    const lon0 = Number(proj4Param(cleaned, "lon_0"));
    const chinaAlbers =
      Math.abs(lat1 - 25) < 0.51 && Math.abs(lat2 - 47) < 0.51 && Math.abs(lon0 - 105) < 0.51;
    return {
      preset: chinaAlbers ? "albers-china" : "custom",
      zoneInEasting: false,
      customProj4: cleaned,
    };
  }
  if (proj === "utm") {
    const zone = Number(proj4Param(cleaned, "zone"));
    if (!Number.isFinite(zone) || zone < 1 || zone > 60) return { preset: "custom", customProj4: cleaned };
    return {
      preset: "wgs84-utm",
      zone,
      zoneInEasting: false,
      customProj4: cleaned,
    };
  }

  if (proj === "tmerc") {
    const lon0 = Number(proj4Param(cleaned, "lon_0"));
    const x0 = Number(proj4Param(cleaned, "x_0") ?? "500000");
    const ellps = (proj4Param(cleaned, "ellps") ?? "").toLowerCase();
    const datum = (proj4Param(cleaned, "datum") ?? "").toLowerCase();
    const krass = ellps === "krass" || datum.includes("54");
    const zoneInEasting = Number.isFinite(x0) && Math.abs(x0) >= 1_000_000;
    let zone = zoneInEasting ? Math.round(Math.abs(x0) / 1_000_000) : NaN;
    let threeDegree = true;
    if (Number.isFinite(lon0)) {
      if (Math.abs(lon0 / 3 - Math.round(lon0 / 3)) < 1e-6) {
        threeDegree = true;
        if (!Number.isFinite(zone)) zone = Math.round(lon0 / 3);
      } else if (Math.abs((lon0 + 3) / 6 - Math.round((lon0 + 3) / 6)) < 1e-6) {
        threeDegree = false;
        if (!Number.isFinite(zone)) zone = Math.round((lon0 + 3) / 6);
      }
    }
    if (!Number.isFinite(zone)) return { preset: "custom", customProj4: cleaned };
    const preset: LocalCrsSettings["preset"] = krass
      ? threeDegree
        ? "bj54-gk3"
        : "bj54-gk6"
      : threeDegree
        ? "cgcs2000-gk3"
        : "cgcs2000-gk6";
    return { preset, zone, zoneInEasting, customProj4: cleaned };
  }

  return { preset: "custom", customProj4: cleaned };
}

function isSphericalWebMercator(def: string): boolean {
  const a = Number(proj4Param(def, "a") ?? "6378137");
  const b = Number(proj4Param(def, "b") ?? String(a));
  const lon0 = Number(proj4Param(def, "lon_0") ?? "0");
  return Math.abs(a - 6378137) < 1 && Math.abs(b - 6378137) < 1 && Math.abs(lon0) < 1e-6;
}

/** Bbox centres tens of kilometres from the origin are already grid easting/northing. */
export function bboxLooksProjected(bbox: { min: [number, number, number]; max: [number, number, number] }): boolean {
  const cx = (bbox.min[0] + bbox.max[0]) / 2;
  const cy = (bbox.min[1] + bbox.max[1]) / 2;
  return Number.isFinite(cx) && Number.isFinite(cy) && Math.hypot(cx, cy) >= 10_000;
}
