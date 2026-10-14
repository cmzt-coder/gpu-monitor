// 告警运行时的装配与热加载。
//
// 热加载的要点不是"重新读文件"，而是**读坏了不能把告警弄丢**：
// 配置文件写错一个字符时，继续沿用上一次可用的规则并在日志里说明，
// 而不是静默变成"没有告警"——监控系统最怕的就是自己悄悄失效。
import fs from 'node:fs';
import path from 'node:path';

import { createNotifier } from '../notify/notifier.js';
import { loadAlertsConfig } from './config.js';
import { createAlertEngine } from './engine.js';

export function createAlertsRuntime({
  options,
  collector,
  store,
  logger = console,
  now = Date.now,
  // 单测里关掉文件监听，直接调 reload()
  watch = true,
} = {}) {
  const runtime = {
    engine: null,
    error: null,
    missing: false,
    disabled: false,
    reloadedAt: null,
    lastReloadError: null,
    watcher: null,
    debounceTimer: null,
  };
  let unsubscribe = null;

  function buildEngine(config) {
    return createAlertEngine({
      config: {
        window: options.windowSamples * options.intervalMs,
        intervalMs: options.intervalMs,
        ...config,
      },
      getSamples: () => collector.getSamples(options.windowSamples),
      // for 超过内存窗口的规则改用历史库判定
      history: store.supportsHistory
        ? ({ from, to }) => store.querySamples({ from, to, stepMs: 0, pointLimit: 3000 })
        : null,
      notifier: createNotifier({ config, dryRun: options.alertsDryRun, logger }),
      logger,
    });
  }

  function install(engine) {
    unsubscribe?.();
    runtime.engine = engine;
    // 内部订阅者不算"有页面在看"，否则空闲降频永远不会生效
    unsubscribe = engine
      ? collector.subscribe((snapshot) => engine.evaluate(snapshot), { countsAsViewer: false })
      : null;
  }

  async function readConfig() {
    const loaded = options.alerts === false
      ? { config: null, path: options.alertsPath, error: null, missing: false, disabled: true }
      : await loadAlertsConfig(options.alertsPath);
    runtime.error = loaded.error || null;
    runtime.missing = Boolean(loaded.missing);
    runtime.disabled = Boolean(loaded.disabled);
    return loaded;
  }

  async function reload({ initial = false } = {}) {
    const previousRules = runtime.engine?.rules.length ?? 0;
    const loaded = await readConfig();

    if (!loaded.config) {
      const reason = loaded.error
        || (options.alerts === false ? '启动时带了 --no-alerts'
          : loaded.disabled ? '配置里 enabled=false'
            : loaded.missing ? `未找到 ${options.alertsPath}` : '未启用');
      if (!initial && runtime.engine) {
        // 已经跑起来的告警不因为一次改错而失效
        runtime.lastReloadError = reason;
        logger.warn?.(`[gpu-monitor] 告警配置重新加载失败（${reason}），继续沿用上一次的 ${previousRules} 条规则`);
        return { reloaded: false, reason };
      }
      install(null);
      runtime.lastReloadError = loaded.error || null;
      return { reloaded: false, reason };
    }

    install(buildEngine(loaded.config));
    runtime.reloadedAt = now();
    runtime.lastReloadError = null;
    return { reloaded: true, ruleCount: runtime.engine.rules.length, previousRuleCount: previousRules };
  }

  function scheduleReload() {
    if (runtime.debounceTimer) clearTimeout(runtime.debounceTimer);
    // 编辑器保存常常连续触发多次事件，攒一下再加载
    runtime.debounceTimer = setTimeout(async () => {
      runtime.debounceTimer = null;
      const result = await reload();
      if (result.reloaded) {
        logger.info?.(`[gpu-monitor] 告警配置已重新加载：${result.ruleCount} 条规则（原有 ${result.previousRuleCount} 条）`);
      }
    }, 500);
    runtime.debounceTimer.unref?.();
  }

  function startWatching() {
    if (!watch || runtime.watcher || options.alerts === false) return;
    const absolute = path.resolve(options.alertsPath);
    try {
      // 监听目录而不是文件本身：编辑器保存常用"写临时文件再改名"替换，
      // 直接 watch 文件在第一次替换后就失效了
      runtime.watcher = fs.watch(path.dirname(absolute), { persistent: false }, (event, filename) => {
        if (filename && filename !== path.basename(absolute)) return;
        scheduleReload();
      });
      runtime.watcher.on('error', (error) => {
        logger.warn?.(`[gpu-monitor] 告警配置监听失败（${error.message}），改动后需重启服务`);
        runtime.watcher = null;
      });
    } catch (error) {
      logger.warn?.(`[gpu-monitor] 无法监听告警配置（${error.message}），改动后需重启服务`);
    }
  }

  return {
    async start() {
      const result = await reload({ initial: true });
      startWatching();
      return result;
    },
    reload,
    snapshot() {
      const base = runtime.engine
        ? runtime.engine.snapshot()
        : { enabled: false, ruleCount: 0, firing: [], problems: [] };
      return {
        ...base,
        configPath: options.alertsPath,
        // 有没有真正装上规则：启动横幅和页面都靠它区分"未启用"和"启用了但当前无告警"
        loaded: Boolean(runtime.engine),
        reason: runtime.engine
          ? null
          : (runtime.error
            // 这条会被界面包在"未启用（…）"里，所以自身不要再带括号
            || (options.alerts === false ? '启动时带了 --no-alerts'
              : runtime.missing ? `未找到 ${options.alertsPath}`
                : runtime.disabled ? '配置里 enabled=false' : '未启用')),
        reloadedAt: runtime.reloadedAt,
        lastReloadError: runtime.lastReloadError,
        autoReload: Boolean(runtime.watcher),
        // dry-run 与真发信在页面上必须能区分：否则容易以为"告警配好了"，
        // 其实只打印不发送
        dryRun: Boolean(options.alertsDryRun),
      };
    },
    close() {
      if (runtime.debounceTimer) clearTimeout(runtime.debounceTimer);
      runtime.watcher?.close();
      runtime.watcher = null;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
