# mango-scraper — Bun worker + Python Scrapling (Cloudflare bypass for m440).
#
# Build:  docker compose build
# Run:    docker compose up -d
# Logs:   docker compose logs -f

FROM oven/bun:1.2 AS bun-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM python:3.12-bookworm
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    BUN_INSTALL=/root/.bun \
    PATH="/root/.bun/bin:${PATH}" \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    M440_SCRAPLING_COOKIES=true \
    M440_PYTHON=python3 \
    M440_SOLVE_SCRIPT=/app/scripts/m440-solve.py \
    SCRAPER_STATUS_FILE=/app/data/scraper-status.json \
    SCRAPER_LOCK_FILE=/app/data/scraper-status.json.lock \
    RETRY_QUEUE_DB=/app/data/retry-queue.db \
    MANGO_IMAGE_DELAY_MS=0 \
    MANGO_IMAGE_CHAPTER_DELAY_MS=0

# System deps for Playwright/Chromium (Scrapling StealthyFetcher).
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Bun runtime (same major as deps stage).
RUN curl -fsSL https://bun.sh/install | bash

# Scrapling + browser binaries for Cloudflare solve script.
COPY scripts/requirements-scrapling.txt /tmp/requirements-scrapling.txt
RUN pip install --no-cache-dir -r /tmp/requirements-scrapling.txt \
    && scrapling install \
    && rm /tmp/requirements-scrapling.txt

COPY --from=bun-deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

COPY docker/entrypoint.sh /entrypoint.sh

RUN mkdir -p /app/data \
    && chmod +x /app/scripts/m440-solve.py /entrypoint.sh

VOLUME ["/app/data"]

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "run", "start"]
