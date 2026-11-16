import type { ApiCountry } from './types.js';

/**
 * The single view-model the UI renders: the fields of a result card plus the
 * fields of the details panel. Missing values are `null` rather than an empty
 * string or `0`, so the interface can say "not reported" instead of inventing a
 * value. Lists are always arrays, which keeps the rendering code branch-free.
 */
export interface CountryView {
  alpha3: string | null;
  name: string;
  flagUrl: string | null;
  flagEmoji: string | null;
  capital: string | null;
  region: string | null;
  subregion: string | null;
  nativeName: string | null;
  demonym: string | null;
  population: number | null;
  area: number | null;
  languages: string[];
  currencies: string[];
  borders: string[];
}

/**
 * `ApiCountry` documents what the endpoint is expected to return; the record
 * branch is what it may actually return, and it is why the mapper validates
 * every field at runtime instead of trusting the declared shape.
 */
export type CountryPayload = ApiCountry | Record<string, unknown>;

const FLAG_IMAGE_PRIORITY = ['png', 'svg'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Non-empty text; blank or missing anything becomes `null`. */
function readText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** A real number only: strings and NaN become `null`, while `0` is kept. */
function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function keepText(values: (string | null)[]): string[] {
  return values.filter((value): value is string => value !== null);
}

function readLanguageNames(value: unknown): string[] {
  return keepText(readList(value).map((entry) => readText(asRecord(entry)?.name)));
}

function formatCurrency(entry: unknown): string | null {
  const currency = asRecord(entry);
  if (!currency) {
    return null;
  }
  const name = readText(currency.name);
  const code = readText(currency.code);
  if (name !== null && code !== null) {
    return `${name} (${code})`;
  }
  return name ?? code ?? readText(currency.symbol);
}

function readCurrencyLabels(value: unknown): string[] {
  return keepText(readList(value).map(formatCurrency));
}

/** Flag image: the raster one is preferred, the vector one is the fallback. */
function readFlagUrl(value: unknown): string | null {
  const flags = asRecord(value);
  if (!flags) {
    return null;
  }
  for (const format of FLAG_IMAGE_PRIORITY) {
    const url = readText(flags[format]);
    if (url !== null) {
      return url;
    }
  }
  return null;
}

/**
 * Turns one raw country of the search response into the view-model.
 *
 * The function is pure: the payload is only read, never modified, and the result
 * depends on the payload alone. Unknown, `null` and wrongly typed fields all
 * degrade to `null` or an empty list, so one incomplete country cannot break the
 * whole result list.
 */
export function mapCountryResponse(payload: CountryPayload): CountryView {
  const source: Record<string, unknown> = payload;

  return {
    alpha3: readText(source.alpha3Code),
    name: readText(source.name) ?? '',
    flagUrl: readFlagUrl(source.flags),
    flagEmoji: readText(source.flag),
    capital: readText(source.capital),
    region: readText(source.region),
    subregion: readText(source.subregion),
    nativeName: readText(source.nativeName),
    demonym: readText(source.demonym),
    population: readCount(source.population),
    area: readCount(source.area),
    languages: readLanguageNames(source.languages),
    currencies: readCurrencyLabels(source.currencies),
    borders: keepText(readList(source.borders).map(readText)),
  };
}
