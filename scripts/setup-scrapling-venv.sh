#!/usr/bin/env bash
# Local Scrapling venv (avoids PEP 668 "externally-managed-environment" on Debian/Ubuntu).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="${ROOT}/.venv-scrapling"
PY="${VENV}/bin/python3"
PIP="${VENV}/bin/pip"

echo "[scrapling] venv: ${VENV}"

if [[ ! -d "${VENV}" ]]; then
  python3 -m venv "${VENV}"
  echo "[scrapling] created venv"
fi

"${PIP}" install --upgrade pip
"${PIP}" install -r "${ROOT}/scripts/requirements-scrapling.txt"
"${VENV}/bin/scrapling" install

echo ""
echo "[scrapling] OK. Add to your .env:"
echo "  M440_SCRAPLING_COOKIES=true"
echo "  M440_PYTHON=${PY}"
echo "  SCRAPER_M440_URL=https://m440.in"
echo ""
echo "Test: bun run cookie-test"
