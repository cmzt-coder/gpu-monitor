#!/usr/bin/env bash
# 前台启动：占住当前终端，日志直接打在屏幕上，Ctrl+C 结束。
# 用法：./start.sh [--port 8090] [--host 0.0.0.0] [--interval 1000] [--window 300] [--node /path/to/node]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

print_usage() {
  cat <<'USAGE'
前台启动 GPU 显存负载监控

用法：./start.sh [选项]

  -p, --port <端口>       监听端口（默认 8090，也可用环境变量 PORT）
      --host <地址>       监听地址（默认 0.0.0.0，局域网可访问）
      --interval <毫秒>   采集间隔（默认 1000）
      --window <点数>     曲线窗口采样点数（默认 300）
      --node <路径>       指定 node 可执行文件（默认从 PATH 查找）
      --mock              用模拟数据启动，方便无显卡环境先看效果
  -h, --help              显示本帮助

示例：
  ./start.sh
  ./start.sh --port 8091
  NODE_BIN=/usr/local/bin/node ./start.sh
USAGE
}

. "$SCRIPT_DIR/_common.sh"

parse_start_args "$@"
validate_port
resolve_node
check_port_free

info "正在前台启动，按 Ctrl+C 结束"
print_urls

exec "$NODE_BIN" "$PROJECT_DIR/server.js" \
  --port "$PORT" \
  --host "$LISTEN_HOST" \
  --interval "$INTERVAL_MS" \
  --window "$WINDOW_POINTS" \
  ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
