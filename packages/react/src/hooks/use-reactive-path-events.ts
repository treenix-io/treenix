import { useEffect } from 'react';

/** Opens the shared tree event stream. Mounted usePath/useChildren own watches. */
export function useReactivePathEvents(): void {
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    import('#tree/events').then(({ startEvents, stopEvents }) => {
      if (cancelled) return;
      startEvents();
      cleanup = stopEvents;
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);
}
