// Debounced async writer — coalesces rapid triggers into periodic writes.
// Handles: debounce timing, inflight guard, try-catch, cleanup.
// Used by: agent/service, cs/service, metatron/service for streaming progress.

export function debouncedWrite(
  fn: () => Promise<void>,
  ms = 2000,
  label = 'debouncedWrite',
): { trigger(): void; flush(): Promise<void>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  function execute(): Promise<void> {
    timer = null;
    if (inFlight) return inFlight;

    inFlight = Promise.resolve().then(fn).then(
      () => { inFlight = null; },
      (e: unknown) => {
        inFlight = null;
        console.error(`[${label}] write failed:`, e);
        throw e;
      },
    );
    return inFlight;
  }

  return {
    trigger() {
      if (timer || inFlight) return;
      timer = setTimeout(execute, ms);
    },

    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await execute();
    },

    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
