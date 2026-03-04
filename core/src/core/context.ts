// ── Context ──

export type Handler = (...args: any[]) => any;

// Typed context handlers — augmented by layers via declaration merging
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ContextHandlers {
}

export type ContextHandler<C extends string> = C extends keyof ContextHandlers
  ? ContextHandlers[C]
  : C extends `${infer Base}:${string}`
    ? ContextHandler<Base>
    : Handler;
