// Timer callbacks log their label and propagate failures.

/**
 * setInterval wrapper that catches async callback errors.
 * Logs failures with label and propagates them.
 */
export function safeInterval(
  fn: () => Promise<void>,
  ms: number,
  label: string,
): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    try {
      await fn();
    } catch (e) {
      console.error(`[${label}] periodic task failed:`, e);
      throw e;
    }
  }, ms);
}

/**
 * setTimeout wrapper that catches async callback errors.
 */
export function safeTimeout(
  fn: () => Promise<void>,
  ms: number,
  label: string,
): ReturnType<typeof setTimeout> {
  return setTimeout(async () => {
    try {
      await fn();
    } catch (e) {
      console.error(`[${label}] deferred task failed:`, e);
      throw e;
    }
  }, ms);
}
