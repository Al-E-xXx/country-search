/**
 * Tuning constants of the search experience, kept in one place so the behaviour
 * can be adjusted without touching the logic, and so tests and the interface
 * agree on the same numbers.
 */

/** Quiet period after the last keystroke before a request is sent. */
export const DEBOUNCE_DELAY_MS = 300;

/** How long a single request may take before it is given up on. */
export const REQUEST_TIMEOUT_MS = 8_000;
