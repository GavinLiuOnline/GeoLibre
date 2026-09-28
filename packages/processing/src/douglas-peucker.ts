/**
 * editor/core · optimizer/douglasPeucker —— Douglas-Peucker 抽稀（纯函数）
 *
 * - 距离度量：度平面空间（经度按参考纬度 cos 缩放，保证东西向距离近似一致）
 * - 抽稀保序，首尾点必保留；容差 ≤0 时原样返回副本
 * - 闭合环（Polygon ring）先按开环抽稀，再补闭合点；结果不足以构成有效环时返回原始环
 */
import type { GeoJSONPosition } from '@geolibre/gis-shared';

/** 对开坐标序列做 Douglas-Peucker 抽稀（首尾必保留） */
export function simplifyPositions(positions: GeoJSONPosition[], toleranceDeg: number): GeoJSONPosition[] {
  const n = positions.length;
  if (n <= 2 || !(toleranceDeg > 0)) return positions.map((p) => [...p] as GeoJSONPosition);

  // 经度缩放系数：用全序列平均纬度，避免高纬度时东西向距离被高估
  let latSum = 0;
  for (const p of positions) latSum += p[1];
  const refLat = latSum / n;
  const lonScale = Math.max(Math.cos((refLat * Math.PI) / 180), 0.01);

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  // 显式栈代替递归，避免长线段深递归
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop() as [number, number];
    if (end - start < 2) continue;
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const dist = perpendicularDistance(positions[i], positions[start], positions[end], lonScale);
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }
    if (maxDist > toleranceDeg && maxIdx > 0) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }

  return positions.filter((_, i) => keep[i] === 1).map((p) => [...p] as GeoJSONPosition);
}

/** 对闭合环抽稀（首尾相同视为闭合）；结果不足以构成有效环（<4 点）时返回原始环副本 */
export function simplifyRing(ring: GeoJSONPosition[], toleranceDeg: number): GeoJSONPosition[] {
  const closed = ring.length >= 4 && samePosition(ring[0], ring[ring.length - 1]);
  if (!closed) return simplifyPositions(ring, toleranceDeg);

  const interior = ring.slice(0, -1);
  if (interior.length <= 3 || !(toleranceDeg > 0)) {
    return ring.map((p) => [...p] as GeoJSONPosition);
  }
  const simplified = simplifyPositions(interior, toleranceDeg);
  if (simplified.length < 3) {
    // 无法再简化为有效环，保持原状
    return ring.map((p) => [...p] as GeoJSONPosition);
  }
  return [...simplified, simplified[0]];
}

function samePosition(a: GeoJSONPosition, b: GeoJSONPosition): boolean {
  return a[0] === b[0] && a[1] === b[1] && (a[2] ?? 0) === (b[2] ?? 0);
}

/** 点到线段的垂线距离（度平面，经度已按 lonScale 缩放） */
function perpendicularDistance(
  p: GeoJSONPosition,
  a: GeoJSONPosition,
  b: GeoJSONPosition,
  lonScale: number,
): number {
  const px = p[0] * lonScale;
  const py = p[1];
  const ax = a[0] * lonScale;
  const ay = a[1];
  const bx = b[0] * lonScale;
  const by = b[1];
  const dx = bx - ax;
  const dy = by - ay;

  if (dx === 0 && dy === 0) {
    return Math.hypot(px - ax, py - ay);
  }
  // 叉积 / 底边长度
  return Math.abs((px - ax) * dy - (py - ay) * dx) / Math.hypot(dx, dy);
}
