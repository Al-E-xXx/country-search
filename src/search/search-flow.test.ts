import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpError } from '../api/http-error.js';
import type { CountryView } from '../api/map-country-response.js';
import { DEBOUNCE_DELAY_MS, REQUEST_TIMEOUT_MS } from '../config.js';
import { createSearchFlow } from './search-flow.js';
import type { SearchFailure, SearchFlow, SearchFlowHandlers } from './search-flow.js';

type SearchFn = (query: string, signal: AbortSignal) => Promise<CountryView[]>;

interface InFlightRequest {
  query: string;
  signal: AbortSignal;
  succeed(countries: CountryView[]): void;
  fail(error: unknown): void;
}

type FlowEvent =
  | { type: 'loading'; query: string }
  | { type: 'success'; query: string; countries: CountryView[] }
  | { type: 'empty'; query: string }
  | { type: 'failure'; query: string; failure: SearchFailure }
  | { type: 'cleared' };

type FailureEvent = Extract<FlowEvent, { type: 'failure' }>;

function makeCountry(name: string, alpha3: string): CountryView {
  return {
    alpha3,
    name,
    flagUrl: null,
    flagEmoji: null,
    capital: null,
    region: null,
    subregion: null,
    nativeName: null,
    demonym: null,
    population: null,
    area: null,
    languages: [],
    currencies: [],
    borders: [],
  };
}

const spainView = makeCountry('Spain', 'ESP');
const portugalView = makeCountry('Portugal', 'PRT');

/**
 * Stands in for the network layer. Like the real fetch, it settles through the
 * signal it is given: once that signal fires, the promise rejects with
 * `signal.reason`. An implementation that keeps the signal to itself therefore
 * can never pass the cancellation scenarios built on top of this stub.
 */
function createNetworkStub(): { search: SearchFn; inFlight: InFlightRequest[] } {
  const inFlight: InFlightRequest[] = [];
  const search: SearchFn = (query, signal) =>
    new Promise<CountryView[]>((resolve, reject) => {
      inFlight.push({ query, signal, succeed: resolve, fail: reject });
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          reject(signal.reason);
        },
        { once: true },
      );
    });
  return { search, inFlight };
}

/** Collects everything the flow reports, so tests can assert on the order too. */
function createHandlerRecorder(): { handlers: SearchFlowHandlers; events: FlowEvent[] } {
  const events: FlowEvent[] = [];
  const handlers: SearchFlowHandlers = {
    onLoading: (query) => {
      events.push({ type: 'loading', query });
    },
    onSuccess: (countries, query) => {
      events.push({ type: 'success', query, countries });
    },
    onEmpty: (query) => {
      events.push({ type: 'empty', query });
    },
    onFailure: (failure, query) => {
      events.push({ type: 'failure', query, failure });
    },
    onCleared: () => {
      events.push({ type: 'cleared' });
    },
  };
  return { handlers, events };
}

function eventTypes(events: FlowEvent[]): string[] {
  return events.map((event) => event.type);
}

function failuresOf(events: FlowEvent[]): FailureEvent[] {
  return events.filter((event): event is FailureEvent => event.type === 'failure');
}

function single<T>(items: T[], what: string): T {
  const [first, ...rest] = items;
  if (first === undefined || rest.length > 0) {
    throw new Error(`Expected exactly one ${what}, got ${items.length}`);
  }
  return first;
}

function onlyRequest(inFlight: InFlightRequest[]): InFlightRequest {
  return single(inFlight, 'request');
}

function onlyFailure(events: FlowEvent[]): FailureEvent {
  return single(failuresOf(events), 'failure');
}

/** Lets the promise chains that the flow started run to completion. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('search flow', () => {
  let network: { search: SearchFn; inFlight: InFlightRequest[] };
  let recorder: { handlers: SearchFlowHandlers; events: FlowEvent[] };
  let flow: SearchFlow;

  beforeEach(() => {
    vi.useFakeTimers();
    network = createNetworkStub();
    recorder = createHandlerRecorder();
    flow = createSearchFlow({ search: network.search, handlers: recorder.handlers });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Types text, waits out the debounce window and returns the started request. */
  async function typeAndWait(query: string): Promise<InFlightRequest> {
    flow.onInput(query);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY_MS);
    return onlyRequest(network.inFlight);
  }

  describe('debounce window', () => {
    it('does not search while the user is still typing', async () => {
      flow.onInput('spain');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY_MS - 1);

      expect(network.inFlight).toHaveLength(0);
    });

    it('starts one request for the text typed during the delay', async () => {
      flow.onInput('s');
      flow.onInput('sp');
      flow.onInput('spa');
      flow.onInput('spain');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY_MS);

      expect(network.inFlight.map((request) => request.query)).toEqual(['spain']);
    });

    it('searches again when the user pauses between two queries', async () => {
      const first = await typeAndWait('spain');
      first.succeed([spainView]);
      await settle();

      await typeAndWait('portugal');

      expect(network.inFlight.map((request) => request.query)).toEqual(['spain', 'portugal']);
    });

    it('searches for the text stripped of the surrounding spaces', async () => {
      flow.onInput('  spain  ');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY_MS);

      expect(onlyRequest(network.inFlight).query).toBe('spain');
    });
  });

  describe('superseded requests', () => {
    it('aborts the request in flight as soon as new text arrives', async () => {
      const stale = await typeAndWait('sp');

      flow.onInput('spain');

      expect(stale.signal.aborted).toBe(true);
    });

    it('cancels the older request before starting a newer one', async () => {
      const stale = await typeAndWait('sp');

      flow.onInput('spain');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY_MS);
      const current = onlyRequest(network.inFlight.slice(-1));

      expect(network.inFlight.map((request) => request.query)).toEqual(['sp', 'spain']);
      expect(stale.signal.aborted).toBe(true);
      expect(current.signal.aborted).toBe(false);
    });

    it('never reports a cancelled request to the interface', async () => {
      await typeAndWait('sp');

      flow.onInput('spain');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY_MS);
      const current = onlyRequest(network.inFlight.slice(-1));
      current.succeed([spainView]);
      await settle();

      expect(eventTypes(recorder.events)).toEqual(['loading', 'loading', 'success']);
      expect(failuresOf(recorder.events)).toEqual([]);
    });

    it('cancels a scheduled search when the input is cleared', async () => {
      flow.onInput('spain');

      flow.onInput('');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY_MS);

      expect(network.inFlight).toHaveLength(0);
      expect(eventTypes(recorder.events)).toEqual(['cleared']);
    });

    it('treats spaces as an empty query', async () => {
      await typeAndWait('spain');

      flow.onInput('   ');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY_MS);

      expect(network.inFlight).toHaveLength(1);
      expect(eventTypes(recorder.events)).toContain('cleared');
    });
  });

  describe('results', () => {
    it('announces that a search is running before the answer arrives', async () => {
      await typeAndWait('spain');

      expect(eventTypes(recorder.events)).toEqual(['loading']);
      expect(recorder.events[0]).toEqual({ type: 'loading', query: 'spain' });
    });

    it('hands the matches to the interface once they are back', async () => {
      const request = await typeAndWait('spain');

      request.succeed([spainView, portugalView]);
      await settle();

      expect(eventTypes(recorder.events)).toEqual(['loading', 'success']);
      expect(single(recorder.events.slice(1), 'result event')).toEqual({
        type: 'success',
        query: 'spain',
        countries: [spainView, portugalView],
      });
    });

    it('reports an empty answer as an empty result, not as a failure', async () => {
      const request = await typeAndWait('nowhere');

      request.succeed([]);
      await settle();

      expect(eventTypes(recorder.events)).toEqual(['loading', 'empty']);
      expect(recorder.events[1]).toEqual({ type: 'empty', query: 'nowhere' });
    });
  });

  describe('failures', () => {
    it('reports a server failure with its status and offers to retry', async () => {
      const request = await typeAndWait('spain');

      request.fail(new HttpError(500, 'Search for "spain" failed with status 500'));
      await settle();

      expect(eventTypes(recorder.events)).toEqual(['loading', 'failure']);
      const failure = onlyFailure(recorder.events).failure;
      expect(failure.kind).toBe('http');
      expect(failure.status).toBe(500);
      expect(failure.retryable).toBe(true);
    });

    it('keeps retrying possible when the api asks to slow down', async () => {
      const request = await typeAndWait('spain');

      request.fail(new HttpError(429, 'Search for "spain" failed with status 429'));
      await settle();

      const failure = onlyFailure(recorder.events).failure;
      expect(failure.kind).toBe('http');
      expect(failure.status).toBe(429);
      expect(failure.retryable).toBe(true);
    });

    it('does not offer to retry a request the api rejected as unusable', async () => {
      const request = await typeAndWait('spain');

      request.fail(new HttpError(400, 'Search for "spain" failed with status 400'));
      await settle();

      const failure = onlyFailure(recorder.events).failure;
      expect(failure.kind).toBe('http');
      expect(failure.status).toBe(400);
      expect(failure.retryable).toBe(false);
    });

    it('reports a transport problem as a network failure', async () => {
      const request = await typeAndWait('spain');

      request.fail(new TypeError('fetch failed'));
      await settle();

      const failure = onlyFailure(recorder.events).failure;
      expect(failure.kind).toBe('network');
      expect(failure.status).toBeNull();
      expect(failure.retryable).toBe(true);
    });

    it('keeps an unrecognised failure reportable instead of swallowing it', async () => {
      const request = await typeAndWait('spain');
      const cause = new Error('something else went wrong');

      request.fail(cause);
      await settle();

      const failure = onlyFailure(recorder.events).failure;
      expect(failure.kind).toBe('unknown');
      expect(failure.retryable).toBe(true);
      expect(failure.cause).toBe(cause);
    });

    it('shows a failure of the current request only', async () => {
      const stale = await typeAndWait('sp');

      flow.onInput('spain');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY_MS);
      stale.fail(new HttpError(500, 'late answer'));
      await settle();

      expect(failuresOf(recorder.events)).toEqual([]);
    });
  });

  describe('timeout', () => {
    it('gives up on a request that answers too slowly', async () => {
      const request = await typeAndWait('spain');

      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

      expect(request.signal.aborted).toBe(true);
      const failure = onlyFailure(recorder.events).failure;
      expect(failure.kind).toBe('timeout');
      expect(failure.retryable).toBe(true);
      expect(eventTypes(recorder.events)).toEqual(['loading', 'failure']);
    });

    it('waits for the whole timeout window before giving up', async () => {
      const request = await typeAndWait('spain');

      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);

      expect(request.signal.aborted).toBe(false);
      expect(failuresOf(recorder.events)).toEqual([]);
    });

    it('labels the timeout with the query that timed out', async () => {
      await typeAndWait('spain');

      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

      expect(onlyFailure(recorder.events).query).toBe('spain');
    });

    it('searches on after a request timed out', async () => {
      await typeAndWait('spain');
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

      const next = await typeAndWait('portugal');
      next.succeed([portugalView]);
      await settle();

      expect(eventTypes(recorder.events)).toEqual(['loading', 'failure', 'loading', 'success']);
    });
  });

  describe('retry', () => {
    it('repeats the last query right away after a failure', async () => {
      const request = await typeAndWait('spain');
      request.fail(new HttpError(500, 'Search for "spain" failed with status 500'));
      await settle();

      flow.retry();
      await settle();

      expect(network.inFlight.map((entry) => entry.query)).toEqual(['spain', 'spain']);
      expect(onlyRequest(network.inFlight.slice(-1)).signal.aborted).toBe(false);
    });

    it('retries without waiting for the debounce delay', async () => {
      const request = await typeAndWait('spain');
      request.fail(new HttpError(500, 'Search for "spain" failed with status 500'));
      await settle();
      recorder.events.length = 0;

      flow.retry();

      expect(eventTypes(recorder.events)).toEqual(['loading']);
    });

    it('reports the outcome of the retried request normally', async () => {
      const first = await typeAndWait('spain');
      first.fail(new HttpError(500, 'Search for "spain" failed with status 500'));
      await settle();
      recorder.events.length = 0;

      flow.retry();
      await settle();
      onlyRequest(network.inFlight.slice(-1)).succeed([spainView]);
      await settle();

      expect(eventTypes(recorder.events)).toEqual(['loading', 'success']);
    });

    it('does nothing when there is nothing to retry', async () => {
      flow.retry();
      await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY_MS + REQUEST_TIMEOUT_MS);

      expect(network.inFlight).toHaveLength(0);
      expect(recorder.events).toEqual([]);
    });

    it('does not bring back a query the user cleared', async () => {
      const request = await typeAndWait('spain');
      request.fail(new HttpError(500, 'Search for "spain" failed with status 500'));
      await settle();

      flow.onInput('');
      flow.retry();
      await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY_MS);

      expect(network.inFlight).toHaveLength(1);
    });
  });

  describe('reset', () => {
    it('cancels the request in flight and reports the cleared state', async () => {
      const request = await typeAndWait('spain');

      flow.reset();
      await settle();

      expect(request.signal.aborted).toBe(true);
      expect(eventTypes(recorder.events)).toEqual(['loading', 'cleared']);
      expect(failuresOf(recorder.events)).toEqual([]);
    });

    it('drops a search that has not started yet', async () => {
      flow.onInput('spain');

      flow.reset();
      await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY_MS);

      expect(network.inFlight).toHaveLength(0);
      expect(eventTypes(recorder.events)).toEqual(['cleared']);
    });
  });
});
