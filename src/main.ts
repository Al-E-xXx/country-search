import { mapCountryResponse } from './api/map-country-response.js';
import type { CountryView } from './api/map-country-response.js';
import { searchCountries } from './api/search-countries.js';
import { createSearchFlow } from './search/search-flow.js';
import { createSearchView } from './ui/render.js';

/** One lookup, from the endpoint to the view-model the interface draws. */
function search(query: string, signal: AbortSignal): Promise<CountryView[]> {
  return searchCountries(query, signal).then((countries) => countries.map(mapCountryResponse));
}

/**
 * Browser entry point. It owns no logic of its own: it connects the three parts —
 * the transport that looks a country up, the flow that decides when a search
 * happens and which answer is still current, and the view that draws the result.
 *
 * Keystroke handling, debounce, cancellation and the difference between "no
 * matches" and "something failed" all live in the flow, so nothing in this file
 * works with timers or abort signals. The view reports only what the user meant:
 * the box changed, the box was cleared, the failed search should run again.
 */
function startApp(): void {
  const view = createSearchView(document.body, {
    // The flow trims the text, tears down the request in flight at once and
    // schedules the debounced lookup; here a keystroke is just reported.
    onQueryChange: (query) => flow.onInput(query),
    onClearQuery: () => flow.reset(),
    // Retrying sends the last query again without waiting out the debounce.
    onRetry: () => flow.retry(),
  });

  const flow = createSearchFlow({
    search,
    handlers: {
      onLoading: (query) => view.showLoading(query),
      onSuccess: (countries, query) => view.showResults(countries, query),
      // A 404 reaches the interface as an empty list, never as a failure.
      onEmpty: (query) => view.showNoMatches(query),
      onFailure: (failure, query) => view.showFailure(failure, query),
      onCleared: () => view.showIdle(),
    },
  });

  view.showIdle();
}

startApp();
