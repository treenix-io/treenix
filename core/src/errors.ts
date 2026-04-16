// Domain errors — transport-agnostic.
// Layer-neutral: usable from tree, schema, server, client.
// Each transport (tRPC, HTTP, MCP) maps these to its own format.

export type ErrorCode = 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT' | 'FORBIDDEN' | 'UNAUTHORIZED' | 'TOO_MANY_REQUESTS';

export class OpError extends Error {
  override readonly name = 'OpError';
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
  }
}
