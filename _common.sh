#!/usr/bin/env bash
# 公共配置与工具函数：由 start.sh / start-bg.sh / stop.sh 通过 source 引入，不单独执行。
# 可用环境变量覆盖：PORT / HOST / INTERVAL / WINDOW / NODE_BIN

set -euo pipefail

# 项目根目录 = 本文件所在目录，脚本从哪个路径调用都能找到 server.js
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PORT="${PORT:-8090}"
LISTEN_HOST="${HOST:-0.0.0.0}"
INTERVAL_MS="${INTERVAL:-1000}"
WINDOW_POINTS="${WINDOW:-300}"
NODE_BIN="${NODE_BIN:-}"

# 运行时文件：PID 放 .run 下，日志固定写项目根目录的 gpu-monitor.log
RUN_DIR="$PROJECT_DIR/.run"
PID_FILE="$RUN_DIR/gpu-monitor.pid"
LOG_FILE="$PROJECT_DIR/gpu-monitor.log"

# 未识别的参数原样透传给 server.js（比如 --mock）
EXTRA_ARGS=()

info() { printf '[gpu-monitor] %s\n' "$*"; }
warn() { printf '[gpu-monitor] 提示：%s\n' "$*" >&2; }
fail() { printf '[gpu-monitor] 错误：%s\n' "$*" >&2; exit 1; }

# 解析启动参数；-h/--help 调用各脚本自己定义的 print_usage
parse_start_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --port|-p)  PORT="${2:-}";         [ -n "$PORT" ] || fail "--port 后面要跟端口号"; shift 2 ;;
      --host)     LISTEN_HOST="${2:-}";  [ -n "$LISTEN_HOST" ] || fail "--host 后面要跟地址"; shift 2 ;;
      --interval) INTERVAL_MS="${2:-}";  [ -n "$INTERVAL_MS" ] || fail "--interval 后面要跟毫秒数"; shift 2 ;;
      --window)   WINDOW_POINTS="${2:-}"; [ -n "$WINDOW_POINTS" ] || fail "--window 后面要跟采样点数"; shift 2 ;;
      --node)     NODE_BIN="${2:-}";     [ -n "$NODE_BIN" ] || fail "--node 后面要跟 node 路径"; shift 2 ;;
      -h|--help)  print_usage; exit 0 ;;
      *)          EXTRA_ARGS+=("$1"); shift ;;
    esac
  done
}

validate_port() {
  case "$PORT" in
    ''|*[!0-9]*) fail "端口号必须是数字：$PORT" ;;
  esac
  # 去掉前导零，避免 shell 把 08090 当成八进制
  PORT="$((10#$PORT))"
  if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    fail "端口号超出范围（1-65535）：$PORT"
  fi
}

# 找到可用的 node 并做最低版本检查
resolve_node() {
  if [ -n "$NODE_BIN" ]; then
    [ -x "$NODE_BIN" ] || fail "指定的 node 不可执行：$NODE_BIN"
  else
    NODE_BIN="$(command -v node 2>/dev/null || true)"
    if [ -z "$NODE_BIN" ] && [ -x /usr/local/bin/node ]; then NODE_BIN=/usr/local/bin/node; fi
    if [ -z "$NODE_BIN" ] && [ -x /usr/bin/node ]; then NODE_BIN=/usr/bin/node; fi
    if [ -z "$NODE_BIN" ]; then
      fail "没有找到 node。请先安装 Node.js 18 或以上版本，或用 NODE_BIN=/path/to/node 指定路径"
    fi
  fi

  local raw major
  raw="$("$NODE_BIN" -v 2>/dev/null || true)"
  case "$raw" in
    v*) ;;
    *) fail "无法执行 ${NODE_BIN}，请检查安装是否完整" ;;
  esac
  major="${raw#v}"
  major="${major%%.*}"

  if [ "$major" -lt 16 ]; then
    fail "Node 版本过低（${raw}），本项目需要 Node.js 18 或以上"
  elif [ "$major" -lt 18 ]; then
    warn "当前 Node 为 ${raw}，低于要求的 18，可能可以运行但不保证"
  fi
  info "使用 node：${NODE_BIN}（${raw}）"
}

# 端口可用性判断：优先用 node 真实绑定一次（最准，且不依赖系统工具），
# 判断不了再退回 ss / lsof，都没有就交给 server.js 自己报错。
# 探测脚本退出码：0=能绑上（空闲） 1=EADDRINUSE（被占用） 2=EACCES（端口 <1024 没权限） 其他=判断不了
PORT_PROBE_JS='const net=require("net");const port=Number(process.env.PROBE_PORT);const host=process.env.PROBE_HOST||"0.0.0.0";const guard=setTimeout(()=>process.exit(3),2000);const server=net.createServer();server.once("error",(err)=>{clearTimeout(guard);if(err.code==="EADDRINUSE")process.exit(1);if(err.code==="EACCES")process.exit(2);process.exit(3)});server.listen(port,host,()=>server.close(()=>{clearTimeout(guard);process.exit(0)}));'

probe_port() {
  local port="$1" host="$2"
  if [ -z "${NODE_BIN:-}" ] || [ ! -x "${NODE_BIN}" ]; then
    return 3
  fi
  local status=0
  PROBE_PORT="$port" PROBE_HOST="$host" "$NODE_BIN" -e "$PORT_PROBE_JS" >/dev/null 2>&1 || status=$?
  return "$status"
}

# 端口是否已被占用：返回 0 = 被占用，1 = 可用或判断不了
port_in_use() {
  local port="$1" host="${2:-0.0.0.0}" status=0
  probe_port "$port" "$host" || status=$?
  case "$status" in
    0) return 1 ;;   # 能绑上：空闲
    1) return 0 ;;   # EADDRINUSE：被占用
    2) return 1 ;;   # 没权限绑定（端口 <1024）：不算被占用，让 server.js 自己报错
  esac

  if command -v ss >/dev/null 2>&1; then
    ss -lntH 2>/dev/null | awk -v p=":$port" '$4 ~ p"$" { found = 1 } END { exit(found ? 0 : 1) }'
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1
  fi
}

# 尽力找出占用端口的进程，用于提示（权限不足时拿不到，返回空即可）
port_owner() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 { print $1 "，PID " $2 }'
  elif command -v ss >/dev/null 2>&1; then
    ss -lntpH 2>/dev/null | awk -v p=":$port" '$4 ~ p"$" { print $NF; exit }'
  fi
}

# 端口被占用直接启动失败（不再继续拉起服务），并提示占用者与换端口的写法
check_port_free() {
  if port_in_use "$PORT" "$LISTEN_HOST"; then
    local owner="" suggestion=""
    owner="$(port_owner "$PORT" 2>/dev/null || true)"
    if [ "$PORT" -lt 65535 ]; then
      suggestion="，例如：$0 --port $((PORT + 1))"
    fi
    if [ -n "$owner" ]; then
      fail "端口 $PORT 已被占用（占用者：${owner}），已中止启动${suggestion}"
    else
      fail "端口 $PORT 已被占用，已中止启动${suggestion}"
    fi
  fi
}

read_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(head -n 1 "$PID_FILE" 2>/dev/null | tr -dc '0-9' || true)"
  [ -n "$pid" ] || return 1
  printf '%s\n' "$pid"
}

# 确认某个 PID 真的是本项目的服务进程，避免 PID 被系统回收后误杀别的进程
pid_is_ours() {
  local pid="$1"
  [ -r "/proc/$pid/cmdline" ] || return 0
  local cmdline
  cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  case "$cmdline" in
    *server.js*) return 0 ;;
    *) return 1 ;;
  esac
}

# 服务在运行则输出 PID 并返回 0，否则返回 1
running_pid() {
  local pid
  pid="$(read_pid)" || return 1
  if kill -0 "$pid" 2>/dev/null && pid_is_ours "$pid"; then
    printf '%s\n' "$pid"
    return 0
  fi
  return 1
}

# 取本机内网 IP（拿不到就留空，不报错）
lan_ip() {
  if command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | awk '{print $1}'
  fi
}

print_urls() {
  local ip
  ip="$(lan_ip || true)"
  info "本机访问：http://127.0.0.1:$PORT/"
  if [ -n "$ip" ]; then
    info "局域网访问：http://$ip:$PORT/"
  fi
}
