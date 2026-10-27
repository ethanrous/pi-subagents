/**
 * abortable.ts — race a promise against an AbortSignal without cancelling the
 * underlying work.
 *
 * Used by the `get_subagent_result` wait paths (top-level and nested): pressing
 * Esc cancels only the caller's wait; the background child keeps running and its
 * result stays unconsumed. The listener is removed on every settle path so the
 * signal accumulates no handlers, and a late settlement of the wrapped promise
 * after an abort is absorbed as a no-op (no unhandled rejection).
 */

/** Await a promise until it settles or the caller cancels, without aborting the underlying work. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/** How long `stop_subagent` waits for a stopped run to settle before returning anyway. */
export const STOP_SETTLE_MS = 3000;

/**
 * Wait for a stopped run's promise to settle, at most `STOP_SETTLE_MS` and
 * until the caller cancels. Never throws: the stop has already happened.
 */
export async function waitForSettle(promise: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, STOP_SETTLE_MS); });
  const settled = promise.then(() => undefined, () => undefined);
  try {
    await abortable(Promise.race([settled, timeout]), signal);
  } catch { /* wait cancelled */ } finally {
    clearTimeout(timer);
  }
}
