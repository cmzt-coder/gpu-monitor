/**
 * 声明式文案：把 `data-i18n` 属性扫一遍写进 DOM。
 *
 * 规矩（很重要，别越界）：
 *   `data-i18n` 只挂在 **JS 不会重写** 的节点上——卡片标题、表头、按钮、图例、
 *   弹窗外框这类"结构文案"。像 #orient-sub、#status-text、各卡片 sub、KPI 数值这些
 *   每秒被渲染函数写入的节点，一律在渲染处调 t()，不要挂属性：
 *   否则切语言时会出现"属性先写英文、渲染函数紧接着又覆盖回中文"的互相打架。
 *
 * 两种写法：
 *   <h2 data-i18n="meta.title">采集信息</h2>
 *   <section data-i18n-attr="aria-label:aside.group">…</section>
 *   多个属性用逗号分隔：data-i18n-attr="aria-label:foo,title:bar"
 *
 * 属性替换用 textContent / setAttribute，不用 innerHTML——文案里不解析 HTML，
 * 少一个注入面，也省得 translator 手滑写出标签。
 */

import { t, getLang } from './index.js';

/** 扫一遍并就地替换。返回替换了几处，方便调试与断言 */
export function applyStaticI18n(root = document, { lang = getLang() } = {}) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  let count = 0;

  for (const node of root.querySelectorAll('[data-i18n]')) {
    const key = node.dataset.i18n;
    if (!key) continue;
    node.textContent = t(key);
    count += 1;
  }

  for (const node of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of String(node.dataset.i18nAttr).split(',')) {
      const at = pair.indexOf(':');
      if (at < 0) continue;
      const attr = pair.slice(0, at).trim();
      const key = pair.slice(at + 1).trim();
      if (!attr || !key) continue;
      node.setAttribute(attr, t(key));
      count += 1;
    }
  }

  // 读屏和字体回退都认它；切换语言后必须跟着变
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  return count;
}

/** 语言开关那组 chip：把当前语言标成 aria-pressed="true" */
export function syncLangSwitch(container, lang = getLang()) {
  if (!container || typeof container.querySelectorAll !== 'function') return;
  for (const button of container.querySelectorAll('.chip[data-lang]')) {
    button.setAttribute('aria-pressed', button.dataset.lang === lang ? 'true' : 'false');
  }
}
