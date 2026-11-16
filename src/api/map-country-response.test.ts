import { describe, expect, it } from 'vitest';

import { mapCountryResponse } from './map-country-response.js';

/**
 * Fixtures are the real payloads of https://countries.dev, captured verbatim, so
 * the mapper is exercised against fields it does not care about as well.
 */
const spainPayload = {
  area: 505992,
  cioc: 'ESP',
  flag: '🇪🇸',
  gini: 34.7,
  name: 'Spain',
  flags: { png: 'https://flagcdn.com/w320/es.png', svg: 'https://flagcdn.com/es.svg' },
  latlng: [40, -4],
  region: 'Europe',
  borders: ['AND', 'FRA', 'GIB', 'PRT', 'MAR'],
  capital: 'Madrid',
  demonym: 'Spanish',
  languages: [{ name: 'Spanish', iso639_1: 'es', iso639_2: 'spa', nativeName: 'Español' }],
  subregion: 'Southern Europe',
  timezones: ['UTC', 'UTC+01:00'],
  alpha2Code: 'ES',
  alpha3Code: 'ESP',
  currencies: [{ code: 'EUR', name: 'Euro', symbol: '€' }],
  nativeName: 'España',
  population: 47351567,
  independent: true,
  numericCode: '724',
  callingCodes: ['34'],
  topLevelDomain: ['.es'],
  populationDensity: 93.58,
};

/** Nauru: the endpoint simply omits the `borders` key for island states. */
const nauruPayload = {
  area: 21,
  flag: '🇳🇷',
  name: 'Nauru',
  flags: { png: 'https://flagcdn.com/w320/nr.png', svg: 'https://flagcdn.com/nr.svg' },
  region: 'Oceania',
  capital: 'Yaren',
  demonym: 'Nauruan',
  languages: [
    { name: 'English', iso639_1: 'en' },
    { name: 'Nauruan', iso639_1: 'na' },
  ],
  subregion: 'Micronesia',
  alpha3Code: 'NRU',
  currencies: [{ code: 'AUD', name: 'Australian dollar', symbol: '$' }],
  nativeName: 'Nauru',
  population: 10834,
};

describe('mapCountryResponse', () => {
  describe('card fields', () => {
    it('maps the name, capital, region and population of a full payload', () => {
      const country = mapCountryResponse(spainPayload);

      expect(country.name).toBe('Spain');
      expect(country.capital).toBe('Madrid');
      expect(country.region).toBe('Europe');
      expect(country.population).toBe(47351567);
    });

    it('prefers the png image and keeps the emoji flag', () => {
      const country = mapCountryResponse(spainPayload);

      expect(country.flagUrl).toBe('https://flagcdn.com/w320/es.png');
      expect(country.flagEmoji).toBe('🇪🇸');
    });

    it('falls back to the svg image when there is no png one', () => {
      const country = mapCountryResponse({
        name: 'Spain',
        flags: { svg: 'https://flagcdn.com/es.svg' },
      });

      expect(country.flagUrl).toBe('https://flagcdn.com/es.svg');
    });

    it('has no flag image when the payload carries none, but keeps the emoji', () => {
      const country = mapCountryResponse({ name: 'Spain', flag: '🇪🇸' });

      expect(country.flagUrl).toBeNull();
      expect(country.flagEmoji).toBe('🇪🇸');
    });

    it('keeps the alpha-3 code to identify the country', () => {
      const country = mapCountryResponse(spainPayload);

      expect(country.alpha3).toBe('ESP');
    });
  });

  describe('detail fields', () => {
    it('maps subregion, native name, demonym and area', () => {
      const country = mapCountryResponse(spainPayload);

      expect(country.subregion).toBe('Southern Europe');
      expect(country.nativeName).toBe('España');
      expect(country.demonym).toBe('Spanish');
      expect(country.area).toBe(505992);
    });

    it('reduces language objects to their names', () => {
      const country = mapCountryResponse(spainPayload);

      expect(country.languages).toEqual(['Spanish']);
    });

    it('labels a currency by its name and code', () => {
      const country = mapCountryResponse(spainPayload);

      expect(country.currencies).toEqual(['Euro (EUR)']);
    });

    it('keeps neighbouring country codes as they are', () => {
      const country = mapCountryResponse(spainPayload);

      expect(country.borders).toEqual(['AND', 'FRA', 'GIB', 'PRT', 'MAR']);
    });
  });

  describe('fields the endpoint omits', () => {
    it('gives an empty list for borders when the payload has no such key', () => {
      const country = mapCountryResponse(nauruPayload);

      expect(country.borders).toEqual([]);
    });

    it('keeps every language and currency of an island state', () => {
      const country = mapCountryResponse(nauruPayload);

      expect(country.languages).toEqual(['English', 'Nauruan']);
      expect(country.currencies).toEqual(['Australian dollar (AUD)']);
    });

    it('uses null for unknown text and null for unknown numbers', () => {
      const country = mapCountryResponse({ name: 'Nowhere' });

      expect(country).toEqual({
        alpha3: null,
        name: 'Nowhere',
        flagUrl: null,
        flagEmoji: null,
        capital: null,
        region: null,
        subregion: null,
        nativeName: null,
        demonym: null,
        population: null,
        area: null,
        languages: [],
        currencies: [],
        borders: [],
      });
    });

    it('keeps a population of zero rather than reading it as missing', () => {
      const country = mapCountryResponse({ name: 'Nowhere', population: 0, area: 0 });

      expect(country.population).toBe(0);
      expect(country.area).toBe(0);
    });

    it('reads a population that is not a number as missing', () => {
      const country = mapCountryResponse({ name: 'Nowhere', population: '47351567' });

      expect(country.population).toBeNull();
    });
  });

  describe('incomplete list entries', () => {
    it('skips language entries that carry no name', () => {
      const country = mapCountryResponse({
        name: 'Nowhere',
        languages: [{ iso639_1: 'en' }, { name: 'English' }, { name: '   ' }],
      });

      expect(country.languages).toEqual(['English']);
    });

    it('labels currencies from whatever single field they have', () => {
      const country = mapCountryResponse({
        name: 'Nowhere',
        currencies: [{ code: 'USD' }, { name: 'Dollar' }, { symbol: '$' }],
      });

      expect(country.currencies).toEqual(['USD', 'Dollar', '$']);
    });

    it('skips currency entries that carry nothing usable', () => {
      const country = mapCountryResponse({
        name: 'Nowhere',
        currencies: [{}, { code: 'USD' }],
      });

      expect(country.currencies).toEqual(['USD']);
    });

    it('ignores list fields that are not arrays', () => {
      const country = mapCountryResponse({
        name: 'Nowhere',
        languages: null,
        currencies: 'Euro',
        borders: { 0: 'FRA' },
      });

      expect(country.languages).toEqual([]);
      expect(country.currencies).toEqual([]);
      expect(country.borders).toEqual([]);
    });
  });

  describe('purity', () => {
    it('does not change the payload it was given', () => {
      const payload = structuredClone(spainPayload);

      mapCountryResponse(payload);

      expect(payload).toEqual(spainPayload);
    });
  });
});
