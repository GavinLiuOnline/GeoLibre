/*
  ribbon/RibbonMenu —— Ribbon 组合件（自 gis-full RibbonMenu.vue 重写为 React）

  「融入原顶部菜单」形态（Phase 2 PR3 反馈调整）：
  - RibbonTabs：选项卡条，嵌入既有 TopToolbar header 行内（与原菜单同一行）；
  - RibbonBody：当前选项卡的命令区，渲染在 header 之下整行展开；
  - 再次点击已激活选项卡 = 收起命令区（Office 风格）。

  渲染原则不变：组件只渲染，不写业务逻辑 —— 命令与分支全部来自 buildRibbonCommands(ctx)。
*/
import { useEffect, useRef, useState } from "react";

import { ribbonIconSvg, type RibbonCommand, type RibbonContext, type RibbonGroup, type RibbonTab } from "./commands";

const iconHtml = (name: string) => ({
  __html: ribbonIconSvg(name),
});

function CommandIcon({ name, className }: { name: string; className?: string }) {
  return <span className={className} dangerouslySetInnerHTML={iconHtml(name)} />;
}

// ---------------------------------------------------------------------------
// 选项卡条（嵌入 header 行内）
// ---------------------------------------------------------------------------

export interface RibbonTabsProps {
  tabs: RibbonTab[];
  activeTabId: string | null;
  /** 选择选项卡；再次选择当前项时由调用方收起（传 null） */
  onSelect: (tabId: string) => void;
  className?: string;
}

export function RibbonTabs({ tabs, activeTabId, onSelect, className }: RibbonTabsProps) {
  return (
    <div
      className={className}
      role="tablist"
      aria-label="功能选项卡"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(tab.id)}
            className={cnTab(active)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function cnTab(active: boolean): string {
  return `rounded-t-md border border-b-0 px-2.5 py-1 text-sm transition-colors ${
    active
      ? "border-border bg-background font-medium text-foreground"
      : "border-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground"
  }`;
}

// ---------------------------------------------------------------------------
// 命令区（header 之下整行）
// ---------------------------------------------------------------------------

export interface RibbonBodyProps {
  ctx: RibbonContext;
  tabs: RibbonTab[];
  activeTabId: string;
  className?: string;
}

export function RibbonBody({ ctx, tabs, activeTabId, className }: RibbonBodyProps) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowWrapRef = useRef<HTMLDivElement | null>(null);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  // 选项卡切换时收起「更多」下拉
  useEffect(() => {
    setOverflowOpen(false);
  }, [activeTabId]);

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

  if (!activeTab) return null;

  const groupPrimaryCommands = (group: RibbonGroup): RibbonCommand[] =>
    group.commands.filter((cmd) => cmd.primary && !cmd.overflowOnly);

  const overflowCommands: RibbonCommand[] = activeTab.groups.flatMap((group) =>
    group.commands.filter((cmd) => !cmd.primary || cmd.overflowOnly),
  );

  const runCommand = (cmd: RibbonCommand) => {
    setOverflowOpen(false);
    try {
      cmd.run(ctx);
    } catch (error) {
      console.error(`ribbon command ${cmd.id} failed`, error);
    }
  };

  return (
    <div
      className={className}
      role="tabpanel"
      aria-label={`${activeTab.label}命令区`}
      data-testid="ribbon-body"
    >
      <div className="flex items-stretch gap-1 overflow-x-auto px-2 py-1.5">
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
    </div>
  );
}
