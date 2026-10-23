// 推理配置文件的读写层：页面只拿到脱敏后的配置，保存时通过版本号避免覆盖别人的修改。
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { expandEnv } from '../alerts/config.js';
import { normalizeInferenceConfig } from './config.js';

export class InferenceConfigFileError extends Error {
  constructor(code, message, { status = 400, warnings = [] } = {}) {
    super(message);
    this.name = 'InferenceConfigFileError';
    this.code = code;
    this.status = status;
    this.warnings = warnings;
  }
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function emptyConfig() {
  return { enabled: true, interval: '15s', timeoutMs: 3000, services: [] };
}

function sanitizeService(service, env) {
  const { apiKey, ...rest } = service && typeof service === 'object' ? service : {};
  const apiKeyEnv = typeof rest.apiKeyEnv === 'string' ? rest.apiKeyEnv.trim() : '';
  const direct = typeof apiKey === 'string' && apiKey.trim().length > 0;
  return {
    ...rest,
    apiKeyEnv: apiKeyEnv || undefined,
    authType: direct ? 'direct' : (apiKeyEnv ? 'env' : 'none'),
    apiKeySet: direct,
    apiKeyEnvConfigured: apiKeyEnv ? Boolean(env?.[apiKeyEnv]) : null,
  };
}

/** 读取原始配置，并生成浏览器可安全编辑的脱敏副本。 */
export async function readInferenceConfigForEdit(file, { env = process.env } = {}) {
  let text = null;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  let raw;
  if (text == null) {
    raw = emptyConfig();
  } else {
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new InferenceConfigFileError('invalid_json', `解析 ${file} 失败：${error.message}`, { status: 422 });
    }
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InferenceConfigFileError('invalid_config', '配置文件顶层必须是 JSON 对象', { status: 422 });
  }

  const services = Array.isArray(raw.services) ? raw.services : [];
  return {
    exists: text != null,
    revision: text == null ? null : hashText(text),
    config: {
      enabled: raw.enabled !== false,
      interval: raw.interval ?? '15s',
      timeoutMs: Number(raw.timeoutMs) || 3000,
      services: services.map((service) => sanitizeService(service, env)),
    },
  };
}

function mergeService(incoming, previous) {
  const {
    authType,
    apiKeySet: _apiKeySet,
    apiKeyEnvConfigured: _apiKeyEnvConfigured,
    apiKey: providedApiKey,
    ...rest
  } = incoming && typeof incoming === 'object' ? incoming : {};
  const mode = ['none', 'env', 'direct'].includes(authType)
    ? authType
    : (rest.apiKeyEnv ? 'env' : 'none');

  delete rest.apiKey;
  if (mode === 'direct') {
    delete rest.apiKeyEnv;
    const nextKey = typeof providedApiKey === 'string' ? providedApiKey.trim() : '';
    if (nextKey) rest.apiKey = nextKey;
    else if (previous?.apiKey) rest.apiKey = previous.apiKey;
    else {
      throw new InferenceConfigFileError('missing_direct_key', `服务 ${rest.id || '--'} 选择了直接密钥，但没有填写密钥`);
    }
  } else if (mode === 'env') {
    delete rest.apiKey;
    const name = typeof rest.apiKeyEnv === 'string' ? rest.apiKeyEnv.trim() : '';
    if (!name) {
      throw new InferenceConfigFileError('missing_api_key_env', `服务 ${rest.id || '--'} 选择了环境变量，但没有填写变量名`);
    }
    rest.apiKeyEnv = name;
  } else {
    delete rest.apiKey;
    delete rest.apiKeyEnv;
  }
  return rest;
}

function prepareConfig(incoming, previousRaw) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw new InferenceConfigFileError('invalid_config', '保存内容必须是配置对象');
  }
  if (!Array.isArray(incoming.services)) {
    throw new InferenceConfigFileError('invalid_services', 'services 必须是数组');
  }

  const previousById = new Map(
    (Array.isArray(previousRaw?.services) ? previousRaw.services : [])
      .filter((service) => service && typeof service === 'object')
      .map((service) => [String(service.id || ''), service]),
  );
  const next = {
    ...incoming,
    enabled: incoming.enabled !== false,
    interval: incoming.interval ?? '15s',
    timeoutMs: Number(incoming.timeoutMs) || 3000,
    services: incoming.services.map((service) => mergeService(
      service,
      previousById.get(String(service?.id || '')),
    )),
  };

  const normalized = normalizeInferenceConfig(expandEnv(next));
  if (normalized.warnings.length > 0) {
    throw new InferenceConfigFileError('invalid_service', '配置校验失败，请修正标记的服务', {
      status: 422,
      warnings: normalized.warnings,
    });
  }
  return next;
}

/** 带并发版本检查和备份的原子保存。 */
async function saveInferenceConfigNow(file, { config, revision, env = process.env, now = Date.now } = {}) {
  let currentText = null;
  try {
    currentText = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const currentRevision = currentText == null ? null : hashText(currentText);
  if ((revision ?? null) !== currentRevision) {
    throw new InferenceConfigFileError('revision_conflict', '配置文件已被其他窗口或手工修改，请重新载入后再保存', { status: 409 });
  }

  let previousRaw = null;
  if (currentText != null) {
    try {
      previousRaw = JSON.parse(currentText);
    } catch (error) {
      throw new InferenceConfigFileError('invalid_json', `当前配置不是合法 JSON：${error.message}`, { status: 422 });
    }
  }

  const next = prepareConfig(config, previousRaw);
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const directory = path.dirname(file);
  await fsp.mkdir(directory, { recursive: true });

  let backup = null;
  if (currentText != null) {
    const stamp = new Date(now()).toISOString().replace(/[-:.TZ]/g, '');
    backup = `${file}.bak.${stamp}.${crypto.randomBytes(3).toString('hex')}`;
    await fsp.copyFile(file, backup);
    await fsp.chmod(backup, 0o600).catch(() => {});
  }

  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${now()}.tmp`);
  try {
    await fsp.writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(temp, file);
    await fsp.chmod(file, 0o600).catch(() => {});
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => {});
  }

  return {
    revision: hashText(text),
    backup,
    config: (await readInferenceConfigForEdit(file, { env })).config,
  };
}

// 同一个进程内把同一文件的写入排成队列：仅比较 revision 挡不住两个请求同时读取、随后同时覆盖。
const writeQueues = new Map();

export function saveInferenceConfig(file, options) {
  const previous = writeQueues.get(file) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => saveInferenceConfigNow(file, options));
  writeQueues.set(file, task);
  return task.finally(() => {
    if (writeQueues.get(file) === task) writeQueues.delete(file);
  });
}

export { emptyConfig as emptyInferenceConfig };
