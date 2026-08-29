#!/usr/bin/env bash
# 金融工作台 - 一键启停脚本
# 用法:
#   bash operation.sh start [port] [host]   启动后端（默认端口 8000，host 0.0.0.0）
#   bash operation.sh stop                   停止后端
#   bash operation.sh status                 查看运行状态
#   bash operation.sh restart [port] [host]  重启后端
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
PID_FILE="$SCRIPT_DIR/.server.pid"
LOG_FILE="$SCRIPT_DIR/.server.log"
PORT="${2:-8000}"
HOST="${3:-0.0.0.0}"

cmd="${1:-start}"

is_running() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || echo '')"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

# 探测本机局域网 IPv4 地址（用于其他终端设备访问）
# 顺序：优先取默认路由网卡 → 常见网卡 → 兜底 hostname -I
get_lan_ip() {
  local ip=""
  # 1) 取默认路由对应的本机 IP（最可靠）
  ip="$(ip route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
  # 2) 备选：hostname -I 第一个非 loopback 地址
  if [ -z "$ip" ]; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  # 3) 兜底：遍历网卡
  if [ -z "$ip" ]; then
    for dev in eth0 ens33 enp0s3 enp2s0 wlan0; do
      ip="$(ip -4 addr show "$dev" 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1)"
      [ -n "$ip" ] && break
    done
  fi
  [ -z "$ip" ] && ip="127.0.0.1"
  printf '%s' "$ip"
}

LAN_IP="$(get_lan_ip)"

do_start() {
  if is_running; then
    echo "[start] 后端已在运行 (PID $(cat "$PID_FILE"))，无需重复启动。"
    echo "[start] 本机访问 → http://localhost:$PORT"
    echo "[start] 局域网访问 → http://$LAN_IP:$PORT （同一局域网内其他终端浏览器打开）"
    return 0
  fi
  if [ ! -x "$SCRIPT_DIR/.venv/bin/uvicorn" ]; then
    echo "[start] 未找到虚拟环境，请先运行: bash setup_env.sh"
    return 1
  fi
  echo "[start] 正在启动金融工作台（监听 $HOST:$PORT）"
  nohup "$SCRIPT_DIR/.venv/bin/uvicorn" app.main:app --host "$HOST" --port "$PORT" --app-dir "$SCRIPT_DIR" --log-config "$SCRIPT_DIR/logging_config.json" >>"$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  if is_running; then
    echo "[start] 启动成功 (PID $(cat "$PID_FILE"))，日志: $LOG_FILE"
    echo "[start] 本机访问 → http://localhost:$PORT"
    if [ "$HOST" = "0.0.0.0" ] || [ "$HOST" = "::" ]; then
      echo "[start] 局域网访问 → http://$LAN_IP:$PORT （同一局域网内其他终端设备浏览器打开）"
    fi
  else
    echo "[start] 启动失败，请查看日志: $LOG_FILE"
    return 1
  fi
}

do_stop() {
  if is_running; then
    local pid
    pid="$(cat "$PID_FILE")"
    kill "$pid" 2>/dev/null
    # 等待进程退出（最多 8 秒）
    for _ in $(seq 1 8); do
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "[stop] 进程未响应，强制终止 (PID $pid)"
      kill -9 "$pid" 2>/dev/null
    fi
    rm -f "$PID_FILE"
    echo "[stop] 后端已停止。"
  else
    rm -f "$PID_FILE"
    echo "[stop] 后端当前未运行。"
  fi
}

do_status() {
  if is_running; then
    echo "[status] 运行中 (PID $(cat "$PID_FILE"))"
    echo "[status] 本机访问 → http://localhost:$PORT"
    echo "[status] 局域网访问 → http://$LAN_IP:$PORT"
  else
    echo "[status] 未运行"
  fi
}

case "$cmd" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; do_start ;;
  status)  do_status ;;
  *)
    echo "用法: bash operation.sh {start|stop|restart|status} [port] [host]"
    echo "示例:"
    echo "  bash operation.sh start          # 启动，默认端口 8000，监听 0.0.0.0（可局域网访问）"
    echo "  bash operation.sh start 8080     # 启动，指定端口 8080"
    echo "  bash operation.sh start 8000 127.0.0.1   # 仅本机访问（禁用局域网）"
    echo "  bash operation.sh stop           # 停止后端"
    echo "  bash operation.sh restart 8080   # 重启"
    exit 1
    ;;
esac
