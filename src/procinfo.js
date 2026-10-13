// 从 /proc 补出"这个进程属于哪个服务"。
//
// 判断顺序：容器 → systemd 单元 → 用户会话。原因是实测里最有用的那一级：
// vLLM 会把自己的进程标题改成 VLLM::EngineCore，命令行里看不出是哪个服务，
// 但 cgroup 里的容器 ID 能唯一确定它属于哪个容器。
//
// 全部尽力而为：读不到就留空，绝不因为权限或格式问题影响采集本身。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * 解析 /proc/<pid>/cgroup。
 * cgroup v2 形如 `0::/system.slice/docker-<64位ID>.scope`，
 * v1 形如 `11:pids:/docker/<ID>` 或 `1:name=systemd:/system.slice/foo.service`。
 */
export function parseCgroup(text) {
  const result = { containerId: null, podId: null, unit: null, session: false };
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // v1 是 `层级:控制器:路径`，取最后一段当路径
    const parts = trimmed.split(':');
    const path = parts.length >= 3 ? parts.slice(2).join(':') : trimmed;
    if (!path || path === '/') continue;

    const docker = /docker[-/]([0-9a-f]{12,64})/.exec(path);
    if (docker) result.containerId = docker[1];
    const cri = /cri-containerd-([0-9a-f]{12,64})\.scope/.exec(path);
    if (cri) result.containerId = cri[1];
    const pod = /(?:^|[-/])pod([0-9a-f-]{36})/.exec(path);
    if (pod) result.podId = pod[1];

    // 容器用 .scope 表示，systemd 服务才是 .service，两者不会混淆
    const unit = /\/([^/]+\.service)(?:\/|$)/.exec(path);
    if (unit) result.unit = unit[1];
    if (path.includes('/user.slice/') || /user@\d+\.service/.test(path) || /session-\d+\.scope/.test(path)) {
      result.session = true;
    }
  }
  return result;
}

/** 解析 /proc/<pid>/status 里的 Uid 行 */
export function parseUidStatus(text) {
  const match = /^Uid:\s+(\d+)/m.exec(String(text));
  return match ? Number(match[1]) : null;
}

/** 解析 /etc/passwd，得到 uid → 用户名 */
export function parsePasswd(text) {
  const map = new Map();
  for (const line of String(text).split('\n')) {
    const fields = line.split(':');
    if (fields.length < 3) continue;
    const uid = Number(fields[2]);
    if (Number.isFinite(uid)) map.set(uid, fields[0]);
  }
  return map;
}

/** /proc/<pid>/cmdline 是 NUL 分隔的；vLLM 这类会改写进程标题的只剩一个词 */
export function parseCmdline(buffer, limit = 240) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer ?? '');
  const joined = text.split('\0').filter(Boolean).join(' ').trim();
  return joined.length > limit ? `${joined.slice(0, limit)}…` : joined || null;
}

/** 把解析结果整理成人能看懂的一行 */
export function serviceLabel({ containerId, containerName, unit, session }) {
  if (containerId) {
    return containerName ? { kind: 'container', label: `容器 ${containerName}` } : { kind: 'container', label: `容器 ${containerId.slice(0, 12)}` };
  }
  if (unit && !session) return { kind: 'systemd', label: unit };
  if (session) return { kind: 'session', label: '用户会话' };
  return { kind: null, label: null };
}

/**
 * 创建进程信息读取器。Linux 上才有效，其它平台 supported=false。
 * 结果按 pid 缓存 cacheTtlMs：进程身份变化很少，没必要每秒重读一堆 /proc 文件。
 */
export function createProcessInfoReader({
  platform = process.platform,
  readFile = fs.readFile,
  exec = run,
  now = Date.now,
  cacheTtlMs = 5000,
  containerCacheTtlMs = 600000,
} = {}) {
  const supported = platform === 'linux';
  const pidCache = new Map();
  const containerNames = new Map();
  let passwdCache = { at: 0, map: new Map() };

  async function readText(path) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  }

  async function userNameFor(uid) {
    if (uid == null) return null;
    const current = now();
    if (!passwdCache.at || current - passwdCache.at > 300000) {
      const text = await readText('/etc/passwd');
      passwdCache = { at: current, map: text ? parsePasswd(text) : new Map() };
    }
    return passwdCache.map.get(uid) ?? String(uid);
  }

  /**
   * 容器 ID → 容器名。
   * 优先读 Docker 自己的元数据（服务以 root 运行时最省事），
   * 读不到再问一次 docker（服务在 docker 组里时也拿得到），最后退回短 ID。
   */
  async function containerNameFor(id) {
    const cached = containerNames.get(id);
    const current = now();
    if (cached && current - cached.at < containerCacheTtlMs) return cached.name;

    let name = null;
    const meta = await readText(`/var/lib/docker/containers/${id}/config.v2.json`);
    if (meta) {
      try {
        name = JSON.parse(meta)?.Name || null;
      } catch {
        name = null;
      }
    }
    if (!name) {
      try {
        const { stdout } = await exec('docker', ['inspect', '--format', '{{.Name}}', id], { timeout: 3000 });
        name = stdout.trim() || null;
      } catch {
        name = null;
      }
    }
    if (name) name = name.replace(/^\//, '');
    containerNames.set(id, { at: current, name });
    return name;
  }

  async function infoFor(pid) {
    const cached = pidCache.get(pid);
    const current = now();
    if (cached && current - cached.at < cacheTtlMs) return cached.info;

    const [cgroupText, statusText, cmdlineRaw] = await Promise.all([
      readText(`/proc/${pid}/cgroup`),
      readText(`/proc/${pid}/status`),
      readFile(`/proc/${pid}/cmdline`).catch(() => null),
    ]);

    const parsed = parseCgroup(cgroupText || '');
    const containerName = parsed.containerId ? await containerNameFor(parsed.containerId) : null;
    const { kind, label } = serviceLabel({ ...parsed, containerName });
    const info = {
      service: label,
      serviceKind: kind,
      containerId: parsed.containerId,
      containerName,
      podId: parsed.podId,
      user: await userNameFor(parseUidStatus(statusText || '')),
      cmdline: parseCmdline(cmdlineRaw),
    };
    pidCache.set(pid, { at: current, info });
    return info;
  }

  /**
   * 给一批进程补上服务归属。返回新的数组，不改动传入的对象。
   * pid 缺失或读不到时对应字段为 null，不影响其它进程。
   */
  async function enrich(processes = []) {
    if (!supported) return processes;
    return Promise.all(processes.map(async (process) => {
      if (process?.pid == null) return process;
      try {
        return { ...process, ...(await infoFor(process.pid)) };
      } catch {
        return process;
      }
    }));
  }

  return { supported, enrich };
}
