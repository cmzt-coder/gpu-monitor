// 告警配置加载：读 JSON、展开环境变量、把问题变成可读的提示。
// 支持 ${ENV_VAR} 占位，这样 SMTP 密码之类的敏感信息可以留在环境变量里，不写进配置文件。
import fs from 'node:fs/promises';

export function expandEnv(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => process.env[name] ?? '');
  }
  if (Array.isArray(value)) return value.map((item) => expandEnv(item));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = expandEnv(item);
    return result;
  }
  return value;
}

/**
 * 读取告警配置。
 * 返回 { config, path, error, missing }：
 * - 文件不存在 → config=null, missing=true（不报错，只是没启用告警）
 * - JSON 解析失败 → error 带原因，服务照常启动
 */
export async function loadAlertsConfig(file) {
  if (!file) return { config: null, path: null, error: null, missing: false };
  try {
    const text = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed.enabled === false) return { config: null, path: file, error: null, missing: false, disabled: true };
    return { config: expandEnv(parsed), path: file, error: null, missing: false };
  } catch (error) {
    if (error?.code === 'ENOENT') return { config: null, path: file, error: null, missing: true };
    return { config: null, path: file, error: error?.message || String(error), missing: false };
  }
}
