import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { debounce } from './debounce.js';

const DELAY_MS = 300;

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('trailing invocation', () => {
    it('does not call the function before the delay has elapsed', () => {
      const spy = vi.fn<(query: string) => void>();
      const debounced = debounce(spy, DELAY_MS);

      debounced('spain');
      vi.advanceTimersByTime(DELAY_MS - 1);

      expect(spy).not.toHaveBeenCalled();
    });

    it('calls the function once the delay has elapsed', () => {
      const spy = vi.fn<(query: string) => void>();
      const debounced = debounce(spy, DELAY_MS);

      debounced('spain');
      vi.advanceTimersByTime(DELAY_MS);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('spain');
    });

    it('does not call again after the pending invocation has run', () => {
      const spy = vi.fn<(query: string) => void>();
      const debounced = debounce(spy, DELAY_MS);

      debounced('spain');
      vi.advanceTimersByTime(DELAY_MS * 3);

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('defers the call even when the delay is zero', () => {
      const spy = vi.fn<(query: string) => void>();
      const debounced = debounce(spy, 0);

      debounced('spain');

      expect(spy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(0);

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('timer restart on repeated calls', () => {
    it('measures the delay from the last call, not the first one', () => {
      const spy = vi.fn<(query: string) => void>();
      const debounced = debounce(spy, DELAY_MS);

      debounced('s');
      vi.advanceTimersByTime(200);
      debounced('sp');
      vi.advanceTimersByTime(200);

      expect(spy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('calls once for a burst of rapid calls', () => {
      const spy = vi.fn<(query: string) => void>();
      const debounced = debounce(spy, DELAY_MS);

      for (const query of ['s', 'sp', 'spa', 'spai', 'spain']) {
        debounced(query);
        vi.advanceTimersByTime(20);
      }

      vi.advanceTimersByTime(DELAY_MS);

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('passes the arguments of the most recent call', () => {
      const spy = vi.fn<(query: string) => void>();
      const debounced = debounce(spy, DELAY_MS);

      debounced('s');
      debounced('sp');
      debounced('spain');
      vi.advanceTimersByTime(DELAY_MS);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('spain');
    });

    it('starts a new timer for a call that arrives after the previous one has run', () => {
      const spy = vi.fn<(query: string) => void>();
      const debounced = debounce(spy, DELAY_MS);

      debounced('s');
      vi.advanceTimersByTime(DELAY_MS);
      debounced('spain');
      vi.advanceTimersByTime(DELAY_MS - 1);

      expect(spy).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);

      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenLastCalledWith('spain');
    });
  });

  describe('cancel', () => {
    it('prevents the pending invocation from running', () => {
      const spy = vi.fn<(query: string) => void>();
      const debounced = debounce(spy, DELAY_MS);

      debounced('spain');
      debounced.cancel();
      vi.advanceTimersByTime(DELAY_MS * 2);

      expect(spy).not.toHaveBeenCalled();
    });

    it('can be called repeatedly without throwing when nothing is pending', () => {
      const spy = vi.fn<(query: string) => void>();
      const debounced = debounce(spy, DELAY_MS);

      expect(() => {
        debounced.cancel();
        debounced.cancel();
      }).not.toThrow();
    });

    it('does not break subsequent calls', () => {
      const spy = vi.fn<(query: string) => void>();
      const debounced = debounce(spy, DELAY_MS);

      debounced('spain');
      debounced.cancel();
      debounced('peru');
      vi.advanceTimersByTime(DELAY_MS);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('peru');
    });
  });

  describe('flush', () => {
    it('invokes the pending call immediately', () => {
      const spy = vi.fn<(query: string) => void>();
      const debounced = debounce(spy, DELAY_MS);

      debounced('spain');
      debounced.flush();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('spain');
    });

    it('does not invoke the pending call twice', () => {
      const spy = vi.fn<(query: string) => void>();
      const debounced = debounce(spy, DELAY_MS);

      debounced('spain');
      debounced.flush();
      debounced.flush();
      vi.advanceTimersByTime(DELAY_MS);

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does nothing when there is no pending call', () => {
      const spy = vi.fn<(query: string) => void>();
      const debounced = debounce(spy, DELAY_MS);

      debounced.flush();
      vi.advanceTimersByTime(DELAY_MS);

      expect(spy).not.toHaveBeenCalled();
    });

    it('leaves the debounced function usable after flushing', () => {
      const spy = vi.fn<(query: string) => void>();
      const debounced = debounce(spy, DELAY_MS);

      debounced('spain');
      debounced.flush();
      debounced('peru');
      vi.advanceTimersByTime(DELAY_MS);

      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenLastCalledWith('peru');
    });
  });
});
