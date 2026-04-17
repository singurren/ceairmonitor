#!/usr/bin/env bash
set -euo pipefail

WSL_CONF_PATH="/etc/wsl.conf"
TMP_FILE="$(mktemp)"

run_sudo_install() {
  if [[ -n "${CEAIR_SUDO_PASSWORD:-}" ]]; then
    printf '%s\n' "${CEAIR_SUDO_PASSWORD}" | sudo -S install -m 644 "$1" "$2"
  else
    sudo install -m 644 "$1" "$2"
  fi
}

python3 - "${WSL_CONF_PATH}" > "${TMP_FILE}" <<'PY'
import configparser
import io
import sys
from pathlib import Path

wsl_conf_path = Path(sys.argv[1])
config = configparser.ConfigParser(strict=False)
config.optionxform = str
if wsl_conf_path.exists():
    config.read(wsl_conf_path, encoding="utf-8")

if config.has_section("boot"):
    config.remove_option("boot", "command")
    if not config.items("boot"):
        config.remove_section("boot")

buffer = io.StringIO()
config.write(buffer)
sys.stdout.write(buffer.getvalue())
PY

run_sudo_install "${TMP_FILE}" "${WSL_CONF_PATH}"
rm -f "${TMP_FILE}"
echo "Removed WSL boot command from ${WSL_CONF_PATH}"
echo "Run 'wsl.exe --shutdown' from Windows once to let the next WSL boot pick it up."
