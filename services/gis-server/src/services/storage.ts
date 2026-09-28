/**
 * 文件存储服务：无数据库，全部状态落盘。
 *
 * data/
 * ├─ scenes/<sceneId>.json     场景文档
 * ├─ assets/<assetId>/<file>   上传资产（glb/gltf/geojson/json/kml/zip）
 * ├─ published/<slug>/         发布包（含 manifest.json）
 * └─ tmp/                      上传临时目录
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SCENE_FORMAT_VERSION,
  type AssetUploadResult,
  type GeoJSONData,
  type PublishManifest,
  type SceneCamera,
  type SceneDocument,
  type SceneLayerType,
  type SceneSummary,
} from '@geolibre/gis-shared';

import { HttpError } from '../util/http.js';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
/** server 包根目录（dist/services → 上两级；tsx 运行 src/services 同样成立） */
const serverRoot = path.resolve(thisDir, '..', '..');

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(serverRoot, 'data');
export const SCENES_DIR = path.join(DATA_DIR, 'scenes');
export const ASSETS_DIR = path.join(DATA_DIR, 'assets');
export const PUBLISHED_DIR = path.join(DATA_DIR, 'published');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');

export function ensureDataDirs(): void {
  for (const dir of [DATA_DIR, SCENES_DIR, ASSETS_DIR, PUBLISHED_DIR, TMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// id / 名称合法性
// ---------------------------------------------------------------------------

const SAFE_ID_RE = /^[\w][\w.-]{0,127}$/;

/** 场景 id / 资产 id：只允许字母数字与 - _ . ，防止路径穿越 */
export function assertSafeId(id: string, label = 'id'): void {
  if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) {
    throw new HttpError(400, `非法的 ${label}: ${String(id)}`);
  }
}

/** slug：URL 友好目录名 */
export function assertSafeSlug(slug: string): void {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) {
    throw new HttpError(500, `非法的发布目录名: ${String(slug)}`);
  }
}

/** 清理上传文件名：去路径、去危险字符，保留中文/字母/数字/._- */
export function sanitizeFilename(name: string): string {
  const base = path.basename(String(name ?? 'file')).trim();
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').replace(/^\.+/, '');
  return cleaned || 'file';
}

// ---------------------------------------------------------------------------
// 场景文档校验与规范化
// ---------------------------------------------------------------------------

const LAYER_TYPES: readonly SceneLayerType[] = [
  'imagery',
  'terrain',
  'geojson',
  'kml',
  'glb',
  '3dtiles',
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 校验并规范化场景文档（不抛出时返回可直接落盘的文档） */
export function normalizeSceneDocument(raw: unknown, id?: string): SceneDocument {
  if (!isPlainObject(raw)) {
    throw new HttpError(400, '场景文档必须是 JSON 对象');
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) throw new HttpError(400, '场景文档缺少有效字段 name（非空字符串）');

  if (raw.layers !== undefined && !Array.isArray(raw.layers)) {
    throw new HttpError(400, '字段 layers 必须为数组');
  }

  const layers = (raw.layers ?? []).map((item, index): SceneDocument['layers'][number] => {
    if (!isPlainObject(item)) throw new HttpError(400, `layers[${index}] 必须为对象`);
    const type = item.type as SceneLayerType;
    if (!LAYER_TYPES.includes(type)) {
      throw new HttpError(400, `layers[${index}].type 非法: ${String(item.type)}`);
    }
    if (!isPlainObject(item.source)) throw new HttpError(400, `layers[${index}].source 必须为对象`);
    const source = item.source as unknown as SceneDocument['layers'][number]['source'];
    if (!['inline', 'url', 'assetId'].includes(source.kind)) {
      throw new HttpError(400, `layers[${index}].source.kind 非法: ${String(source.kind)}`);
    }
    return {
      id: typeof item.id === 'string' && item.id ? item.id : randomUUID(),
      name: typeof item.name === 'string' && item.name ? item.name : `图层 ${index + 1}`,
      type,
      source,
      style: isPlainObject(item.style) ? item.style : undefined,
      projection: isPlainObject(item.projection) ? item.projection : undefined,
      position: isPlainObject(item.position) ? item.position : undefined,
      features: item.features,
      // 编辑器扩展元数据（本地缓存图层的 cacheKind / files / template 等）原样保存，
      // 场景包发布会把它一并写入托管版 SceneDocument（见 publishPackage.rewriteHostedScene）。
      metadata: isPlainObject(item.metadata) ? item.metadata : undefined,
    } as SceneDocument['layers'][number];
  });

  return {
    version: typeof raw.version === 'number' ? raw.version : SCENE_FORMAT_VERSION,
    id,
    name,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    camera: isPlainObject(raw.camera) ? (raw.camera as unknown as SceneCamera) : undefined,
    layers,
    features: (raw.features ?? undefined) as GeoJSONData | undefined,
    metadata: isPlainObject(raw.metadata) ? raw.metadata : undefined,
    // 底图状态（t19 顶层字段）：编辑器「底图管理」的注册表快照 + 激活项。
    // t22 前服务端只白名单透传已知字段，会丢弃顶层 basemap，编辑器只能把同一份数据
    // 镜像到 metadata.basemap 兜底；现在与其它顶层可选字段同款守卫显式透传，
    // 镜像写法的场景仍原样保留（向后兼容，见 storage.test.ts）。
    basemap: isPlainObject(raw.basemap) ? (raw.basemap as unknown as SceneDocument['basemap']) : undefined,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
  };
}

// ---------------------------------------------------------------------------
// 场景 CRUD（文件存储）
// ---------------------------------------------------------------------------

function sceneFile(sceneId: string): string {
  assertSafeId(sceneId, '场景 id');
  return path.join(SCENES_DIR, `${sceneId}.json`);
}

function writeSceneDocument(doc: SceneDocument): void {
  fs.writeFileSync(path.join(SCENES_DIR, `${doc.id}.json`), JSON.stringify(doc, null, 2), 'utf8');
}

export function listScenes(): SceneSummary[] {
  ensureDataDirs();
  const summaries: SceneSummary[] = [];
  for (const entry of fs.readdirSync(SCENES_DIR)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(SCENES_DIR, entry), 'utf8')) as SceneDocument;
      summaries.push({
        id: doc.id ?? entry.replace(/\.json$/, ''),
        name: doc.name,
        description: doc.description,
        layerCount: Array.isArray(doc.layers) ? doc.layers.length : 0,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt ?? doc.createdAt,
        createdBy: doc.createdBy,
        updatedBy: doc.updatedBy,
      });
    } catch (err) {
      console.warn(`[storage] 跳过无法解析的场景文件 ${entry}:`, err);
    }
  }
  summaries.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return summaries;
}

export function getScene(sceneId: string): SceneDocument {
  const file = sceneFile(sceneId);
  if (!fs.existsSync(file)) {
    throw new HttpError(404, `场景不存在: ${sceneId}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SceneDocument;
  } catch (err) {
    throw new HttpError(500, `场景文档损坏: ${sceneId}`);
  }
}

export function sceneExists(sceneId: string): boolean {
  return fs.existsSync(sceneFile(sceneId));
}

/** 新建/导入场景：id 由服务端生成或采用调用方提供的 id（导入语义） */
export function createScene(raw: unknown, createdBy?: string): SceneDocument {
  ensureDataDirs();
  const requestedId = isPlainObject(raw) && typeof raw.id === 'string' && raw.id ? raw.id : undefined;
  if (requestedId) assertSafeId(requestedId, '场景 id');
  if (requestedId && sceneExists(requestedId)) {
    throw new HttpError(409, `场景已存在: ${requestedId}`);
  }
  const now = new Date().toISOString();
  const user = createdBy ?? 'anonymous';
  const doc: SceneDocument = {
    ...normalizeSceneDocument(raw, requestedId ?? randomUUID()),
    createdAt: now,
    updatedAt: now,
    createdBy: user,
    updatedBy: user,
  };
  writeSceneDocument(doc);
  return doc;
}

/** 覆盖保存（upsert），保留 createdAt，刷新 updatedAt */
export function saveScene(sceneId: string, raw: unknown, updatedBy?: string): SceneDocument {
  ensureDataDirs();
  assertSafeId(sceneId, '场景 id');
  const existing = sceneExists(sceneId) ? getScene(sceneId) : null;
  const user = updatedBy ?? 'anonymous';
  const doc: SceneDocument = {
    ...normalizeSceneDocument(raw, sceneId),
    id: sceneId,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: existing?.createdBy ?? user,
    updatedBy: user,
  };
  writeSceneDocument(doc);
  return doc;
}

export function deleteScene(sceneId: string): void {
  const file = sceneFile(sceneId);
  if (!fs.existsSync(file)) {
    throw new HttpError(404, `场景不存在: ${sceneId}`);
  }
  fs.rmSync(file);
}

// ---------------------------------------------------------------------------
// 资产
// ---------------------------------------------------------------------------

const ASSET_EXT_RE = /\.(glb|gltf|geojson|json|kml|zip)$/i;

export function isAllowedAssetFilename(filename: string): boolean {
  return ASSET_EXT_RE.test(filename);
}

export function assetUrl(assetId: string, filename: string): string {
  return `/assets/${assetId}/${encodeURI(filename)}`;
}

/** 把 multer 已落盘的临时文件收入 data/assets/<assetId>/ */
export function storeAsset(tmpPath: string, originalName: string, contentType?: string): AssetUploadResult {
  ensureDataDirs();
  if (!isAllowedAssetFilename(originalName)) {
    fs.rmSync(tmpPath, { force: true });
    throw new HttpError(400, `不支持的资产类型，允许的扩展名: .glb/.gltf/.geojson/.json/.kml/.zip`);
  }
  const assetId = randomUUID();
  const filename = sanitizeFilename(originalName);
  const dir = path.join(ASSETS_DIR, assetId);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, filename);
  try {
    fs.renameSync(tmpPath, dest);
  } catch {
    fs.copyFileSync(tmpPath, dest);
    fs.rmSync(tmpPath, { force: true });
  }
  const size = fs.statSync(dest).size;
  return { assetId, url: assetUrl(assetId, filename), size, filename, contentType };
}

/** 定位资产文件（assetId 目录下第一个文件，或指定文件名） */
export function resolveAssetFile(assetId: string, filename?: string): { filePath: string; filename: string } | null {
  if (!assetId || typeof assetId !== 'string') return null;
  assertSafeId(assetId, '资产 id');
  const dir = path.join(ASSETS_DIR, assetId);
  if (!fs.existsSync(dir)) return null;
  if (filename) {
    const filePath = path.join(dir, sanitizeFilename(filename));
    return fs.existsSync(filePath) ? { filePath, filename: path.basename(filePath) } : null;
  }
  const entries = fs.readdirSync(dir);
  if (entries.length === 0) return null;
  const name = entries[0];
  return { filePath: path.join(dir, name), filename: name };
}

/** 解析本地资产 URL（/assets/<assetId>/<filename>） */
export function resolveAssetUrl(url: string): { filePath: string; filename: string } | null {
  const match = /^\/assets\/([\w.-]+)\/(.+)$/.exec(url);
  if (!match) return null;
  return resolveAssetFile(decodeURIComponent(match[1]), decodeURIComponent(match[2]));
}

export interface AssetInfo {
  assetId: string;
  filename: string;
  url: string;
  size: number;
  updatedAt: string;
}

/** 资产列表（GET /api/assets，供管理页资产管理使用） */
export function listAssets(): AssetInfo[] {
  ensureDataDirs();
  const out: AssetInfo[] = [];
  if (!fs.existsSync(ASSETS_DIR)) return out;
  for (const entry of fs.readdirSync(ASSETS_DIR)) {
    const dir = path.join(ASSETS_DIR, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const filename of fs.readdirSync(dir)) {
      const stat = fs.statSync(path.join(dir, filename));
      if (!stat.isFile()) continue;
      out.push({
        assetId: entry,
        filename,
        url: assetUrl(entry, filename),
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
      });
    }
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

/** 删除资产（整目录）；不校验场景引用，管理页调用前应向用户确认 */
export function deleteAsset(assetId: string): void {
  assertSafeId(assetId, '资产 id');
  const dir = path.join(ASSETS_DIR, assetId);
  if (!fs.existsSync(dir)) {
    throw new HttpError(404, `资产不存在: ${assetId}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 已发布清单索引
// ---------------------------------------------------------------------------

export function listPublished(): PublishManifest[] {
  ensureDataDirs();
  const manifests: PublishManifest[] = [];
  if (!fs.existsSync(PUBLISHED_DIR)) return manifests;
  for (const entry of fs.readdirSync(PUBLISHED_DIR)) {
    const manifestFile = path.join(PUBLISHED_DIR, entry, 'manifest.json');
    if (!fs.existsSync(manifestFile)) continue;
    try {
      manifests.push(JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as PublishManifest);
    } catch (err) {
      console.warn(`[storage] 跳过无法解析的发布清单 ${entry}:`, err);
    }
  }
  manifests.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return manifests;
}
