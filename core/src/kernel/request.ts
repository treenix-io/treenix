import { KernelError } from '#errors'
import type { AuthAdmission } from '#kernel/auth-factory'

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

export function createRequestAdmission(admission: AuthAdmission, requestSignal?: AbortSignal): AuthAdmission {
  if (requestSignal === undefined) return admission
  const cancellation = requestSignal
  const signal = AbortSignal.any([admission.signal, cancellation])
  function assertActive(): void {
    admission.assertActive()
    if (cancellation.aborted) throw new KernelError('CANCELLED', 'Request ended')
  }
  return { ...admission, signal, assertActive, async validate(source) {
    assertActive()
    await admission.validate(source)
    assertActive()
  } }
}
