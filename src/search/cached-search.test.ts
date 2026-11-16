import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpError } from '../api/http-error.js';
import type { CountryView } from '../api/map-country-response.js';
import { SEARCH_CACHE_TTL_MS } from '../config.js';
import { createCachedSearch } from './cached-search.js';
import type { CachedSearch } from './cached-search.js';
import type { SearchFn } from './search-flow.js';

interface InFlightRequest {
  query: string;
  signal: AbortSignal;
  succeed(countries: CountryView[]): void;
  fail(error: unknown): void;
}

/**
 * Stands in for the network layer exactly like the real fetch does: the promise
 * settles through the signal it is handed, so a cache that cancels a shared
 * request because one caller walked away is caught by these scenarios.
 */
function createNetworkStub(): { search: SearchFn; inFlight: InFlightRequest[] } {
  const inFlight: InFlightRequest[] = [];
  const search: SearchFn = (query, signal) =>
    new Promise<CountryView[]>((resolve, reject) => {
      inFlight.push({ query, signal, succeed: resolve, fail: reject });
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          reject(signal.reason);
        },
        { once: true },
      );
    });
  return { search, inFlight };
}

function makeCountry(name: string, alpha3: string): CountryView {
  return {
    alpha3,
    name,
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
  };
}

const spainView = makeCountry('Spain', 'ESP');
const portugalView = makeCountry('Portugal', 'PRT');
const franceView = makeCountry('France', 'FRA');

const ABORTED = { name: 'AbortError' };

function single<T>(items: T[], what: string): T {
  const [first, ...rest] = items;
  if (first === undefined || rest.length > 0) {
    throw new Error(`Expected exactly one ${what}, got ${items.length}`);
  }
  return first;
}

function lastRequest(inFlight: InFlightRequest[]): InFlightRequest {
  return single(inFlight.slice(-1), 'request');
}

function queriesOf(inFlight: InFlightRequest[]): string[] {
  return inFlight.map((request) => request.query);
}

describe('search cache', () => {
  let network: { search: SearchFn; inFlight: InFlightRequest[] };
  let cache: CachedSearch;

  beforeEach(() => {
    vi.useFakeTimers();
    network = createNetworkStub();
    cache = createCachedSearch({ search: network.search });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets the promise chains the cache started run to completion. */
  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  /**
   * Asks one query on behalf of its own caller and reports both the answer and
   * the network request it ended up needing, if any.
   */
  async function ask(
    query: string,
    controller = new AbortController(),
  ): Promise<{ promise: Promise<CountryView[]>; controller: AbortController }> {
    const promise = cache.search(query, controller.signal);
    await settle();
    return { promise, controller };
  }

  /** Runs a query to a good end and returns what the caller received. */
  async function fetchOnce(query: string, countries: CountryView[]): Promise<CountryView[]> {
    const { promise } = await ask(query);
    lastRequest(network.inFlight).succeed(countries);
    await settle();
    return promise;
  }

  describe('a query asked twice', () => {
    it('answers the second time without touching the network', async () => {
      const first = await fetchOnce('spain', [spainView]);

      const { promise } = await ask('spain');
      await settle();

      expect(queriesOf(network.inFlight)).toEqual(['spain']);
      await expect(promise).resolves.toEqual([spainView]);
      expect(first).toEqual([spainView]);
    });

    it('recognises a query typed with other spacing and other case', async () => {
      await fetchOnce('spain', [spainView]);

      const { promise } = await ask('  SPAIN  ');
      await settle();

      expect(queriesOf(network.inFlight)).toEqual(['spain']);
      await expect(promise).resolves.toEqual([spainView]);
      expect(cache.size()).toBe(1);
    });

    it('keeps the answers of two different queries apart', async () => {
      const spain = await fetchOnce('spain', [spainView]);
      const portugal = await fetchOnce('portugal', [portugalView]);

      const { promise } = await ask('spain');
      await settle();

      expect(queriesOf(network.inFlight)).toEqual(['spain', 'portugal']);
      await expect(promise).resolves.toEqual([spainView]);
      expect(spain).toEqual([spainView]);
      expect(portugal).toEqual([portugalView]);
    });

    it('remembers an answer that matched nothing, too', async () => {
      const first = await fetchOnce('zzqq', []);

      const { promise } = await ask('zzqq');
      await settle();

      expect(queriesOf(network.inFlight)).toEqual(['zzqq']);
      await expect(promise).resolves.toEqual([]);
      expect(first).toEqual([]);
    });
  });

  describe('a request that is still running', () => {
    it('is shared by two identical questions instead of being sent twice', async () => {
      const one = await ask('spain');
      const two = await ask('spain');

      expect(queriesOf(network.inFlight)).toEqual(['spain']);
      lastRequest(network.inFlight).succeed([spainView]);
      await settle();

      await expect(one.promise).resolves.toEqual([spainView]);
      await expect(two.promise).resolves.toEqual([spainView]);
    });

    it('survives a caller that walks away while another one waits', async () => {
      const leaving = await ask('spain');
      const staying = await ask('spain');
      const request = lastRequest(network.inFlight);
      const cancelled = expect(leaving.promise).rejects.toMatchObject(ABORTED);

      leaving.controller.abort();
      await settle();

      await cancelled;
      expect(request.signal.aborted).toBe(false);
      request.succeed([spainView]);
      await settle();

      expect(queriesOf(network.inFlight)).toEqual(['spain']);
      await expect(staying.promise).resolves.toEqual([spainView]);
    });

    it('is cancelled for real once the last caller walks away', async () => {
      const only = await ask('spain');
      const request = lastRequest(network.inFlight);
      const cancelled = expect(only.promise).rejects.toMatchObject(ABORTED);

      only.controller.abort();
      await settle();

      await cancelled;
      expect(request.signal.aborted).toBe(true);
      expect(cache.size()).toBe(0);
    });

    it('is asked again after every caller gave up on it', async () => {
      const only = await ask('spain');
      const cancelled = expect(only.promise).rejects.toMatchObject(ABORTED);

      only.controller.abort();
      await settle();
      await cancelled;

      const { promise } = await ask('spain');
      lastRequest(network.inFlight).succeed([spainView]);
      await settle();

      expect(queriesOf(network.inFlight)).toEqual(['spain', 'spain']);
      await expect(promise).resolves.toEqual([spainView]);
    });

    it('does not hold back a different query that is asked meanwhile', async () => {
      await ask('spain');
      await ask('portugal');

      expect(queriesOf(network.inFlight)).toEqual(['spain', 'portugal']);
    });
  });

  describe('a request that failed', () => {
    it('is not remembered, so a retry really asks again', async () => {
      const { promise } = await ask('spain');
      const rejected = expect(promise).rejects.toBeInstanceOf(HttpError);

      lastRequest(network.inFlight).fail(new HttpError(500, 'Search for "spain" failed'));
      await settle();
      await rejected;

      expect(cache.size()).toBe(0);

      await ask('spain');
      expect(queriesOf(network.inFlight)).toEqual(['spain', 'spain']);
    });

    it('is reported to every caller that shared it', async () => {
      const one = await ask('spain');
      const two = await ask('spain');
      const failure = new HttpError(503, 'Search for "spain" failed');
      const firstFailure = expect(one.promise).rejects.toBe(failure);
      const secondFailure = expect(two.promise).rejects.toBe(failure);

      lastRequest(network.inFlight).fail(failure);
      await settle();
      await Promise.all([firstFailure, secondFailure]);
    });

    it('leaves the answers of other queries alone', async () => {
      await fetchOnce('portugal', [portugalView]);
      const { promise } = await ask('spain');
      const rejected = expect(promise).rejects.toBeInstanceOf(HttpError);

      lastRequest(network.inFlight).fail(new HttpError(500, 'Search for "spain" failed'));
      await settle();
      await rejected;

      const reused = await ask('portugal');
      await settle();

      expect(queriesOf(network.inFlight)).toEqual(['portugal', 'spain']);
      await expect(reused.promise).resolves.toEqual([portugalView]);
    });
  });

  describe('how long an answer may be reused', () => {
    it('reuses an answer while it is still inside the configured window', async () => {
      await fetchOnce('spain', [spainView]);

      await vi.advanceTimersByTimeAsync(SEARCH_CACHE_TTL_MS - 1);
      const { promise } = await ask('spain');
      await settle();

      expect(queriesOf(network.inFlight)).toEqual(['spain']);
      await expect(promise).resolves.toEqual([spainView]);
    });

    it('asks again once the answer is older than the configured window', async () => {
      await fetchOnce('spain', [spainView]);

      await vi.advanceTimersByTimeAsync(SEARCH_CACHE_TTL_MS);
      await ask('spain');

      expect(queriesOf(network.inFlight)).toEqual(['spain', 'spain']);
    });

    it('honours a window chosen for one cache', async () => {
      const shortLived = createCachedSearch({ search: network.search, ttlMs: 5_000 });
      const { promise } = shortLived.search('spain', new AbortController().signal);
      await settle();
      lastRequest(network.inFlight).succeed([spainView]);
      await settle();
      await expect(promise).resolves.toEqual([spainView]);

      await vi.advanceTimersByTimeAsync(4_999);
      await shortLived.search('spain', new AbortController().signal);
      await vi.advanceTimersByTimeAsync(1);
      await shortLived.search('spain', new AbortController().signal);
      await settle();

      expect(queriesOf(network.inFlight)).toEqual(['spain', 'spain']);
    });
  });

  describe('a cache that holds only a few answers', () => {
    it('pushes out the answer that was used least recently', async () => {
      const small = createCachedSearch({ search: network.search, maxEntries: 2 });
      const askSmall = async (query: string, answer: CountryView): Promise<CountryView[]> => {
        const promise = small.search(query, new AbortController().signal);
        await settle();
        lastRequest(network.inFlight).succeed([answer]);
        await settle();
        return promise;
      };

      await askSmall('spain', spainView);
      await askSmall('portugal', portugalView);
      // Reusing spain makes portugal the oldest answer of the two.
      await askSmall('spain', spainView);
      await askSmall('france', franceView);
      expect(small.size()).toBe(2);

      const reused = await askSmall('spain', spainView);
      const fetchedAgain = await askSmall('portugal', portugalView);

      expect(queriesOf(network.inFlight)).toEqual(['spain', 'portugal', 'france', 'portugal']);
      expect(reused).toEqual([spainView]);
      expect(fetchedAgain).toEqual([portugalView]);
    });
  });

  describe('emptying the cache', () => {
    it('forgets what it knew', async () => {
      await fetchOnce('spain', [spainView]);

      cache.clear();

      expect(cache.size()).toBe(0);
      await ask('spain');
      expect(queriesOf(network.inFlight)).toEqual(['spain', 'spain']);
    });
  });

  describe('a caller that has already given up', () => {
    it('is answered with a cancellation and starts no request', async () => {
      const controller = new AbortController();
      controller.abort();

      const promise = cache.search('spain', controller.signal);
      const cancelled = expect(promise).rejects.toMatchObject(ABORTED);
      await settle();

      await cancelled;
      expect(network.inFlight).toHaveLength(0);
    });

    it('is not served from the cache either', async () => {
      await fetchOnce('spain', [spainView]);
      const controller = new AbortController();
      controller.abort();

      const promise = cache.search('spain', controller.signal);
      const cancelled = expect(promise).rejects.toMatchObject(ABORTED);
      await settle();

      await cancelled;
      expect(queriesOf(network.inFlight)).toEqual(['spain']);
    });
  });
});
