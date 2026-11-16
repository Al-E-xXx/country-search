import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { HttpError } from './http-error.js';
import { searchCountries } from './search-countries.js';

type FetchStub = (input: RequestInfo | URL, init: RequestInit | undefined) => Promise<Response>;
type FetchMock = Mock<FetchStub>;

const spainFixture = [
  {
    name: 'Spain',
    capital: 'Madrid',
    region: 'Europe',
    population: 47_351_567,
    flags: { png: 'https://flagcdn.com/w320/es.png' },
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** fetch itself produces this kind of error when a signal fires; the stub must match. */
function abortError(): Error {
  return new DOMException('This operation was aborted', 'AbortError');
}

/**
 * Stands in for the network. It settles only through the signal handed to fetch,
 * so an implementation that fails to pass the caller signal down cannot pass the
 * cancellation scenarios built on top of it.
 */
function cancellableFetch(response: Response): FetchMock {
  return vi.fn<FetchStub>((_input, init) => {
    const signal = init?.signal;
    if (!signal) {
      return Promise.resolve(response);
    }
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          reject(abortError());
        },
        { once: true },
      );
    });
  });
}

function firstCall(fetchMock: FetchMock): [RequestInfo | URL, RequestInit | undefined] {
  const call = fetchMock.mock.calls[0];
  if (!call) {
    throw new Error('fetch was never called');
  }
  return [call[0], call[1]];
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected the promise to reject, but it resolved');
    },
    (reason: unknown) => reason,
  );
}

describe('searchCountries', () => {
  let fetchMock: FetchMock;

  function stubFetch(mock: FetchMock): void {
    fetchMock = mock;
    vi.stubGlobal('fetch', mock);
  }

  beforeEach(() => {
    stubFetch(vi.fn<FetchStub>(() => Promise.resolve(jsonResponse(spainFixture))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('request', () => {
    it('requests the country-name endpoint for the given query', async () => {
      await searchCountries('spain', new AbortController().signal);

      const [url] = firstCall(fetchMock);
      expect(String(url)).toBe('https://countries.dev/name/spain');
    });

    it('uses the GET method', async () => {
      await searchCountries('spain', new AbortController().signal);

      const [, init] = firstCall(fetchMock);
      expect(init?.method ?? 'GET').toBe('GET');
    });

    it('percent-encodes a query that is not URL safe', async () => {
      await searchCountries('south africa', new AbortController().signal);

      const [url] = firstCall(fetchMock);
      expect(String(url)).toBe('https://countries.dev/name/south%20africa');
    });

    it('hands the caller signal over to fetch', async () => {
      const controller = new AbortController();

      await searchCountries('spain', controller.signal);

      const [, init] = firstCall(fetchMock);
      expect(init?.signal).toBe(controller.signal);
    });

    it('makes exactly one request per call', async () => {
      await searchCountries('spain', new AbortController().signal);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('successful responses', () => {
    it('resolves with the parsed list of matches', async () => {
      const countries = await searchCountries('spain', new AbortController().signal);

      expect(countries).toEqual(spainFixture);
    });

    it('resolves with an empty list when the api returns an empty array', async () => {
      stubFetch(vi.fn<FetchStub>(() => Promise.resolve(jsonResponse([]))));

      const countries = await searchCountries('zzz', new AbortController().signal);

      expect(countries).toEqual([]);
    });
  });

  describe('no matches (404)', () => {
    it('treats a 404 response as an empty result instead of a failure', async () => {
      stubFetch(vi.fn<FetchStub>(() => Promise.resolve(jsonResponse([], 404))));

      const countries = await searchCountries('notacountry', new AbortController().signal);

      expect(countries).toEqual([]);
    });

    it('does not report a 404 as an HttpError', async () => {
      stubFetch(vi.fn<FetchStub>(() => Promise.resolve(jsonResponse([], 404))));

      await expect(searchCountries('notacountry', new AbortController().signal)).resolves.toEqual(
        [],
      );
    });
  });

  describe('http failures', () => {
    it('rejects with an HttpError carrying the status of a failed response', async () => {
      stubFetch(vi.fn<FetchStub>(() => Promise.resolve(jsonResponse({ message: 'boom' }, 500))));

      const error = await captureRejection(searchCountries('spain', new AbortController().signal));

      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(500);
    });

    it('reports rate limiting as an HttpError with status 429', async () => {
      stubFetch(
        vi.fn<FetchStub>(() => Promise.resolve(jsonResponse({ message: 'slow down' }, 429))),
      );

      const error = await captureRejection(searchCountries('spain', new AbortController().signal));

      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(429);
    });

    it('names the failure so it can be told apart from other errors', async () => {
      stubFetch(vi.fn<FetchStub>(() => Promise.resolve(jsonResponse({}, 500))));

      const error = await captureRejection(searchCountries('spain', new AbortController().signal));

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('HttpError');
      expect((error as Error).message).toContain('500');
    });
  });

  describe('cancellation', () => {
    it('rejects with an AbortError when the caller aborts while the request is in flight', async () => {
      const controller = new AbortController();
      stubFetch(cancellableFetch(jsonResponse(spainFixture)));

      const pending = searchCountries('spain', controller.signal);
      controller.abort();

      const error = await captureRejection(pending);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('AbortError');
    });

    it('does not turn a cancellation into an HttpError', async () => {
      const controller = new AbortController();
      stubFetch(cancellableFetch(jsonResponse(spainFixture)));

      const pending = searchCountries('spain', controller.signal);
      controller.abort();

      const error = await captureRejection(pending);

      expect(error).not.toBeInstanceOf(HttpError);
    });

    it('rejects right away when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      stubFetch(cancellableFetch(jsonResponse(spainFixture)));

      const error = await captureRejection(searchCountries('spain', controller.signal));

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('AbortError');
    });
  });
});
