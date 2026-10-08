import { KernelError } from '#errors';
import type { BlobRef, BlobStore } from '#kernel/types';

interface MemoryBlob {
  readonly reference: BlobRef;
  readonly parts: readonly Uint8Array[];
}

/** Keeps binary content outside nodes and owns each supplied chunk. */
export function createMemoryBlobStore(): BlobStore {
  const blobs = new Map<string, MemoryBlob>();
  const writing = new Set<string>();

  /** Holds an id until the complete stream can become readable. */
  async function put(
    id: string,
    source: AsyncIterable<Uint8Array>,
    type: string,
  ): Promise<BlobRef> {
    if (blobs.has(id) || writing.has(id)) throw new KernelError('CONFLICT', 'Blob already exists');
    writing.add(id);

    try {
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const part of source) {
        parts.push(new Uint8Array(part));
        size += part.byteLength;
      }

      const reference: BlobRef = Object.freeze({ $blob: id, size, type });
      blobs.set(id, { reference, parts });
      return reference;
    } finally {
      writing.delete(id);
    }
  }

  /** Resolves only fully accepted uploads. */
  async function stat(id: string): Promise<BlobRef> {
    const blob = blobs.get(id);
    if (blob === undefined) throw new KernelError('NOT_FOUND', 'Blob is absent');
    return blob.reference;
  }

  /** Yields owned buffers so consumers cannot alter future downloads. */
  async function* get(id: string): AsyncIterable<Uint8Array> {
    const blob = blobs.get(id);
    if (blob === undefined) throw new KernelError('NOT_FOUND', 'Blob is absent');
    for (const part of blob.parts) yield new Uint8Array(part);
  }

  /** Removes an existing upload without affecting another id. */
  async function remove(id: string): Promise<void> {
    if (!blobs.delete(id)) throw new KernelError('NOT_FOUND', 'Blob is absent');
  }

  return { put, stat, get, delete: remove };
}
