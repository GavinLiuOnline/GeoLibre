/**
 * 服务注册表：对外服务实例（发布包）的统一索引 data/services.json。
 *
 * - 场景发布 / 3D Tiles 数据集 zip 直接发布都会注册条目；
 * - GET /api/services 读取注册表，并自动与 data/published/ 目录对账：
 *   目录缺失的条目剔除、目录存在但未注册的（如旧版本产物/手工拷贝）自动补录；
 * - DELETE 服务 = 删除发布目录 + 注册表条目，不影响场景源数据。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { PublishArtifact, PublishArtifactKind, PublishManifest, ServiceEntry } from '@geolibre/gis-shared';

import { DATA_DIR, PUBLISHED_DIR, assertSafeSlug } from './storage.js';
import { HttpError } from '../util/http.js';

const REGISTRY_FILE = path.join(DATA_DIR, 'services.json');

interface RegistryFile {
  version: 1;
  services: ServiceEntry[];
}

function readRegistry(): ServiceEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')) as RegistryFile;
    return Array.isArray(raw.services) ? raw.services : [];
  } catch {
    return [];
  }
}

function writeRegistry(services: ServiceEntry[]): void {
  const payload: RegistryFile = { version: 1, services };
  fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

function dedupeKinds(artifacts: PublishArtifact[]): PublishArtifactKind[] {
  return [...new Set(artifacts.map((a) => a.kind))];
}

function readManifest(slug: string): PublishManifest | null {
  try {
    const file = path.join(PUBLISHED_DIR, slug, 'manifest.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')) as PublishManifest;
  } catch {
    return null;
  }
}

/** 由 manifest 推导注册表条目（补录旧产物用，publishedAt/updatedAt 取 manifest） */
export function entryFromManifest(manifest: PublishManifest, sceneName?: string, assetId?: string): ServiceEntry {
  return {
    slug: manifest.slug,
    sceneId: manifest.sceneId,
    sceneName: sceneName ?? manifest.name ?? '',
    types: dedupeKinds(manifest.artifacts),
    artifacts: manifest.artifacts,
    publishedAt: manifest.publishedAt,
    updatedAt: manifest.publishedAt,
    ...(assetId ? { assetId } : {}),
  };
}

/** 发布成功后注册/刷新条目（publishedAt 保留首次发布时间，updatedAt 刷新） */
export function upsertService(entry: ServiceEntry): void {
  const services = readRegistry();
  const index = services.findIndex((s) => s.slug === entry.slug);
  if (index >= 0) {
    const prev = services[index];
    services[index] = { ...entry, publishedAt: prev.publishedAt || entry.publishedAt };
  } else {
    services.push(entry);
  }
  writeRegistry(services);
}

/** 全量服务列表：与发布目录对账（剔除孤儿条目、补录未注册目录），按最近发布排序 */
export function listServices(): ServiceEntry[] {
  const services = readRegistry();
  const dirSlugs = fs.existsSync(PUBLISHED_DIR)
    ? fs.readdirSync(PUBLISHED_DIR).filter((name) => fs.existsSync(path.join(PUBLISHED_DIR, name, 'manifest.json')))
    : [];

  const known = new Set<string>();
  const result: ServiceEntry[] = [];
  for (const entry of services) {
    // 目录托管服务（t26）：不依赖 data/published 目录，源目录存在即有效。
    if (entry.hostDir) {
      if (!fs.existsSync(entry.hostDir)) continue; // 源目录被移走 → 条目失效
      known.add(entry.slug);
      result.push(entry);
      continue;
    }
    if (!dirSlugs.includes(entry.slug)) continue; // 发布目录已被删除 → 条目失效
    known.add(entry.slug);
    result.push(entry);
  }
  let dirty = result.length !== services.length;
  for (const slug of dirSlugs) {
    if (known.has(slug)) continue;
    const manifest = readManifest(slug);
    if (!manifest) continue;
    result.push(entryFromManifest(manifest));
    dirty = true;
  }
  if (dirty) writeRegistry(result);
  result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return result;
}

export function getService(slug: string): ServiceEntry | null {
  return listServices().find((s) => s.slug === slug) ?? null;
}

/** 轻量查询（不做发布目录对账）：托管静态资源热路径使用，避免每次请求都扫描 published 目录 */
export function getRegisteredService(slug: string): ServiceEntry | null {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) return null;
  return readRegistry().find((s) => s.slug === slug) ?? null;
}

export function findServiceByAssetId(assetId: string): ServiceEntry | null {
  return readRegistry().find((s) => s.assetId === assetId) ?? null;
}

/** 服务注销结果：说明本次注销对磁盘做了什么（t26 目录托管必须不删源文件） */
export interface DeleteServiceOutcome {
  slug: string;
  /** published：删除发布包目录；hosted：仅移除注册与托管映射，不碰源目录 */
  mode: 'published' | 'hosted';
  /** 是否删除了服务端生成的产物文件 */
  removedGeneratedFiles: boolean;
  /** 目录托管服务的源目录（仅 mode='hosted'） */
  sourceDir?: string;
  /** 面向调用方的说明文案 */
  message: string;
}

/** 删除服务：发布型删发布目录 + 注册表条目；目录托管型只注销，**绝不删除源目录** */
export function deleteService(slug: string): DeleteServiceOutcome {
  assertSafeSlug(slug);
  const dir = path.join(PUBLISHED_DIR, slug);
  const dirExists = fs.existsSync(dir);
  const services = readRegistry();
  const entry = services.find((s) => s.slug === slug);
  if (!dirExists && !entry) {
    throw new HttpError(404, `服务不存在: ${slug}`);
  }
  if (entry?.hostDir) {
    // 目录托管：只移除注册表条目与托管映射，源目录一个文件都不动（t26 语义）
    writeRegistry(services.filter((s) => s.slug !== slug));
    return {
      slug,
      mode: 'hosted',
      removedGeneratedFiles: false,
      sourceDir: entry.hostDir,
      message: `已注销目录托管服务 ${slug}：仅移除注册表条目与托管映射，源目录未被删除或修改（${entry.hostDir}）`,
    };
  }
  if (dirExists) fs.rmSync(dir, { recursive: true, force: true });
  writeRegistry(services.filter((s) => s.slug !== slug));
  return {
    slug,
    mode: 'published',
    removedGeneratedFiles: dirExists,
    message: `已删除发布包目录与注册表条目: ${slug}`,
  };
}
