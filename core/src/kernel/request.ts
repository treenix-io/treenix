import { isDeepStrictEqual } from 'node:util';
import { KernelError } from '#errors';
import type { AuthAdmission } from '#kernel/auth-factory';

/** Serializes owned request data while rejecting binary values before deep freezing. */
export function serializeRequest(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (
      ArrayBuffer.isView(item) ||
      item instanceof ArrayBuffer ||
      item instanceof SharedArrayBuffer
    )
      throw new KernelError('INVALID', 'Binary content belongs in a blob');
    return item;
  });
  if (serialized === undefined) throw new KernelError('INVALID', 'Request data is absent');
  return serialized;
}

export function createRequestAdmission(
  admission: AuthAdmission,
  requestSignal?: AbortSignal,
): AuthAdmission {
  if (requestSignal === undefined && admission.shard === undefined) return admission;
  const shard = admission.shard;
  const cancellation = requestSignal;
  const signal =
    cancellation === undefined
      ? admission.signal
      : AbortSignal.any([admission.signal, cancellation]);
  function assertActive(): void {
    admission.assertActive();
    if (shard !== undefined && !isDeepStrictEqual(shard, admission.shard))
      throw new KernelError('CONFLICT', 'Shard prefix changed during the request');
    if (cancellation?.aborted) throw new KernelError('CANCELLED', 'Request ended');
  }
  return {
    ...admission,
    signal,
    assertActive,
    async validate(source) {
      assertActive();
      await admission.validate(source);
      assertActive();
    },
  };
}
