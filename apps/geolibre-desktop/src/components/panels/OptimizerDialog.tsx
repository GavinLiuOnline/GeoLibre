/*
  panels/OptimizerDialog —— 数据轻量化（数据优化）

  对选中的矢量图层做 Douglas-Peucker 简化 + 坐标精度截断，结果以
  「<图层名>（轻量化）」新图层加入工程（非破坏：原图层保留），
  并在对话框内回显顶点数/体积的前后对比。
*/
import { useMemo, useState } from "react";

import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
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

import { lightweightGeoJson } from "../../lib/geojson-lightweight";

function formatVertices(n: number): string {
  return new Intl.NumberFormat().format(n);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function OptimizerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const layers = useAppStore((s) => s.layers);
  const addLayer = useAppStore((s) => s.addLayer);
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);

  const vectorLayers = useMemo(
    () => layers.filter((layer: GeoLibreLayer) => layer.type === "geojson" && layer.geojson),
    [layers],
  );
  const [layerId, setLayerId] = useState("");
  const [tolerance, setTolerance] = useState("0.0001");
  const [precision, setPrecision] = useState("6");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ added: string; before: string; after: string; size: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const effectiveLayerId = layerId || selectedLayerId || vectorLayers[0]?.id || "";
  const target = vectorLayers.find((layer) => layer.id === effectiveLayerId);

  const run = () => {
    if (!target?.geojson) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const toleranceDeg = Math.max(0, Number(tolerance) || 0);
      const precisionNum = Math.min(10, Math.max(2, Number(precision) || 6));
      const outcome = lightweightGeoJson(target.geojson, {
        toleranceDeg,
        precision: precisionNum,
      });
      const name = `${target.name}（轻量化）`;
      addLayer({
        id: `lightweight-${Date.now()}`,
        name,
        type: "geojson",
        source: { ...target.source, lightweightOf: target.id },
        visible: true,
        opacity: target.opacity,
        style: structuredClone(target.style),
        geojson: outcome.fc,
        metadata: {
          lightweightOf: target.id,
          optimizer: {
            toleranceDeg,
            precision: precisionNum,
            verticesBefore: outcome.verticesBefore,
            verticesAfter: outcome.verticesAfter,
          },
        },
      });
      setResult({
        added: name,
        before: `${formatVertices(outcome.verticesBefore)} 顶点 / ${formatBytes(outcome.bytesBefore)}`,
        after: `${formatVertices(outcome.verticesAfter)} 顶点 / ${formatBytes(outcome.bytesAfter)}`,
        size:
          outcome.bytesBefore > 0
            ? `${(((outcome.bytesBefore - outcome.bytesAfter) / outcome.bytesBefore) * 100).toFixed(1)}%`
            : "0%",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="gis-optimizer-dialog">
        <DialogHeader>
          <DialogTitle>数据轻量化</DialogTitle>
          <DialogDescription>
            对矢量图层做 Douglas-Peucker 简化与坐标精度截断；结果生成新图层，原图层保留不动。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="optimizer-layer">目标图层（矢量）</Label>
            <Select
              id="optimizer-layer"
              value={effectiveLayerId}
              onChange={(e) => setLayerId(e.target.value)}
            >
              {vectorLayers.length === 0 ? <option value="">（无矢量图层）</option> : null}
              {vectorLayers.map((layer) => (
                <option key={layer.id} value={layer.id}>
                  {layer.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="optimizer-tolerance">简化容差（度）</Label>
              <Input
                id="optimizer-tolerance"
                value={tolerance}
                onChange={(e) => setTolerance(e.target.value)}
                inputMode="decimal"
              />
              <p className="text-xs text-muted-foreground">0 为不简化；0.0001 ≈ 11 m</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="optimizer-precision">坐标小数位</Label>
              <Select id="optimizer-precision" value={precision} onChange={(e) => setPrecision(e.target.value)}>
                <option value="7">7（≈1.1 cm）</option>
                <option value="6">6（≈0.11 m）</option>
                <option value="5">5（≈1.1 m）</option>
                <option value="4">4（≈11 m）</option>
              </Select>
            </div>
          </div>

          {result ? (
            <div className="rounded-md border border-border bg-muted/40 p-3 text-xs">
              <p className="text-emerald-600">已生成「{result.added}」</p>
              <p className="mt-1 text-muted-foreground">
                前：{result.before}　→　后：{result.after}（体积 −{result.size}）
              </p>
            </div>
          ) : null}
          {error ? <p className="text-xs text-red-600">{error}</p> : null}

          <Button onClick={run} disabled={busy || !target}>
            {busy ? "处理中…" : "生成轻量化图层"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
