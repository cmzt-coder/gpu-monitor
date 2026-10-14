#!/usr/bin/env node
// 通知通道自检：手动发一条测试通知，确认邮件 / Webhook 真的能发出去。
//
// 用法：
//   node tools/notify-test.mjs                          # 读 alerts.json，真发一封
//   node tools/notify-test.mjs --dry-run                # 只打印将要发什么，不真发
//   node tools/notify-test.mjs --alerts /etc/gpu-monitor/alerts.json
//   SMTP_PASS=xxxx node tools/notify-test.mjs           # 配置里用 ${SMTP_PASS} 占位时必须带上
//
// 为什么需要它：告警只在规则真的触发时才发信，而阈值通常配得比较高，
// 想验证"邮件通道到底通不通"可能要等好几天。这个工具复用服务里同一套
// notifier / SMTP 实现和同一份配置，发一条写清楚是测试的消息——不用改阈值、
// 不用重启服务，也不影响正在运行的服务（只读配置，不碰库）。
//
// 注意：服务自己的 --alerts-dry-run 与本工具无关。带了 --dry-run 才是只预览，
// 否则就会真发。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expandEnv, loadAlertsConfig } from '../src/alerts/config.js';
import { createNotifier } from '../src/notify/notifier.js';

export const CHANNEL_LABELS = { email: '邮件', webhook: 'Webhook', console: '控制台' };

/**
 * 读通知配置。
 * enabled=false 只表示"服务别跑告警判定"，通道配置本身照样可以拿来验证，
 * 所以这里绕开 loadAlertsConfig 的"禁用即返回 null"，直接解析一份出来。
 */
async function readNotifyConfig(file) {
  const loaded = await loadAlertsConfig(file);
  if (loaded.config || !loaded.disabled) return loaded;
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  return { ...loaded, config: expandEnv(parsed) };
}

/** 组装一条测试通知，字段与服务真正发信时保持一致 */
export function buildTestPayload({ now = Date.now, hostname = os.hostname() } = {}) {
  return {
    kind: 'firing',
    level: 'warning',
    ruleId: 'test-notice',
    title: '测试通知：通知渠道自检',
    detail: `这是 ${hostname} 上 gpu-monitor 手动发出的一条测试通知。`
      + '收到即说明通知渠道是通的，不是真的有告警触发。',
    at: now(),
    since: null,
  };
}

/** 读配置、装配 notifier、组装测试消息——只做准备，不发信 */
export async function prepareNotifyTest({
  alertsPath = 'alerts.json',
  dryRun = false,
  now = Date.now,
  hostname = os.hostname(),
  logger = console,
} = {}) {
  const loaded = await readNotifyConfig(alertsPath);
  if (!loaded.config) {
    const reason = loaded.error
      || (loaded.missing ? `未找到 ${alertsPath}` : '没有可用的通知配置');
    return { ok: false, reason: `${alertsPath} 里读不到通知配置：${reason}` };
  }

  const email = loaded.config.email || null;
  const webhook = loaded.config.webhook || null;
  const notifier = createNotifier({ config: loaded.config, logger, dryRun });

  // 先把"要发到哪"摆出来：发错对象比发不出去更难发现
  const info = {
    path: loaded.configPath || alertsPath,
    disabled: Boolean(loaded.disabled),
    dryRun,
    channels: notifier.channels,
    email: email?.host
      ? {
        host: email.host,
        port: email.port ?? 587,
        tls: email.secure === true ? '隐式 TLS' : (email.starttls !== false ? 'STARTTLS' : '明文'),
        from: email.from || email.user,
        to: [].concat(email.to || []).filter(Boolean),
        hasPassword: Boolean(email.pass),
      }
      : null,
    webhookUrl: webhook?.url || null,
  };

  return { ok: true, info, payload: buildTestPayload({ now, hostname }), notifier };
}

/** 真发。返回每个渠道的结果，任何一个失败都算整体失败 */
export async function sendPrepared(prepared) {
  const results = await prepared.notifier.send(prepared.payload);
  return { ok: results.every((item) => item.ok), info: prepared.info, payload: prepared.payload, results };
}

export async function sendTestNotice(options = {}) {
  const prepared = await prepareNotifyTest(options);
  if (!prepared.ok) return prepared;
  return sendPrepared(prepared);
}

function printTarget(info) {
  process.stdout.write(`[gpu-monitor] 配置：${info.path}${info.disabled ? '（enabled=false，本次不判告警，只验证通道）' : ''}\n`);
  process.stdout.write(`  渠道：${info.channels.map((name) => CHANNEL_LABELS[name] || name).join(' / ')}\n`);
  if (info.email) {
    process.stdout.write(`  发件人：${info.email.from}\n`);
    process.stdout.write(`  收件人：${info.email.to.join('、') || '（未配置）'}\n`);
    process.stdout.write(`  服务器：${info.email.host}:${info.email.port}（${info.email.tls}）\n`);
    if (!info.email.hasPassword) process.stdout.write('  提示：配置里没读到密码，检查 ${SMTP_PASS} 对应的环境变量有没有带上\n');
  }
  if (info.webhookUrl) process.stdout.write(`  Webhook：${info.webhookUrl}\n`);
  process.stdout.write(info.dryRun ? 'dry-run：只打印，不真发\n' : '正在发送测试通知…\n');
}

function printResults({ info, results }) {
  for (const item of results) {
    const label = CHANNEL_LABELS[item.channel] || item.channel;
    // dry-run 下远程渠道并没有真的发出去，这里写"已发送"会让人以为验证通过了
    if (info.dryRun && item.channel !== 'console') {
      process.stdout.write(`○ ${label} 跳过（dry-run，未实际发送）\n`);
    } else {
      process.stdout.write(item.ok ? `✓ ${label} 已发送\n` : `✗ ${label} 发送失败：${item.error}\n`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const options = {
    alertsPath: process.env.GPU_MONITOR_ALERTS || 'alerts.json',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case '--alerts':
        options.alertsPath = next() || options.alertsPath;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
      case '-h':
        process.stdout.write(
          '用法：node tools/notify-test.mjs [--alerts <路径>] [--dry-run]\n\n'
          + '  真发一条测试通知，验证 alerts.json 里的邮件 / Webhook 通道是否可用。\n'
          + '  配置里用 ${SMTP_PASS} 占位时，记得同一个命令行带上环境变量。\n',
        );
        process.exit(0);
        break;
      default:
        break;
    }
  }
  const prepared = await prepareNotifyTest({ ...options, alertsPath: path.resolve(options.alertsPath) });
  if (!prepared.ok) {
    process.stdout.write(`✗ ${prepared.reason}\n`);
    process.exit(1);
  }
  printTarget(prepared.info);
  const report = await sendPrepared(prepared);
  printResults(report);
  process.exit(report.ok ? 0 : 1);
}
