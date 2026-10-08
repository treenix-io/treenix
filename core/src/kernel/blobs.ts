import { randomBytes } from 'node:crypto';
import { KernelError } from '#errors';
import { createActionControl } from '#kernel/action-context';
import type { CommandOptions } from '#kernel/commands';
import { judgeGates } from '#kernel/gates';
import { createReader } from '#kernel/reader';
import { createRequestAdmission } from '#kernel/request';
import type { BlobRef, BlobStore, Budget, Path } from '#kernel/types';
import { assertSafePatchPath, getByPath } from '#kernel/update-ops';
import { isRecord } from '#util/is-record';

/** Decodes a reference at the node-write boundary, where binary data is forbidden. */
function decodeReference(value: unknown): BlobRef {
  if (
    !isRecord(value) ||
    typeof value.$blob !== 'string' ||
    typeof value.type !== 'string' ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    Object.keys(value).some((key) => key !== '$blob' && key !== 'size' && key !== 'type')
  )
    throw new KernelError('INVALID', 'Malformed blob reference');
  return { $blob: value.$blob, size: value.size, type: value.type };
}

/** Walks write input once; only references cause storage I/O. */
export async function validateBlobReferences(
  value: unknown,
  store: BlobStore | undefined,
  budget: Budget,
): Promise<void> {
  const references = new Map<string, BlobRef>();
  let work = 0;

  /** Finds references without permitting binary values to be embedded in nodes. */
  function visit(item: unknown): void {
    if (++work > budget.exprWork || Date.now() > budget.deadline)
      throw new KernelError('BUDGET', 'Blob reference validation exceeded its budget');
    if (item === null || typeof item !== 'object') return;
    if (
      ArrayBuffer.isView(item) ||
      item instanceof ArrayBuffer ||
      item instanceof SharedArrayBuffer
    )
      throw new KernelError('INVALID', 'Binary content belongs in a blob');
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!isRecord(item)) throw new KernelError('INVALID', 'Malformed node data');
    if (Object.hasOwn(item, '$blob')) {
      const ref = decodeReference(item);
      const previous = references.get(ref.$blob);
      if (previous !== undefined && (previous.size !== ref.size || previous.type !== ref.type))
        throw new KernelError('INVALID', 'Conflicting blob reference metadata');
      references.set(ref.$blob, ref);
      return;
    }
    for (const child of Object.values(item)) visit(child);
  }

  visit(value);
  for (const ref of references.values()) {
    if (store === undefined) throw new KernelError('UNAVAILABLE', 'Blob storage is not configured');
    let stored: BlobRef;
    try {
      stored = await store.stat(ref.$blob);
    } catch (error) {
      if (error instanceof KernelError && error.code === 'NOT_FOUND')
        throw new KernelError('INVALID', 'Blob reference is unknown');
      throw error;
    }
    if (stored.$blob !== ref.$blob || stored.size !== ref.size || stored.type !== ref.type)
      throw new KernelError('INVALID', 'Blob reference differs from stored content');
    if (Date.now() > budget.deadline)
      throw new KernelError('BUDGET', 'Blob reference validation exceeded its deadline');
  }
}

/** Resolves a caller-supplied field through the visible node, without prototype lookup. */
function fieldReference(node: unknown, field: string): BlobRef {
  assertSafePatchPath(field, 'INVALID');
  const value = getByPath(node, field);
  if (value === undefined) throw new KernelError('NOT_FOUND', 'Blob field is absent');
  return decodeReference(value);
}

/** Produces streamed transfers through the same admission, Reader and gates as other requests. */
export function createBlobTransfers(options: CommandOptions, store: BlobStore) {
  /** Issues an unpredictable id and forwards one chunk at a time under the operation deadline. */
  async function upload(
    parts: AsyncIterable<Uint8Array>,
    type: string,
    signal?: AbortSignal,
  ): Promise<BlobRef> {
    const request = createRequestAdmission(options.admission, signal);
    const budget = options.budget('action');
    const control = createActionControl(request, budget.deadline);
    const iterator = parts[Symbol.asyncIterator]();
    const id = randomBytes(32).toString('hex');
    let finished = false;

    try {
      control.active();
      if (Buffer.byteLength(type) > options.limits().requestBytes)
        throw new KernelError('BUDGET', 'Blob request exceeded its budget');
      await judgeGates(
        options.gates,
        { kind: 'upload', type, origin: options.admission.origin },
        request.actor,
        { signal: control.signal, deadline: budget.deadline },
      );

      /** Rejects the overflowing chunk before the storage adapter writes it. */
      async function* bounded(): AsyncIterable<Uint8Array> {
        let size = 0;
        for (;;) {
          const next = await control.wait(iterator.next());
          if (next.done) {
            finished = true;
            return;
          }
          size += next.value.byteLength;
          if (size > options.limits().blobBytes)
            throw new KernelError('BUDGET', 'Blob byte budget exceeded');
          yield next.value;
        }
      }

      return await control.wait(store.put(id, bounded(), type));
    } finally {
      if (!finished) {
        // A stalled external next() must not prevent cancellation from settling.
        iterator
          .return?.()
          .catch((error) =>
            console.error(
              'Blob upload source failed',
              error instanceof KernelError ? error.code : 'UNAVAILABLE',
            ),
          );
      }
      control.close();
    }
  }

  /** Requires a reference in the caller's current projection before opening binary content. */
  async function* download(
    path: Path,
    field: string,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const request = createRequestAdmission(options.admission, signal);
    const budget = options.budget('action');
    const control = createActionControl(request, budget.deadline);

    try {
      control.active();
      if (Buffer.byteLength(JSON.stringify([path, field])) > options.limits().requestBytes)
        throw new KernelError('BUDGET', 'Blob request exceeded its budget');
      await judgeGates(
        options.gates,
        { kind: 'download', path, field, origin: options.admission.origin },
        request.actor,
        { signal: control.signal, deadline: budget.deadline },
      );
      const source = options.source(budget);
      if (source.auth.shard(path))
        throw new KernelError('INVALID', 'Authority blobs belong to their instance');
      const reader = createReader({
        admission: request,
        writer: options.writer,
        registry: options.registry,
        source,
        budget,
        limits: options.limits(),
        projector: options.projector,
      });
      const copy = (await reader.read({ node: path })).copies[0]!;
      if (!('node' in copy)) throw copy.error;
      const ref = fieldReference(copy.node, field);
      const stored = await control.wait(store.stat(ref.$blob));
      if (stored.$blob !== ref.$blob || stored.size !== ref.size || stored.type !== ref.type)
        throw new KernelError('INVALID', 'Blob reference differs from stored content');

      const iterator = store.get(ref.$blob)[Symbol.asyncIterator]();
      let size = 0;
      let finished = false;
      let closing: Promise<IteratorResult<Uint8Array>> | undefined;

      /** Releases a paused source even while the outer consumer is not pulling. */
      function closeSource(): void {
        if (finished || closing !== undefined || iterator.return === undefined) return;
        closing = iterator.return();
        closing.catch((error) =>
          console.error(
            'Blob download source failed',
            error instanceof KernelError ? error.code : 'UNAVAILABLE',
          ),
        );
      }

      control.signal.addEventListener('abort', closeSource, { once: true });
      try {
        for (;;) {
          const next = await control.wait(iterator.next());
          if (next.done) {
            finished = true;
            break;
          }
          size += next.value.byteLength;
          if (size > options.limits().blobBytes || size > ref.size)
            throw new KernelError('BUDGET', 'Blob byte budget exceeded');
          yield next.value;
        }
      } finally {
        control.signal.removeEventListener('abort', closeSource);
        closeSource();
        if (!control.signal.aborted) await closing;
      }
      control.active();
      if (size !== ref.size)
        throw new KernelError('INVALID', 'Blob content differs from its reference');
    } finally {
      control.close();
    }
  }

  return { upload, download };
}

export type BlobTransfers = ReturnType<typeof createBlobTransfers>;
