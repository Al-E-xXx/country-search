import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { mapCountryResponse } from '../api/map-country-response.js';
import type { CountryView } from '../api/map-country-response.js';
import { searchCountries } from '../api/search-countries.js';
import type { ApiCountry } from '../api/types.js';
import { DEBOUNCE_DELAY_MS } from '../config.js';
import { classifySearchError } from './error-classification.js';
import { createSearchFlow } from './search-flow.js';
import type { SearchFailure, SearchFlow, SearchFlowHandlers, SearchFn } from './search-flow.js';

/**
 * Race scenarios between requests, told through the transport: the flow, the real
 * `searchCountries` and the real mapper are all wired together, only the network
 * is faked. That is what makes the test worth something — a flow that cancels
 * politely but keeps its signal to itself still passes a flow-level test, and
 * fails this one.
 */

type FetchStub = (input: RequestInfo | URL, init: RequestInit | undefined) => Promise<Response>;
type FetchMock = Mock<FetchStub>;

const ENDPOINT_BASE_URL = 'https://countries.dev/name/';

/**
 * Answers of https://countries.dev, captured live; the fields the view never
 * reads are left out to keep this file readable.
 */
const southAfrica: ApiCountry = {
  name: 'South Africa',
  alpha3Code: 'ZAF',
  capital: 'Pretoria',
  region: 'Africa',
  subregion: 'Southern Africa',
  demonym: 'South African',
  nativeName: 'South Africa',
  population: 59_308_690,
  area: 1_221_037,
  flag: '🇿🇦',
  flags: { png: 'https://flagcdn.com/w320/za.png', svg: 'https://flagcdn.com/za.svg' },
  languages: [
    { name: 'Afrikaans', iso639_1: 'af' },
    { name: 'English', iso639_1: 'en' },
    { name: 'Zulu', iso639_1: 'zu' },
  ],
  currencies: [{ code: 'ZAR', name: 'South African rand', symbol: 'R' }],
  borders: ['BWA', 'LSO', 'MOZ', 'NAM', 'SWZ', 'ZWE'],
};

const frenchSouthernTerritories: ApiCountry = {
  name: 'French Southern Territories',
  alpha3Code: 'ATF',
  capital: 'Port-aux-Français',
  region: 'Africa',
  subregion: 'Southern Africa',
  population: 140,
  flag: '🇹🇫',
  flags: { png: 'https://flagcdn.com/w320/tf.png', svg: 'https://flagcdn.com/tf.svg' },
  languages: [{ name: 'French', iso639_1: 'fr' }],
  currencies: [{ code: 'EUR', name: 'Euro', symbol: '€' }],
};

const southGeorgia: ApiCountry = {
  name: 'South Georgia and the South Sandwich Islands',
  alpha3Code: 'SGS',
  capital: 'King Edward Point',
  region: 'Americas',
  subregion: 'South America',
  population: 30,
  flag: '🇬🇸',
  flags: { png: 'https://flagcdn.com/w320/gs.png', svg: 'https://flagcdn.com/gs.svg' },
  languages: [{ name: 'English', iso639_1: 'en' }],
  currencies: [{ code: 'FKP', name: 'Falkland Islands Pound', symbol: '£' }],
};

const southSudan: ApiCountry = {
  name: 'South Sudan',
  alpha3Code: 'SSD',
  capital: 'Juba',
  region: 'Africa',
  subregion: 'Middle Africa',
  population: 11_193_729,
  flag: '🇸🇸',
  flags: { png: 'https://flagcdn.com/w320/ss.png', svg: 'https://flagcdn.com/ss.svg' },
  languages: [{ name: 'English', iso639_1: 'en' }],
  currencies: [{ code: 'SSP', name: 'South Sudanese pound', symbol: '£' }],
};

/** What `south` returns: three countries, none of them South Africa. */
const southMatches: ApiCountry[] = [frenchSouthernTerritories, southGeorgia, southSudan];

interface RaceRequest {
  query: string;
  signal: AbortSignal;
  /** Answers the way a server does: a response with a JSON body, `200` by default. */
  respond(rows: ApiCountry[], status?: number): void;
  /** `answered` or `rejected` once the request is over, `undefined` while open. */
  outcome: 'answered' | 'rejected' | undefined;
  /** What the transport rejected with, which is how a cancellation is proven. */
  rejection: unknown;
}

interface RaceNetwork {
  requests: RaceRequest[];
  search: SearchFn;
  fetchMock: FetchMock;
}

/**
 * Stands in for the network, through `fetch` rather than through the flow.
 *
 * `obeysCancellation: true` behaves like a browser: the moment the signal handed
 * to `fetch` fires, the promise rejects with `signal.reason`. A flow that never
 * calls `abort()` therefore hangs these tests instead of passing them.
 *
 * `obeysCancellation: false` stands for the answer that is already on its way —
 * the bytes were in the pipeline when the browser tore the request down, so the
 * promise still settles afterwards, with a result or with a failure. Real
 * browsers do this in miniature; it is the case a cancellation alone cannot
 * protect against, and the reason the flow has to check the signal before it
 * shows anything.
 */
function createRaceNetwork(obeysCancellation: boolean): RaceNetwork {
  const requests: RaceRequest[] = [];

  const fetchMock = vi.fn<FetchStub>((input, init) => {
    const url = String(input);
    const query = decodeURIComponent(url.slice(ENDPOINT_BASE_URL.length));
    const signal = init?.signal;
    if (signal === null || signal === undefined) {
      throw new Error('The search has to hand its signal to fetch, and it did not');
    }

    return new Promise<Response>((resolve, reject) => {
      const request: RaceRequest = {
        query,
        signal,
        respond: () => undefined,
        outcome: undefined,
        rejection: undefined,
      };

      const rejectWith = (reason: unknown): void => {
        if (request.outcome !== undefined) {
          return;
        }
        request.outcome = 'rejected';
        request.rejection = reason;
        reject(reason);
      };

      request.respond = (rows: ApiCountry[], status = 200): void => {
        if (request.outcome !== undefined) {
          return;
        }
        request.outcome = 'answered';
        resolve(
          new Response(JSON.stringify(rows), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        );
      };

      if (obeysCancellation) {
        if (signal.aborted) {
          rejectWith(signal.reason);
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            rejectWith(signal.reason);
          },
          { once: true },
        );
      }

      requests.push(request);
    });
  });

  vi.stubGlobal('fetch', fetchMock);

  const search: SearchFn = (query, signal) =>
    searchCountries(query, signal).then((rows) => rows.map(mapCountryResponse));

  return { requests, search, fetchMock };
}

type FlowEvent =
  | { type: 'loading'; query: string }
  | { type: 'success'; query: string; countries: CountryView[] }
  | { type: 'empty'; query: string }
  | { type: 'failure'; query: string; failure: SearchFailure }
  | { type: 'cleared' };

type SuccessEvent = Extract<FlowEvent, { type: 'success' }>;

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

function namesOf(countries: CountryView[]): string[] {
  return countries.map((country) => country.name);
}

function ofKind<K extends FlowEvent['type']>(
  events: FlowEvent[],
  kind: K,
): Array<Extract<FlowEvent, { type: K }>> {
  return events.filter((event): event is Extract<FlowEvent, { type: K }> => event.type === kind);
}

function single<T>(items: T[], what: string): T {
  const [first, ...rest] = items;
  if (first === undefined || rest.length > 0) {
    throw new Error(`Expected exactly one ${what}, got ${items.length}`);
  }
  return first;
}

function lastRequest(requests: RaceRequest[]): RaceRequest {
  return single(requests.slice(-1), 'request');
}

function onlySuccess(events: FlowEvent[]): SuccessEvent {
  return single(ofKind(events, 'success'), 'success');
}

/** Lets the promise chains the flow started run to completion. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function abortNameOf(request: RaceRequest): string {
  const reason = request.rejection;
  return reason instanceof Error || reason instanceof DOMException ? reason.name : '';
}

describe('request race condition', () => {
  let network: RaceNetwork;
  let recorder: { handlers: SearchFlowHandlers; events: FlowEvent[] };
  let flow: SearchFlow;

  function wireUp(obeysCancellation: boolean): void {
    vi.useFakeTimers();
    network = createRaceNetwork(obeysCancellation);
    recorder = createHandlerRecorder();
    flow = createSearchFlow({ search: network.search, handlers: recorder.handlers });
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Types text, waits out the debounce window and returns the request it started. */
  async function typeAndWait(query: string): Promise<RaceRequest> {
    flow.onInput(query);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY_MS);
    return lastRequest(network.requests);
  }

  /**
   * Types newer text and leaves the older request in flight: the newest part of a
   * race, which is what the whole point of cancellation is about.
   */
  async function supersedeWith(query: string): Promise<RaceRequest> {
    flow.onInput(query);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY_MS);
    return lastRequest(network.requests);
  }

  describe('a transport that obeys cancellation', () => {
    beforeEach(() => {
      wireUp(true);
    });

    it('keeps the newest answer when the older one arrives later', async () => {
      const stale = await typeAndWait('south');

      const current = await supersedeWith('south afr');
      current.respond([southAfrica]);
      await settle();

      stale.respond(southMatches);
      await settle();

      expect(eventTypes(recorder.events)).toEqual(['loading', 'loading', 'success']);
      const success = onlySuccess(recorder.events);
      expect(success.query).toBe('south afr');
      expect(namesOf(success.countries)).toEqual(['South Africa']);
    });

    it('tears the older request down in the transport, not only in its own bookkeeping', async () => {
      const stale = await typeAndWait('south');

      flow.onInput('south afr');

      expect(stale.signal.aborted).toBe(true);
      expect(stale.outcome).toBe('rejected');
      expect(abortNameOf(stale)).toBe('AbortError');
    });

    it('reports nothing about the request it cancelled', async () => {
      const stale = await typeAndWait('south');
      const current = await supersedeWith('south afr');

      current.respond([southAfrica]);
      await settle();
      stale.respond(southMatches);
      await settle();

      expect(ofKind(recorder.events, 'failure')).toEqual([]);
      expect(ofKind(recorder.events, 'empty')).toEqual([]);
      expect(eventTypes(recorder.events)).toEqual(['loading', 'loading', 'success']);
    });

    it('cancels the older request before the newer one starts', async () => {
      const older = await typeAndWait('south');

      flow.onInput('south afr');
      expect(network.requests).toHaveLength(1);
      expect(older.signal.aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY_MS);
      expect(network.requests.map((request) => request.query)).toEqual(['south', 'south afr']);
      expect(lastRequest(network.requests).signal.aborted).toBe(false);
    });

    it('keeps only the answer of the last query when three searches overlap', async () => {
      const oldest = await typeAndWait('south');
      const older = await supersedeWith('south af');
      const current = await supersedeWith('south afr');

      expect(oldest.signal.aborted).toBe(true);
      expect(older.signal.aborted).toBe(true);
      expect(current.signal.aborted).toBe(false);

      current.respond([southAfrica]);
      await settle();
      older.respond([southAfrica, southSudan]);
      oldest.respond(southMatches);
      await settle();

      expect(network.fetchMock).toHaveBeenCalledTimes(3);
      expect(eventTypes(recorder.events)).toEqual(['loading', 'loading', 'loading', 'success']);
      expect(namesOf(onlySuccess(recorder.events).countries)).toEqual(['South Africa']);
    });

    it('shows an empty answer of the current query after a cancelled one', async () => {
      const stale = await typeAndWait('south');

      const current = await supersedeWith('zzz');
      stale.respond(southMatches);
      await settle();
      current.respond([]);
      await settle();

      expect(eventTypes(recorder.events)).toEqual(['loading', 'loading', 'empty']);
      expect(single(ofKind(recorder.events, 'empty'), 'empty query').query).toBe('zzz');
    });
  });

  describe('an answer that cancellation cannot reach', () => {
    beforeEach(() => {
      wireUp(false);
    });

    it('drops the late answer of a superseded search', async () => {
      const stale = await typeAndWait('south');
      const current = await supersedeWith('south afr');

      expect(stale.signal.aborted).toBe(true);

      current.respond([southAfrica]);
      await settle();
      stale.respond(southMatches);
      await settle();

      expect(eventTypes(recorder.events)).toEqual(['loading', 'loading', 'success']);
      expect(namesOf(onlySuccess(recorder.events).countries)).toEqual(['South Africa']);
    });

    it('ignores a superseded answer that lands before the current one', async () => {
      const stale = await typeAndWait('south');
      const current = await supersedeWith('south afr');

      stale.respond(southMatches);
      await settle();
      expect(eventTypes(recorder.events)).toEqual(['loading', 'loading']);

      current.respond([southAfrica]);
      await settle();

      expect(eventTypes(recorder.events)).toEqual(['loading', 'loading', 'success']);
      expect(namesOf(onlySuccess(recorder.events).countries)).toEqual(['South Africa']);
    });

    it('turns a cancelled empty answer into nothing at all', async () => {
      const stale = await typeAndWait('south');
      const current = await supersedeWith('south afr');

      stale.respond([]);
      await settle();
      expect(ofKind(recorder.events, 'empty')).toEqual([]);

      current.respond([southAfrica]);
      await settle();
      expect(eventTypes(recorder.events)).toEqual(['loading', 'loading', 'success']);
    });

    it('hides a failure of the superseded request that answers last', async () => {
      const stale = await typeAndWait('south');
      const current = await supersedeWith('south afr');

      current.respond([southAfrica]);
      await settle();
      stale.respond(southMatches, 500);
      await settle();

      expect(ofKind(recorder.events, 'failure')).toEqual([]);
      expect(eventTypes(recorder.events)).toEqual(['loading', 'loading', 'success']);
      expect(namesOf(onlySuccess(recorder.events).countries)).toEqual(['South Africa']);
    });

    it('hides a failure of the superseded request that answers first', async () => {
      const stale = await typeAndWait('south');
      const current = await supersedeWith('south afr');

      stale.respond(southMatches, 500);
      await settle();
      expect(ofKind(recorder.events, 'failure')).toEqual([]);

      current.respond([southAfrica]);
      await settle();

      expect(eventTypes(recorder.events)).toEqual(['loading', 'loading', 'success']);
      expect(namesOf(onlySuccess(recorder.events).countries)).toEqual(['South Africa']);
    });
  });

  describe('a cancellation is not a failure', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      recorder = createHandlerRecorder();
    });

    it('reports nothing when the transport cancels on its own', async () => {
      const search: SearchFn = () =>
        Promise.reject(new DOMException('This operation was aborted', 'AbortError'));
      flow = createSearchFlow({ search, handlers: recorder.handlers });

      flow.onInput('spain');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY_MS);
      await settle();

      expect(eventTypes(recorder.events)).toEqual(['loading']);
    });

    it('classifies a deliberate cancellation as nothing worth reporting', () => {
      expect(
        classifySearchError(new DOMException('This operation was aborted', 'AbortError')),
      ).toBeNull();

      const asAnError = new Error('This operation was aborted');
      asAnError.name = 'AbortError';
      expect(classifySearchError(asAnError)).toBeNull();
    });

    it('still reports a timeout as a failure worth retrying', () => {
      const failure = classifySearchError(new DOMException('Timed out', 'TimeoutError'));
      if (failure === null) {
        throw new Error('Expected a timeout to be reported as a failure');
      }

      expect(failure.kind).toBe('timeout');
      expect(failure.retryable).toBe(true);
    });
  });
});
