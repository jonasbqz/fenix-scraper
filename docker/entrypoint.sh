#!/usr/bin/env bash
set -euo pipefail

mkdir -p /app/data

# Defaults for persistent state inside the container volume.
export SCRAPER_STATUS_FILE="${SCRAPER_STATUS_FILE:-/app/data/scraper-status.json}"
export SCRAPER_LOCK_FILE="${SCRAPER_LOCK_FILE:-/app/data/scraper-status.json.lock}"
export RETRY_QUEUE_DB="${RETRY_QUEUE_DB:-/app/data/retry-queue.db}"
export M440_PYTHON="${M440_PYTHON:-python3}"
export M440_SOLVE_SCRIPT="${M440_SOLVE_SCRIPT:-/app/scripts/m440-solve.py}"

if [[ "${M440_SCRAPLING_COOKIES:-true}" == "true" ]]; then
  echo "[docker] Scrapling Cloudflare bypass enabled (M440_SCRAPLING_COOKIES=true)"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[docker] ERROR: DATABASE_URL is required. Copy .env.docker.example to .env and set it." >&2
  exit 1
fi

exec "$@"
