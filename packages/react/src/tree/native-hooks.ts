import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { IncludeSpec, SubSelector } from '@treenx/core/kernel/types'
import { useNativeSource } from '#tree/native-source-context'

/** Subscribe to one selector and expose its paging controls. */
export function useNativeSelector(input: SubSelector) {
  const source = useNativeSource(),
    key = JSON.stringify(input);
  const selector = useMemo(() => structuredClone(input), [key]);
  const subscribe = useCallback(
    (listener: () => void) => source.subscribe(selector, listener),
    [source, selector],
  );
  const read = useCallback(() => source.getSnapshot(selector), [source, selector]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  const loadMore = useCallback(() => source.loadMore(selector), [source, selector]);
  const refetch = useCallback(() => source.refetch(selector), [source, selector]);
  return useMemo(() => ({ ...snapshot, loadMore, refetch }), [snapshot, loadMore, refetch]);
}

/** Read one node, optionally including related nodes. */
export function useNativeNode(path: string, include?: readonly IncludeSpec[]) {
  return useNativeSelector({ node: path, ...(include === undefined ? {} : { include }) });
}

/** Read a child window, defaulting to the first 100 results. */
export function useNativeChildren(
  path: string,
  options: Omit<Extract<SubSelector, { readonly children: string }>, 'children'> = {},
) {
  return useNativeSelector({
    children: path,
    ...options,
    window: options.window ?? { limit: 100 },
  });
}
