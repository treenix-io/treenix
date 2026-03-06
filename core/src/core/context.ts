// ── Context ──

export type Handler = (...args: any[]) => any;

// Typed context handlers — augmented by layers via declaration merging
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ContextHandlers<T = any> {
}

export type ContextHandler<C extends string, T = any> = C extends keyof ContextHandlers<T>
  ? ContextHandlers<T>[C]
  : C extends `${infer Base}:${string}`
    ? ContextHandler<Base, T>
    : Handler;
