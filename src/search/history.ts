import { HISTORY_STORAGE_KEY, SEARCH_HISTORY_MAX_ENTRIES } from '../config.js';

/**
 * Keeps a short list of the queries searched so far, so the interface can offer
 * them back as one-click searches:
 *
 * - the most recent query is always at the front,
 * - a query that comes back is moved to the front instead of being written twice,
 * - the list never grows past the agreed limit,
 * - what is kept in the browser survives a reload.
 *
 * Only the queries that reached an answer belong here, and that is decided by
 * whoever calls `record` — this module only stores what it is told.
 *
 * The browser storage is handed in rather than reached for. That keeps this module
 * free of the DOM and testable, and it keeps the one place where an unreliable
 * storage is a problem: a blocked frame, a full quota or rubbish left under the
 * key may break persistence, but must never break the search.
 */

/** The part of `window.localStorage` the history needs, and nothing more. */
export interface HistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SearchHistoryOptions {
  storage: HistoryStorage;
  /** Where inside that storage the list lives. */
  key?: string;
  /** How many queries are kept. */
  maxEntries?: number;
}

export interface SearchHistory {
  /** Adds one searched query to the front; blank queries are ignored. */
  record(query: string): void;
  /** The queries to offer again, most recent first. */
  list(): string[];
  /** Forgets every query, here and in the browser. */
  clear(): void;
}

const BLANK_QUERY = '';

/**
 * `France`, ` france ` and `FRANCE` ask for the same country, so they are one
 * query in the list. The spelling that stays is the one used most recently.
 */
const toHistoryKey = (query: string): string => query.trim().toLowerCase();

/**
 * Turns whatever sits in the storage into a usable list. Anything that is not a
 * list of readable texts — an older format, a half-written value, another program
 * sharing the origin — is treated as no history at all, and entries that are not
 * usable text are skipped one by one.
 */
const readStored = (raw: string | null, maxEntries: number): string[] => {
  if (raw === null) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }

  const queries: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string') {
      continue;
    }
    const query = entry.trim();
    if (query === BLANK_QUERY) {
      continue;
    }
    queries.push(query);
    // The front of the stored list is the freshest part, so that is what stays
    // when the stored list is longer than the limit allows.
    if (queries.length === maxEntries) {
      break;
    }
  }
  return queries;
};

export function createSearchHistory({
  storage,
  key = HISTORY_STORAGE_KEY,
  maxEntries = SEARCH_HISTORY_MAX_ENTRIES,
}: SearchHistoryOptions): SearchHistory {
  const load = (): string[] => {
    try {
      return readStored(storage.getItem(key), maxEntries);
    } catch {
      // A storage that refuses to be read (a blocked frame, for instance) simply
      // means there is no history to show.
      return [];
    }
  };

  /** Newest first, which is also the order written to the browser. */
  let entries = load();

  const save = (): void => {
    try {
      storage.setItem(key, JSON.stringify(entries));
    } catch {
      // A full quota or a private window costs the person their history later,
      // not the list of queries they can see and click right now.
    }
  };

  const record = (query: string): void => {
    const text = query.trim();
    if (text === BLANK_QUERY) {
      return;
    }

    const identity = toHistoryKey(text);
    const kept = entries.filter((entry) => toHistoryKey(entry) !== identity);
    // Deduplicating before the cut is what keeps an older query in the list when
    // the repeated one only changes places.
    entries = [text, ...kept].slice(0, maxEntries);
    save();
  };

  return {
    record,
    list: () => [...entries],
    clear: () => {
      entries = [];
      try {
        storage.removeItem(key);
      } catch {
        // Nothing left to do: the list is already forgotten here.
      }
    },
  };
}
