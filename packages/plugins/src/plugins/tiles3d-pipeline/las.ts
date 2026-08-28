/**
 * ASPRS LAS 1.2 / 1.4 reader (uncompressed). LAZ is rejected with a clear
 * error — decompressing it needs a WASM codec that this pipeline does not
 * bundle. Scale/offset are applied so positions come back in the file's CRS
 * units (typically meters).
 */

import { computeBBox } from "./mesh";
import type { PointCloudData } from "./types";

const decoder = new TextDecoder("ascii");

export class LasParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LasParseError";
  }
}

function readCString(bytes: Uint8Array, offset: number, length: number): string {
  const slice = bytes.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end)).trim();
}

/**
 * Parse an uncompressed LAS file into a point cloud. RGB is read when the
 * point record format carries it (2, 3, 5, 7, 8, 10).
 */
export function parseLas(bytes: Uint8Array, maxPoints = 2_000_000): PointCloudData {
  if (bytes.byteLength < 227) throw new LasParseError("File is too small to be LAS.");
  if (readCString(bytes, 0, 4) !== "LASF") throw new LasParseError("Not a LAS file (missing LASF signature).");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = bytes[24];
  const minor = bytes[25];
  if (major !== 1 || minor > 4) {
    throw new LasParseError(`Unsupported LAS version ${major}.${minor}.`);
  }
  const headerSize = dv.getUint16(94, true);
  const offsetToPoints = dv.getUint32(96, true);
  const format = bytes[104];
  const recordLength = dv.getUint16(105, true);
  let count = dv.getUint32(107, true);
  if (count === 0 && headerSize >= 255 && bytes.byteLength >= 255) {
    const n64 = dv.getBigUint64(247, true);
    count = Number(n64 > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : n64);
  }
  if (recordLength === 0) throw new LasParseError("LAS point record length is 0.");
  const scaleX = dv.getFloat64(131, true);
  const scaleY = dv.getFloat64(139, true);
  const scaleZ = dv.getFloat64(147, true);
  const offX = dv.getFloat64(155, true);
  const offY = dv.getFloat64(163, true);
  const offZ = dv.getFloat64(171, true);

  const available = Math.max(0, Math.floor((bytes.byteLength - offsetToPoints) / recordLength));
  const n = Math.min(count || available, available, maxPoints);
  if (n <= 0) throw new LasParseError("LAS file contains no point records.");

  const hasRgb = format === 2 || format === 3 || format === 5 || format === 7 || format === 8 || format === 10;
  const rgbOffset = format <= 5 ? 20 : 30;
  const positions = new Float32Array(n * 3);
  const colors = hasRgb ? new Uint8Array(n * 3) : undefined;
  const step = count > n ? count / n : 1;
  let written = 0;
  for (let i = 0; i < n; i++) {
    const recordIndex = Math.min(available - 1, Math.floor(i * step));
    const at = offsetToPoints + recordIndex * recordLength;
    if (at + 12 > bytes.byteLength) break;
    const x = dv.getInt32(at, true) * scaleX + offX;
    const y = dv.getInt32(at + 4, true) * scaleY + offY;
    const z = dv.getInt32(at + 8, true) * scaleZ + offZ;
    positions[written * 3] = x;
    positions[written * 3 + 1] = y;
    positions[written * 3 + 2] = z;
    if (colors && at + rgbOffset + 6 <= bytes.byteLength) {
      // LAS RGB is 16-bit; keep the high byte so 8-bit viewers stay in range.
      colors[written * 3] = dv.getUint16(at + rgbOffset, true) >> 8;
      colors[written * 3 + 1] = dv.getUint16(at + rgbOffset + 2, true) >> 8;
      colors[written * 3 + 2] = dv.getUint16(at + rgbOffset + 4, true) >> 8;
    }
    written++;
  }
  const used = positions.subarray(0, written * 3);
  return {
    positions: used.length === positions.length ? positions : new Float32Array(used),
    colors: colors ? colors.subarray(0, written * 3) : undefined,
    bbox: computeBBox(used),
  };
}

export function isLaz(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 10) return false;
  // LAZ files still start with LASF but carry compressed point data; the
  // lazperf/laszip marker lives in a VLRs. A cheap sniff: "laz" in the
  // generating software or the first VLR user id "laszip encoded".
  const header = decoder.decode(bytes.subarray(0, Math.min(bytes.byteLength, 375))).toLowerCase();
  return header.includes("laszip") || header.includes("lazperf");
}

/**
 * Voxel downsample a point cloud. `cell` is the grid size in the same units as
 * the positions. One representative point (the first in the cell) is kept.
 */
export function voxelDownsample(cloud: PointCloudData, cell: number): PointCloudData {
  if (cell <= 0) return cloud;
  const inv = 1 / cell;
  const seen = new Map<string, number>();
  const positions: number[] = [];
  const colors: number[] = [];
  const n = cloud.positions.length / 3;
  for (let i = 0; i < n; i++) {
    const x = cloud.positions[i * 3];
    const y = cloud.positions[i * 3 + 1];
    const z = cloud.positions[i * 3 + 2];
    const key = `${Math.floor(x * inv)}:${Math.floor(y * inv)}:${Math.floor(z * inv)}`;
    if (seen.has(key)) continue;
    seen.set(key, positions.length / 3);
    positions.push(x, y, z);
    if (cloud.colors) colors.push(cloud.colors[i * 3], cloud.colors[i * 3 + 1], cloud.colors[i * 3 + 2]);
  }
  const pos = new Float32Array(positions);
  return {
    positions: pos,
    colors: cloud.colors ? new Uint8Array(colors) : undefined,
    bbox: computeBBox(pos),
  };
}

/** Encode a point cloud as 3D Tiles 1.0 PNTS (POSITION + optional RGB). */
export function writePnts(cloud: PointCloudData): Uint8Array {
  const n = cloud.positions.length / 3;
  const positionBytes = new Uint8Array(cloud.positions.buffer, cloud.positions.byteOffset, cloud.positions.byteLength);
  const rgb = cloud.colors;
  const rgbPadded = rgb ? padTo(rgb, 8) : new Uint8Array(0);
  const posPadded = padTo(positionBytes, 8);
  const feature: Record<string, unknown> = {
    POINTS_LENGTH: n,
    POSITION: { byteOffset: 0 },
  };
  if (rgb) feature.RGB = { byteOffset: posPadded.length };
  const json = padTo(new TextEncoder().encode(JSON.stringify(feature)), 8);
  const featureBin = new Uint8Array(posPadded.length + rgbPadded.length);
  featureBin.set(posPadded);
  if (rgb) featureBin.set(rgbPadded, posPadded.length);
  const header = 28;
  const total = header + json.length + featureBin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode("pnts"), 0);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, json.length, true);
  dv.setUint32(16, featureBin.length, true);
  dv.setUint32(20, 0, true);
  dv.setUint32(24, 0, true);
  out.set(json, 28);
  out.set(featureBin, 28 + json.length);
  return out;
}

function padTo(bytes: Uint8Array, align: number): Uint8Array {
  const pad = (align - (bytes.length % align)) % align;
  const out = new Uint8Array(bytes.length + pad);
  out.set(bytes);
  return out;
}
