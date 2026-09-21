/*
  panels/ReprojectionDialog —— 坐标重投影（Phase 2 PR5）

  选中矢量图层 → 源/目标坐标系 → transformGeoJSON（@geolibre/processing，
  proj4 + 七参数支持）→ 结果作为新图层加入（EPSG:4326 供 Web 墨卡托渲染）。
  坐标系清单来自 processing 的 CRS 注册表（内置 + CGCS2000 3 度带 + UTM），
  另支持自定义 proj4 定义字符串。全部纯客户端。
*/
import { useMemo, useState } from "react";

import { useAppStore } from "@geolibre/core";
import {
  BUILTIN_CRS_LIST,
  generateCgcs2000GaussKruger3,
  getUtmCrs,
  transformGeoJSON,
} from "@geolibre/processing";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  Textarea,
} from "@geolibre/ui";

import { getVectorLayers } from "../../lib/dialog-layer-utils";

const CUSTOM = "__custom__";

function buildCrsOptions(): { code: string; name: string }[] {
  const cgcs = generateCgcs2000GaussKruger3().map((c) => ({ code: c.code, name: c.name }));
  const utm = [47, 48, 49, 50, 51, 52, 53, 54].map((zone) => {
    const c = getUtmCrs(zone);
    return { code: c.code, name: c.name };
  });
  const builtin = BUILTIN_CRS_LIST.map((c) => ({ code: c.code, name: c.name }));
  // 去重（BUILTIN 已含部分 CGCS2000 条目）
  const seen = new Set<string>();
  return [...builtin, ...cgcs, ...utm].filter((c) => {
    if (seen.has(c.code)) return false;
    seen.add(c.code);
    return true;
  });
}

export function ReprojectionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const layers = useAppStore((s) => s.layers);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const vectorLayers = useMemo(() => getVectorLayers(layers), [layers]);
  const [layerId, setLayerId] = useState<string>("");
  const [fromCrs, setFromCrs] = useState("EPSG:4326");
  const [toCrs, setToCrs] = useState("EPSG:4490");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const crsOptions = useMemo(buildCrsOptions, []);
  const layer = vectorLayers.find((l) => l.id === layerId) ?? vectorLayers[0];

  const run = async () => {
    if (!layer?.geojson) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const from = fromCrs === CUSTOM ? customFrom.trim() : fromCrs;
      const to = toCrs === CUSTOM ? customTo.trim() : toCrs;
      if (!from || !to) throw new Error("请填写自定义 proj4 定义字符串");
      const out = transformGeoJSON(layer.geojson as unknown as Parameters<typeof transformGeoJSON>[0], from, to, {
        keepHeight: true,
      });
      const name = `${layer.name}（${to}）`;
      if (out.type !== "FeatureCollection") throw new Error("转换结果不是 FeatureCollection");
      addGeoJsonLayer(name, out as Parameters<typeof addGeoJsonLayer>[1]);
      setDone(`已生成图层「${name}」（${String(out.type)}）`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="reprojection-dialog">
        <DialogHeader>
          <DialogTitle>坐标重投影</DialogTitle>
          <DialogDescription>把矢量图层的 GeoJSON 坐标在坐标系间转换（proj4，纯客户端）。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="reproj-layer">矢量图层</Label>
            <Select
              id="reproj-layer"
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
              <Label htmlFor="reproj-from">源坐标系</Label>
              <Select id="reproj-from" value={fromCrs} onChange={(e) => setFromCrs(e.target.value)}>
                {crsOptions.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} · {c.name}
                  </option>
                ))}
                <option value={CUSTOM}>自定义 proj4…</option>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="reproj-to">目标坐标系</Label>
              <Select id="reproj-to" value={toCrs} onChange={(e) => setToCrs(e.target.value)}>
                {crsOptions.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} · {c.name}
                  </option>
                ))}
                <option value={CUSTOM}>自定义 proj4…</option>
              </Select>
            </div>
          </div>
          {fromCrs === CUSTOM ? (
            <div className="grid gap-1.5">
              <Label htmlFor="reproj-custom-from">源 proj4 定义</Label>
              <Textarea id="reproj-custom-from" rows={2} value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} placeholder="+proj=tmerc +lat_0=0 +lon_0=105 +k=1 …" />
            </div>
          ) : null}
          {toCrs === CUSTOM ? (
            <div className="grid gap-1.5">
              <Label htmlFor="reproj-custom-to">目标 proj4 定义</Label>
              <Textarea id="reproj-custom-to" rows={2} value={customTo} onChange={(e) => setCustomTo(e.target.value)} placeholder="+proj=longlat +datum=WGS84 +no_defs" />
            </div>
          ) : null}
          {error ? <p className="text-xs text-red-600">{error}</p> : null}
          {done ? <p className="text-xs text-emerald-600">{done}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
            <Button disabled={busy || !layer?.geojson} onClick={() => void run()}>
              {busy ? "转换中…" : "开始转换"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
