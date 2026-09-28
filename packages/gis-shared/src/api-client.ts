/**
 * @gis/shared · GIS 服务端 API client
 *
 * 基于 fetch 的轻量封装，供编辑器 / 桌面端 / 脚本调用 GIS 服务端。
 * baseUrl 默认 http://localhost:8080；所有方法在非 2xx 响应时抛出 GisApiError。
 *
 * 鉴权：通过 GisApiClientOptions.token / setToken() 注入 Bearer Token，
 * 全部请求自动携带 `Authorization: Bearer <token>`（token 为空则不携带）。
 * 401 响应被识别为鉴权失败，抛出的 GisApiError.code === 'auth'，UI 据此弹窗引导 Token 设置。
 */

import type { SceneDocument, SceneSummary } from './scene.js';
import type {
  AssetUploadResult,
  DeleteServiceResult,
  HealthStatus,
  HostDirectoryInput,
  HostDirectoryResult,
  PublishManifest,
  PublishPackageAsset,
  PublishPackageBundle,
  PublishPackageOptions,
  PublishPackageResult,
  ServiceEntry,
} from './types.js';

/** 服务端默认基础地址 */
export const DEFAULT_SERVER_BASE_URL = 'http://localhost:8080';

/** GisApiError 分类：UI 据此决定是否弹窗引导 Token 设置等 */
export type GisApiErrorCode = 'auth' | 'network' | 'server';

export interface GisApiClientOptions {
  /** 服务端基础地址，默认 http://localhost:8080 */
  baseUrl?: string;
  /**
   * 初始 Bearer Token（可选）。也可通过 setToken / clearToken 后续修改。
   * 为空字符串或缺省时所有请求不携带 Authorization 头。
   */
  token?: string;
  /** 自定义 fetch 实现（测试 / 特殊运行环境注入），默认 globalThis.fetch */
  fetchImpl?: typeof fetch;
}

/**
 * 统一 API 错误：非 2xx 响应抛出，携带状态码、请求 URL、响应体与错误分类 code。
 *
 * code 语义：
 * - `'auth'`：服务端拒绝（401/403），通常是 Token 缺失/错误；UI 应引导 Token 设置。
 * - `'network'`：请求未能到达服务端（fetch reject / AbortError / DNS 失败）。
 * - `'server'`：服务端 5xx 类错误。
 * - `undefined`：其它 4xx（参数错误 400、资源不存在 404 等），按业务文案提示即可。
 */
export class GisApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: unknown;
  readonly code: GisApiErrorCode | undefined;

  constructor(
    message: string,
    status: number,
    url: string,
    body: unknown,
    code?: GisApiErrorCode,
  ) {
    super(message);
    this.name = 'GisApiError';
    this.status = status;
    this.url = url;
    this.body = body;
    this.code = code;
  }
}

/**
 * GIS 服务端 client。
 *
 * 约定：服务端返回的产物/资产 URL 为「根相对路径」（如 /published/<slug>/tileset.json），
 * 使用 resolveUrl 拼接为完整地址；这样发布包可随服务端部署位置迁移。
 */
export class GisApiClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private token: string;

  constructor(options: GisApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_SERVER_BASE_URL).replace(/\/+$/, '');
    const impl = options.fetchImpl ?? globalThis.fetch;
    if (typeof impl !== 'function') {
      throw new Error('当前环境没有 fetch 实现，请通过 GisApiClientOptions.fetchImpl 注入');
    }
    this.fetchImpl = impl.bind(globalThis);
    this.token = options.token ?? '';
  }

  /** 当前 Bearer Token；为空时所有请求不携带 Authorization 头 */
  getToken(): string {
    return this.token;
  }

  /** 设置 Token（持久生效，后续全部请求自动携带）；传空字符串等效于 clearToken */
  setToken(token: string): void {
    this.token = typeof token === 'string' ? token : '';
  }

  /** 清除 Token（后续请求不再携带 Authorization 头） */
  clearToken(): void {
    this.token = '';
  }

  /** 根相对路径 → 完整 URL；绝对 http(s) URL 原样返回 */
  resolveUrl(pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return `${this.baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
  }

  // -------------------------------------------------------------------------
  // 场景 CRUD
  // -------------------------------------------------------------------------

  /** GET /api/scenes —— 场景列表 */
  async listScenes(): Promise<SceneSummary[]> {
    return this.requestJson<SceneSummary[]>('GET', '/api/scenes');
  }

  /** GET /api/scenes/:id —— 获取场景文档 */
  async getScene(id: string): Promise<SceneDocument> {
    return this.requestJson<SceneDocument>('GET', `/api/scenes/${encodeURIComponent(id)}`);
  }

  /**
   * 保存场景：有 id 走 PUT /api/scenes/:id（覆盖保存），无 id 走 POST /api/scenes（新建/导入）。
   * 返回服务端规范化后的场景文档（含生成的 id 与时间戳）。
   */
  async saveScene(scene: SceneDocument): Promise<SceneDocument> {
    if (scene.id) {
      return this.requestJson<SceneDocument>(
        'PUT',
        `/api/scenes/${encodeURIComponent(scene.id)}`,
        scene,
      );
    }
    return this.requestJson<SceneDocument>('POST', '/api/scenes', scene);
  }

  /** DELETE /api/scenes/:id —— 删除场景 */
  async deleteScene(id: string): Promise<void> {
    await this.requestVoid('DELETE', `/api/scenes/${encodeURIComponent(id)}`);
  }

  // -------------------------------------------------------------------------
  // 发布
  // -------------------------------------------------------------------------

  /**
   * POST /api/scenes/:id/publish —— 发布场景，生成发布包并返回发布清单
   * （纯引用型：场景文档需要先上传源数据，本接口不携带 zip/资产）。
   */
  async publishScene(id: string): Promise<PublishManifest> {
    return this.requestJson<PublishManifest>(
      'POST',
      `/api/scenes/${encodeURIComponent(id)}/publish`,
    );
  }

  /**
   * POST /api/scenes/publish-package —— 一站式场景包发布（multipart）。
   *
   * 把编辑器侧的"场景文档 + 本地缓存 zip + 零散资产"一次推到服务端，
   * 由服务端解包、托管并改写图层 source 为服务端 URL，返回 PublishPackageResult。
   *
   * 字段约定：
   * - `scene`               JSON 字段，值为 SceneDocument 的 JSON 字符串（必填）
   * - `bundles[<layerId>]`  zip 字段，文件名随层 id 变化；顺序由 bundleMeta 描述
   * - `bundleMeta`          JSON 字段：`{ layerId, kind: 'xyz'|'3dtiles' }[]`
   * - `assets[]`            零散资产文件（glb/geojson/...），落到 /models/
   */
  async publishScenePackage(
    scene: SceneDocument,
    bundles: PublishPackageBundle[],
    assets: PublishPackageAsset[] = [],
    options: PublishPackageOptions = {},
  ): Promise<PublishPackageResult> {
    if (!scene || typeof scene !== 'object') {
      throw new Error('publishScenePackage: scene 必须为 SceneDocument');
    }
    if (!Array.isArray(bundles)) {
      throw new Error('publishScenePackage: bundles 必须为数组');
    }
    const form = new FormData();
    form.append('scene', JSON.stringify(scene));

    // bundleMeta + 每个 bundle 的 zip 字段
    const bundleMeta = bundles.map((b, index) => ({
      layerId: b.layerId,
      kind: b.kind,
      index,
      filename: b.filename ?? `${b.layerId || `bundle-${index}`}.zip`,
    }));
    form.append('bundleMeta', JSON.stringify(bundleMeta));
    bundles.forEach((b, index) => {
      const meta = bundleMeta[index];
      const blob = toBlob(b.zip, 'application/zip');
      const filename = meta.filename;
      const field = `bundles[${b.layerId || meta.filename}]`;
      form.append(field, blob, filename);
    });

    // 零散资产
    assets.forEach((asset, index) => {
      const blob = toBlob(asset.data, asset.contentType ?? 'application/octet-stream');
      form.append('assets[]', blob, asset.filename || `asset-${index}`);
    });

    const url = (options.baseUrl ?? this.baseUrl).replace(/\/+$/, '') + '/api/scenes/publish-package';
    const token = options.token ?? this.token;
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        body: form,
        headers,
      });
    } catch (err) {
      throw new GisApiError(
        err instanceof Error ? err.message : String(err),
        0,
        url,
        undefined,
        'network',
      );
    }
    return this.handleResponse<PublishPackageResult>(res, url);
  }

  /** GET /api/published —— 已发布清单列表 */
  async listPublished(): Promise<PublishManifest[]> {
    return this.requestJson<PublishManifest[]>('GET', '/api/published');
  }

  // -------------------------------------------------------------------------
  // 服务注册表 / 目录托管（t26）
  // -------------------------------------------------------------------------

  /** GET /api/services —— 服务注册表（含发布型与目录托管型服务） */
  async listServices(): Promise<ServiceEntry[]> {
    return this.requestJson<ServiceEntry[]>('GET', '/api/services');
  }

  /**
   * POST /api/services/host-directory —— 按路径托管本机目录（免上传发布 GB 级缓存）。
   *
   * 服务端**默认拒绝**：仅当环境变量 `GIS_HOST_DIR_ROOTS`（冒号分隔的允许根）配置且目录
   * 位于其中时才允许，否则返回 403（`GisApiError.code === 'auth'`）并给出配置指引文案。
   * 调用方应原样展示该文案（不要一律当成 Token 问题弹设置面板）；判断依据：
   * `err.status === 403 && err.message.includes('GIS_HOST_DIR_ROOTS')`。
   */
  async hostDirectory(input: HostDirectoryInput): Promise<HostDirectoryResult> {
    return this.requestJson<HostDirectoryResult>('POST', '/api/services/host-directory', {
      dir: input.dir,
      kind: input.kind,
      ...(input.slug ? { slug: input.slug } : {}),
      ...(input.title ? { title: input.title } : {}),
    });
  }

  /**
   * DELETE /api/services/:slug —— 注销服务。
   * - 发布型：删除发布包目录 + 注册表条目 → 204（返回 undefined）；
   * - 目录托管型：只移除注册表条目与托管映射，**源目录一个文件都不动** → 200 + DeleteServiceResult。
   */
  async deleteService(slug: string): Promise<DeleteServiceResult | undefined> {
    return this.requestJson<DeleteServiceResult | undefined>(
      'DELETE',
      `/api/services/${encodeURIComponent(slug)}`,
    );
  }

  // -------------------------------------------------------------------------
  // 资产上传
  // -------------------------------------------------------------------------

  /**
   * POST /api/assets —— 上传资产（.glb/.gltf/.geojson/.json/.kml/.zip），
   * 返回 { assetId, url, size }。
   */
  async uploadAsset(
    file: Blob | ArrayBuffer | ArrayBufferView,
    filename: string,
    contentType?: string,
  ): Promise<AssetUploadResult> {
    const blob = toBlob(file, contentType ?? 'application/octet-stream');
    const form = new FormData();
    form.append('file', blob, filename);
    return this.requestFormJson<AssetUploadResult>('POST', '/api/assets', form);
  }

  // -------------------------------------------------------------------------
  // 健康检查
  // -------------------------------------------------------------------------

  /** GET /api/health —— 服务端健康检查 */
  async health(): Promise<HealthStatus> {
    return this.requestJson<HealthStatus>('GET', '/api/health');
  }

  // -------------------------------------------------------------------------
  // 内部工具
  // -------------------------------------------------------------------------

  private buildHeaders(method: string, body: unknown, extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...(extra ?? {}) };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    void method;
    return headers;
  }

  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    const url = this.resolveUrl(path);
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: this.buildHeaders(method, body),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new GisApiError(
        err instanceof Error ? err.message : String(err),
        0,
        url,
        undefined,
        'network',
      );
    }
    return this.handleResponse<T>(res, url);
  }

  private async requestFormJson<T>(method: string, path: string, form: FormData): Promise<T> {
    let res: Response;
    const url = this.resolveUrl(path);
    try {
      res = await this.fetchImpl(url, {
        method,
        body: form,
        headers: this.buildHeaders(method, form),
      });
    } catch (err) {
      throw new GisApiError(
        err instanceof Error ? err.message : String(err),
        0,
        url,
        undefined,
        'network',
      );
    }
    return this.handleResponse<T>(res, url);
  }

  private async requestVoid(method: string, path: string): Promise<void> {
    let res: Response;
    const url = this.resolveUrl(path);
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: this.buildHeaders(method, undefined),
      });
    } catch (err) {
      throw new GisApiError(
        err instanceof Error ? err.message : String(err),
        0,
        url,
        undefined,
        'network',
      );
    }
    await this.ensureOk(res, url);
  }

  private async handleResponse<T>(res: Response, url: string): Promise<T> {
    await this.ensureOk(res, url);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async ensureOk(res: Response, url: string): Promise<void> {
    if (res.ok) return;
    let body: unknown;
    let message = `${res.status} ${res.statusText || 'Request Failed'}`;
    try {
      body = await res.json();
      const errText = (body as { error?: unknown } | null)?.error;
      if (typeof errText === 'string' && errText) message = `${res.status} ${errText}`;
    } catch {
      // 响应体不是 JSON：保留状态码信息即可
    }
    let code: GisApiErrorCode | undefined;
    if (res.status === 401 || res.status === 403) code = 'auth';
    else if (res.status === 0) code = 'network';
    else if (res.status >= 500) code = 'server';
    throw new GisApiError(message, res.status, url || res.url || '', body, code);
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function toBlob(data: Blob | File | ArrayBuffer | ArrayBufferView, contentType: string): Blob {
  if (data instanceof Blob) return data;
  if (data instanceof ArrayBuffer) return new Blob([data as ArrayBuffer], { type: contentType });
  if (ArrayBuffer.isView(data)) {
    const view = data as unknown as ArrayBufferView;
    // 拷贝到独立 ArrayBuffer，避免 SharedArrayBuffer 类型推断问题
    const copy = new ArrayBuffer(view.byteLength);
    new Uint8Array(copy).set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return new Blob([copy], { type: contentType });
  }
  throw new Error('publishScenePackage: 不支持的数据类型（需为 Blob/File/ArrayBuffer）');
}

/** 便捷工厂：创建指向默认或指定地址的 client */
export function createGisApiClient(baseUrl?: string): GisApiClient {
  return new GisApiClient({ baseUrl });
}
