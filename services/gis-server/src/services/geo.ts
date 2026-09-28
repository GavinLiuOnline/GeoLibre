/**
 * 地理坐标工具：WGS84 ENU（East-North-Up）局部坐标系 → ECEF 的 4x4 变换矩阵。
 * 用于为 GLB 生成 3D Tiles tileset.json 的 tile transform（列主序，与 3D Tiles/Cesium 一致）。
 */

const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * 生成 ENU→ECEF 列主序 4x4 矩阵。
 * @param lonDeg 经度（度）
 * @param latDeg 纬度（度）
 * @param heightM 高程（米，椭球面以上）
 * @param rotateZDeg 绕 up 轴的旋转（度，顺时针为正，可选）
 * @param scaleUniform 等比缩放因子（可选，默认 1）
 */
export function enuToFixedFrame(
  lonDeg: number,
  latDeg: number,
  heightM: number,
  rotateZDeg = 0,
  scaleUniform = 1,
): number[] {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;

  // 椭球面点（WGS84）
  const e2 = 2 * WGS84_F - WGS84_F * WGS84_F; // 第一偏心率平方
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const primeVertical = WGS84_A / Math.sqrt(1 - e2 * sinLat * sinLat);
  const ox = (primeVertical + heightM) * cosLat * Math.cos(lon);
  const oy = (primeVertical + heightM) * cosLat * Math.sin(lon);
  const oz = (primeVertical * (1 - e2) + heightM) * sinLat;

  // 局部坐标轴
  const up: [number, number, number] = [cosLat * Math.cos(lon), cosLat * Math.sin(lon), sinLat];
  const east: [number, number, number] = [-Math.sin(lon), Math.cos(lon), 0];
  const north = cross(up, east); // up × east = north

  // 应用绕 up 轴旋转与等比缩放
  const theta = (rotateZDeg * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const s = scaleUniform;
  const e: number[] = [(cosT * east[0] - sinT * north[0]) * s, (cosT * east[1] - sinT * north[1]) * s, (cosT * east[2] - sinT * north[2]) * s];
  const n: number[] = [(sinT * east[0] + cosT * north[0]) * s, (sinT * east[1] + cosT * north[1]) * s, (sinT * east[2] + cosT * north[2]) * s];
  const u: number[] = [up[0] * s, up[1] * s, up[2] * s];

  // 列主序：east / north / up / origin
  return [e[0], e[1], e[2], 0, n[0], n[1], n[2], 0, u[0], u[1], u[2], 0, ox, oy, oz, 1];
}
