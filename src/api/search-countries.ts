import { HttpError } from './http-error.js';
import type { ApiCountry } from './types.js';

const SEARCH_ENDPOINT_BASE_URL = 'https://countries.dev/name/';
const NOT_FOUND_STATUS = 404;

/**
 * Looks up countries whose name matches `query`.
 *
 * The caller `signal` is passed straight to `fetch`, which is what makes
 * cancellation real: aborting it tears the request down instead of letting the
 * stale answer land later. A 404 is a normal "no matches" outcome, so it becomes
 * an empty list; every other unsuccessful status throws an {@link HttpError} so
 * the caller can tell a failure apart from an empty result.
 *
 * @param query raw search text
 * @param signal abort signal owned by the caller
 * @returns matching countries, empty when there are none
 * @throws HttpError on any non-404 unsuccessful response
 * @throws AbortError when `signal` fires before the answer arrives
 */
export async function searchCountries(query: string, signal: AbortSignal): Promise<ApiCountry[]> {
  const url = `${SEARCH_ENDPOINT_BASE_URL}${encodeURIComponent(query)}`;
  const response = await fetch(url, { method: 'GET', signal });

  if (response.status === NOT_FOUND_STATUS) {
    return [];
  }

  if (!response.ok) {
    throw new HttpError(
      response.status,
      `Search for "${query}" failed with status ${response.status}`,
    );
  }

  return (await response.json()) as ApiCountry[];
}
