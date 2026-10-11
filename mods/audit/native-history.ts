import { KernelError } from '@treenx/core/errors';
import type { HistoryEntry, ModuleManifest, Position, Reader } from '@treenx/core/kernel/types';

/** Read accepted journal images through the native history selector and its current A checks. */
export async function readAuditHistory(reader: Reader, path: string, after?: Position, limit = 256): Promise<readonly HistoryEntry[]> {
  const result = await reader.read({ history: path, after, window: { limit } });
  if (result.history === undefined) throw new KernelError('INVALID', 'History selector returned no journal rows');
  if (result.next !== undefined) throw new KernelError('BUDGET', 'Audit history exceeds the requested bounded page');
  return result.history;
}

/** Keep native audit reads on the accepted journal rather than the retiring mutation wrapper. */
export function nativeAuditManifest(): ModuleManifest {
  return { id: 'treenix.audit', security: [], open: [], types: [{
    name: 'audit.reader', module: 'treenix.audit', security: 'ordinary', version: 1,
    schema: { type: 'object', required: ['target'], additionalProperties: false, properties: { target: { type: 'string' } } },
    actions: { history: { kind: 'read', args: { type: 'object', additionalProperties: false }, async handler(context) {
      const target = context.node.target;
      if (typeof target !== 'string') throw new KernelError('INVALID', 'Audit reader has no target');
      return readAuditHistory(context.read, target);
    } } },
  }] };
}
