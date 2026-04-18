#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/.run"
PID_FILE="${RUNTIME_DIR}/ceair-monitor.pid"
LOG_FILE="${RUNTIME_DIR}/ceair-monitor.log"
if [[ -x "${ROOT_DIR}/.venv/bin/ceair-monitor" ]]; then
  CMD=("${ROOT_DIR}/.venv/bin/ceair-monitor")
else
  CMD=(uv run ceair-monitor)
fi
HEALTHCHECK_URL="http://127.0.0.1:8766/api/status"

mkdir -p "${RUNTIME_DIR}"

read_pid() {
  if [[ -f "${PID_FILE}" ]]; then
    tr -d '[:space:]' < "${PID_FILE}"
  fi
}

find_running_pid() {
  local pid
  pid="$(read_pid)"
  if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
    printf '%s\n' "${pid}"
    return 0
  fi

  local candidates=()
  if command -v pgrep >/dev/null 2>&1; then
    while IFS= read -r line; do
      [[ -n "${line}" ]] && candidates+=("${line}")
    done < <(pgrep -f "${ROOT_DIR}/.venv/bin/ceair-monitor" || true)
    if [[ ${#candidates[@]} -eq 0 ]]; then
      while IFS= read -r line; do
        [[ -n "${line}" ]] && candidates+=("${line}")
      done < <(pgrep -f "uv run ceair-monitor" || true)
    fi
  fi

  if [[ ${#candidates[@]} -gt 0 ]]; then
    printf '%s\n' "${candidates[0]}"
    return 0
  fi
  return 1
}

is_running() {
  local pid
  pid="$(find_running_pid || true)"
  if [[ -z "${pid}" ]]; then
    return 1
  fi
  echo "${pid}" > "${PID_FILE}"
  return 0
}

start_service() {
  if is_running; then
    echo "ceair-monitor is already running (pid $(read_pid))"
    exit 0
  fi

  rm -f "${PID_FILE}"
  nohup "${CMD[@]}" >> "${LOG_FILE}" 2>&1 &
  local pid=$!
  echo "${pid}" > "${PID_FILE}"

  for _ in {1..30}; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      break
    fi
    if curl -fsS "${HEALTHCHECK_URL}" >/dev/null 2>&1; then
      echo "ceair-monitor started (pid ${pid})"
      echo "log: ${LOG_FILE}"
      exit 0
    fi
    sleep 1
  done

  echo "failed to start ceair-monitor"
  tail -n 50 "${LOG_FILE}" 2>/dev/null || true
  rm -f "${PID_FILE}"
  exit 1
}

stop_service() {
  if ! is_running; then
    echo "ceair-monitor is not running"
    rm -f "${PID_FILE}"
    exit 0
  fi

  local pid
  pid="$(read_pid)"
  kill "${pid}" 2>/dev/null || true

  for _ in {1..20}; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      rm -f "${PID_FILE}"
      echo "ceair-monitor stopped"
      exit 0
    fi
    sleep 0.5
  done

  echo "ceair-monitor did not stop within timeout (pid ${pid})"
  exit 1
}

show_status() {
  if is_running; then
    echo "ceair-monitor is running (pid $(read_pid))"
    echo "log: ${LOG_FILE}"
    exit 0
  fi
  echo "ceair-monitor is not running"
  exit 1
}

show_logs() {
  touch "${LOG_FILE}"
  tail -n 100 -f "${LOG_FILE}"
}

case "${1:-}" in
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    stop_service || true
    start_service
    ;;
  status)
    show_status
    ;;
  logs)
    show_logs
    ;;
  *)
    cat <<'EOF'
Usage: ./scripts/ceair-daemon.sh <command>

Commands:
  start    Start ceair-monitor in background
  stop     Stop the background process
  restart  Restart the background process
  status   Show whether the process is running
  logs     Tail the log file
EOF
    exit 1
    ;;
esac
