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
import { useTranslation } from "react-i18next";
import type { ParseKeys } from "i18next";

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
        // reason 存目录键（模块作用域无 t()），渲染处解析
        skipped.push({ name: layer.name, type: layer.type, reason: "gisServer.skipNoUrl" });
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
  const { t } = useTranslation();
  const projectName = useAppStore((s) => s.projectName);
  const mapView = useAppStore((s) => s.mapView);
  const basemapStyleUrl = useAppStore((s) => s.basemapStyleUrl);
  const layers = useAppStore((s) => s.layers);

  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PublishPackageResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const effectiveName = name.trim() || projectName || t("gisServer.unnamedScene");
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
          <DialogTitle>{t("gisServer.publishTitle")}</DialogTitle>
          <DialogDescription>{t("gisServer.publishDescription")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="publish-name">{t("gisServer.sceneName")}</Label>
            <Input
              id="publish-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={projectName || t("gisServer.unnamedScene")}
            />
          </div>

          <div className="grid gap-1.5 rounded-md border border-border p-3 text-xs">
            <p>
              {t("gisServer.willPublish", { count: analysis.publishable.length })}
              {analysis.publishable.some((l) => l.mode === "inline") ? t("gisServer.inlineSuffix") : ""}
              {analysis.publishable.some((l) => l.mode === "url") ? t("gisServer.urlSuffix") : ""}
            </p>
            {analysis.skipped.length > 0 ? (
              <p className="text-muted-foreground">
                {t("gisServer.skippedCount", {
                  count: analysis.skipped.length,
                  items: analysis.skipped
                    .map((s) => `${s.name}（${t(s.reason as ParseKeys)}）`)
                    .join("、"),
                })}
              </p>
            ) : null}
          </div>

          {result?.hostedSceneUrl ? (
            <div className="rounded-md border border-border bg-muted/40 p-3 text-xs">
              <p className="text-emerald-600">{t("gisServer.publishedOk")}</p>
              <p className="mt-1 break-all text-foreground">{result.hostedSceneUrl}</p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void navigator.clipboard.writeText(result.hostedSceneUrl ?? "")}
                >
                  {t("gisServer.copyAddress")}
                </Button>
                <a href={result.hostedSceneUrl} target="_blank" rel="noreferrer">
                  <Button size="sm" variant="ghost">
                    {t("gisServer.open")}
                  </Button>
                </a>
              </div>
            </div>
          ) : null}

          {error ? <p className="text-xs text-red-600">{error}</p> : null}

          <Button onClick={() => void runPublish()} disabled={busy || analysis.publishable.length === 0}>
            {busy ? t("gisServer.publishing") : t("gisServer.publishButton")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
