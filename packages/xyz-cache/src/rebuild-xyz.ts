/**
 * editor/core · localCache/rebuildXyz —— XYZ 缓存图层「应用设置并重载」（t30 + t37）
 *
 * 用户在属性面板修改坐标系 / 切片模式（web-mercator / geographic / **proj4 任意 CRS**）、
 * TMS（Y 轴翻转）、范围（bounds）后，需要**重建 provider 并重载图层**：Cesium 的
 * ImageryLayer 不支持原地换 provider，这里走「先构建新 provider（失败即中止、旧图层
 * 无损）→ 移除旧图层 → 以**同一图层 id** 重新注册」的路径：
 *
 * - id / 名称 / 可见性 / 不透明度保持不变 → 场景选中态、localCacheRegistry（发布打包）、
 *   generatedXyzLayerUrlMaps（blob URL 释放表）都不需要迁移；
 * - 数据来源（tiles / tileBlobs / urlTemplate + subdomains/token/loadImage/allowFileUrls）
 *   从**旧 provider 实例**原样继承（tiles 模式的 blob URL 仍然有效，直接复用零拷贝）；
 * - 旧 provider 在移除后 dispose()（只释放懒加载对象 URL，tiles 模式无懒加载不受影响）；
 * - 新设置写回 LayerSource.metadata（tilingMode / tms / bounds / **crs**），随场景保存/打开往返。
 *
 * 仅支持 LocalXyzImageryProvider（本地缓存 / 模板 / 生成 XYZ 图层）；其它 provider
 * （如外部 UrlTemplateImageryProvider 底图）给可读错误。
 *
 * t37 CRS 切换语义：
 * - patch.crs 存在（且合法）→ 写 metadata.crs，**移除** tilingMode（互斥）；
 * - patch.crs === null → 显式从 metadata 移除 crs，**回退**到 tilingMode（若无则默认 web-mercator）；
 * - patch.crs 未给 → 保留 metadata.crs。
 */
import type { LayerInfo, LayerManager } from './layer-manager';
import { normalizeBounds } from './bounds';
import type { XyzLayerBounds } from './bounds';
import { normalizeXyzLayerCrs } from './crs-registry';
import type { LocalCacheMetadata, XyzLayerCrs, XyzTilingMode } from './types';
import { LocalXyzImageryProvider } from './xyz-cache';

/** 图层设置修改项（属性面板「应用并重载」提交的补丁） */
export interface XyzLayerSettingsPatch {
  /** 切片模式；缺省 = 保持当前（crs 未给且 tilingMode 未给 → 保持现有） */
  tilingMode?: XyzTilingMode;
  /** TMS（Y 轴翻转）；缺省 = 保持当前 */
  tms?: boolean;
  /**
   * 地理范围 [minLon, minLat, maxLon, maxLat]（度）：
   * - 具体元组 = 应用该范围；
   * - `null` = 清除自定义范围（回退全球/瓦片键推算语义，模板图层即全球）；
   * - `undefined`（缺省）= 保持当前不变。
   */
  bounds?: XyzLayerBounds | null;
  /**
   * proj4 任意投影 CRS（t37）：
   * - 具体对象 = 应用该 CRS（**优先级最高**；移除 tilingMode）；
   * - `null` = 显式清除自定义 CRS（回退到 tilingMode 快路径）；
   * - `undefined`（缺省）= 保持当前 metadata.crs。
   *
   * 当 crs 给定时，bounds（如果用户同时给了）被当作 validBounds 内的请求子范围
   * （与 validBounds 求交；超出则回退 validBounds）。
   */
  crs?: XyzLayerCrs | null;
}

/** 重建结果（除图层快照外给出实际生效的设置，便于 UI 回显） */
export interface RebuildXyzResult {
  layer: LayerInfo;
  tilingMode: XyzTilingMode;
  tms: boolean;
  /** 实际生效的范围；模板/全球图层未设 bounds 时为 undefined */
  bounds?: XyzLayerBounds;
  /** 实际生效的 CRS；未设时 undefined（回退 tilingMode） */
  crs?: XyzLayerCrs;
}

/**
 * 按设置补丁重建 XYZ 缓存图层（原地换 provider，图层 id 不变）。
 *
 * @throws 图层不存在 / 非 XYZ 缓存图层 / provider 不支持重建 / bounds 非法 / crs 不可用
 *         —— 均为可读中文。
 */
export async function rebuildXyzLayer(
  layers: LayerManager,
  layerId: string,
  patch: XyzLayerSettingsPatch = {},
): Promise<RebuildXyzResult> {
  const info = layers.get(layerId);
  if (!info) throw new Error(`图层不存在：${layerId}`);

  const source = layers.getLayerSource(layerId);
  const metadata = (source?.metadata ?? {}) as unknown as LocalCacheMetadata;
  if (metadata.cacheKind !== 'xyz') {
    throw new Error(
      `图层「${info.name}」不是 XYZ 缓存图层，无法修改坐标系/切片方案设置` +
        '（该功能目前仅用于 XYZ 瓦片缓存）',
    );
  }

  const provider = layers.getImageryProvider(layerId);
  if (!(provider instanceof LocalXyzImageryProvider)) {
    throw new Error(`图层「${info.name}」的影像提供者不支持在线重建（非本地 XYZ 缓存提供者）`);
  }

  // ---- 解析补丁（旧值 → 补丁覆盖）----
  // t37：crs 优先；crs === null → 显式清除；crs 给定 → 移除 tilingMode；
  // 否则沿用 metadata.crs；二者皆无则按 tilingMode。
  let crs: XyzLayerCrs | undefined;
  let tilingMode: XyzTilingMode;
  if (patch.crs !== undefined) {
    if (patch.crs === null) {
      crs = undefined;
    } else {
      // normalizeXyzLayerCrs 抛可读中文错误
      crs = normalizeXyzLayerCrs(patch.crs);
    }
  } else if (metadata.crs) {
    crs = normalizeXyzLayerCrs(metadata.crs);
  }
  // tilingMode：crs 给定时强制回退到 web-mercator（写 metadata 时不再写 tilingMode 字段，
  // provider 内部看 crs 决定切片方案）；crs 未给时按补丁/旧值/默认。
  if (crs) {
    tilingMode = patch.tilingMode ?? metadata.tilingMode ?? 'web-mercator';
  } else {
    tilingMode = patch.tilingMode ?? metadata.tilingMode ?? 'web-mercator';
  }
  const tms = patch.tms ?? metadata.tms === true;
  let bounds: XyzLayerBounds | undefined;
  if (patch.bounds === null) {
    bounds = undefined; // 显式清除：模板/全球图层回退 tilingScheme.rectangle
  } else if (patch.bounds !== undefined) {
    const normalized = normalizeBounds(patch.bounds);
    if (!normalized) {
      throw new Error(
        `范围非法：应为 [minLon, minLat, maxLon, maxLat]（min < max，经度 -180~180，纬度 -90~90），` +
          `实际 ${JSON.stringify(patch.bounds)}`,
      );
    }
    bounds = normalized;
  } else {
    bounds = normalizeBounds(metadata.bounds);
  }

  // ---- 先构建新 provider（构造失败 → 旧图层保持原样）----
  let nextProvider: LocalXyzImageryProvider;
  try {
    nextProvider = new LocalXyzImageryProvider({
      ...(provider.tiles.size > 0 ? { tiles: provider.tiles } : {}),
      ...(provider.tileBlobs ? { tileBlobs: provider.tileBlobs } : {}),
      ...(provider.urlTemplate ? { urlTemplate: provider.urlTemplate } : {}),
      ...(provider.subdomains ? { subdomains: provider.subdomains } : {}),
      ...(provider.token !== undefined ? { token: provider.token } : {}),
      ...(provider.loadImage ? { loadImage: provider.loadImage } : {}),
      allowFileUrls: provider.allowFileUrls,
      minLevel: provider.minLevel,
      maxLevel: provider.maxLevel,
      hasAlphaChannel: provider.hasAlphaChannel,
      tilingMode,
      tms,
      ...(bounds ? { bounds } : {}),
      ...(crs ? { crs } : {}),
      // tiles 已在首次注册时校验过协议；重建时不重复校验（blob URL / 大映射代价高）
      validateTileUrls: false,
    });
  } catch (err) {
    throw new Error(
      `重建图层失败：${err instanceof Error ? err.message : String(err)}（旧图层未受影响）`,
    );
  }

  // ---- 元数据：写回新设置（场景保存/打开往返、属性面板回显都读这里）----
  // patch.bounds === null → 显式从 metadata 移除 bounds（保留 metadata 其它字段）；
  // bounds === undefined（缺省或非法/已清除）→ 不写入 bounds 字段。
  const nextMetadata: LocalCacheMetadata = {
    ...metadata,
    tms,
    ...(bounds ? { bounds: [...bounds] as [number, number, number, number] } : {}),
  };
  if (patch.bounds === null) {
    delete nextMetadata.bounds;
  }
  // t37：crs 与 tilingMode 互斥——crs 存在时移除 tilingMode；crs 移除时 tilingMode 保留
  if (crs) {
    nextMetadata.crs = crs;
    delete nextMetadata.tilingMode;
  } else {
    nextMetadata.tilingMode = tilingMode;
    if (patch.crs === null) delete nextMetadata.crs;
  }
  const nextSource = {
    ...(source ?? {}),
    metadata: nextMetadata as unknown as Record<string, unknown>,
  };

  layers.remove(layerId);
  layers.addImageryLayerInstance(info.name, nextProvider, nextSource, {
    id: info.id,
    ...(info.show !== undefined ? { show: info.show } : {}),
    ...(info.opacity !== undefined ? { opacity: info.opacity } : {}),
    maximumLevel: provider.maxLevel,
  });
  // 旧 provider 的懒加载对象 URL 释放（tiles 模式无懒加载，为空操作；tileBlobs/模板幂等）
  provider.dispose();

  return {
    layer: layers.get(info.id) ?? info,
    tilingMode,
    tms,
    ...(bounds ? { bounds } : {}),
    ...(crs ? { crs } : {}),
  };
}

/**
 * 图层是否支持「应用并重载」（属性面板据此显示/隐藏设置区）：
 * XYZ 缓存图层（含模板按需加载图层，cacheKind='xyz'）支持；3D Tiles / 矢量等不支持。
 */
export function supportsXyzRebuild(metadata: Record<string, unknown> | undefined): boolean {
  return (metadata as LocalCacheMetadata | undefined)?.cacheKind === 'xyz';
}