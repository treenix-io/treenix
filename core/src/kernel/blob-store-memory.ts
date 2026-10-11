import { KernelError } from '#errors';
import type { BlobBirth, BlobRef, BlobStore } from '#kernel/types';

interface MemoryBlob {
  readonly reference: BlobRef;
  readonly parts: readonly Uint8Array[];
  readonly birth: BlobBirth;
}

/** Keeps binary content outside nodes and owns each supplied chunk. */
export function createMemoryBlobStore(): BlobStore {
  const blobs = new Map<string, MemoryBlob>();
  const writing = new Set<string>();
  const births = new Map<string, BlobBirth>();
  const readers = new Map<string, number>();

  /** Holds an id until the complete stream can become readable. */
  async function put(
    id: string,
    source: AsyncIterable<Uint8Array>,
    type: string,
  ): Promise<BlobRef> {
    if (births.has(id) || writing.has(id)) throw new KernelError('CONFLICT', 'Blob already exists');
    writing.add(id);

    try {
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const part of source) {
        parts.push(new Uint8Array(part));
        size += part.byteLength;
      }

      const reference: BlobRef = Object.freeze({ $blob: id, size, type });
      const birth: BlobBirth = { reference, bornAt: Date.now() };
      blobs.set(id, { reference, parts, birth });
      births.set(id, birth);
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
    readers.set(id, (readers.get(id) ?? 0) + 1);
    try {
      for (const part of blob.parts) yield new Uint8Array(part);
    } finally {
      const count = readers.get(id)! - 1;
      if (count === 0) readers.delete(id);
      else readers.set(id, count);
    }
  }

  /** Removes an existing upload without affecting another id. */
  async function remove(id: string): Promise<void> {
    if (readers.has(id)) throw new KernelError('CONFLICT', 'Blob transfer is active');
    const birth = births.get(id);
    if (birth === undefined) throw new KernelError('NOT_FOUND', 'Blob is absent');
    if (birth.retiredAt !== undefined) return;
    births.set(id, { ...birth, retiredAt: Date.now() });
    blobs.delete(id);
  }

  /** Keeps completed birth and retirement decisions available after binary removal. */
  async function* census(): AsyncIterable<BlobBirth> {
    for (const birth of births.values()) yield birth;
  }

  return { put, stat, get, census, delete: remove };
}
