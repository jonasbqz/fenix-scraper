# Docker (rama `termux`)

Imagen lista para correr `bun run start` con **Scrapling + Chromium** incluidos, sin instalar Python ni browsers en el host (útil en Termux, VPS mínimos, etc.).

## Requisitos

- Docker + Docker Compose v2
- Archivo `.env` con al menos `DATABASE_URL`

## Inicio rápido

```bash
cp .env.docker.example .env
# Edita .env — DATABASE_URL, MANGO_IMAGE_*, SCRAPER_MODE, etc.

docker compose up --build -d
docker compose logs -f
```

Equivalente con npm scripts:

```bash
bun run docker:up
bun run docker:logs
```

## Qué incluye la imagen

| Componente | Detalle |
|-----------|---------|
| Bun | Worker (`bun run start`) |
| Python 3.12 | Runtime para `scripts/m440-solve.py` |
| Scrapling `[fetchers]` | StealthyFetcher + browsers (`scrapling install`) |
| Chromium deps | libs del sistema para headless |
| Volumen `/app/data` | `scraper-status.json`, `retry-queue.db` |

## Variables por defecto en Docker

- `M440_SCRAPLING_COOKIES=true` — bypass Cloudflare activo
- `M440_PYTHON=python3`
- `M440_SOLVE_SCRIPT=/app/scripts/m440-solve.py`
- `SCRAPER_STATUS_FILE=/app/data/scraper-status.json`
- `RETRY_QUEUE_DB=/app/data/retry-queue.db`
- `MANGO_IMAGE_DELAY_MS=0` — subidas sin delay artificial

## Comandos útiles

```bash
# Rebuild tras cambios de código
docker compose up --build -d

# Probar script Scrapling dentro del contenedor
docker compose run --rm mango-scraper python3 /app/scripts/m440-solve.py

# Backfill manual
docker compose run --rm mango-scraper bun run upload peerless

# Parar
docker compose down
```

## Notas

- **`shm_size: 2gb`** en compose evita crashes de Chromium por memoria compartida baja.
- La primera resolución Cloudflare tarda ~30–60 s; luego se reutilizan cookies ~20 min.
- En Termux: necesitas Docker funcionando (root/proot o servidor remoto). Esta rama no instala Docker en Termux; empaqueta el entorno para cuando Docker esté disponible.
