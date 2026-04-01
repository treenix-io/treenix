// Domain errors for server operations.
// Transport-agnostic: tRPC, HTTP, MCP each map these to their own format.

export type ErrorCode = 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT' | 'FORBIDDEN' | 'UNAUTHORIZED' | 'TOO_MANY_REQUESTS';

export class OpError extends Error {
  override readonly name = 'OpError';
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
  }
}
