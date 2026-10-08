import { createContext, createElement, useContext, type ReactNode } from 'react'
import type { NativeTreeSource } from '#tree/native-source'

const Context = createContext<NativeTreeSource | null>(null)

/** Provide the native tree source to the editor subtree. */
export function NativeSourceProvider({
  source,
  children,
}: {
  source: NativeTreeSource;
  children: ReactNode;
}) {
  return createElement(Context.Provider, { value: source }, children);
}

/** Require the source installed by NativeSourceProvider. */
export function useNativeSource(): NativeTreeSource {
  const source = useContext(Context);
  if (source === null) throw new Error('NativeSourceProvider is required');
  return source;
}
