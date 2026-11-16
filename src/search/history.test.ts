import { beforeEach, describe, expect, it } from 'vitest';

import { HISTORY_STORAGE_KEY, SEARCH_HISTORY_MAX_ENTRIES } from '../config.js';
import { createSearchHistory } from './history.js';
import type { HistoryStorage, SearchHistory } from './history.js';

/**
 * Stands in for `window.localStorage`. The module under test is given this object
 * instead of reaching for a browser global, which is what keeps these tests running
 * in plain node. `raw` reports what a browser would really hold, so the stored shape
 * is part of the contract and not an implementation detail.
 */
interface StorageStub extends HistoryStorage {
  raw(key: string): string | null;
  writes(): number;
}

function createStorageStub(stored: Record<string, string> = {}): StorageStub {
  const items = new Map<string, string>(Object.entries(stored));
  let written = 0;
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
      written += 1;
    },
    removeItem: (key) => {
      items.delete(key);
    },
    raw: (key) => items.get(key) ?? null,
    writes: () => written,
  };
}

/** A storage that refuses to be read, the way a blocked third-party frame does. */
function unreadableStorage(): HistoryStorage {
  return {
    getItem: () => {
      throw new Error('localStorage is blocked');
    },
    setItem: () => undefined,
    removeItem: () => undefined,
  };
}

/** A storage that refuses to be written, the way a full or private window does. */
function unwritableStorage(): HistoryStorage {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota exceeded');
    },
    removeItem: () => undefined,
  };
}

function storedList(storage: StorageStub, key: string = HISTORY_STORAGE_KEY): unknown {
  const raw = storage.raw(key);
  return raw === null ? null : JSON.parse(raw);
}

/** Reads the history back the way a new page load would: same storage, new object. */
function visitAgain(storage: StorageStub): SearchHistory {
  return createSearchHistory({ storage });
}

function recordAll(history: SearchHistory, queries: string[]): void {
  for (const query of queries) {
    history.record(query);
  }
}

describe('search history', () => {
  let storage: StorageStub;
  let history: SearchHistory;

  beforeEach(() => {
    storage = createStorageStub();
    history = createSearchHistory({ storage });
  });

  describe('an empty start', () => {
    it('has nothing to offer before anything was searched', () => {
      expect(history.list()).toEqual([]);
    });

    it('ignores a query that is only spaces, and does not touch the storage', () => {
      recordAll(history, ['', '   ', '\n\t ']);
      expect(history.list()).toEqual([]);
      expect(storage.writes()).toBe(0);
    });
  });

  describe('recording what was searched', () => {
    it('keeps the most recent query first', () => {
      recordAll(history, ['spain', 'france']);
      expect(history.list()).toEqual(['france', 'spain']);
    });

    it('remembers the query without the spaces around it', () => {
      history.record('  south africa  ');
      expect(history.list()).toEqual(['south africa']);
    });

    it('treats the same query written differently as one entry', () => {
      recordAll(history, ['peru', 'PERU', '  peru ']);
      expect(history.list()).toEqual(['peru']);
    });

    it('keeps the spelling the person used most recently', () => {
      recordAll(history, ['Spain', '  SPAIN ']);
      expect(history.list()).toEqual(['SPAIN']);
      expect(storedList(storage)).toEqual(['SPAIN']);
    });

    it('moves a query that comes up again back to the front', () => {
      recordAll(history, ['chile', 'peru', 'brazil', 'chile']);
      expect(history.list()).toEqual(['chile', 'brazil', 'peru']);
    });

    it('does not grow the list when the same query keeps coming back', () => {
      recordAll(history, ['spain', 'spain', 'spain', 'spain', 'spain']);
      expect(history.list()).toEqual(['spain']);
    });
  });

  describe('what is kept in the storage', () => {
    it('keeps the list as text under the key the application agreed on', () => {
      recordAll(history, ['spain', 'france']);
      expect(storedList(storage)).toEqual(['france', 'spain']);
    });

    it('keeps two histories apart when they use different keys', () => {
      const places = createSearchHistory({ storage, key: 'country-search.places' });
      const others = createSearchHistory({ storage, key: 'country-search.others' });
      places.record('spain');
      others.record('peru');
      expect(places.list()).toEqual(['spain']);
      expect(others.list()).toEqual(['peru']);
      expect(storedList(storage, 'country-search.places')).toEqual(['spain']);
      expect(storedList(storage, 'country-search.others')).toEqual(['peru']);
    });

    it('forgets the stored list when it is cleared', () => {
      recordAll(history, ['spain', 'france']);
      history.clear();
      expect(history.list()).toEqual([]);
      expect(storage.raw(HISTORY_STORAGE_KEY)).toBeNull();
    });

    it('hands out a copy, so the list cannot be edited from outside', () => {
      recordAll(history, ['spain', 'france']);
      const handedOut = history.list();
      handedOut.push('nowhere');
      handedOut[0] = 'tampered';
      expect(history.list()).toEqual(['france', 'spain']);
      expect(storedList(storage)).toEqual(['france', 'spain']);
    });
  });

  describe('how many queries are kept', () => {
    it('keeps only as many queries as it was told to', () => {
      const small = createSearchHistory({ storage, maxEntries: 3 });
      recordAll(small, ['one', 'two', 'three', 'four', 'five']);
      expect(small.list()).toEqual(['five', 'four', 'three']);
      expect(storedList(storage)).toEqual(['five', 'four', 'three']);
    });

    it('moves a repeated query to the front without dropping the oldest one', () => {
      const small = createSearchHistory({ storage, maxEntries: 3 });
      recordAll(small, ['alpha', 'beta', 'gamma', 'alpha']);
      expect(small.list()).toEqual(['alpha', 'gamma', 'beta']);
    });

    it('honours the limit the application is configured with', () => {
      const queries = Array.from(
        { length: SEARCH_HISTORY_MAX_ENTRIES + 4 },
        (_, index) => `q${index}`,
      );
      recordAll(history, queries);
      expect(history.list()).toHaveLength(SEARCH_HISTORY_MAX_ENTRIES);
      expect(history.list()[0]).toBe(queries[queries.length - 1]);
      expect(history.list()).toEqual(queries.slice(-SEARCH_HISTORY_MAX_ENTRIES).reverse());
    });
  });

  describe('reading back what an earlier visit left behind', () => {
    it('a new history over the same storage sees the earlier queries', () => {
      recordAll(history, ['spain', 'france', 'peru']);
      expect(visitAgain(storage).list()).toEqual(['peru', 'france', 'spain']);
    });

    it('starts empty when the stored list is empty', () => {
      const seeded = createStorageStub({ [HISTORY_STORAGE_KEY]: '[]' });
      expect(createSearchHistory({ storage: seeded }).list()).toEqual([]);
    });

    it('keeps the stored order instead of sorting anything', () => {
      const seeded = createStorageStub({ [HISTORY_STORAGE_KEY]: '["zambia","albania","peru"]' });
      const reloaded = createSearchHistory({ storage: seeded });
      expect(reloaded.list()).toEqual(['zambia', 'albania', 'peru']);
      reloaded.record('peru');
      expect(reloaded.list()).toEqual(['peru', 'zambia', 'albania']);
    });

    it('never offers more queries than the limit, however long the stored list is', () => {
      const seeded = createStorageStub({
        [HISTORY_STORAGE_KEY]: '["one","two","three","four","five"]',
      });
      expect(createSearchHistory({ storage: seeded, maxEntries: 2 }).list()).toEqual([
        'one',
        'two',
      ]);
    });
  });

  describe('storage that does not cooperate', () => {
    it('ignores text that is not a list instead of throwing it at the interface', () => {
      const seeded = createStorageStub({ [HISTORY_STORAGE_KEY]: '{"nonsense":true}' });
      expect(createSearchHistory({ storage: seeded }).list()).toEqual([]);
    });

    it('ignores text that is not even readable', () => {
      const seeded = createStorageStub({ [HISTORY_STORAGE_KEY]: '[oops' });
      expect(createSearchHistory({ storage: seeded }).list()).toEqual([]);
    });

    it('skips stored entries that are not usable text', () => {
      const seeded = createStorageStub({
        [HISTORY_STORAGE_KEY]: '["spain", 42, null, "", "   ", "france"]',
      });
      expect(createSearchHistory({ storage: seeded }).list()).toEqual(['spain', 'france']);
    });

    it('works without any history when the storage cannot be read', () => {
      const historyOnBlockedStorage = createSearchHistory({ storage: unreadableStorage() });
      expect(historyOnBlockedStorage.list()).toEqual([]);
      expect(() => historyOnBlockedStorage.record('spain')).not.toThrow();
    });

    it('still remembers this session when the storage cannot be written', () => {
      const failing = createSearchHistory({ storage: unwritableStorage() });
      expect(() => failing.record('spain')).not.toThrow();
      expect(failing.list()).toEqual(['spain']);
      expect(() => failing.record('france')).not.toThrow();
      expect(failing.list()).toEqual(['france', 'spain']);
    });
  });
});
