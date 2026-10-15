/**
 * 界面语言的运行时：当前语言、t()、复数、持久化、订阅。
 *
 * 这个文件**不碰 DOM**（<html lang> / data-i18n 扫描在 ./dom.js 里），
 * 所以 tools/smoke-test.mjs 可以直接 import 它做单测，不需要浏览器环境。
 *
 * 关于 Intl 的取舍（有意为之，不是漏做）：
 *   - 复数用内置 `Intl.PluralRules` 选 `.one` / `.other`；
 *   - 时间（HH:MM:SS，24 小时制）、数字（小数点、千分位）、单位（GB / MiB / % / °C / W）
 *     **不跟随语言变化**。原因：页面上的数值要和导出的 CSV、日志、nvidia-smi 输出逐列对得上，
 *     一旦按 locale 把小数点换成逗号、或把时钟改成 12 小时制，对账就会出错。
 *     相对时间（"3 秒前" / "3 seconds ago"）是真正需要翻译的部分，用 key + 占位符 + 复数处理，
 *     这样中文侧的输出与改造前逐字一致。
 */

import { zhCN } from './zh-CN.js';
import { enUS } from './en-US.js';

/** 缺 key 时回退到哪种语言：中文是基线，任何 key 都先在这里定义 */
export const FALLBACK_LANG = 'zh-CN';

/** 已支持的语言 → 资源表。key 就是 BCP-47 标签，可直接喂给 Intl */
export const MESSAGES = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

export const SUPPORTED_LANGS = Object.keys(MESSAGES);

/** localStorage 里的键名。改它等于让所有已有用户的偏好失效，非必要不要动 */
export const STORAGE_KEY = 'gpu-monitor.lang';

let current = FALLBACK_LANG;
const listeners = new Set();
const warnedKeys = new Set();

/* ---------- 语言识别 ---------- */

/** 'zh_CN' / 'zh-Hans' / 'en-GB' → 受支持的标签；认不出来返回 null */
export function normalizeLang(value) {
  if (!value) return null;
  const tag = String(value).trim().toLowerCase();
  if (!tag) return null;
  if (tag.startsWith('zh')) return 'zh-CN';
  if (tag.startsWith('en')) return 'en-US';
  return null;
}

/** 从 `?lang=en-US` 或 `#view=nav&page=curve&lang=zh-CN` 里取显式覆盖 */
export function langFromUrl(search = '', hash = '') {
  const fromSearch = new URLSearchParams(String(search).replace(/^\?/, '')).get('lang');
  if (fromSearch) return fromSearch;
  const matched = /[#&?]lang=([^&]+)/.exec(String(hash));
  return matched ? decodeURIComponent(matched[1]) : null;
}

/**
 * 语言优先级：URL 显式指定 → 上次选择 → 浏览器偏好 → 中文。
 * 纯函数，单测直接喂参数；initI18n 负责把真实环境的值读出来传进来。
 */
export function detectLang({ search = '', hash = '', stored = null, navigatorLang = null } = {}) {
  return (
    normalizeLang(langFromUrl(search, hash)) ||
    normalizeLang(stored) ||
    normalizeLang(navigatorLang) ||
    FALLBACK_LANG
  );
}

function readStored() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // 隐私模式 / 禁用存储：降级成"只在本次会话里记住"
    return null;
  }
}

function writeStored(lang) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* 同上，静默降级 */
  }
}

/**
 * 启动时调一次：决定初始语言并落地成当前语言。不触发订阅者
 * （那时还没有人订阅，也不该在首帧前重绘）。
 */
export function initI18n({ search = '', hash = '', navigatorLang = null, stored = undefined } = {}) {
  current = detectLang({
    search,
    hash,
    navigatorLang,
    stored: stored === undefined ? readStored() : stored,
  });
  return current;
}

export function getLang() {
  return current;
}

export function isSupportedLang(lang) {
  return SUPPORTED_LANGS.includes(lang);
}

/**
 * 切语言。持久化 → 通知订阅者（app.js 在那里刷新 DOM 与 canvas）。
 * 传入与当前相同的语言时是空操作，不会白重绘一次。
 */
export function setLang(lang, { persist = true } = {}) {
  const next = normalizeLang(lang) || FALLBACK_LANG;
  if (next === current) return current;
  current = next;
  if (persist) writeStored(next);
  for (const listener of listeners) listener(next);
  return current;
}

export function onLangChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* ---------- 取文案 ---------- */

function pick(lang, key) {
  const table = MESSAGES[lang];
  const value = table ? table[key] : undefined;
  return typeof value === 'string' ? value : null;
}

/** `{name}` 占位符替换。参数缺失时保留原样的 `{name}`，方便一眼看出漏传了 */
function fill(text, params) {
  if (!text || !params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) => {
    const value = params[name];
    return value === undefined || value === null ? whole : String(value);
  });
}

function warnMissing(key) {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  if (typeof console !== 'undefined' && console.warn) {
    console.warn(`[i18n] 缺少文案 key：${key}（当前 ${current}，中文里也没有）`);
  }
}

/**
 * 取一条文案。找不到时依次：当前语言 → 中文 → 原样返回 key（并 warn 一次）。
 * 返回 key 而不是空串，是为了让漏翻在页面上立刻看得见、而不是留一片空白。
 */
export function t(key, params) {
  const text = pick(current, key) ?? pick(FALLBACK_LANG, key);
  if (text === null) {
    warnMissing(key);
    return key;
  }
  return fill(text, params);
}

const pluralRulesCache = new Map();

function pluralCategory(count, lang = current) {
  let rules = pluralRulesCache.get(lang);
  if (!rules) {
    rules = new Intl.PluralRules(lang);
    pluralRulesCache.set(lang, rules);
  }
  return rules.select(count);
}

/**
 * 带数量的文案：key 在资源表里写成 `xxx.one` / `xxx.other` 两条。
 * 中文永远命中 `.other`（中文没有单复数），英文按 PluralRules 选。
 * `{n}` 是自动补的，其余参数照常传。
 */
export function tn(key, count, params = {}) {
  const category = pluralCategory(count);
  const suffix = category === 'one' ? 'one' : 'other';
  const merged = { n: count, ...params };
  const text =
    pick(current, `${key}.${suffix}`) ??
    pick(current, `${key}.other`) ??
    pick(FALLBACK_LANG, `${key}.${suffix}`) ??
    pick(FALLBACK_LANG, `${key}.other`);
  if (text === null) {
    warnMissing(`${key}.${suffix}`);
    return key;
  }
  return fill(text, merged);
}

/* ---------- 给测试与工具用的查询接口 ---------- */

export function hasKey(key, lang = current) {
  return pick(lang, key) !== null;
}

export function keysOf(lang) {
  const table = MESSAGES[lang];
  return table ? Object.keys(table) : [];
}

/** 取出文案里的占位符名（有序、去重），冒烟测试用它比对中英是否漏写参数 */
export function placeholdersOf(text) {
  const found = String(text ?? '').match(/\{(\w+)\}/g) || [];
  return [...new Set(found.map((token) => token.slice(1, -1)))].sort();
}
