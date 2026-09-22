/*
  lib/gis-server-client —— @geolibre/gis-server（Node GIS sidecar）客户端

  Phase 3：桌面端与服务端的连接层。服务端默认 127.0.0.1:8080，
  地址可改（localStorage 持久化）。接口契约与 services/gis-server 一致：
  - GET  /api/services        → ServiceEntry[]（发布/托管服务注册表）
  - GET  /api/scenes          → SceneSummary[]
  - POST /api/services/host-directory { dir, kind, slug?, title? }
        → { entry, scan, access: { url, kind, note } }
  写接口在服务端配置 AUTH_TOKEN 时需 Bearer（本地默认无鉴权）。
*/

export interface GisServiceEntry {
  slug: string;
  kind?: string;
  hostKind?: string;
  title?: string;
  url?: string;
  hostDir?: string;
  [key: string]: unknown;
}

export interface GisSceneSummary {
  id?: string;
  name?: string;
  version?: number;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface HostDirectoryResult {
  entry: GisServiceEntry;
  scan?: { fileCount?: number; totalBytes?: number; maxZoom?: number };
  access?: { url?: string; kind?: string; note?: string };
}

const URL_KEY = "geolibre.gis-server.url";
export const DEFAULT_GIS_SERVER_URL = "http://127.0.0.1:8080";

export function getGisServerUrl(): string {
  try {
    const stored = localStorage.getItem(URL_KEY);
    if (stored && stored.trim()) return stored.trim().replace(/\/+$/, "");
  } catch {
    /* localStorage 不可用（隐私模式等）→ 用默认 */
  }
  return DEFAULT_GIS_SERVER_URL;
}

export function setGisServerUrl(url: string): void {
  try {
    localStorage.setItem(URL_KEY, url.trim().replace(/\/+$/, ""));
  } catch {
    /* 同上 */
  }
}

export class GisServerRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getGisServerUrl();
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch (error) {
    throw new GisServerRequestError(
      0,
      `无法连接 GIS 服务端（${base}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      detail = body.error ?? body.message ?? detail;
    } catch {
      /* 非 JSON 错误体 → 用状态行 */
    }
    throw new GisServerRequestError(response.status, detail);
  }
  return (await response.json()) as T;
}

export function listGisServices(): Promise<GisServiceEntry[]> {
  return request<GisServiceEntry[]>("/api/services");
}

export function listGisScenes(): Promise<GisSceneSummary[]> {
  return request<GisSceneSummary[]>("/api/scenes");
}

export function hostGisDirectory(
  dir: string,
  kind: "xyz" | "3dtiles",
  title?: string,
): Promise<HostDirectoryResult> {
  return request<HostDirectoryResult>("/api/services/host-directory", {
    method: "POST",
    body: JSON.stringify({ dir, kind, title }),
  });
}

/** 发布结果（POST /api/scenes/publish-package） */
export interface PublishPackageResult {
  manifest?: { slug?: string; title?: string; [key: string]: unknown };
  hostedSceneUrl?: string;
  hostedScene?: { id?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * 一键发布：场景文档（图层内嵌 GeoJSON + XYZ URL 引用）上传为场景包。
 * multipart（scene + 空 bundleMeta），浏览器自动带 multipart boundary。
 */
export async function publishGisScene(
  scene: Record<string, unknown>,
): Promise<PublishPackageResult> {
  const base = getGisServerUrl();
  const form = new FormData();
  form.append("scene", JSON.stringify(scene));
  form.append("bundleMeta", "[]");
  let response: Response;
  try {
    response = await fetch(`${base}/api/scenes/publish-package`, { method: "POST", body: form });
  } catch (error) {
    throw new GisServerRequestError(
      0,
      `无法连接 GIS 服务端（${base}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      detail = body.error ?? body.message ?? detail;
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new GisServerRequestError(response.status, detail);
  }
  const result = (await response.json()) as PublishPackageResult;
  // 服务端返回相对路径（/published/<slug>/scene.json）→ 拼成绝对 URL 便于展示/分享
  if (typeof result.hostedSceneUrl === "string" && result.hostedSceneUrl.startsWith("/")) {
    result.hostedSceneUrl = `${base}${result.hostedSceneUrl}`;
  }
  return result;
}
