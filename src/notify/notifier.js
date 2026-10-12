// 通知分发：把一条告警按配置发到各个渠道。
// 设计原则是"尽力而为"——任何一个渠道失败都不能影响采集与判定，只记一条错误。
import { sendMail } from './smtp.js';

export function createNotifier({ config = {}, logger = console, dryRun = false } = {}) {
  const email = config.email || null;
  const webhook = config.webhook || null;
  const channels = [];

  if (email?.enabled !== false && email?.host) {
    channels.push({
      name: 'email',
      async send(payload) {
        if (dryRun) {
          logger.info?.(`[gpu-monitor] （dry-run）将发送邮件给 ${[].concat(email.to || []).join(', ')}：${payload.title}`);
          return;
        }
        await sendMail({
          host: email.host,
          port: email.port ?? 587,
          secure: email.secure === true,
          starttls: email.starttls !== false,
          user: email.user,
          pass: email.pass,
          from: email.from || email.user,
          to: email.to,
          subject: `[GPU 监控] ${payload.title}`,
          text: [
            payload.detail,
            '',
            `级别：${payload.level === 'critical' ? '严重' : '警告'}`,
            `规则：${payload.ruleId}`,
            `时间：${new Date(payload.at).toLocaleString('zh-CN')}`,
            payload.since ? `起始：${new Date(payload.since).toLocaleString('zh-CN')}` : null,
          ].filter((line) => line !== null).join('\n'),
          timeoutMs: email.timeoutMs,
        });
      },
    });
  }

  if (webhook?.url) {
    channels.push({
      name: 'webhook',
      async send(payload) {
        if (dryRun) {
          logger.info?.(`[gpu-monitor] （dry-run）将 POST 到 ${webhook.url}：${payload.title}`);
          return;
        }
        const response = await fetch(webhook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(webhook.headers || {}) },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error(`Webhook 返回 HTTP ${response.status}`);
      },
    });
  }

  // 控制台始终保留一路：不配任何渠道时至少日志里能看到，也方便排查"到底有没有触发"
  channels.push({
    name: 'console',
    async send(payload) {
      const line = `[gpu-monitor] ${payload.title}｜${payload.detail}`;
      if (payload.level === 'critical') logger.error?.(line);
      else logger.warn?.(line);
    },
  });

  return {
    channels: channels.map((channel) => channel.name),
    async send(payload) {
      const results = [];
      for (const channel of channels) {
        try {
          await channel.send(payload);
          results.push({ channel: channel.name, ok: true });
        } catch (error) {
          results.push({ channel: channel.name, ok: false, error: error?.message || String(error) });
          logger.warn?.(`[gpu-monitor] ${channel.name} 通知失败：${error?.message || error}`);
        }
      }
      return results;
    },
  };
}
