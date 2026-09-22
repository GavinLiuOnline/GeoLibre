/*
  ribbon/sections —— 把 Ribbon 命令并入既有菜单的通用小节

  供 AddDataMenu / ViewMenu / EditMenu 等在自身末尾追加一节
  「GIS 工具」条目：每条 = 内联 SVG 图标 + 标签 + 快捷键提示，
  点击经由 TopToolbar 注入的 runner（ribbonCtx.findCommand(id).run）分发。
  真实现直达功能，未接入的由 ctx 统一提示兜底。
*/
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@geolibre/ui";

import { findCommand, ribbonIconSvg } from "../../command/ribbon/commands";

export interface RibbonSectionProps {
  /** 小节标题（如「本地缓存与数据处理」） */
  label: string;
  /** 要并入的 ribbon command id 列表 */
  ids: string[];
  /** 命令分发器（TopToolbar 注入：findCommand(id).run(ctx)） */
  run: (id: string) => void;
}

export function RibbonMenuSection({ label, ids, run }: RibbonSectionProps) {
  const commands = ids
    .map((id) => findCommand(id))
    .filter((cmd): cmd is NonNullable<ReturnType<typeof findCommand>> => Boolean(cmd));
  if (commands.length === 0) return null;

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      {commands.map((cmd) => (
        <DropdownMenuItem
          key={cmd.id}
          title={cmd.pending ? `${cmd.hint ?? cmd.label}（功能开发中，后续阶段接入）` : (cmd.hint ?? cmd.label)}
          data-ribbon-command={cmd.id}
          disabled={Boolean(cmd.pending)}
          onSelect={() => {
            try {
              run(cmd.id);
            } catch (error) {
              console.error(`ribbon command ${cmd.id} failed`, error);
            }
          }}
        >
          <span
            aria-hidden="true"
            className="me-2 h-3.5 w-3.5 shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5"
            dangerouslySetInnerHTML={{ __html: ribbonIconSvg(cmd.icon) }}
          />
          <span className="flex-1">{cmd.label}</span>
          {cmd.pending ? (
            <span className="text-[10px] leading-none text-muted-foreground">开发中</span>
          ) : null}
          {cmd.shortcut ? (
            <span className="ms-4 text-xs text-muted-foreground">{cmd.shortcut}</span>
          ) : null}
        </DropdownMenuItem>
      ))}
    </>
  );
}
