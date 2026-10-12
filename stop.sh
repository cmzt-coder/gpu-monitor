#!/usr/bin/env bash
# 停止后台服务：先发 SIGTERM 优雅退出，10 秒内没退出再 SIGKILL。
# 用法：./stop.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

print_usage() {
  cat <<'USAGE'
停止后台运行的 GPU 显存负载监控

用法：./stop.sh

  -h, --help    显示本帮助

说明：脚本读取 .run/gpu-monitor.pid 找到服务进程，先发 SIGTERM 优雅退出，
      10 秒内仍未退出则强制结束。前台启动（./start.sh）的服务请直接在终端按 Ctrl+C。
USAGE
}

. "$SCRIPT_DIR/_common.sh"

case "${1:-}" in
  -h|--help) print_usage; exit 0 ;;
  '') ;;
  *) fail "stop.sh 不接受参数：${1}（-h 查看用法）" ;;
esac

if ! pid="$(running_pid)"; then
  if [ -f "$PID_FILE" ]; then
    warn "PID 文件存在但进程已不在，清理：$PID_FILE"
    rm -f "$PID_FILE"
  fi
  info "服务未在运行"
  exit 0
fi

info "正在停止服务（PID ${pid}）..."
kill -TERM "$pid" 2>/dev/null || true

for _ in $(seq 1 20); do
  if ! kill -0 "$pid" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

if kill -0 "$pid" 2>/dev/null; then
  warn "10 秒内没有退出，强制结束"
  kill -KILL "$pid" 2>/dev/null || true
  sleep 0.5
fi

rm -f "$PID_FILE"
info "已停止（PID ${pid}）"
