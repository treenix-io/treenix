import { KernelError } from '#errors';

/** Preserve the public diagnostics of KernelError in JSON output. */
export function kernelErrorData(error: Pick<KernelError, 'code' | 'message'>) {
  return { code: error.code, message: error.message };
}

/** Error diagnostics have non-enumerable messages; budget the same representation that is delivered. */
export function serializeKernel(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item instanceof KernelError ? kernelErrorData(item) : item,
  );
}
