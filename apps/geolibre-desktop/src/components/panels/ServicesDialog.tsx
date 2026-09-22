/*
  panels/ServicesDialog —— GIS 服务管理（Phase 3）

  对接 services/gis-server（Node GIS sidecar）：
  - 服务端地址配置 + 连接状态；
  - 服务注册表（发布/托管的服务实例，一键复制访问 URL——XYZ 模板可直接
    被「添加数据 → XYZ URL」加载）；
  - 托管本机瓦片目录（免上传发布 GB 级缓存，POST /api/services/host-directory）；
  - 场景列表（服务端已有场景一览）。
*/
import { useCallback, useEffect, useState } from "react";

import {
  DEFAULT_GIS_SERVER_URL,
  GisServerRequestError,
  getGisServerUrl,
  hostGisDirectory,
  listGisScenes,
  listGisServices,
  setGisServerUrl,
  type GisSceneSummary,
  type GisServiceEntry,
  type HostDirectoryResult,
} from "../../lib/gis-server-client";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
} from "@geolibre/ui";

type ConnState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "ok"; at: number }
  | { phase: "error"; message: string };

export function ServicesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [serverUrl, setServerUrlInput] = useState(DEFAULT_GIS_SERVER_URL);
  const [conn, setConn] = useState<ConnState>({ phase: "idle" });
  const [services, setServices] = useState<GisServiceEntry[] | null>(null);
  const [scenes, setScenes] = useState<GisSceneSummary[] | null>(null);
  const [hostDir, setHostDir] = useState("");
  const [hostKind, setHostKind] = useState<"xyz" | "3dtiles">("xyz");
  const [hostTitle, setHostTitle] = useState("");
  const [hostBusy, setHostBusy] = useState(false);
  const [hostResult, setHostResult] = useState<HostDirectoryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (url: string) => {
    setConn({ phase: "checking" });
    setError(null);
    try {
      const [svcs, scns] = await Promise.all([listGisServices(), listGisScenes()]);
      setServices(svcs);
      setScenes(scns);
      setConn({ phase: "ok", at: Date.now() });
    } catch (e) {
      setServices(null);
      setScenes(null);
      setConn({
        phase: "error",
        message: e instanceof GisServerRequestError ? e.message : String(e),
      });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setServerUrlInput(getGisServerUrl());
    void refresh(getGisServerUrl());
  }, [open, refresh]);

  const applyUrl = () => {
    setGisServerUrl(serverUrl);
    void refresh(serverUrl);
  };

  const runHost = async () => {
    if (!hostDir.trim()) return;
    setHostBusy(true);
    setHostResult(null);
    setError(null);
    try {
      const result = await hostGisDirectory(hostDir.trim(), hostKind, hostTitle.trim() || undefined);
      setHostResult(result);
      void refresh(getGisServerUrl());
    } catch (e) {
      setError(e instanceof GisServerRequestError ? e.message : String(e));
    } finally {
      setHostBusy(false);
    }
  };

  const busy = conn.phase === "checking";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="gis-services-dialog">
        <DialogHeader>
          <DialogTitle>GIS 服务管理</DialogTitle>
          <DialogDescription>
            连接 GIS 服务端（Node sidecar），管理已发布/托管的服务与场景；本地缓存目录可免上传直接对外发布。
          </DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[70vh] gap-4 overflow-auto py-2">
          {/* 服务器地址 */}
          <div className="grid gap-1.5">
            <Label htmlFor="gis-server-url">服务端地址</Label>
            <div className="flex gap-2">
              <Input
                id="gis-server-url"
                value={serverUrl}
                onChange={(e) => setServerUrlInput(e.target.value)}
                placeholder={DEFAULT_GIS_SERVER_URL}
              />
              <Button variant="secondary" onClick={applyUrl} disabled={busy}>
                {busy ? "连接中…" : "连接"}
              </Button>
            </div>
            {conn.phase === "ok" ? (
              <p className="text-xs text-emerald-600">
                已连接：{services?.length ?? 0} 个服务 / {scenes?.length ?? 0} 个场景
              </p>
            ) : null}
            {conn.phase === "error" ? <p className="text-xs text-red-600">{conn.message}</p> : null}
          </div>

          {/* 托管本地目录 */}
          <div className="grid gap-1.5 rounded-md border border-border p-3">
            <Label htmlFor="gis-host-dir">托管本机瓦片目录（免上传，服务端所在机器的绝对路径）</Label>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <Input
                id="gis-host-dir"
                value={hostDir}
                onChange={(e) => setHostDir(e.target.value)}
                placeholder="/data/xyz-cache-beijing"
              />
              <Select
                className="w-28"
                value={hostKind}
                onChange={(e) => setHostKind(e.target.value === "3dtiles" ? "3dtiles" : "xyz")}
              >
                <option value="xyz">XYZ 瓦片</option>
                <option value="3dtiles">3D Tiles</option>
              </Select>
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <Input
                value={hostTitle}
                onChange={(e) => setHostTitle(e.target.value)}
                placeholder="服务标题（可选）"
              />
              <Button onClick={() => void runHost()} disabled={hostBusy || !hostDir.trim()}>
                {hostBusy ? "托管中…" : "托管"}
              </Button>
            </div>
            {hostResult ? (
              <div className="rounded bg-muted/40 px-2 py-1.5 text-xs">
                <p className="text-emerald-600">
                  已托管「{String(hostResult.entry.title ?? hostResult.entry.slug)}」
                  {hostResult.scan?.fileCount != null ? `（${hostResult.scan.fileCount} 个文件）` : ""}
                </p>
                {hostResult.access?.url ? (
                  <p className="mt-1 break-all text-muted-foreground">
                    访问：{hostResult.access.url}
                    {hostResult.entry.hostKind === "xyz" ? "/{z}/{x}/{y}.png" : ""}
                    <button
                      type="button"
                      className="ms-2 text-primary underline"
                      onClick={() => void navigator.clipboard.writeText(
                        `${hostResult.access?.url ?? ""}${hostResult.entry.hostKind === "xyz" ? "/{z}/{x}/{y}.png" : ""}`,
                      )}
                    >
                      复制
                    </button>
                    {hostResult.entry.hostKind === "xyz" ? (
                      <span className="ms-1 text-muted-foreground">（可粘贴到「添加数据 → XYZ URL」直接加载）</span>
                    ) : null}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* 服务列表 */}
          <div className="grid gap-1.5">
            <Label>服务注册表</Label>
            {services && services.length > 0 ? (
              <ul className="divide-y divide-border rounded-md border border-border text-xs">
                {services.map((entry) => (
                  <li key={String(entry.slug)} className="flex items-center gap-2 px-2 py-1.5">
                    <span className="truncate text-foreground">{String(entry.title ?? entry.slug)}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {String(entry.hostKind ?? entry.kind ?? "service")}
                    </span>
                    <button
                      type="button"
                      className="ms-auto shrink-0 text-primary underline"
                      onClick={() => void navigator.clipboard.writeText(String(entry.url ?? entry.slug))}
                    >
                      复制 URL
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">
                {services ? "暂无已注册服务；先在上方托管目录或发布数据" : "连接后显示"}
              </p>
            )}
          </div>

          {/* 场景列表 */}
          <div className="grid gap-1.5">
            <Label>服务端场景</Label>
            {scenes && scenes.length > 0 ? (
              <ul className="divide-y divide-border rounded-md border border-border text-xs">
                {scenes.map((scene, index) => (
                  <li key={String(scene.id ?? index)} className="flex items-center gap-2 px-2 py-1.5">
                    <span className="truncate text-foreground">{String(scene.name ?? scene.id ?? `场景 ${index + 1}`)}</span>
                    {typeof scene.updatedAt === "string" ? (
                      <span className="ms-auto shrink-0 text-muted-foreground">
                        {new Date(scene.updatedAt).toLocaleString()}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">
                {scenes ? "服务端暂无场景；发布后在此查看" : "连接后显示"}
              </p>
            )}
          </div>

          {error ? <p className="text-xs text-red-600">{error}</p> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
