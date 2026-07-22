# mango-scraper

Worker/CLI Bun separado para ejecutar los scrapers sin arrancar todo `monline-api`.

Este proyecto contiene su propia copia del scraper y del schema Drizzle necesario. No importa código desde `monline-api`, para que pueda versionarse, desplegarse y ejecutarse de forma independiente.

No usa NestJS. Para este runtime solo necesitamos CLI/worker, Drizzle, fetch/parsing y una cola en memoria sencilla. Si más adelante hace falta un API HTTP para disparar jobs o consultar estado, se puede agregar Hono encima sin volver a Nest.

## Uso

Instalar dependencias:

```bash
bun install
```

Ejecutar un scraper:

```bash
DATABASE_URL="postgres://..." bun run scrape ikigai --start=1 --end=3
DATABASE_URL="postgres://..." bun run scrape olympus --start=1 --end=2
DATABASE_URL="postgres://..." bun run scrape nobledicion --start=0 --end=1 --posts-per-page=6
DATABASE_URL="postgres://..." bun run scrape taurus --start=0 --end=1 --posts-per-page=6
```

## Producción

Para dejar el scraper encendido como proceso persistente:

```bash
bun run start
```

El worker escribe un archivo de estado configurable:

```env
SCRAPER_STATUS_FILE=./scraper-status.json
SCRAPER_LOCK_FILE=./scraper-status.json.lock
SCRAPER_HEARTBEAT_SECONDS=30
```

Consultar estado:

```bash
bun run status
```

El status incluye:

- `status`: `running`, `stopping`, `stopped` o `error`.
- `pid`: proceso activo.
- `heartbeatAt`: último latido.
- `mode`: modo activo.
- `enabledScrapers`: scrapers habilitados según `SCRAPER_MODE`.
- `running`: scrapers corriendo en ese momento.
- `lastRun`: último resultado por scraper.

Ejecutar M440/Peerless solo cuando el modo lo permita:

```bash
SCRAPER_MODE=m440_only bun run scrape m440 --start=1 --end=1
```

Ejecutar todos:

```bash
DATABASE_URL="postgres://..." bun run scrape:all --start=1 --end=1
```

También puedes copiar/crear un `.env` en esta carpeta. Bun carga `.env` automáticamente.

## Docker (rama `termux`)

Para entornos donde no se puede instalar Scrapling/Chromium (Termux, VPS mínimos):

```bash
cp .env.docker.example .env   # editar DATABASE_URL, etc.
docker compose up --build -d
```

Ver `docker/README.md` para detalle. La imagen incluye Bun + Scrapling + browsers y ejecuta `bun run start` con `M440_SCRAPLING_COOKIES=true` por defecto.

## Variables importantes

- `DATABASE_URL`: conexión Postgres.
- `SCRAPER_MODE`: controla qué scrapers pueden ejecutarse.
  - `m440_disabled`: default; activa Ikigai/Olympus/Nobledicion y bloquea M440.
  - `m440_only`: activa solo M440/Peerless.
  - `all`: activa todos, incluyendo M440.
- `SCRAPER_DELAY_MS`: delay entre requests; default `2000`.
- `SCRAPER_RUN_ON_STARTUP`: ejecuta los scrapers habilitados al arrancar `bun run start`; default `true`: ejecuta una vez al iniciar y luego espera el intervalo configurado.
- `SCRAPER_STATUS_FILE`: ruta del archivo JSON de estado; default `./scraper-status.json`.
- `SCRAPER_LOCK_FILE`: lock file del worker; evita que un cron/restart arranque workers duplicados.
- `SCRAPER_HEARTBEAT_SECONDS`: cada cuántos segundos actualizar/loguear estado; default `30`.
- `DB_POOL_MAX`: tamaño del pool para el worker; default `5`.
- `SCRAPER_IKIGAI_URL`, `SCRAPER_NOBLEDICION_URL`, `SCRAPER_TAURUS_URL`: overrides por fuente.
- `SCRAPER_IKIGAI_INTERVAL_MIN`, `SCRAPER_OLYMPUS_INTERVAL_MIN`, `SCRAPER_NOBLEDICION_INTERVAL_MIN`, `SCRAPER_TAURUS_INTERVAL_MIN`, `SCRAPER_M440_INTERVAL_MIN`: intervalos del scheduler de `bun run start`.
- `SCRAPER_M440_URL`: URL base de M440/Peerless. Usa tu proxy/local en desarrollo para evitar bloqueos de IP en producción.
- `LOG_LEVEL=debug`: habilita logs debug.

### M440 en local vs producción

Recomendado en producción:

```env
SCRAPER_MODE=m440_disabled
SCRAPER_M440_URL=https://m440.in
```

Solo M440 en local/proxy:

```env
SCRAPER_MODE=m440_only
SCRAPER_M440_URL=http://localhost:3228
```

Todos activados, incluyendo M440:

```env
SCRAPER_MODE=all
SCRAPER_M440_URL=http://localhost:3228
```

También se soporta `SCRAPER_PEERLESS_URL` como alias legacy de `SCRAPER_M440_URL`.

## Nota de arquitectura

Esta carpeta pasa a ser la fuente de verdad runtime del scraper:

1. `monline-api` conserva su código histórico del scraper, pero no lo carga en `AppModule`.
2. El worker ejecuta scrapers manualmente/por cron externo.
3. Si el schema cambia en `monline-api`, replica conscientemente el cambio aquí o promueve `src/database/schema` a un paquete compartido versionado.
# mango-scraper
