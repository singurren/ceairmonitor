#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WSL_CONF_PATH="/etc/wsl.conf"
TMP_FILE="$(mktemp)"

run_sudo_install() {
  if [[ -n "${CEAIR_SUDO_PASSWORD:-}" ]]; then
    printf '%s\n' "${CEAIR_SUDO_PASSWORD}" | sudo -S install -m 644 "$1" "$2"
  else
    sudo install -m 644 "$1" "$2"
  fi
}

python3 - "${ROOT_DIR}" "${WSL_CONF_PATH}" > "${TMP_FILE}" <<'PY'
import configparser
import io
import sys
from pathlib import Path

root_dir = Path(sys.argv[1])
wsl_conf_path = Path(sys.argv[2])

config = configparser.ConfigParser(strict=False)
config.optionxform = str
if wsl_conf_path.exists():
    config.read(wsl_conf_path, encoding="utf-8")

if not config.has_section("boot"):
    config.add_section("boot")

command = f"bash -lc 'cd {root_dir} && ./scripts/ceair-daemon.sh start'"
config.set("boot", "command", command)

buffer = io.StringIO()
config.write(buffer)
sys.stdout.write(buffer.getvalue())
PY

run_sudo_install "${TMP_FILE}" "${WSL_CONF_PATH}"
rm -f "${TMP_FILE}"
echo "Installed WSL boot command into ${WSL_CONF_PATH}"
echo "Run 'wsl.exe --shutdown' from Windows once to let the next WSL boot pick it up."
