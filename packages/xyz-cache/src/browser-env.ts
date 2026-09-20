/**
 * editor/core · browserEnv —— 运行环境 / 浏览器引擎探测（纯逻辑，零依赖）
 *
 * 起因（t23）：用户在 **Firefox** 里上传本地缓存目录（实测 `/home/nuanyang/tiles`
 * 242 万文件 / 15GB）浏览器崩溃。Firefox 与 Chromium 的差异无法用 feature detect
 * 区分（`webkitdirectory` 两边都支持），真正的差异是行为与策略：
 * 1. FileList 物化时机：Chromium 可流式处理，Firefox 在选择目录时就一次性物化
 *    整个 FileList（百万级 File 对象 ≈ 数 GB）→ 浏览器自身崩溃；
 * 2. `webkitRelativePath` 边界（分隔符 / 缺失 / 0 字节文件）与 Chromium 不完全一致；
 * 3. `URL.createObjectURL` 大批量下的 GC 行为差异；
 * 4. `file://` 受更严的安全策略（Firefox 下 `file://` fetch 基本必失败）。
 *
 * 因此把「引擎识别」抽成纯函数：可在 node 单测里用任意 UA 字符串回归，
 * `detectBrowser(input)` 支持注入 UA / userAgentData / Electron 版本；
 * `readBrowserEnv()` 读真实运行环境（无 navigator 时返回 'unknown'，不抛错）。
 *
 * 设计取舍：**只做引擎识别 + 能力信号，不做特性嗅探分支** —— 各引擎都支持
 * `webkitdirectory`，分支的意义在于「限额与引导」而不是「功能可用性」，
 * 具体限额与提示文案在 `stores/directoryIntake.ts`（策略层）。
 */

/** 浏览器引擎（Electron 单列：它的 file:// 能力与标准浏览器不同） */
export type BrowserEngine = 'firefox' | 'chromium' | 'webkit' | 'electron' | 'unknown';

export interface BrowserEnv {
  engine: BrowserEngine;
  isFirefox: boolean;
  isChromium: boolean;
  isWebKit: boolean;
  isElectron: boolean;
  /** 原始 UA（诊断 / 日志用；为空表示无 navigator） */
  userAgent: string;
  /** `navigator.userAgentData` 是否存在（Chromium 独有信号，UA 被裁剪时兜底） */
  hasUserAgentData: boolean;
}

export interface BrowserEnvInput {
  userAgent?: string;
  hasUserAgentData?: boolean;
  /** Electron 版本（`window.process.versions.electron` / 主进程注入） */
  electronVersion?: string;
}

/**
 * UA 是否为 Firefox 系（桌面 / Android；Firefox iOS 是 WebKit 内核，不算）。
 *
 * 覆盖：`Firefox/…`、`Waterfox/…`、`LibreWolf`、`Iceweasel`、`SeaMonkey`，
 * 以及 `rv:… Gecko/20100101` 但**不含** Chrome 的旧式 UA。
 */
export function isFirefoxUserAgent(userAgent: string): boolean {
  const ua = String(userAgent ?? '');
  if (!ua) return false;
  if (/FxiOS\//i.test(ua)) return false; // Firefox iOS = WebKit
  if (/Firefox\/|Waterfox\/|LibreWolf|Iceweasel|SeaMonkey/i.test(ua)) return true;
  return /\brv:\d/.test(ua) && /Gecko\/\d{8}/i.test(ua) && !/Chrome\/|Chromium\//i.test(ua);
}

/** UA 是否为 Electron（渲染进程里 UA 会带 `Electron/<version>`） */
export function isElectronUserAgent(userAgent: string): boolean {
  return /Electron\//i.test(String(userAgent ?? ''));
}

/** 归一化引擎识别（唯一真源；限额 / 引导都基于它的结果） */
export function detectBrowser(input: BrowserEnvInput = {}): BrowserEnv {
  const userAgent = String(input.userAgent ?? '');
  const hasUserAgentData = input.hasUserAgentData === true;
  const electron = typeof input.electronVersion === 'string' || isElectronUserAgent(userAgent);
  const firefox = !electron && isFirefoxUserAgent(userAgent);
  const chromium =
    !electron &&
    !firefox &&
    (/Chrome\/|Chromium\/|CriOS\/|Edg[A-Z]?\//i.test(userAgent) ||
      // UA 被裁剪（UA-CH 浏览器）时用 userAgentData 兜底
      (hasUserAgentData && userAgent === ''));
  const webkit =
    !electron && !firefox && !chromium && (/AppleWebKit/i.test(userAgent) || /Safari\//i.test(userAgent));

  const engine: BrowserEngine = electron
    ? 'electron'
    : firefox
      ? 'firefox'
      : chromium
        ? 'chromium'
        : webkit
          ? 'webkit'
          : 'unknown';

  return {
    engine,
    isFirefox: engine === 'firefox',
    isChromium: engine === 'chromium',
    isWebKit: engine === 'webkit',
    isElectron: engine === 'electron',
    userAgent,
    hasUserAgentData,
  };
}

/** 读取真实运行环境（node / SSR / 测试环境返回 'unknown'，不抛错） */
export function readBrowserEnv(): BrowserEnv {
  try {
    const nav = (globalThis as { navigator?: { userAgent?: string; userAgentData?: unknown } }).navigator;
    const proc = (globalThis as { process?: { versions?: { electron?: string } } }).process;
    return detectBrowser({
      userAgent: nav?.userAgent ?? '',
      hasUserAgentData: Boolean(nav?.userAgentData),
      ...(typeof proc?.versions?.electron === 'string' ? { electronVersion: proc.versions.electron } : {}),
    });
  } catch {
    return detectBrowser({});
  }
}

/** 引擎中文标签（对话框 / 日志 / 错误文案共用） */
export function browserEngineLabel(env: BrowserEnv): string {
  switch (env.engine) {
    case 'firefox':
      return 'Firefox';
    case 'chromium':
      return 'Chromium（Chrome / Edge / 国产套壳）';
    case 'webkit':
      return 'Safari / WebKit';
    case 'electron':
      return 'Electron 桌面端';
    default:
      return '未知浏览器';
  }
}

/**
 * `file://` 地址在当前环境下是否被安全策略限制，返回可读提示（Firefox 才有）。
 *
 * - Firefox：`file://` fetch 被同源策略拒绝（即使目录内清单存在也读不到）；
 * - Electron 桌面端：主进程 `webSecurity: false`，`file://` 可用 → 不提示；
 * - Chromium / WebKit：不额外提示（失败时由引擎给通用错误）。
 */
export function fileUrlSupportHint(env: BrowserEnv): string | undefined {
  if (env.isElectron) return undefined;
  if (env.isFirefox) {
    return (
      'Firefox 严格限制 file:// 读取（同源/隐私策略，即使目录内有清单也会被拒绝）：' +
      '请改用 ① http(s) 地址（如本地静态服务）、② Electron 桌面端，或 ③ 小体量目录用「本地 XYZ 缓存目录」选择导入'
    );
  }
  return undefined;
}

/** 当前环境是否需要「F/iOS 以外的 Firefox 大目录警告」（Electron 不算 Firefox） */
export function needsFirefoxLargeDirectoryCare(env: BrowserEnv): boolean {
  return env.isFirefox;
}
