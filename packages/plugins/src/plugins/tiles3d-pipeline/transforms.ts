/**
 * Geographic placement math for the 3D Tiles pipeline: WGS84 ECEF, east-north-up
 * frames, and a 3D similarity (Umeyama) fit from ground control points.
 *
 * Side-effect free so it can be unit tested without a map or DOM.
 */

import type { BBox3, ModelGcp, Placement } from "./types";
import { DEFAULT_PLACEMENT } from "./types";

const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export type Vec3 = [number, number, number];

/** 4×4 matrix stored column-major, matching 3D Tiles `transform`. */
export type Mat4 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** WGS84 geodetic to Earth-centered Earth-fixed meters. */
export function ecefFromLngLatHeight(lng: number, lat: number, height: number): Vec3 {
  const latR = lat * D2R;
  const lngR = lng * D2R;
  const sinLat = Math.sin(latR);
  const cosLat = Math.cos(latR);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return [
    (n + height) * cosLat * Math.cos(lngR),
    (n + height) * cosLat * Math.sin(lngR),
    (n * (1 - E2) + height) * sinLat,
  ];
}

/**
 * Approximate inverse of {@link ecefFromLngLatHeight}. Accurate to millimetres
 * for terrestrial heights; iteration is Bowring's closed-then-one-step form.
 */
export function lngLatHeightFromEcef(x: number, y: number, z: number): {
  longitude: number;
  latitude: number;
  height: number;
} {
  const lng = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  const b = A * (1 - F);
  const theta = Math.atan2(z * A, p * b);
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  const lat = Math.atan2(z + (E2 * A * A) / b * sinT * sinT * sinT, p - E2 * A * cosT * cosT * cosT);
  const sinLat = Math.sin(lat);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const height = p / Math.cos(lat) - n;
  return { longitude: lng * R2D, latitude: lat * R2D, height };
}

/** Identity 4×4. */
export const IDENTITY_MAT4: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major ENU-to-ECEF frame at a geodetic origin (Z-up local). */
export function eastNorthUpToEcef(lng: number, lat: number, height: number): Mat4 {
  const origin = ecefFromLngLatHeight(lng, lat, height);
  const latR = lat * D2R;
  const lngR = lng * D2R;
  const sinLat = Math.sin(latR);
  const cosLat = Math.cos(latR);
  const sinLng = Math.sin(lngR);
  const cosLng = Math.cos(lngR);
  // East
  const ex = -sinLng;
  const ey = cosLng;
  const ez = 0;
  // North
  const nx = -sinLat * cosLng;
  const ny = -sinLat * sinLng;
  const nz = cosLat;
  // Up
  const ux = cosLat * cosLng;
  const uy = cosLat * sinLng;
  const uz = sinLat;
  return [ex, ey, ez, 0, nx, ny, nz, 0, ux, uy, uz, 0, origin[0], origin[1], origin[2], 1];
}

/**
 * glTF Y-up → ENU Z-up: (x, y, z)_gltf → (x, -z, y)_enu.
 * Column-major: first column (1,0,0,0), second (0,0,1,0), third (0,-1,0,0).
 */
export const Y_UP_TO_Z_UP: Mat4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

/** Multiply two column-major 4×4 matrices: `a * b`. */
export function multiplyMat4(a: Mat4, b: Mat4): Mat4 {
  const out = new Array(16) as number[];
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row] * b[col * 4] +
        a[row + 4] * b[col * 4 + 1] +
        a[row + 8] * b[col * 4 + 2] +
        a[row + 12] * b[col * 4 + 3];
    }
  }
  return out as Mat4;
}

/** Transform a point by a column-major 4×4 matrix. */
export function transformPoint(m: Mat4, x: number, y: number, z: number): Vec3 {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

function rotationZyx(headingDeg: number, pitchDeg: number, rollDeg: number): Mat4 {
  const h = headingDeg * D2R;
  const p = pitchDeg * D2R;
  const r = rollDeg * D2R;
  const ch = Math.cos(h);
  const sh = Math.sin(h);
  const cp = Math.cos(p);
  const sp = Math.sin(p);
  const cr = Math.cos(r);
  const sr = Math.sin(r);
  // ZYX intrinsic: heading about Up (Z), then pitch about East (X), then roll about North (Y)
  // applied to a Z-up ENU point. Built as Rz(heading) * Rx(pitch) * Ry(roll).
  const rz: Mat4 = [ch, sh, 0, 0, -sh, ch, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const rx: Mat4 = [1, 0, 0, 0, 0, cp, sp, 0, 0, -sp, cp, 0, 0, 0, 0, 1];
  const ry: Mat4 = [cr, 0, -sr, 0, 0, 1, 0, 0, sr, 0, cr, 0, 0, 0, 0, 1];
  return multiplyMat4(rz, multiplyMat4(rx, ry));
}

function scaleMat4(s: number): Mat4 {
  return [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
}

/**
 * 3D Tiles root transform: local glTF meters → ECEF, via ENU at `placement`.
 * Chain: ECEF ← ENU ← (scale · rotation) ← Y-up-to-Z-up ← glTF.
 */
export function tilesetTransform(placement: Placement, yUp = true): Mat4 {
  const enu = eastNorthUpToEcef(placement.longitude, placement.latitude, placement.height);
  const rot = rotationZyx(placement.heading, placement.pitch, placement.roll);
  const scl = scaleMat4(placement.scale);
  const local = multiplyMat4(rot, scl);
  const withUp = yUp ? multiplyMat4(local, Y_UP_TO_Z_UP) : local;
  return multiplyMat4(enu, withUp);
}

/** Geographic `[west, south, east, north]` of a local AABB under `placement`. */
export function geographicBounds(bbox: BBox3, placement: Placement, yUp = true): [number, number, number, number] {
  const m = tilesetTransform(placement, yUp);
  const corners: Vec3[] = [];
  for (const x of [bbox.min[0], bbox.max[0]]) {
    for (const y of [bbox.min[1], bbox.max[1]]) {
      for (const z of [bbox.min[2], bbox.max[2]]) {
        corners.push(transformPoint(m, x, y, z));
      }
    }
  }
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [x, y, z] of corners) {
    const g = lngLatHeightFromEcef(x, y, z);
    west = Math.min(west, g.longitude);
    east = Math.max(east, g.longitude);
    south = Math.min(south, g.latitude);
    north = Math.max(north, g.latitude);
  }
  return [west, south, east, north];
}

/** Diagonal length of an AABB, used as a default geometricError. */
export function bboxDiagonal(bbox: BBox3): number {
  return Math.hypot(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]);
}

/** Region bounding volume `[west, south, east, north, minHeight, maxHeight]` (radians / meters). */
export function regionBoundingVolume(
  bbox: BBox3,
  placement: Placement,
  yUp = true,
): [number, number, number, number, number, number] {
  const m = tilesetTransform(placement, yUp);
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let minH = Infinity;
  let maxH = -Infinity;
  for (const x of [bbox.min[0], bbox.max[0]]) {
    for (const y of [bbox.min[1], bbox.max[1]]) {
      for (const z of [bbox.min[2], bbox.max[2]]) {
        const [ex, ey, ez] = transformPoint(m, x, y, z);
        const g = lngLatHeightFromEcef(ex, ey, ez);
        west = Math.min(west, g.longitude);
        east = Math.max(east, g.longitude);
        south = Math.min(south, g.latitude);
        north = Math.max(north, g.latitude);
        minH = Math.min(minH, g.height);
        maxH = Math.max(maxH, g.height);
      }
    }
  }
  return [west * D2R, south * D2R, east * D2R, north * D2R, minH, maxH];
}

export interface Similarity3 {
  scale: number;
  rotation: [Vec3, Vec3, Vec3];
  translation: Vec3;
}

function centroid(points: readonly Vec3[]): Vec3 {
  const n = points.length;
  const s: Vec3 = [0, 0, 0];
  for (const p of points) {
    s[0] += p[0];
    s[1] += p[1];
    s[2] += p[2];
  }
  return [s[0] / n, s[1] / n, s[2] / n];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function transpose3(m: [Vec3, Vec3, Vec3]): [Vec3, Vec3, Vec3] {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

function mul3(a: [Vec3, Vec3, Vec3], b: [Vec3, Vec3, Vec3]): [Vec3, Vec3, Vec3] {
  const out: [Vec3, Vec3, Vec3] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return out;
}

function det3(m: [Vec3, Vec3, Vec3]): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

/**
 * Jacobi eigen-decomposition of a symmetric 3×3. Returns eigenvalues and
 * corresponding orthonormal eigenvectors as columns of `vectors`.
 */
function jacobiEigen3(s00: number, s01: number, s02: number, s11: number, s12: number, s22: number): {
  values: Vec3;
  vectors: [Vec3, Vec3, Vec3];
} {
  let a00 = s00;
  let a01 = s01;
  let a02 = s02;
  let a11 = s11;
  let a12 = s12;
  let a22 = s22;
  let v: [Vec3, Vec3, Vec3] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iter = 0; iter < 32; iter++) {
    const off = Math.abs(a01) + Math.abs(a02) + Math.abs(a12);
    if (off < 1e-12) break;
    const rotate = (p: 0 | 1 | 2, q: 0 | 1 | 2, app: number, aqq: number, apq: number) => {
      if (Math.abs(apq) < 1e-18) return;
      const tau = (aqq - app) / (2 * apq);
      const t = Math.abs(tau) < 1e-18 ? 1 : Math.sign(tau) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
      const c = 1 / Math.sqrt(1 + t * t);
      const s = t * c;
      const newV: [Vec3, Vec3, Vec3] = [
        [...v[0]] as Vec3,
        [...v[1]] as Vec3,
        [...v[2]] as Vec3,
      ];
      for (let i = 0; i < 3; i++) {
        const vip = v[i][p];
        const viq = v[i][q];
        newV[i][p] = c * vip - s * viq;
        newV[i][q] = s * vip + c * viq;
      }
      v = newV;
      return { c, s };
    };
    // (0,1)
    {
      const rs = rotate(0, 1, a00, a11, a01);
      if (rs) {
        const { c, s } = rs;
        const a00n = c * c * a00 - 2 * s * c * a01 + s * s * a11;
        const a11n = s * s * a00 + 2 * s * c * a01 + c * c * a11;
        const a02n = c * a02 - s * a12;
        const a12n = s * a02 + c * a12;
        a00 = a00n;
        a11 = a11n;
        a01 = 0;
        a02 = a02n;
        a12 = a12n;
      }
    }
    // (0,2)
    {
      const rs = rotate(0, 2, a00, a22, a02);
      if (rs) {
        const { c, s } = rs;
        const a00n = c * c * a00 - 2 * s * c * a02 + s * s * a22;
        const a22n = s * s * a00 + 2 * s * c * a02 + c * c * a22;
        const a01n = c * a01 - s * a12;
        const a12n = s * a01 + c * a12;
        a00 = a00n;
        a22 = a22n;
        a02 = 0;
        a01 = a01n;
        a12 = a12n;
      }
    }
    // (1,2)
    {
      const rs = rotate(1, 2, a11, a22, a12);
      if (rs) {
        const { c, s } = rs;
        const a11n = c * c * a11 - 2 * s * c * a12 + s * s * a22;
        const a22n = s * s * a11 + 2 * s * c * a12 + c * c * a22;
        const a01n = c * a01 - s * a02;
        const a02n = s * a01 + c * a02;
        a11 = a11n;
        a22 = a22n;
        a12 = 0;
        a01 = a01n;
        a02 = a02n;
      }
    }
  }
  return { values: [a00, a11, a22], vectors: v };
}

/**
 * SVD of a 3×3 matrix via eigen-decomposition of AᵀA. Good enough for the
 * well-conditioned covariance matrices Umeyama produces from GCPs.
 */
function svd3(a: [Vec3, Vec3, Vec3]): { u: [Vec3, Vec3, Vec3]; vt: [Vec3, Vec3, Vec3] } {
  const at: [Vec3, Vec3, Vec3] = transpose3(a);
  const ata = mul3(at, a);
  const { values, vectors } = jacobiEigen3(ata[0][0], ata[0][1], ata[0][2], ata[1][1], ata[1][2], ata[2][2]);
  // Eigenvectors of AᵀA are V (columns). Sort by descending singular value.
  const order = [0, 1, 2].sort((i, j) => Math.abs(values[j]) - Math.abs(values[i]));
  const vCols: Vec3[] = order.map((i) => [vectors[0][i], vectors[1][i], vectors[2][i]]);
  // Orthonormalize in case Jacobi left a small residual.
  const v0 = vCols[0];
  const n0 = norm(v0) || 1;
  const v0n: Vec3 = [v0[0] / n0, v0[1] / n0, v0[2] / n0];
  let v1 = subtract(vCols[1], [v0n[0] * dot(vCols[1], v0n), v0n[1] * dot(vCols[1], v0n), v0n[2] * dot(vCols[1], v0n)]);
  const n1 = norm(v1) || 1;
  const v1n: Vec3 = [v1[0] / n1, v1[1] / n1, v1[2] / n1];
  const v2n = cross(v0n, v1n);
  const v: [Vec3, Vec3, Vec3] = [
    [v0n[0], v1n[0], v2n[0]],
    [v0n[1], v1n[1], v2n[1]],
    [v0n[2], v1n[2], v2n[2]],
  ];
  const sigmas = order.map((i) => Math.sqrt(Math.max(values[i], 0)));
  const av: [Vec3, Vec3, Vec3] = mul3(a, v);
  const uCols: Vec3[] = [0, 1, 2].map((j) => {
    const col: Vec3 = [av[0][j], av[1][j], av[2][j]];
    const s = sigmas[j] > 1e-12 ? sigmas[j] : 1;
    const n = sigmas[j] > 1e-12 ? s : norm(col) || 1;
    return [col[0] / n, col[1] / n, col[2] / n];
  });
  // Ensure a right-handed U.
  const uDet = det3([
    [uCols[0][0], uCols[1][0], uCols[2][0]],
    [uCols[0][1], uCols[1][1], uCols[2][1]],
    [uCols[0][2], uCols[1][2], uCols[2][2]],
  ]);
  if (uDet < 0) {
    uCols[2] = [-uCols[2][0], -uCols[2][1], -uCols[2][2]];
  }
  const u: [Vec3, Vec3, Vec3] = [
    [uCols[0][0], uCols[1][0], uCols[2][0]],
    [uCols[0][1], uCols[1][1], uCols[2][1]],
    [uCols[0][2], uCols[1][2], uCols[2][2]],
  ];
  return { u, vt: transpose3(v) };
}

/**
 * Least-squares 3D similarity (scale + rotation + translation) mapping `src`
 * onto `dst` (Umeyama). Returns null with fewer than 3 points or a degenerate
 * configuration.
 */
export function umeyama(src: readonly Vec3[], dst: readonly Vec3[]): Similarity3 | null {
  if (src.length < 3 || src.length !== dst.length) return null;
  const cs = centroid(src);
  const cd = centroid(dst);
  const srcC = src.map((p) => subtract(p, cs));
  const dstC = dst.map((p) => subtract(p, cd));
  let srcVar = 0;
  const cov: [Vec3, Vec3, Vec3] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const n = src.length;
  for (let i = 0; i < n; i++) {
    srcVar += dot(srcC[i], srcC[i]);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) cov[r][c] += dstC[i][r] * srcC[i][c];
    }
  }
  srcVar /= n;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) cov[r][c] /= n;
  }
  if (srcVar < 1e-18) return null;
  const { u, vt } = svd3(cov);
  let r = mul3(u, vt);
  if (det3(r) < 0) {
    const s3: [Vec3, Vec3, Vec3] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, -1],
    ];
    r = mul3(u, mul3(s3, vt));
  }
  let trace = 0;
  const rt = transpose3(r);
  const rcov = mul3(rt, cov);
  trace = rcov[0][0] + rcov[1][1] + rcov[2][2];
  const scale = trace / srcVar;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const rs: Vec3 = [
    r[0][0] * cs[0] + r[0][1] * cs[1] + r[0][2] * cs[2],
    r[1][0] * cs[0] + r[1][1] * cs[1] + r[1][2] * cs[2],
    r[2][0] * cs[0] + r[2][1] * cs[1] + r[2][2] * cs[2],
  ];
  const translation: Vec3 = [cd[0] - scale * rs[0], cd[1] - scale * rs[1], cd[2] - scale * rs[2]];
  return { scale, rotation: r, translation };
}

export interface GcpFit {
  placement: Placement;
  residualRmsMeters: number;
  residuals: number[];
}

function applySimilarity(s: Similarity3, p: Vec3): Vec3 {
  return [
    s.scale * (s.rotation[0][0] * p[0] + s.rotation[0][1] * p[1] + s.rotation[0][2] * p[2]) + s.translation[0],
    s.scale * (s.rotation[1][0] * p[0] + s.rotation[1][1] * p[1] + s.rotation[1][2] * p[2]) + s.translation[1],
    s.scale * (s.rotation[2][0] * p[0] + s.rotation[2][1] * p[1] + s.rotation[2][2] * p[2]) + s.translation[2],
  ];
}

/**
 * Fit a {@link Placement} from GCPs. One point sets the origin (identity
 * rotation, unit scale). Three or more run Umeyama in ECEF and recover an ENU
 * placement at the geographic centroid. Returns null when the fit is degenerate.
 */
export function fitPlacementFromGcps(gcps: readonly ModelGcp[]): GcpFit | null {
  const usable = gcps.filter(
    (g) =>
      Number.isFinite(g.modelX) &&
      Number.isFinite(g.modelY) &&
      Number.isFinite(g.modelZ) &&
      Number.isFinite(g.longitude) &&
      Number.isFinite(g.latitude) &&
      Number.isFinite(g.height),
  );
  if (usable.length === 0) return null;
  if (usable.length < 3) {
    const g = usable[0];
    return {
      placement: {
        ...DEFAULT_PLACEMENT,
        longitude: g.longitude,
        latitude: g.latitude,
        height: g.height,
      },
      residualRmsMeters: 0,
      residuals: usable.map(() => 0),
    };
  }
  const src: Vec3[] = usable.map((g) => [g.modelX, g.modelY, g.modelZ]);
  const dst: Vec3[] = usable.map((g) => ecefFromLngLatHeight(g.longitude, g.latitude, g.height));
  const sim = umeyama(src, dst);
  if (!sim) return null;
  const residuals = src.map((p, i) => {
    const pred = applySimilarity(sim, p);
    return Math.hypot(pred[0] - dst[i][0], pred[1] - dst[i][1], pred[2] - dst[i][2]);
  });
  const rms = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length);
  const origin = lngLatHeightFromEcef(sim.translation[0], sim.translation[1], sim.translation[2]);
  // Heading from the rotated local +X expressed in the ENU frame at the origin.
  const enu = eastNorthUpToEcef(origin.longitude, origin.latitude, origin.height);
  const east: Vec3 = [enu[0], enu[1], enu[2]];
  const north: Vec3 = [enu[4], enu[5], enu[6]];
  const localX: Vec3 = [sim.rotation[0][0], sim.rotation[1][0], sim.rotation[2][0]];
  const heading = Math.atan2(dot(localX, east), dot(localX, north)) * R2D;
  return {
    placement: {
      longitude: origin.longitude,
      latitude: origin.latitude,
      height: origin.height,
      heading,
      pitch: 0,
      roll: 0,
      scale: sim.scale,
    },
    residualRmsMeters: rms,
    residuals,
  };
}

/** Clamp a placement to finite, in-range values. */
export function normalizePlacement(value: unknown, base: Placement = DEFAULT_PLACEMENT): Placement {
  const c = (value ?? {}) as Partial<Placement>;
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const lng = num(c.longitude, base.longitude);
  const lat = num(c.latitude, base.latitude);
  return {
    longitude: Math.min(180, Math.max(-180, lng)),
    latitude: Math.min(90, Math.max(-90, lat)),
    height: num(c.height, base.height),
    heading: num(c.heading, base.heading),
    pitch: num(c.pitch, base.pitch),
    roll: num(c.roll, base.roll),
    scale: Math.max(1e-9, num(c.scale, base.scale)),
  };
}
