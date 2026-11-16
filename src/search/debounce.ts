/**
 * A debounced function plus the controls the UI needs:
 * `cancel()` drops a pending call, `flush()` runs it immediately.
 */
export interface Debounced<Args extends readonly unknown[]> {
  (...args: Args): void;
  cancel(): void;
  flush(): void;
}

/**
 * Wraps `fn` so that it runs once, `delayMs` after the *last* call in a series.
 * Every call restarts the timer, so a stream of user input produces a single
 * invocation with the most recent arguments.
 *
 * @param fn function to defer
 * @param delayMs quiet period to wait after the last call; even `0` keeps the
 * call asynchronous, which is what makes a single input event never fire twice
 */
export function debounce<Args extends readonly unknown[]>(
  fn: (...args: Args) => void,
  delayMs: number,
): Debounced<Args> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: Args | null = null;

  const clearTimer = (): void => {
    if (timer === null) {
      return;
    }
    clearTimeout(timer);
    timer = null;
  };

  const invokePending = (): void => {
    if (pendingArgs === null) {
      return;
    }
    const args = pendingArgs;
    pendingArgs = null;
    fn(...args);
  };

  const debounced = (...args: Args): void => {
    pendingArgs = args;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      invokePending();
    }, delayMs);
  };

  const cancel = (): void => {
    pendingArgs = null;
    clearTimer();
  };

  const flush = (): void => {
    clearTimer();
    invokePending();
  };

  return Object.assign(debounced, { cancel, flush });
}
