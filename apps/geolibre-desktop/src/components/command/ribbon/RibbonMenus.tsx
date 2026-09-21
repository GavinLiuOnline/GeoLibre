/*
  ribbon/RibbonMenus —— Ribbon 命令 → 顶部菜单栏下拉菜单

  按 PR3 用户反馈调整：Ribbon 的七个选项卡（文件/数据/缓存/发布/视图/工具/帮助）
  不再是独立选项卡条，而是与「项目」「编辑」同款的标准下拉菜单
  （@geolibre/ui DropdownMenu + ToolbarChrome 样式），融入原菜单栏。

  渲染原则不变：组件只渲染，命令与分支全部来自 buildRibbonCommands(ctx)。
  组间用分隔线；条目 = 内联 SVG 图标 + 标签 + 快捷键提示。
*/
import { useMemo } from "react";

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@geolibre/ui";

import { buildRibbonCommands, ribbonIconSvg, type RibbonContext } from "./commands";
import type { ToolbarChrome } from "../../layout/toolbar/constants";

interface RibbonMenusProps {
  ctx: RibbonContext;
  chrome: ToolbarChrome;
  className?: string;
}

const iconHtml = (name: string) => ({
  __html: ribbonIconSvg(name),
});

export function RibbonMenus({ ctx, chrome, className }: RibbonMenusProps) {
  const tabs = useMemo(() => buildRibbonCommands(ctx), [ctx]);

  return (
    <div className={className} data-testid="ribbon-menus">
      {tabs.map((tab) => (
        <DropdownMenu key={tab.id}>
          <DropdownMenuTrigger asChild>
            <Button
              className={chrome.buttonClass}
              variant="ghost"
              size={chrome.buttonSize}
              aria-label={tab.label}
            >
              {tab.label}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-56">
            <DropdownMenuLabel>{tab.label}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {tab.groups.map((group, groupIndex) => (
              <div key={group.id}>
                {groupIndex > 0 ? <DropdownMenuSeparator /> : null}
                {group.commands.map((cmd) => (
                  <DropdownMenuItem
                    key={cmd.id}
                    title={cmd.hint ?? cmd.label}
                    onSelect={() => {
                      try {
                        cmd.run(ctx);
                      } catch (error) {
                        console.error(`ribbon command ${cmd.id} failed`, error);
                      }
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className="me-2 h-3.5 w-3.5 shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5"
                      dangerouslySetInnerHTML={iconHtml(cmd.icon)}
                    />
                    <span className="flex-1">{cmd.label}</span>
                    {cmd.shortcut ? (
                      <span className="ms-4 text-xs text-muted-foreground">{cmd.shortcut}</span>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
    </div>
  );
}
