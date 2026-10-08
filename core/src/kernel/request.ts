import { KernelError } from '#errors'
import type { AuthAdmission } from '#kernel/auth-factory'

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
