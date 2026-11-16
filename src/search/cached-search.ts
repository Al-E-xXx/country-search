import type { CountryView } from '../api/map-country-response.js';
import { SEARCH_CACHE_MAX_ENTRIES, SEARCH_CACHE_TTL_MS } from '../config.js';
import type { SearchFn } from './search-flow.js';

/**
 * Wraps the search function with two memory savers, and nothing else:
 *
 * - **Answers are remembered.** Asking the same query again inside the freshness
 *   window is answered from memory, without a request.
 * - **Requests are shared.** While a query is on its way, anyone who asks for the
 *   same thing joins that one request instead of starting a second one.
 *
 * The wrapper stays a drop-in replacement for the plain search function: it still
 * obeys the signal it is handed, because cancellation is the rule of this app and
 * a cache must not quietly break it:
 *
 * - a caller that walks away only leaves the shared request,
 * - the real request is torn down only once the last caller has gone, and then it
 *   is really aborted rather than left to run for nobody,
 * - a failure is never remembered, so a retry goes back to the API,
 * - an answer that arrives is handed to every caller that was waiting for it.
 *
 * Memory is bounded: answers expire, and the least recently used answer is pushed
 * out when the cache is full.
 */

interface CachedAnswer {
  countries: CountryView[];
  /** When the answer arrived, which is what decides whether it is still fresh. */
  storedAt: number;
}

/** One request on its way to the API, together with everyone waiting for it. */
interface SharedRequest {
  controller: AbortController;
  watchers: Set<AbortSignal>;
  promise: Promise<CountryView[]>;
  /** Takes the request out of the register of requests in flight. */
  leaveRegister(): void;
}

export interface CachedSearchOptions {
  search: SearchFn;
  ttlMs?: number;
  maxEntries?: number;
}

export interface CachedSearch {
  /** Same contract as the search function it wraps. */
  search(query: string, signal: AbortSignal): Promise<CountryView[]>;
  /** How many answers are remembered right now. */
  size(): number;
  /** Forgets every remembered answer. Requests already running are left alone. */
  clear(): void;
}

const EMPTY_QUERY = '';

/**
 * Queries that differ only in spacing or lettering ask the same question, so they
 * share one answer. The raw text is what goes to the API; the key only decides
 * whether an answer may be reused.
 */
const toCacheKey = (query: string): string => query.trim().toLowerCase();

export function createCachedSearch({
  search,
  ttlMs = SEARCH_CACHE_TTL_MS,
  maxEntries = SEARCH_CACHE_MAX_ENTRIES,
}: CachedSearchOptions): CachedSearch {
  const answers = new Map<string, CachedAnswer>();
  const pending = new Map<string, SharedRequest>();

  const remember = (key: string, countries: CountryView[]): void => {
    answers.delete(key);
    answers.set(key, { countries, storedAt: Date.now() });
    // A Map visits its entries in insertion order, so the first one is the answer
    // that has gone longest without being asked for.
    while (answers.size > maxEntries) {
      const leastRecent = answers.keys().next();
      if (leastRecent.done) {
        break;
      }
      answers.delete(leastRecent.value);
    }
  };

  /** Gives back a remembered answer, or null when it is gone or too old. */
  const recall = (key: string): CountryView[] | null => {
    const answer = answers.get(key);
    if (answer === undefined) {
      return null;
    }
    if (Date.now() - answer.storedAt >= ttlMs) {
      answers.delete(key);
      return null;
    }
    // Asking for an answer puts it at the fresh end of the remembered ones.
    answers.delete(key);
    answers.set(key, answer);
    return answer.countries;
  };

  const openRequest = (key: string, query: string): SharedRequest => {
    const controller = new AbortController();
    const watchers = new Set<AbortSignal>();
    let registered = true;

    // Whoever drops out may only take this very request out of the register: a
    // query that was given up on may already have been started again by then.
    const leaveRegister = (): void => {
      if (!registered) {
        return;
      }
      registered = false;
      pending.delete(key);
    };

    const promise = search(query, controller.signal).then(
      (countries) => {
        leaveRegister();
        // An answer of a request nobody is waiting for is not worth remembering:
        // whoever asks next should get a fresh one.
        if (!controller.signal.aborted) {
          remember(key, countries);
        }
        return countries;
      },
      (error: unknown) => {
        leaveRegister();
        throw error;
      },
    );

    const request: SharedRequest = { controller, watchers, promise, leaveRegister };
    pending.set(key, request);
    return request;
  };

  /**
   * Attaches one caller to a request. The caller receives the answer that is on
   * its way, but the only power it has over that request is to leave it.
   */
  const follow = (request: SharedRequest, signal: AbortSignal): Promise<CountryView[]> =>
    new Promise<CountryView[]>((resolve, reject) => {
      const giveUp = (): void => {
        request.watchers.delete(signal);
        if (request.watchers.size === 0) {
          // Nobody is left who can use the answer, so the request is cancelled
          // for real rather than left to run for nothing.
          request.leaveRegister();
          request.controller.abort(signal.reason);
        }
        reject(signal.reason);
      };

      signal.addEventListener('abort', giveUp, { once: true });
      request.promise.then(
        (countries) => {
          signal.removeEventListener('abort', giveUp);
          resolve(countries);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', giveUp);
          reject(error);
        },
      );
    });

  const searchCached = (query: string, signal: AbortSignal): Promise<CountryView[]> => {
    // A caller that has already given up is answered with the cancellation right
    // away, and neither the memory nor the API is disturbed on its way out.
    if (signal.aborted) {
      return Promise.reject(signal.reason);
    }

    const key = toCacheKey(query);
    if (key === EMPTY_QUERY) {
      return search(query, signal);
    }

    const remembered = recall(key);
    if (remembered !== null) {
      return Promise.resolve(remembered);
    }

    const alreadyRunning = pending.get(key);
    const request = alreadyRunning ?? openRequest(key, query);
    request.watchers.add(signal);
    return follow(request, signal);
  };

  return {
    search: searchCached,
    size: () => answers.size,
    clear: () => {
      answers.clear();
    },
  };
}
