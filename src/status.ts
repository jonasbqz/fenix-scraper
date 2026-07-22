import { readFile } from 'node:fs/promises';

const statusFile = process.env.SCRAPER_STATUS_FILE || './scraper-status.json';

async function run() {
  try {
    const raw = await readFile(statusFile, 'utf8');
    const status = JSON.parse(raw);
    console.log(JSON.stringify(status, null, 2));
  } catch (error) {
    console.error(`No se pudo leer status en ${statusFile}: ${error}`);
    process.exit(1);
  }
}

void run();
