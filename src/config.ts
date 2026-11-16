/**
 * Tuning constants of the search experience, kept in one place so the behaviour
 * can be adjusted without touching the logic, and so tests and the interface
 * agree on the same numbers.
 */

/** Quiet period after the last keystroke before a request is sent. */
export const DEBOUNCE_DELAY_MS = 300;

/** How long a single request may take before it is given up on. */
export const REQUEST_TIMEOUT_MS = 8_000;

/** How long an answer may be reused before the API is asked again. */
export const SEARCH_CACHE_TTL_MS = 30_000;

/** How many answers the cache keeps before the oldest one is pushed out. */
export const SEARCH_CACHE_MAX_ENTRIES = 50;

/** The name under which the browser keeps the list of queries searched so far. */
export const HISTORY_STORAGE_KEY = 'country-search.history';

/** How many recent queries the interface offers to search again. */
export const SEARCH_HISTORY_MAX_ENTRIES = 8;
