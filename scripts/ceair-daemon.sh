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

process_exists() {
  local pid="$1"
  [[ -n "${pid}" ]] && ps -p "${pid}" >/dev/null 2>&1
}

terminate_pid() {
  local pid="$1"
  kill -- "-${pid}" 2>/dev/null || kill "${pid}" 2>/dev/null
}

find_running_pid() {
  local pid
  pid="$(read_pid)"
  if process_exists "${pid}"; then
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

write_pid_file() {
  local pid="$1"
  if ! { echo "${pid}" > "${PID_FILE}"; } 2>/dev/null; then
    echo "warning: cannot write pid file: ${PID_FILE}" >&2
  fi
}

is_running() {
  local pid
  pid="$(find_running_pid || true)"
  if [[ -z "${pid}" ]]; then
    return 1
  fi
  write_pid_file "${pid}"
  return 0
}

start_service() {
  local pid
  pid="$(find_running_pid || true)"
  if [[ -n "${pid}" ]]; then
    write_pid_file "${pid}"
    echo "ceair-monitor is already running (pid ${pid})"
    exit 0
  fi

  rm -f "${PID_FILE}"
  nohup setsid "${CMD[@]}" >> "${LOG_FILE}" 2>&1 &
  pid=$!
  write_pid_file "${pid}"

  for _ in {1..30}; do
    if ! process_exists "${pid}"; then
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
  local pid
  pid="$(find_running_pid || true)"
  if [[ -z "${pid}" ]]; then
    echo "ceair-monitor is not running"
    rm -f "${PID_FILE}" 2>/dev/null || true
    exit 0
  fi

  write_pid_file "${pid}"
  if ! terminate_pid "${pid}"; then
    echo "ceair-monitor is running but could not be stopped (pid ${pid}); try: sudo kill ${pid}" >&2
    exit 1
  fi

  for _ in {1..20}; do
    if ! process_exists "${pid}"; then
      rm -f "${PID_FILE}" 2>/dev/null || true
      echo "ceair-monitor stopped"
      exit 0
    fi
    sleep 0.5
  done

  echo "ceair-monitor did not stop within timeout (pid ${pid})"
  exit 1
}

show_status() {
  local pid
  pid="$(find_running_pid || true)"
  if [[ -n "${pid}" ]]; then
    write_pid_file "${pid}"
    echo "ceair-monitor is running (pid ${pid})"
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
    pid="$(find_running_pid || true)"
    if [[ -n "${pid}" ]]; then
      write_pid_file "${pid}"
      if ! terminate_pid "${pid}"; then
        echo "ceair-monitor is running but could not be stopped (pid ${pid}); try: sudo kill ${pid}" >&2
        exit 1
      fi
      for _ in {1..20}; do
        if ! process_exists "${pid}"; then
          rm -f "${PID_FILE}" 2>/dev/null || true
          echo "ceair-monitor stopped"
          break
        fi
        sleep 0.5
      done
      if kill -0 "${pid}" 2>/dev/null; then
        echo "ceair-monitor did not stop within timeout (pid ${pid})"
        exit 1
      fi
    else
      rm -f "${PID_FILE}" 2>/dev/null || true
    fi
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
