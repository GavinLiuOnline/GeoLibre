/**
 * Labels and DOM workbench for the 3D Tiles pipeline plugin.
 */

import type { Tiles3dPipelineLabels } from "./labels";
import type { CrsPreset, LocalCrsSettings, ModelGcp, PipelineStep, Placement, QaReport, RegisterMode } from "./types";
import { PIPELINE_STEPS } from "./types";
import { parseProj4Params, proj4FromLocalCrs, proj4StringForParams } from "./crs";
import { defaultProj4ParamLabel } from "./labels";

export type { Tiles3dPipelineLabels };

const STEP_LABEL_KEY: Record<PipelineStep, keyof Tiles3dPipelineLabels> = {
  import: "stepImport",
  register: "stepRegister",
  optimize: "stepOptimize",
  export: "stepExport",
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style?: Partial<CSSStyleDeclaration>,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (style) Object.assign(node.style, style);
  if (text !== undefined) node.textContent = text;
  return node;
}

function fieldStyle(): Partial<CSSStyleDeclaration> {
  return {
    width: "100%",
    padding: "4px 6px",
    border: "1px solid hsl(var(--border))",
    borderRadius: "6px",
    background: "hsl(var(--background))",
    color: "inherit",
    font: "inherit",
  };
}

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const node = el("button", {
    padding: "6px 10px",
    border: primary ? "1px solid transparent" : "1px solid hsl(var(--border))",
    borderRadius: "6px",
    background: primary ? "hsl(var(--primary))" : "hsl(var(--background))",
    color: primary ? "hsl(var(--primary-foreground))" : "inherit",
    cursor: "pointer",
    font: "inherit",
  });
  node.type = "button";
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

function numericInput(
  value: number,
  onChange: (n: number) => void,
  step = "any",
): HTMLInputElement {
  const input = el("input", fieldStyle()) as HTMLInputElement;
  input.type = "number";
  input.step = step;
  input.value = String(value);
  input.addEventListener("change", () => {
    const n = Number(input.value);
    if (Number.isFinite(n)) onChange(n);
  });
  return input;
}

function labeled(labelText: string, control: HTMLElement): HTMLLabelElement {
  const label = el("label", {
    display: "grid",
    gap: "4px",
    fontSize: "12px",
  }) as HTMLLabelElement;
  label.append(el("span", { fontWeight: "600" }, labelText), control);
  return label;
}

function checkbox(checked: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const input = el("input") as HTMLInputElement;
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return input;
}

export interface PipelinePanelModel {
  step: PipelineStep;
  fileName: string | null;
  kind: "mesh" | "points" | "tileset" | null;
  vertexCount: number;
  triangleCount: number;
  registerMode: RegisterMode;
  crs: LocalCrsSettings;
  gcps: ModelGcp[];
  placement: Placement;
  weldEpsilon: number;
  reduction: number;
  lodLevels: number;
  quantize: boolean;
  pickOrigin: boolean;
  status: string;
  qa: QaReport | null;
  labels: Tiles3dPipelineLabels;
}

export interface PipelinePanelHandlers {
  onStep: (step: PipelineStep) => void;
  onPickFile: () => void;
  onPickFolder: () => void;
  onRegisterMode: (mode: RegisterMode) => void;
  onCrs: (patch: Partial<LocalCrsSettings>) => void;
  onCrsDefinition: (raw: string) => void;
  onProj4Param: (key: string, value: string, flag?: boolean) => void;
  onApplyCrs: () => void;
  onPlacement: (patch: Partial<Placement>) => void;
  onOptimize: (patch: {
    weldEpsilon?: number;
    reduction?: number;
    lodLevels?: number;
    quantize?: boolean;
  }) => void;
  onAddGcp: () => void;
  onRemoveGcp: (id: string) => void;
  onGcpChange: (id: string, patch: Partial<ModelGcp>) => void;
  onFitGcps: () => void;
  onTogglePickOrigin: () => void;
  onExport: () => void;
  onAddTileset: () => void;
}

const PRESET_LABEL: Record<CrsPreset, keyof Tiles3dPipelineLabels> = {
  enu: "crsEnu",
  "wgs84-utm": "crsWgs84Utm",
  "web-mercator": "crsWebMercator",
  "albers-china": "crsAlbersChina",
  "cgcs2000-gk3": "crsCgcs2000Gk3",
  "cgcs2000-gk6": "crsCgcs2000Gk6",
  "bj54-gk3": "crsBj54Gk3",
  "bj54-gk6": "crsBj54Gk6",
  custom: "crsCustom",
};

function kindLabel(model: PipelinePanelModel): string {
  if (model.kind === "points") return model.labels.kindPoints;
  if (model.kind === "tileset") return model.labels.kindTileset;
  return model.labels.kindMesh;
}

function renderQa(root: HTMLElement, model: PipelinePanelModel): void {
  const { labels, qa } = model;
  if (!qa) return;
  const box = el("div", {
    display: "grid",
    gap: "4px",
    fontSize: "12px",
    padding: "8px",
    border: "1px solid hsl(var(--border))",
    borderRadius: "8px",
  });
  box.append(
    el("div", { fontWeight: "600" }, labels.qaTitle),
    el("div", undefined, `${labels.vertices}: ${qa.vertexCount.toLocaleString()}`),
    el("div", undefined, `${labels.triangles}: ${qa.triangleCount.toLocaleString()}`),
    el(
      "div",
      undefined,
      qa.geographicBounds
        ? `${labels.bounds}: ${qa.geographicBounds.map((n) => n.toFixed(5)).join(", ")}`
        : "",
    ),
    el(
      "div",
      undefined,
      qa.residualRmsMeters !== null
        ? `${labels.residualRms}: ${qa.residualRmsMeters.toFixed(3)} m`
        : `${labels.gcpCount}: ${qa.gcpCount}`,
    ),
  );
  for (const level of qa.lodLevels) {
    box.append(
      el(
        "div",
        undefined,
        `${labels.lodLevel} ${level.level}: ${level.vertices.toLocaleString()} ${labels.vertices.toLowerCase()}, GE ${level.geometricError.toFixed(2)}`,
      ),
    );
  }
  for (const issue of qa.issues) {
    box.append(
      el(
        "div",
        {
          color:
            issue.level === "error"
              ? "hsl(var(--destructive))"
              : issue.level === "warning"
                ? "hsl(var(--warning, 38 92% 40%))"
                : "hsl(var(--muted-foreground))",
        },
        issue.message,
      ),
    );
  }
  root.appendChild(box);
}

function renderPlacement(root: HTMLElement, model: PipelinePanelModel, handlers: PipelinePanelHandlers): void {
  const { labels } = model;
  const grid = el("div", { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" });
  const p = model.placement;
  grid.append(
    labeled(labels.longitude, numericInput(p.longitude, (n) => handlers.onPlacement({ longitude: n }))),
    labeled(labels.latitude, numericInput(p.latitude, (n) => handlers.onPlacement({ latitude: n }))),
    labeled(labels.height, numericInput(p.height, (n) => handlers.onPlacement({ height: n }))),
    labeled(labels.heading, numericInput(p.heading, (n) => handlers.onPlacement({ heading: n }))),
    labeled(labels.pitch, numericInput(p.pitch, (n) => handlers.onPlacement({ pitch: n }))),
    labeled(labels.roll, numericInput(p.roll, (n) => handlers.onPlacement({ roll: n }))),
    labeled(labels.scale, numericInput(p.scale, (n) => handlers.onPlacement({ scale: n }))),
  );
  root.appendChild(grid);
  const pick = button(
    model.pickOrigin ? labels.pickingOrigin : labels.pickOrigin,
    handlers.onTogglePickOrigin,
    model.pickOrigin,
  );
  root.appendChild(pick);
}

export function renderPipelinePanel(
  container: HTMLElement,
  model: PipelinePanelModel,
  handlers: PipelinePanelHandlers,
): void {
  container.replaceChildren();
  const labels = model.labels;
  container.style.font = "13px/1.45 system-ui, sans-serif";
  container.style.color = "hsl(var(--foreground))";

  const root = el("div", {
    display: "grid",
    gap: "12px",
    padding: "12px",
    paddingInline: "12px",
  });
  container.appendChild(root);

  root.appendChild(
    el(
      "p",
      { margin: "0", fontSize: "12px", color: "hsl(var(--muted-foreground))" },
      labels.intro,
    ),
  );

  const steps = el("div", {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
  });
  for (const step of PIPELINE_STEPS) {
    const active = step === model.step;
    const tab = button(String(labels[STEP_LABEL_KEY[step]]), () => handlers.onStep(step), active);
    tab.style.fontSize = "12px";
    steps.appendChild(tab);
  }
  root.appendChild(steps);

  if (model.step === "import") {
    const actions = el("div", { display: "flex", flexWrap: "wrap", gap: "8px" });
    actions.append(button(labels.chooseFile, handlers.onPickFile, true), button(labels.chooseFolder, handlers.onPickFolder));
    root.appendChild(actions);
    root.appendChild(
      el(
        "p",
        { margin: "0", fontSize: "12px", color: "hsl(var(--muted-foreground))" },
        labels.formatsHint,
      ),
    );
    if (model.fileName) {
      const summary = el("div", { display: "grid", gap: "2px", fontSize: "12px" });
      summary.append(
        el("div", undefined, `${labels.file}: ${model.fileName}`),
        el("div", undefined, `${labels.kind}: ${kindLabel(model)}`),
      );
      if (model.kind !== "tileset") {
        summary.append(
          el("div", undefined, `${labels.vertices}: ${model.vertexCount.toLocaleString()}`),
          el("div", undefined, `${labels.triangles}: ${model.triangleCount.toLocaleString()}`),
        );
      }
      root.appendChild(summary);
    }
  }

  if (model.step === "register") {
    root.appendChild(el("p", { margin: "0", fontSize: "12px" }, labels.registerHint));
    const modes = el("div", { display: "flex", flexWrap: "wrap", gap: "4px" });
    modes.append(
      button(labels.registerModeCrs, () => handlers.onRegisterMode("crs"), model.registerMode === "crs"),
      button(labels.registerModeGcp, () => handlers.onRegisterMode("gcp"), model.registerMode === "gcp"),
    );
    root.appendChild(modes);

    if (model.registerMode === "crs") {
      const area = el("textarea", { ...fieldStyle(), minHeight: "64px" }) as HTMLTextAreaElement;
      area.value = model.crs.customProj4.trim() || proj4FromLocalCrs(model.crs) || "";
      area.placeholder = "+proj=utm +zone=50 +datum=WGS84 +units=m +no_defs";
      area.spellcheck = false;
      area.autocomplete = "off";
      area.setAttribute("autocorrect", "off");
      area.setAttribute("autocapitalize", "off");
      area.lang = "zxx";
      const commitDefinition = () => handlers.onCrsDefinition(area.value);
      area.addEventListener("change", commitDefinition);
      area.addEventListener("paste", () => {
        requestAnimationFrame(commitDefinition);
      });
      root.appendChild(labeled(labels.crsCustomProj4, area));
      if (labels.crsPasteHint) {
        root.appendChild(
          el("p", { margin: "0", fontSize: "11px", color: "hsl(var(--muted-foreground))" }, labels.crsPasteHint),
        );
      }

      const definition = proj4StringForParams(model.crs);
      const params = parseProj4Params(definition);
      if (params.length) {
        root.appendChild(el("div", { fontWeight: "600", fontSize: "12px" }, labels.crsParamsTitle));
        const paramGrid = el("div", { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" });
        const caption = (key: string) => labels.crsParamLabel?.(key) ?? defaultProj4ParamLabel(key);
        for (const param of params) {
          if (param.flag) {
            paramGrid.appendChild(
              labeled(
                caption(param.key),
                checkbox(true, (checked) => handlers.onProj4Param(param.key, "", checked)),
              ),
            );
            continue;
          }
          const numeric = param.value !== "" && Number.isFinite(Number(param.value));
          if (numeric) {
            paramGrid.appendChild(
              labeled(
                caption(param.key),
                numericInput(Number(param.value), (n) => handlers.onProj4Param(param.key, String(n))),
              ),
            );
          } else {
            const input = el("input", fieldStyle()) as HTMLInputElement;
            input.type = "text";
            input.spellcheck = false;
            input.value = param.value;
            input.addEventListener("change", () => handlers.onProj4Param(param.key, input.value));
            paramGrid.appendChild(labeled(caption(param.key), input));
          }
        }
        root.appendChild(paramGrid);
      }

      const preset = el("select", fieldStyle()) as HTMLSelectElement;
      const presets: CrsPreset[] = [
        "enu",
        "wgs84-utm",
        "web-mercator",
        "albers-china",
        "cgcs2000-gk3",
        "cgcs2000-gk6",
        "bj54-gk3",
        "bj54-gk6",
        "custom",
      ];
      for (const value of presets) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = String(labels[PRESET_LABEL[value]]);
        preset.appendChild(option);
      }
      preset.value = model.crs.preset;
      preset.addEventListener("change", () => handlers.onCrs({ preset: preset.value as CrsPreset }));
      root.appendChild(labeled(labels.crsPreset, preset));

      const needsZone = model.crs.preset === "wgs84-utm" || model.crs.preset.startsWith("cgcs") || model.crs.preset.startsWith("bj54");
      if (needsZone) {
        root.appendChild(
          labeled(labels.crsZone, numericInput(model.crs.zone, (n) => handlers.onCrs({ zone: n }), "1")),
        );
        if (model.crs.preset !== "wgs84-utm") {
          root.appendChild(labeled(labels.crsZoneInEasting, checkbox(model.crs.zoneInEasting, (v) => handlers.onCrs({ zoneInEasting: v }))));
        }
      }
      const grid = el("div", { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" });
      grid.append(
        labeled(labels.crsOffsetX, numericInput(model.crs.offsetX, (n) => handlers.onCrs({ offsetX: n }))),
        labeled(labels.crsOffsetY, numericInput(model.crs.offsetY, (n) => handlers.onCrs({ offsetY: n }))),
        labeled(labels.crsOffsetZ, numericInput(model.crs.offsetZ, (n) => handlers.onCrs({ offsetZ: n }))),
      );
      root.appendChild(grid);
      root.appendChild(
        labeled(labels.crsModelProjected, checkbox(model.crs.modelIsProjected, (v) => handlers.onCrs({ modelIsProjected: v }))),
      );
      root.appendChild(button(labels.crsApply, handlers.onApplyCrs, true));
    } else {
      root.appendChild(button(labels.addGcp, handlers.onAddGcp));
      for (const gcp of model.gcps) {
        const card = el("div", {
          display: "grid",
          gap: "6px",
          padding: "8px",
          border: "1px solid hsl(var(--border))",
          borderRadius: "8px",
        });
        const grid = el("div", {
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: "6px",
        });
        const field = (key: keyof ModelGcp, label: string, value: number) =>
          labeled(
            label,
            numericInput(value, (n) => handlers.onGcpChange(gcp.id, { [key]: n })),
          );
        grid.append(
          field("modelX", labels.modelX, gcp.modelX),
          field("modelY", labels.modelY, gcp.modelY),
          field("modelZ", labels.modelZ, gcp.modelZ),
          field("longitude", labels.longitude, gcp.longitude),
          field("latitude", labels.latitude, gcp.latitude),
          field("height", labels.height, gcp.height),
        );
        card.append(grid, button(labels.removeGcp, () => handlers.onRemoveGcp(gcp.id)));
        root.appendChild(card);
      }
      root.appendChild(button(labels.fitGcps, handlers.onFitGcps, true));
    }

    renderPlacement(root, model, handlers);
  }

  if (model.step === "optimize") {
    root.appendChild(el("p", { margin: "0", fontSize: "12px" }, labels.optimizeHint));
    root.appendChild(
      labeled(
        labels.weldEpsilon,
        numericInput(model.weldEpsilon, (n) => handlers.onOptimize({ weldEpsilon: n })),
      ),
    );
    const reduction = el("input") as HTMLInputElement;
    reduction.type = "range";
    reduction.min = "5";
    reduction.max = "100";
    reduction.value = String(Math.round(model.reduction * 100));
    reduction.addEventListener("input", () =>
      handlers.onOptimize({ reduction: Number(reduction.value) / 100 }),
    );
    root.appendChild(labeled(`${labels.reduction} (${Math.round(model.reduction * 100)}%)`, reduction));
    const lod = el("input") as HTMLInputElement;
    lod.type = "range";
    lod.min = "1";
    lod.max = "6";
    lod.value = String(model.lodLevels);
    lod.addEventListener("input", () => handlers.onOptimize({ lodLevels: Number(lod.value) }));
    root.appendChild(labeled(`${labels.lodLevels} (${model.lodLevels})`, lod));
    const quant = el("input") as HTMLInputElement;
    quant.type = "checkbox";
    quant.checked = model.quantize;
    quant.addEventListener("change", () => handlers.onOptimize({ quantize: quant.checked }));
    root.appendChild(labeled(labels.quantize, quant));
  }

  if (model.step === "export") {
    root.appendChild(el("p", { margin: "0", fontSize: "12px" }, labels.exportHint));
    const actions = el("div", { display: "flex", flexWrap: "wrap", gap: "8px" });
    actions.append(button(labels.exportZip, handlers.onExport, true), button(labels.addTileset, handlers.onAddTileset));
    root.appendChild(actions);
    renderQa(root, model);
  }

  if (model.status) {
    root.appendChild(
      el("p", { margin: "0", fontSize: "12px", color: "hsl(var(--muted-foreground))" }, model.status),
    );
  }
}
