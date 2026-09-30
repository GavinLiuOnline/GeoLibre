/*
  panels/ScenesDialog —— 从服务端打开场景（发布 ↔ 打开闭环）

  列出 gis-server 已托管场景（GET /api/scenes），选择后拉取完整
  SceneDocument（GET /api/scenes/:id），经 lib/scene-document 反向转换：
  图层 → GeoLibreLayer（替换当前工程图层）、camera → MapViewState、
  激活底图 → basemapStyleUrl；无法还原的类型列入 skipped 并提示。
*/
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAppStore } from "@geolibre/core";

import {
  GisServerRequestError,
  getGisServerUrl,
  getGisScene,
  listGisScenes,
  type GisSceneSummary,
} from "../../lib/gis-server-client";
import { sceneDocumentToProject } from "../../lib/scene-document";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@geolibre/ui";

type LoadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "done"; opened: string; layers: number; skipped: { name: string; reason: string }[] };

export function ScenesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const [scenes, setScenes] = useState<GisSceneSummary[]>([]);
  const [connError, setConnError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>({ phase: "idle" });

  const refresh = useCallback(async () => {
    setLoadingList(true);
    setConnError(null);
    try {
      setScenes(await listGisScenes());
    } catch (e) {
      setConnError(e instanceof GisServerRequestError ? e.message : String(e));
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const openScene = async (summary: GisSceneSummary) => {
    if (!summary.id) return;
    setLoadState({ phase: "loading" });
    try {
      const doc = await getGisScene(summary.id);
      const result = sceneDocumentToProject(doc, getGisServerUrl());
      const store = useAppStore.getState();
      // 打开场景 = 替换当前工作集（与正向「发布场景」语义对称）
      for (const layer of store.layers) store.removeLayer(layer.id);
      for (const layer of result.layers) store.addLayer(layer);
      if (result.camera) store.setMapView(result.camera, true);
      if (result.basemapUrl) store.setBasemapStyleUrl(result.basemapUrl);
      setLoadState({
        phase: "done",
        opened: doc.name || summary.name || summary.id,
        layers: result.layers.length,
        skipped: result.skipped,
      });
    } catch (e) {
      setLoadState({
        phase: "error",
        message: e instanceof GisServerRequestError ? e.message : String(e),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="gis-scenes-dialog">
        <DialogHeader>
          <DialogTitle>{t("gisServer.scenesTitle")}</DialogTitle>
          <DialogDescription>{t("gisServer.scenesDescription")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="flex items-center justify-between">
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loadingList}>
              {t("gisServer.refresh")}
            </Button>
            <span className="text-xs text-muted-foreground">
              {getGisServerUrl()}
            </span>
          </div>

          {connError ? <p className="text-xs text-red-600">{connError}</p> : null}

          {scenes.length === 0 && !connError && !loadingList ? (
            <p className="text-xs text-muted-foreground">{t("gisServer.scenesEmpty")}</p>
          ) : null}

          <ul className="max-h-64 overflow-y-auto rounded-md border border-border">
            {scenes.map((scene) => (
              <li
                key={scene.id ?? scene.name}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{scene.name ?? scene.id}</p>
                  {scene.updatedAt ? (
                    <p className="text-xs text-muted-foreground">{scene.updatedAt}</p>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!scene.id || loadState.phase === "loading"}
                  onClick={() => void openScene(scene)}
                >
                  {t("gisServer.scenesOpen")}
                </Button>
              </li>
            ))}
          </ul>

          {loadState.phase === "error" ? (
            <p className="text-xs text-red-600">{loadState.message}</p>
          ) : null}
          {loadState.phase === "done" ? (
            <div className="rounded-md border border-border bg-muted/40 p-3 text-xs">
              <p className="text-emerald-600">
                {t("gisServer.scenesOpened", { name: loadState.opened, count: loadState.layers })}
              </p>
              {loadState.skipped.length > 0 ? (
                <ul className="mt-1 list-inside list-disc text-muted-foreground">
                  {loadState.skipped.map((item) => (
                    <li key={item.name}>
                      {t("gisServer.scenesSkipped", { name: item.name, reason: item.reason })}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
