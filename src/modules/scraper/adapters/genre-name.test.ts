import { describe, expect, it } from 'bun:test';
import { isPlausibleGenreName, sanitizeGenreNames } from './base.adapter';

describe('isPlausibleGenreName', () => {
  it('keeps normal genres', () => {
    expect(isPlausibleGenreName('Acción')).toBe(true);
    expect(isPlausibleGenreName('Boys Love')).toBe(true);
    expect(isPlausibleGenreName('+18')).toBe(true);
    expect(isPlausibleGenreName('Artes Marciales')).toBe(true);
  });

  it('rejects Ikigai list-card pollution', () => {
    expect(
      isPlausibleGenreName(
        'La obsesión del tirano no tiene fin.comic44,5 mil vistas',
      ),
    ).toBe(false);
    expect(
      isPlausibleGenreName('¿por qué eres tan grande?comic24,3 mil vistas'),
    ).toBe(false);
    expect(isPlausibleGenreName('+15')).toBe(false);
  });

  it('dedupes via sanitizeGenreNames', () => {
    expect(sanitizeGenreNames(['Acción', 'acción', 'Romance', '+15'])).toEqual([
      'Acción',
      'Romance',
    ]);
  });
});
