/*
  panels/PublishDialog —— 一键发布（发布链路收口）

  把当前 GeoLibre 工程转换为 gis-full SceneDocument 并 POST 到
  services/gis-server 的 /api/scenes/publish-package：
  - geojson 图层 → 内嵌 features（source.kind='inline'）
  - xyz / wms / wmts / vector-tiles 图层 → URL 引用（source.kind='url'）
  - 其余类型列出跳过原因；底图以 XYZ 模板形式写入 basemap 状态
  发布结果返回 hostedSceneUrl（服务端托管的 scene.json）。
*/
import { useMemo, useState } from "react";

import { useAppStore } from "@geolibre/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@geolibre/ui";

import {
  GisServerRequestError,
  publishGisScene,
  type PublishPackageResult,
} from "../../lib/gis-server-client";
import type { GeoLibreLayer } from "@geolibre/core";

const URL_LAYER_TYPES = new Set(["xyz", "wms", "wmts", "vector-tiles"]);

interface PublishableLayer {
  id: string;
  name: string;
  mode: "inline" | "url";
  type: string;
  url?: string;
}

function layerSourceUrl(layer: GeoLibreLayer): string | undefined {
  const source = layer.source as { url?: unknown; tiles?: unknown };
  if (typeof source?.url === "string" && source.url) return source.url;
  if (Array.isArray(source?.tiles) && typeof source.tiles[0] === "string") return source.tiles[0];
  return undefined;
}

/** 工程 → SceneDocument（转换规则见文件头注释）。返回场景文档与跳过清单。 */
export function buildSceneDocument(
  project: { name: string; mapView: { center: [number, number]; zoom: number; bearing: number; pitch: number }; basemapStyleUrl: string; layers: GeoLibreLayer[] },
): { scene: Record<string, unknown>; publishable: PublishableLayer[]; skipped: { name: string; type: string; reason: string }[] } {
  const publishable: PublishableLayer[] = [];
  const skipped: { name: string; type: string; reason: string }[] = [];
  const layers = project.layers
    .filter((layer) => layer.visible)
    .map((layer, index): Record<string, unknown> | null => {
      if (layer.type === "geojson" && layer.geojson) {
        publishable.push({ id: layer.id, name: layer.name, mode: "inline", type: layer.type });
        return {
          id: `${layer.id}-${index}`,
          name: layer.name,
          type: "geojson",
          source: { kind: "inline" },
          features: layer.geojson,
          style: { opacity: layer.opacity, visibility: layer.visible },
        };
      }
      if (URL_LAYER_TYPES.has(layer.type)) {
        const url = layerSourceUrl(layer);
        if (url) {
          publishable.push({ id: layer.id, name: layer.name, mode: "url", type: layer.type, url });
          return {
            id: `${layer.id}-${index}`,
            name: layer.name,
            type: "imagery",
            source: { kind: "url", url },
            style: { opacity: layer.opacity, visibility: layer.visible },
          };
        }
        skipped.push({ name: layer.name, type: layer.type, reason: "未找到数据 URL" });
        return null;
      }
      skipped.push({ name: layer.name, type: layer.type, reason: "该类型暂不支持发布" });
      return null;
    })
    .filter(Boolean);

  // 初始视角：zoom → 高度近似（米）；bearing/pitch 直接映射
  const [lon, lat] = project.mapView.center;
  const height = Math.max(
    300,
    (40075016.686 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, project.mapView.zoom),
  );

  const basemap: Record<string, unknown> | undefined = project.basemapStyleUrl.includes("{z}")
    ? {
        activeId: "current",
        items: [
          {
            id: "current",
            kind: "custom",
            label: "当前底图",
            urlTemplate: project.basemapStyleUrl,
            isBuiltin: true,
            isActive: true,
          },
        ],
      }
    : undefined;

  const scene: Record<string, unknown> = {
    version: 1,
    name: project.name || "未命名场景",
    camera: {
      lon,
      lat,
      height: Math.round(height),
      heading: project.mapView.bearing,
      pitch: project.mapView.pitch,
      roll: 0,
    },
    layers,
    metadata: { source: "geolibre", publishedAt: new Date().toISOString() },
    ...(basemap ? { basemap } : {}),
  };
  return { scene, publishable, skipped };
}

export function PublishDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const projectName = useAppStore((s) => s.projectName);
  const mapView = useAppStore((s) => s.mapView);
  const basemapStyleUrl = useAppStore((s) => s.basemapStyleUrl);
  const layers = useAppStore((s) => s.layers);

  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PublishPackageResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const effectiveName = name.trim() || projectName || "未命名场景";
  const analysis = useMemo(
    () => buildSceneDocument({ name: effectiveName, mapView, basemapStyleUrl, layers }),
    [effectiveName, mapView, basemapStyleUrl, layers],
  );

  const runPublish = async () => {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const doc = buildSceneDocument({ name: effectiveName, mapView, basemapStyleUrl, layers });
      const published = await publishGisScene({ ...doc.scene, name: effectiveName });
      setResult(published);
    } catch (e) {
      setError(e instanceof GisServerRequestError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="gis-publish-dialog">
        <DialogHeader>
          <DialogTitle>一键发布</DialogTitle>
          <DialogDescription>
            将当前工程发布到 GIS 服务端：geojson 图层内嵌，瓦片/WMS 图层按 URL 引用；服务端返回可分享的场景地址。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="publish-name">场景名</Label>
            <Input
              id="publish-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={projectName || "未命名场景"}
            />
          </div>

          <div className="grid gap-1.5 rounded-md border border-border p-3 text-xs">
            <p>
              将发布 <b>{analysis.publishable.length}</b> 个图层
              {analysis.publishable.some((l) => l.mode === "inline") ? "（geojson 内嵌）" : ""}
              {analysis.publishable.some((l) => l.mode === "url") ? "（含 URL 引用）" : ""}
            </p>
            {analysis.skipped.length > 0 ? (
              <p className="text-muted-foreground">
                跳过 {analysis.skipped.length} 个：
                {analysis.skipped.map((s) => `${s.name}（${s.reason}）`).join("、")}
              </p>
            ) : null}
          </div>

          {result?.hostedSceneUrl ? (
            <div className="rounded-md border border-border bg-muted/40 p-3 text-xs">
              <p className="text-emerald-600">发布成功</p>
              <p className="mt-1 break-all text-foreground">{result.hostedSceneUrl}</p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void navigator.clipboard.writeText(result.hostedSceneUrl ?? "")}
                >
                  复制地址
                </Button>
                <a href={result.hostedSceneUrl} target="_blank" rel="noreferrer">
                  <Button size="sm" variant="ghost">
                    打开
                  </Button>
                </a>
              </div>
            </div>
          ) : null}

          {error ? <p className="text-xs text-red-600">{error}</p> : null}

          <Button onClick={() => void runPublish()} disabled={busy || analysis.publishable.length === 0}>
            {busy ? "发布中…" : "发布到 GIS 服务端"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
