/**
 * Error for any HTTP response that means "the request failed", as opposed to
 * "there is nothing to show" (404 is handled as an empty result and never
 * reaches this error).
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `Request failed with status ${status}`);
    this.name = 'HttpError';
    this.status = status;
  }
}
