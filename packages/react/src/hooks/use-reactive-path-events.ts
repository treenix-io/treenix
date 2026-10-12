import { useTreeSource } from '#tree/tree-source-context';

/** The selected native source owns the stream; mounted reads retain their subscriptions. */
export function useReactivePathEvents(): void {
  useTreeSource();
}
