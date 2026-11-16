import { HttpError } from '../api/http-error.js';

/**
 * What went wrong, in terms the interface can act on. The interface never looks
 * at the error object itself: it switches on `kind`, shows a message and decides
 * whether a retry makes sense.
 */
export type SearchFailureKind = 'http' | 'network' | 'timeout' | 'unknown';

export interface SearchFailure {
  kind: SearchFailureKind;
  /** HTTP status for a failed response, `null` for everything else. */
  status: number | null;
  retryable: boolean;
  /** The original error, kept for diagnostics. */
  cause: unknown;
}

/** Codes that usually fix themselves: request timeout and rate limiting. */
const RETRYABLE_STATUS_CODES = new Set([408, 429]);
const SERVER_ERROR_FROM = 500;
const ABORT_ERROR_NAME = 'AbortError';
const TIMEOUT_ERROR_NAME = 'TimeoutError';
const NETWORK_ERROR_NAMES = new Set(['TypeError', 'NetworkError']);

/** `name` of whatever was thrown; DOMException is not an Error, but has one too. */
function nameOf(error: unknown): string {
  return error instanceof Error || error instanceof DOMException ? error.name : '';
}

function isRetryableStatus(status: number): boolean {
  return status >= SERVER_ERROR_FROM || RETRYABLE_STATUS_CODES.has(status);
}

/**
 * Turns a rejection of a search request into a {@link SearchFailure}.
 *
 * A cancellation is not a failure at all: when the caller aborted on purpose the
 * function returns `null`, which is what keeps a superseded search from popping
 * an error message in the interface.
 *
 * @param error rejection reason of the request
 * @returns the failure to report, `null` for a deliberate cancellation
 */
export function classifySearchError(error: unknown): SearchFailure | null {
  const name = nameOf(error);

  if (name === ABORT_ERROR_NAME) {
    return null;
  }

  if (name === TIMEOUT_ERROR_NAME) {
    return { kind: 'timeout', status: null, retryable: true, cause: error };
  }

  if (error instanceof HttpError) {
    return {
      kind: 'http',
      status: error.status,
      retryable: isRetryableStatus(error.status),
      cause: error,
    };
  }

  if (error instanceof TypeError || NETWORK_ERROR_NAMES.has(name)) {
    return { kind: 'network', status: null, retryable: true, cause: error };
  }

  return { kind: 'unknown', status: null, retryable: true, cause: error };
}
