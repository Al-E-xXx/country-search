import { mapCountryResponse } from './api/map-country-response.js';
import type { CountryView } from './api/map-country-response.js';
import { searchCountries } from './api/search-countries.js';
import { createCachedSearch } from './search/cached-search.js';
import { createSearchHistory } from './search/history.js';
import type { HistoryStorage } from './search/history.js';
import { createSearchFlow } from './search/search-flow.js';
import { createSearchView } from './ui/render.js';

/** One lookup, from the endpoint to the view-model the interface draws. */
function search(query: string, signal: AbortSignal): Promise<CountryView[]> {
  return searchCountries(query, signal).then((countries) => countries.map(mapCountryResponse));
}

/**
 * Where the searches of an earlier visit are kept. A frame that is allowed no
 * storage at all gets an object that turns down every call, which the history
 * already reads as "nothing is kept between visits" rather than as a search that
 * cannot work.
 */
function browserStorage(): HistoryStorage {
  try {
    return window.localStorage;
  } catch {
    return {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
  }
}

/**
 * Browser entry point. It owns no logic of its own: it connects the five parts —
 * the transport that looks a country up, the memory that keeps recent answers and
 * shares identical requests, the list of searches made before, the flow that
 * decides when a search happens and which answer is still current, and the view
 * that draws the result.
 *
 * Keystroke handling, debounce, cancellation and the difference between "no
 * matches" and "something failed" all live in the flow, so nothing in this file
 * works with timers or abort signals. The view reports only what the user meant:
 * the box changed, the box was cleared, the failed search should run again, one of
 * the remembered searches should be searched again.
 */
function startApp(): void {
  const view = createSearchView(document.body, {
    // The flow trims the text, tears down the request in flight at once and
    // schedules the debounced lookup; here a keystroke is just reported.
    onQueryChange: (query) => flow.onInput(query),
    onClearQuery: () => flow.reset(),
    // Retrying sends the last query again without waiting out the debounce.
    onRetry: () => flow.retry(),
    // Picking a remembered search is an ordinary search: the box is filled and the
    // usual debounce and cancellation rules apply, so nothing here steps around
    // them — the answer only tends to be nearer than the network.
    onHistoryPick: (query) => {
      view.setQuery(query);
      flow.onInput(query);
    },
    onClearHistory: () => {
      keepRecentQueries.clear();
      showRecentQueries();
    },
  });

  // Repeating a query is answered from memory instead of the network, and a query
  // that is already on its way is shared rather than sent twice. Cancellation still
  // works from here: the flow aborts the signal it no longer cares about, and the
  // memory only lets a real request carry on while somebody is waiting for it.
  const rememberAnswers = createCachedSearch({ search });

  // What has been searched is kept in the browser, so the interface can offer it
  // back even after a reload. The store is handed in rather than reached for: that
  // is what lets the history be tested without a browser, and it keeps one place to
  // deal with a storage that is not available at all.
  const keepRecentQueries = createSearchHistory({ storage: browserStorage() });

  /** Keeps the row of remembered searches in step with what has been searched. */
  const showRecentQueries = (): void => {
    view.showHistory(keepRecentQueries.list());
  };

  const flow = createSearchFlow({
    search: rememberAnswers.search,
    handlers: {
      onLoading: (query) => view.showLoading(query),
      onSuccess: (countries, query) => {
        view.showResults(countries, query);
        // A search that reached an answer is worth offering back later, whether the
        // answer came from the network or from memory.
        keepRecentQueries.record(query);
        showRecentQueries();
      },
      // A 404 reaches the interface as an empty list, never as a failure.
      onEmpty: (query) => {
        view.showNoMatches(query);
        // "No country matches that spelling" is still an answer the user looked for.
        keepRecentQueries.record(query);
        showRecentQueries();
      },
      // A search that failed is not remembered: offering it back would only offer
      // the same failure again.
      onFailure: (failure, query) => view.showFailure(failure, query),
      onCleared: () => view.showIdle(),
    },
  });

  view.showIdle();
  // Searches from an earlier visit are offered back before anything is typed; the
  // row stays on screen when the box is emptied, which is when it is most useful.
  showRecentQueries();
}

startApp();
