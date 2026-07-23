import { EnvConfig } from '@/lib/config';

export type ScraperName =
  | 'ikigai'
  | 'olympus'
  | 'peerless'
  | 'm440'
  | 'nobledicion'
  | 'taurus'
  | 'leercapitulo';
export type ScraperMode = 'm440_disabled' | 'm440_only' | 'all';

export function getScraperMode(config: EnvConfig): ScraperMode {
  const raw = config.get<string>('SCRAPER_MODE') || 'm440_disabled';
  const normalized = raw.trim().toLowerCase().replace(/-/g, '_');

  if (normalized === 'm440_only' || normalized === 'only_m440') {
    return 'm440_only';
  }

  if (normalized === 'all' || normalized === 'all_enabled') {
    return 'all';
  }

  if (
    normalized === 'm440_disabled'
    || normalized === 'no_m440'
    || normalized === 'default'
    || normalized === 'production'
  ) {
    return 'm440_disabled';
  }

  throw new Error(`Invalid SCRAPER_MODE="${raw}". Use m440_disabled, m440_only, or all.`);
}

export function getScrapersForMode(mode: ScraperMode): ScraperName[] {
  switch (mode) {
    case 'm440_only':
      return ['m440'];
    case 'all':
      return ['ikigai', 'olympus', 'nobledicion', 'taurus', 'leercapitulo', 'm440'];
    case 'm440_disabled':
      return ['ikigai', 'olympus', 'nobledicion', 'taurus', 'leercapitulo'];
  }
}
