/**
 * 后端下发的诊断文案 → 中英文案 key 的映射。
 *
 * 为什么需要这一层：`/api/state` 里的 platform.note、hint、systemWarning、storeWarning、
 * processWarning、xidStatus.error 都是后端拼好的**中文自由文本**（见 src/platform.js、
 * src/collector.js、src/nvidia.js、src/xid.js），这一轮约定不动后端，所以只能在前端按
 * "已知原文 → 文案 key"对照翻译。
 *
 * 两条原则：
 *   1. 命中就翻，**没命中原样显示**——后端改了措辞最多是这一句没翻，不会出现空白或 key；
 *   2. 中文那侧的输出必须与改造前逐字一致（zh-CN.js 里的值就是后端原文），
 *      所以中文界面看起来不会有任何变化。
 *
 * tools/smoke-test.mjs 对每一条都写了断言：后端改了文案，测试会先失败，提醒来这里同步。
 * 更彻底的做法是给后端加 code 字段，那需要动后端，不在本轮范围内。
 */

import { t } from './i18n/index.js';

const PATTERNS = [
  // src/platform.js
  { re: /^macOS 上 NVIDIA 官方驱动已停止支持/, key: 'backend.platform.macos' },
  {
    re: /^(.+) 上没有 NVIDIA 官方驱动，无法读取显存数据$/,
    key: 'backend.platform.noDriver',
    params: (match) => ({ os: match[1] }),
  },
  // src/collector.js
  {
    re: /^宿主指标采集失败：(.*)$/s,
    key: 'backend.warn.systemFailed',
    params: (match) => ({ message: match[1] }),
  },
  {
    re: /^写入历史库失败：(.*)$/s,
    key: 'backend.warn.storeFailed',
    params: (match) => ({ message: match[1] }),
  },
  // src/nvidia.js
  { re: /^进程列表读取失败/, key: 'backend.warn.processFailed' },
  // src/store/store.js：历史库不可用的几种原因
  { re: /^启动时加了 --no-db$/, key: 'backend.store.flagNoDb' },
  { re: /^未启用历史库$/, key: 'backend.store.notEnabled' },
  {
    re: /^当前 Node (.+) 用不了内置的 node:sqlite，需要升级到 (.+) 或更高$/,
    key: 'backend.store.nodeTooOld',
    params: (match) => ({ version: match[1], need: match[2] }),
  },
  {
    re: /^没有权限写入历史库：(.*)$/s,
    key: 'backend.store.permission',
    params: (match) => ({ message: match[1] }),
  },
  { re: /^磁盘空间不足，无法创建历史库$/, key: 'backend.store.noSpace' },
  {
    re: /^历史库路径不可用：(.*)$/s,
    key: 'backend.store.badPath',
    params: (match) => ({ message: match[1] }),
  },
  // src/xid.js
  { re: /^读不到内核日志（权限不足）/, key: 'backend.xid.permission' },
  {
    re: /^读不到内核日志：(.*)$/s,
    key: 'backend.xid.failed',
    params: (match) => ({ detail: match[1] }),
  },
  // src/platform.js 的 platformHint()
  { re: /^显存监控需要装在带 NVIDIA 显卡与驱动的机器上运行/, key: 'backend.hint.needNvidia' },
  { re: /^确认已安装 NVIDIA 显卡驱动；/, key: 'backend.hint.installWindows' },
  { re: /^确认已安装 NVIDIA 驱动（nvidia-smi 随驱动一起安装）/, key: 'backend.hint.install' },
];

/** 认得出就翻，认不出原样返回（含 null / undefined / 空串） */
export function backendText(text) {
  if (!text) return text;
  const raw = String(text);
  for (const { re, key, params } of PATTERNS) {
    const match = re.exec(raw);
    if (match) return t(key, params ? params(match) : undefined);
  }
  return text;
}

/** 导出出去给冒烟测试用：确认每条后端文案都还在映射表里 */
export const BACKEND_TEXT_PATTERNS = PATTERNS;
