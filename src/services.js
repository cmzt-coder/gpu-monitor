// 把"一个个占卡进程"汇总成"一个个服务占了多少"。
//
// 典型场景是一张卡被多个服务共享（容器 / systemd 单元 / 某个用户的会话），
// 这时"哪张卡用了多少"意义不大，真正想知道的是"哪个服务占了多少、有没有异常膨胀"。

/** 服务占用占整机显存的比例；拿不到总量时返回 null */
export function serviceSharePct(memMiB, gpus = []) {
  const total = (gpus || []).reduce((sum, gpu) => sum + (gpu?.memTotalMiB || 0), 0);
  if (!(total > 0)) return null;
  return ((memMiB || 0) / total) * 100;
}

/**
 * 按服务汇总进程占用。
 * 服务身份拿不到的进程归到"未识别"而不是丢掉——这部分总量同样值得看见
 * （它也提醒你：有几张卡的占用没能归到具体服务上）。
 */
export function summarizeServices(processes = [], gpus = []) {
  const groups = new Map();
  for (const process of processes || []) {
    const service = process?.service || '未识别';
    let entry = groups.get(service);
    if (!entry) {
      entry = { service, memMiB: 0, processes: 0, users: new Set() };
      groups.set(service, entry);
    }
    entry.memMiB += process?.usedMemMiB || 0;
    entry.processes += 1;
    if (process?.user) entry.users.add(process.user);
  }

  return [...groups.values()]
    .map((entry) => ({
      service: entry.service,
      memMiB: entry.memMiB,
      sharePct: serviceSharePct(entry.memMiB, gpus),
      processes: entry.processes,
      users: [...entry.users],
    }))
    .sort((a, b) => b.memMiB - a.memMiB);
}
