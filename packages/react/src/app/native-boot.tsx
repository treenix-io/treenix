import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { openTwpHttp } from '@treenx/core/client/http-twp';
import { createTwpClient } from '@treenx/core/client/twp';
import { KernelError } from '@treenx/core/errors';
import { isReadResult, isSelector } from '@treenx/core/protocol/twp';
import { NativeRouter } from '#app/NativeRouter';
import { createLaneTreeSource } from '#tree/lane-source';
import type { NativeHydrationState } from '#tree/read-snapshot';
import { TreeSourceProvider } from '#tree/tree-source-context';
import { Toaster } from '#components/ui/sonner';

/** Decode external HTML hydration at its boundary, retaining actual selectors and native results. */
export function decodeNativeHydration(value: unknown): NativeHydrationState {
  if (typeof value !== 'object' || value === null || !('reads' in value) || !Array.isArray(value.reads))
    throw new KernelError('INVALID', 'Malformed native hydration');
  const reads: NativeHydrationState['reads'][number][] = [];
  for (const read of value.reads) {
    if (typeof read !== 'object' || read === null || !('selector' in read) || !isSelector(read.selector)
      || 'history' in read.selector || !('result' in read) || !isReadResult(read.result))
      throw new KernelError('INVALID', 'Malformed native hydration read');
    reads.push({ selector: read.selector, result: read.result });
  }
  return { reads };
}

/** Replace server presentation with one genuinely admitted native lane. */
export async function bootNative(root: HTMLElement, initial: NativeHydrationState) {
  const connection = await openTwpHttp({ url: window.location.origin });
  const client = createTwpClient(connection, { close: connection.close });
  try { await client.ready; }
  catch (error) { client.close(); throw error; }
  const source = createLaneTreeSource(client, initial);
  const tree = <TreeSourceProvider source={source}><QueryClientProvider client={new QueryClient()}>
    <NativeRouter /><Toaster />
  </QueryClientProvider></TreeSourceProvider>;
  const hydrate = root.firstElementChild !== null;
  const mounted = hydrate ? hydrateRoot(root, tree) : createRoot(root);
  if (!hydrate) mounted.render(tree);
  const close = () => { mounted.unmount(); source.close(); client.close(); };
  window.addEventListener('pagehide', close, { once: true });
  return close;
}
