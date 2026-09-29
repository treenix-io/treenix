// Domain errors — transport-agnostic.
// Layer-neutral: usable from tree, schema, server, client.
// Each transport (tRPC, HTTP, MCP) maps these to its own format.

import type { ErrorCode, KernelError as KernelErrorShape } from '#kernel/types';

export class KernelError extends Error implements KernelErrorShape {
  override readonly name = 'KernelError';
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
  }
}
