import { useEffect } from 'react';

export function useDebounce(fn: () => void, delay: number, deps: unknown[]) {
  useEffect(() => {
    const timer = setTimeout(fn, delay);
    return () => clearTimeout(timer);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}