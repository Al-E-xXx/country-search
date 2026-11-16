import type { CountryView } from '../api/map-country-response.js';
import { DEBOUNCE_DELAY_MS, REQUEST_TIMEOUT_MS } from '../config.js';
import { debounce } from './debounce.js';
import { classifySearchError } from './error-classification.js';
import type { SearchFailure } from './error-classification.js';

export type { SearchFailure, SearchFailureKind } from './error-classification.js';

/** Looks one query up, and obeys the signal it is handed. */
export type SearchFn = (query: string, signal: AbortSignal) => Promise<CountryView[]>;

/**
 * Everything the interface has to know about a search. Each callback describes
 * one state, so the interface only draws and never asks what happened before.
 */
export interface SearchFlowHandlers {
  onLoading(query: string): void;
  onSuccess(countries: CountryView[], query: string): void;
  onEmpty(query: string): void;
  onFailure(failure: SearchFailure, query: string): void;
  onCleared(): void;
}

export interface SearchFlowOptions {
  search: SearchFn;
  handlers: SearchFlowHandlers;
}

export interface SearchFlow {
  /** Feeds the flow whatever the search box holds right now. */
  onInput(query: string): void;
  /** Sends the last query again, right away. */
  retry(): void;
  /** Cancels everything in flight and returns to the empty state. */
  reset(): void;
}

const EMPTY_QUERY = '';

/**
 * Drives one search box: it batches keystrokes, keeps at most one request alive
 * and translates whatever comes back into the five states of the interface.
 *
 * Cancellation is the core of it. Every new piece of input tears the previous
 * request down with `abort()` instead of letting its answer arrive late and
 * overwrite a newer one, so the results on screen always belong to the text that
 * is in the box. A request that was torn down this way never reports anything.
 */
export function createSearchFlow({ search, handlers }: SearchFlowOptions): SearchFlow {
  let activeController: AbortController | null = null;
  let lastQuery = EMPTY_QUERY;

  const abortActiveRequest = (): void => {
    if (activeController === null) {
      return;
    }
    activeController.abort();
    activeController = null;
  };

  const reportFailure = (query: string, failure: SearchFailure | null): void => {
    if (failure !== null) {
      handlers.onFailure(failure, query);
    }
  };

  const runSearch = (query: string): void => {
    const controller = new AbortController();
    activeController = controller;

    const timeoutId = setTimeout(() => {
      const reason = new DOMException(
        `Search for "${query}" timed out after ${REQUEST_TIMEOUT_MS}ms`,
        'TimeoutError',
      );
      controller.abort(reason);
      reportFailure(query, classifySearchError(reason));
    }, REQUEST_TIMEOUT_MS);

    const finish = (): void => {
      clearTimeout(timeoutId);
      if (activeController === controller) {
        activeController = null;
      }
    };

    handlers.onLoading(query);

    search(query, controller.signal).then(
      (countries) => {
        finish();
        // An answer of a request that was given up on is not allowed to reach
        // the interface, no matter how late it arrives.
        if (controller.signal.aborted) {
          return;
        }
        if (countries.length === 0) {
          handlers.onEmpty(query);
        } else {
          handlers.onSuccess(countries, query);
        }
      },
      (error: unknown) => {
        finish();
        // A request we tore down ourselves has already said everything it had to
        // say: either nothing (the user typed on) or a timeout (the timer spoke).
        if (controller.signal.aborted) {
          return;
        }
        reportFailure(query, classifySearchError(error));
      },
    );
  };

  const scheduleSearch = debounce(runSearch, DEBOUNCE_DELAY_MS);

  const onInput = (rawQuery: string): void => {
    const query = rawQuery.trim();
    abortActiveRequest();
    scheduleSearch.cancel();

    if (query === EMPTY_QUERY) {
      lastQuery = EMPTY_QUERY;
      handlers.onCleared();
      return;
    }

    lastQuery = query;
    scheduleSearch(query);
  };

  const retry = (): void => {
    if (lastQuery === EMPTY_QUERY) {
      return;
    }
    abortActiveRequest();
    scheduleSearch.cancel();
    runSearch(lastQuery);
  };

  const reset = (): void => {
    abortActiveRequest();
    scheduleSearch.cancel();
    lastQuery = EMPTY_QUERY;
    handlers.onCleared();
  };

  return { onInput, retry, reset };
}
