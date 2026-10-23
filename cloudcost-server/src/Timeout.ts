/**
 * Run an operation with a hard deadline. The abort signal is passed to the
 * underlying SDK call so it can cancel the request; the promise rejects with
 * a timeout error even when the operation ignores the signal.
 */
export async function WithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  // Defer the call so a synchronous throw rejects the raced promise instead
  // of escaping before the timer is cleared.
  const work = Promise.resolve().then(() => operation(controller.signal));
  // A late rejection after the timeout won must not surface as unhandled.
  work.catch(() => {});
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
