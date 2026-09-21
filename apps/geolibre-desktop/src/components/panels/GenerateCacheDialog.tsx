/*
  panels/GenerateCacheDialog —— XYZ 瓦片缓存生成（Phase 2 PR5）

  两种模式（来自 Ribbon data.gen-2d / data.gen-region）：
  - vector：矢量图层内嵌 GeoJSON → 逐瓦片渲染 PNG（@geolibre/xyz-cache
    generateXyzFromGeoJSON，bbox 取数据范围）；
  - region：底图 URL 模板 + 矢量图层范围 → 底图瓦片抓取打包
    （generateXyzFromRegion，source='basemap'）。

  产物统一 buildZipBlob 打包为 zip 并 downloadBlob 下载（浏览器路径）；
  桌面端写盘目录随 Phase 4 Tauri 统一时接入 saveBlobAs。
*/
import { useMemo, useState } from "react";

import { useAppStore } from "@geolibre/core";
import {
  buildZipBlob,
  downloadBlob,
  generateXyzFromGeoJSON,
  generateXyzFromRegion,
  geojsonExtent,
} from "@geolibre/xyz-cache";
import type { GeoJSONData } from "@geolibre/gis-shared";
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

import { getVectorLayers } from "../../lib/dialog-layer-utils";

const MIN_ZOOM_MIN = 0;
const MAX_ZOOM_MAX = 22;

interface GenerateCacheDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 'vector'：矢量渲染生成；'region'：底图源按范围抓取 */
  mode: "vector" | "region";
}

export function GenerateCacheDialog({ open, onOpenChange, mode }: GenerateCacheDialogProps) {
  const layers = useAppStore((s) => s.layers);
  const vectorLayers = useMemo(() => getVectorLayers(layers), [layers]);
  const [layerId, setLayerId] = useState<string>("");
  const [minZoom, setMinZoom] = useState(mode === "vector" ? 0 : 8);
  const [maxZoom, setMaxZoom] = useState(14);
  const [urlTemplate, setUrlTemplate] = useState("");
  const [token, setToken] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const layer = vectorLayers.find((l) => l.id === layerId) ?? vectorLayers[0];

  const run = async () => {
    if (!layer?.geojson) return;
    const min = Math.max(MIN_ZOOM_MIN, Math.floor(minZoom));
    const max = Math.min(MAX_ZOOM_MAX, Math.floor(maxZoom));
    setProgress(0);
    setError(null);
    setDone(null);
    try {
      const onProgress = (ratio: number) => setProgress(ratio);
      const bbox = geojsonExtent(layer.geojson as unknown as GeoJSONData);
      if (!bbox) throw new Error("无法确定图层地理范围（数据无有效坐标）");
      const cache =
        mode === "vector"
          ? await generateXyzFromGeoJSON(layer.geojson as unknown as GeoJSONData, { minZoom: min, maxZoom: max, onProgress })
          : await generateXyzFromRegion({
              bbox,
              minZoom: min,
              maxZoom: max,
              source: "basemap",
              basemap: {
                urlTemplate: urlTemplate.trim(),
                token: token.trim() || undefined,
                label: layer.name,
              },
              onProgress,
            });
      const zip = await buildZipBlob(
        cache.files.map((f) => ({ path: f.path, data: f.blob })),
        { label: `XYZ 缓存（${layer.name}）` },
      );
      const filename = `xyz-cache-${layer.name.replace(/[\\/:*?"<>|\s]+/g, "-")}-z${min}-z${max}.zip`;
      downloadBlob(zip.blob, filename);
      setDone(
        `已生成 ${cache.stats.fileCount} 个瓦片（${(cache.stats.totalBytes / 1024).toFixed(1)} KB），` +
          `最大层级 z${cache.stats.maxZoom ?? max}；zip 已开始下载：${filename}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  };

  const busy = progress !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="generate-cache-dialog">
        <DialogHeader>
          <DialogTitle>{mode === "vector" ? "生成 XYZ 缓存（矢量渲染）" : "生成 XYZ 缓存（底图区域）"}</DialogTitle>
          <DialogDescription>
            {mode === "vector"
              ? "把选中矢量图层按缩放级别渲染为 {z}/{x}/{y}.png 瓦片并打包 zip 下载。"
              : "按选中图层的范围抓取底图瓦片（URL 模板需含 {z}/{x}/{y}）并打包 zip 下载。"}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="cache-layer">范围来源图层</Label>
            <Select
              id="cache-layer"
              value={layer?.id ?? ""}
              onChange={(e) => setLayerId(e.target.value)}
              disabled={vectorLayers.length === 0}
            >
              {vectorLayers.length === 0 ? <option value="">（无含几何的矢量图层）</option> : null}
              {vectorLayers.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="cache-zmin">最小层级</Label>
              <Input
                id="cache-zmin"
                type="number"
                min={MIN_ZOOM_MIN}
                max={MAX_ZOOM_MAX}
                value={minZoom}
                onChange={(e) => setMinZoom(Number(e.target.value))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="cache-zmax">最大层级（≤22）</Label>
              <Input
                id="cache-zmax"
                type="number"
                min={MIN_ZOOM_MIN}
                max={MAX_ZOOM_MAX}
                value={maxZoom}
                onChange={(e) => setMaxZoom(Number(e.target.value))}
              />
            </div>
          </div>
          {mode === "region" ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="cache-url">底图 URL 模板</Label>
                <Input
                  id="cache-url"
                  value={urlTemplate}
                  onChange={(e) => setUrlTemplate(e.target.value)}
                  placeholder="https://tile.example.com/{z}/{x}/{y}.png"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cache-token">访问令牌（可选，模板含 {"{token}"} 时代入）</Label>
                <Input id="cache-token" value={token} onChange={(e) => setToken(e.target.value)} />
              </div>
            </>
          ) : null}
          {busy ? (
            <div className="h-2 w-full overflow-hidden rounded bg-muted" role="progressbar" aria-label="生成进度">
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
              />
            </div>
          ) : null}
          {error ? <p className="text-xs text-red-600">{error}</p> : null}
          {done ? <p className="text-xs text-emerald-600">{done}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              关闭
            </Button>
            <Button
              disabled={busy || !layer?.geojson || (mode === "region" && urlTemplate.trim() === "")}
              onClick={() => void run()}
            >
              {busy ? "生成中…" : "开始生成"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
