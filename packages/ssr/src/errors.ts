// Typed errors thrown by the SSR pipeline. Caller (handler.ts) maps them to
// HTTP responses. Keeping them in one place so server adapters can pattern-match
// on `e.code` without instanceof checks across module boundaries.

/** A `site` view was requested for a type that has no handler registered for
 *  the `site` rendering context. The strict resolver does NOT fall back to
 *  `react` (`react` views may use `window`/`document`/FlowGram). */
export class MissingSiteViewError extends Error {
  readonly code = 'MISSING_SITE_VIEW' as const;
  constructor(
    public readonly type: string,
    public readonly context: string,
    public readonly nodePath?: string,
  ) {
    super(`No '${context}' view registered for type '${type}'${nodePath ? ` at ${nodePath}` : ''}`);
    this.name = 'MissingSiteViewError';
  }
}

/** Render loop exhausted its budget — pending data reads keep being
 *  discovered after each flush. Indicates a runaway view. */
export class SsrDataUnresolved extends Error {
  readonly code = 'SSR_DATA_UNRESOLVED' as const;
  constructor(public readonly pendingPaths: string[]) {
    super(`SSR render did not stabilise after max passes; still pending: ${pendingPaths.slice(0, 10).join(', ')}`);
    this.name = 'SsrDataUnresolved';
  }
}
