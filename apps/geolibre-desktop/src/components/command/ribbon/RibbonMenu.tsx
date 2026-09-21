/*
  ribbon/RibbonMenu —— Ribbon 菜单（自 gis-full RibbonMenu.vue 重写为 React）

  渲染原则（与注册表设计对齐）：
  - 组件只渲染，不写业务逻辑 —— 命令与分支全部来自 buildRibbonCommands(ctx)；
  - 主命令（primary）平铺在命令区；非主命令与 overflowOnly 收进右侧「更多」下拉；
  - 图标用注册表内联 SVG（静态字符串，无用户输入）；
  - 选项卡/命令区带完整 aria 语义（tablist / tab / tabpanel）。
*/
import { useEffect, useMemo, useRef, useState } from "react";

import {
  buildRibbonCommands,
  ribbonIconSvg,
  type RibbonCommand,
  type RibbonContext,
  type RibbonGroup,
} from "./commands";

interface RibbonMenuProps {
  ctx: RibbonContext;
  className?: string;
}

const iconHtml = (name: string) => ({
  __html: ribbonIconSvg(name),
});

function CommandIcon({ name, className }: { name: string; className?: string }) {
  return <span className={className} dangerouslySetInnerHTML={iconHtml(name)} />;
}

export function RibbonMenu({ ctx, className }: RibbonMenuProps) {
  const tabs = useMemo(() => buildRibbonCommands(ctx), [ctx]);
  const [activeTabId, setActiveTabId] = useState(tabs[0]?.id ?? "file");
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowWrapRef = useRef<HTMLDivElement | null>(null);

  // tab 集合随 ctx 变化（如桌面桥就绪）时，回落到仍存在的第一个选项卡
  useEffect(() => {
    if (!tabs.some((t) => t.id === activeTabId)) {
      setActiveTabId(tabs[0]?.id ?? "file");
    }
  }, [tabs, activeTabId]);

  // 点击外部关闭「更多」下拉
  useEffect(() => {
    if (!overflowOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (overflowWrapRef.current && !overflowWrapRef.current.contains(event.target as Node)) {
        setOverflowOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [overflowOpen]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  const groupPrimaryCommands = (group: RibbonGroup): RibbonCommand[] =>
    group.commands.filter((cmd) => cmd.primary && !cmd.overflowOnly);

  const overflowCommands: RibbonCommand[] = activeTab
    ? activeTab.groups.flatMap((group) =>
        group.commands.filter((cmd) => !cmd.primary || cmd.overflowOnly),
      )
    : [];

  const runCommand = (cmd: RibbonCommand) => {
    setOverflowOpen(false);
    try {
      cmd.run(ctx);
    } catch (error) {
      console.error(`ribbon command ${cmd.id} failed`, error);
    }
  };

  return (
    <div className={className} data-testid="ribbon-menu">
      {/* 选项卡行 */}
      <div
        className="flex items-end gap-0.5 border-b border-border bg-muted/40 px-2"
        role="tablist"
        aria-label="功能选项卡"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTab?.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTabId(tab.id)}
              className={`-mb-px rounded-t-md border border-b-0 px-3 py-1.5 text-sm transition-colors ${
                active
                  ? "border-border bg-background font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* 命令区 */}
      {activeTab ? (
        <div
          className="flex items-stretch gap-1 overflow-x-auto border-b border-border bg-background px-2 py-1.5"
          role="tabpanel"
          aria-label={`${activeTab.label}命令区`}
        >
          {activeTab.groups.map((group, groupIndex) => (
            <div key={group.id} className="flex items-stretch gap-1">
              <div className="flex flex-col items-center justify-between gap-1 px-1">
                <div className="flex items-center gap-0.5">
                  {groupPrimaryCommands(group).map((cmd) => (
                    <button
                      key={cmd.id}
                      type="button"
                      title={cmd.hint ?? cmd.label}
                      aria-label={cmd.label}
                      onClick={() => runCommand(cmd)}
                      className="flex min-w-16 flex-col items-center gap-0.5 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      <CommandIcon name={cmd.icon} className="h-5 w-5 [&>svg]:h-5 [&>svg]:w-5" />
                      <span className="whitespace-nowrap text-xs text-foreground">{cmd.label}</span>
                    </button>
                  ))}
                </div>
                <span className="text-[10px] leading-none text-muted-foreground">{group.label}</span>
              </div>
              {groupIndex < activeTab.groups.length - 1 ? (
                <div aria-hidden="true" className="w-px bg-border" />
              ) : null}
            </div>
          ))}

          {/* 「更多」下拉：收纳非主命令 */}
          {overflowCommands.length > 0 ? (
            <div className="relative ml-auto self-center" ref={overflowWrapRef}>
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={overflowOpen}
                aria-label="更多命令"
                onClick={() => setOverflowOpen((open) => !open)}
                className={`flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground ${
                  overflowOpen ? "bg-accent text-accent-foreground" : ""
                }`}
              >
                更多
                <span aria-hidden="true">▾</span>
              </button>
              {overflowOpen ? (
                <div
                  role="menu"
                  aria-label="更多命令"
                  className="absolute right-0 top-full z-50 mt-1 min-w-56 rounded-md border border-border bg-popover p-1 shadow-md"
                >
                  {overflowCommands.map((cmd) => (
                    <button
                      key={cmd.id}
                      type="button"
                      role="menuitem"
                      title={cmd.hint ?? cmd.label}
                      onClick={() => runCommand(cmd)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-popover-foreground transition-colors hover:bg-accent"
                    >
                      <CommandIcon name={cmd.icon} className="h-4 w-4 [&>svg]:h-4 [&>svg]:w-4" />
                      <span className="flex-1">{cmd.label}</span>
                      {cmd.shortcut ? (
                        <span className="text-xs text-muted-foreground">{cmd.shortcut}</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
