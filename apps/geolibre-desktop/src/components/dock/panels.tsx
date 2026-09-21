/*
  dock/panels —— Dock 属性面板 + 输出窗（真实内容，Phase 2 PR3 反馈补充）

  - DockPropertyPanel：当前选中图层的真实属性（名称/类型/可见性/透明度/要素数）
  - DockOutputPanel：处理历史（processingHistory）真实数据流

  数据一律来自 @geolibre/core 的 useAppStore，不复制状态。
*/
import { useAppStore, type GeoLibreLayer } from "@geolibre/core";

const EMPTY: Record<string, unknown> = {};

function formatType(type: string): string {
  return type;
}

function LayerSummary({ layer }: { layer: GeoLibreLayer }) {
  const featureCount = layer.geojson?.features.length;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 p-3 text-xs">
      <dt className="text-muted-foreground">名称</dt>
      <dd className="truncate text-foreground">{layer.name}</dd>
      <dt className="text-muted-foreground">类型</dt>
      <dd className="text-foreground">{formatType(layer.type)}</dd>
      <dt className="text-muted-foreground">可见</dt>
      <dd className="text-foreground">{layer.visible ? "是" : "否"}</dd>
      <dt className="text-muted-foreground">透明度</dt>
      <dd className="text-foreground">{Math.round(layer.opacity * 100)}%</dd>
      {typeof featureCount === "number" ? (
        <>
          <dt className="text-muted-foreground">要素数</dt>
          <dd className="text-foreground">{featureCount}</dd>
        </>
      ) : null}
    </dl>
  );
}

/** Dock 属性面板：选中图层属性 / 未选中时给出操作指引 */
export function DockPropertyPanel(_props: Record<string, unknown> = EMPTY) {
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const layer = useAppStore((s) => s.layers.find((l) => l.id === s.selectedLayerId) ?? null);
  const selectLayer = useAppStore((s) => s.selectLayer);

  if (!selectedLayerId || !layer) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-muted-foreground">
        在左侧「图层」页签选择一个图层后，这里显示其属性
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs font-medium text-foreground">图层属性</span>
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => selectLayer(null)}
        >
          取消选择
        </button>
      </div>
      <LayerSummary layer={layer} />
    </div>
  );
}

/** Dock 输出窗：处理历史（真实 processingHistory 数据） */
export function DockOutputPanel(_props: Record<string, unknown> = EMPTY) {
  const history = useAppStore((s) => s.processingHistory);

  if (history.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-muted-foreground">
        暂无处理记录；运行处理工具后在此查看历史
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <ul className="divide-y divide-border text-xs">
        {history.map((run) => (
          <li key={run.id} className="flex items-center gap-2 px-3 py-1.5">
            <span className="truncate text-foreground">{run.toolName ?? run.id}</span>
            <span className="ms-auto shrink-0 text-muted-foreground">
              {new Date(run.startedAt).toLocaleTimeString()}
            </span>
            <span
              className={
                run.status === "success"
                  ? "shrink-0 text-emerald-600"
                  : run.status === "error"
                    ? "shrink-0 text-red-600"
                    : "shrink-0 text-muted-foreground"
              }
            >
              {run.status}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
