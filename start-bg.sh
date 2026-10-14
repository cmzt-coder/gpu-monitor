#!/usr/bin/env bash
# 后台启动：用 nohup 常驻，PID 写入 .run/gpu-monitor.pid，日志追加到 gpu-monitor.log。
# 用法：./start-bg.sh [--port 8090] [--host 0.0.0.0] [--interval 1000] [--window 300] [--node /path/to/node]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

print_usage() {
  cat <<'USAGE'
后台启动 GPU 显存负载监控

用法：./start-bg.sh [选项]

  -p, --port <端口>       监听端口（默认 8090，也可用环境变量 PORT）
      --host <地址>       监听地址（默认 0.0.0.0，局域网可访问）
      --interval <毫秒>   采集间隔（默认 1000）
      --window <点数>     曲线窗口采样点数（默认 300）
      --node <路径>       指定 node 可执行文件（默认从 PATH 查找）
      --disk <路径>       额外监控的挂载点，可重复（如 --disk / --disk /data）
      --no-system         只采集 GPU，不采集宿主 CPU / 内存 / 磁盘 / 网络
      --no-extended       不采集扩展 GPU 指标（时钟 / P-State / 风扇 / 节流原因）
      --idle-after <秒>   无人访问多久后降频（默认 30，0 表示不降频）
      --idle-interval <毫秒> 空闲期间的采集间隔（默认 10000）
      --db <路径>         历史库文件（默认 data/gpu-monitor.db，需要 Node 22.13+）
      --no-db             不落库，只保留内存窗口
      --store-interval <毫秒> 落库间隔，与页面刷新解耦（默认 5000）
      --retention-days <天>   历史保留天数；默认 0 = 永久保留，填天数则按天自动清理
      --alerts <路径>     告警配置（默认 alerts.json，不存在则不启用）
      --no-alerts         不启用告警
      --alerts-dry-run    只打印将要发送的通知，不真正发信
      --no-push           关掉 SSE 推送，页面自动回到轮询
      --tz <时区>         固定本服务时区（如 Asia/Shanghai），影响导出时间列 / 文件名 / 日志。
                          只对本进程生效，不改系统时区、不影响其他服务（云主机默认常是 UTC）
      --mock              用模拟数据启动，方便无显卡环境先看效果
  -h, --help              显示本帮助

其余 server.js 支持的参数会原样透传，完整列表见 node server.js --help

运行时文件：
  PID：.run/gpu-monitor.pid    日志：gpu-monitor.log

本机部署配置：gpu-monitor.conf（模板 gpu-monitor.conf.example，不进版本库）
  可放 TZ / SMTP_PASS / PORT / INTERVAL / NODE_BIN 这些"只属于这台机器"的值，
  放进去之后启动就不用每次带参数。优先级：命令行 > 本文件 > 内置默认。

示例：
  ./start-bg.sh
  ./start-bg.sh --port 8091
  NODE_BIN=/usr/local/bin/node ./start-bg.sh
USAGE
}

. "$SCRIPT_DIR/_common.sh"

parse_start_args "$@"
validate_port
resolve_node
if [ -r "$CONF_FILE" ]; then info "本机配置：${CONF_FILE}"; fi

if pid="$(running_pid)"; then
  fail "服务已经在运行（PID ${pid}）。要重启请先执行：$SCRIPT_DIR/stop.sh"
fi

if [ -f "$PID_FILE" ]; then
  warn "PID 文件已过期，先清理：$PID_FILE"
  rm -f "$PID_FILE"
fi

check_port_free

mkdir -p "$RUN_DIR"

nohup "$NODE_BIN" "$PROJECT_DIR/server.js" \
  --port "$PORT" \
  --host "$LISTEN_HOST" \
  --interval "$INTERVAL_MS" \
  --window "$WINDOW_POINTS" \
  ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} >>"$LOG_FILE" 2>&1 &

service_pid=$!
printf '%s\n' "$service_pid" >"$PID_FILE"

# 等一秒确认进程活着，避免端口被占用之类的启动失败被当成成功
sleep 1
if kill -0 "$service_pid" 2>/dev/null; then
  info "已在后台启动，PID $service_pid"
  print_urls
  info "日志文件：${LOG_FILE}（tail -f ${LOG_FILE} 实时查看）"
  info "停止服务：$SCRIPT_DIR/stop.sh"
else
  rm -f "$PID_FILE"
  fail "启动失败，日志最后几行：
$(tail -n 20 "$LOG_FILE" 2>/dev/null || true)"
fi
