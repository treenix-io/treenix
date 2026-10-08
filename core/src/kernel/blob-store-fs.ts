import { link, mkdir, open, readFile, stat as fileStat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { safeJsonParse } from '#core/json';
import { KernelError } from '#errors';
import type { BlobRef, BlobStore } from '#kernel/types';
import { isRecord } from '#util/is-record';

/** Keeps filesystem errors useful without exposing the secret blob id in paths. */
function storageError(error: unknown): KernelError {
  if (error instanceof KernelError) return error;
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'UNKNOWN';
  if (code === 'ENOENT') return new KernelError('NOT_FOUND', 'Blob is absent');
  if (code === 'EEXIST') return new KernelError('CONFLICT', 'Blob already exists');
  console.error('Blob storage failed', code);
  return new KernelError('UNAVAILABLE', 'Blob storage failed');
}

/** Restricts the filesystem segment at this storage boundary. */
function assertId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{22,128}$/.test(id)) throw new KernelError('INVALID', 'Invalid blob id');
}

/** Validates persisted metadata before returning it through the storage contract. */
function reference(value: unknown, id: string): BlobRef {
  if (
    !isRecord(value) ||
    value.$blob !== id ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    typeof value.type !== 'string'
  )
    throw new KernelError('INVALID', 'Malformed blob metadata');
  return Object.freeze({ $blob: id, size: value.size, type: value.type });
}

/** Publishes metadata last; incomplete binary writes never become readable blobs. */
export async function createFsBlobStore(directory: string): Promise<BlobStore> {
  await mkdir(directory, { recursive: true });

  /** Writes one stream with bounded in-flight memory and exclusive id ownership. */
  async function put(id: string, parts: AsyncIterable<Uint8Array>, type: string): Promise<BlobRef> {
    assertId(id);
    const data = join(directory, `${id}.data`);
    const pending = join(directory, `${id}.pending`);
    const metadata = join(directory, `${id}.json`);
    let ownsData = false;
    let ownsPending = false;

    try {
      const file = await open(data, 'wx');
      ownsData = true;
      let size = 0;
      try {
        for await (const part of parts) {
          let offset = 0;
          while (offset < part.byteLength) {
            const written = await file.write(part, offset, part.byteLength - offset);
            if (written.bytesWritten === 0)
              throw new KernelError('UNAVAILABLE', 'Blob write made no progress');
            offset += written.bytesWritten;
          }
          size += part.byteLength;
        }
        await file.sync();
      } finally {
        await file.close();
      }

      const result: BlobRef = Object.freeze({ $blob: id, size, type });
      const marker = await open(pending, 'wx');
      ownsPending = true;
      try {
        await marker.writeFile(JSON.stringify(result));
        await marker.sync();
      } finally {
        await marker.close();
      }
      await link(pending, metadata);
      ownsData = false;
      await unlink(pending);
      ownsPending = false;
      return result;
    } catch (error) {
      if (ownsPending)
        await unlink(pending).catch((caught) => {
          throw storageError(caught);
        });
      if (ownsData)
        await unlink(data).catch((caught) => {
          throw storageError(caught);
        });
      throw storageError(error);
    }
  }

  /** Checks the marker against the actual file so corruption fails loudly. */
  async function stat(id: string): Promise<BlobRef> {
    assertId(id);
    try {
      const result = reference(
        safeJsonParse(await readFile(join(directory, `${id}.json`), 'utf8')),
        id,
      );
      const data = await fileStat(join(directory, `${id}.data`));
      if (data.size !== result.size)
        throw new KernelError('INVALID', 'Blob size differs from its metadata');
      return result;
    } catch (error) {
      throw storageError(error);
    }
  }

  /** Streams fixed-size chunks and closes the descriptor when the consumer stops. */
  async function* get(id: string): AsyncIterable<Uint8Array> {
    await stat(id);
    try {
      const file = await open(join(directory, `${id}.data`), 'r');
      try {
        for (;;) {
          const part = new Uint8Array(64 * 1024);
          const read = await file.read(part);
          if (read.bytesRead === 0) return;
          yield part.subarray(0, read.bytesRead);
        }
      } finally {
        await file.close();
      }
    } catch (error) {
      throw storageError(error);
    }
  }

  /** Withdraws metadata before removing binary content. */
  async function remove(id: string): Promise<void> {
    assertId(id);
    try {
      await unlink(join(directory, `${id}.json`));
      await unlink(join(directory, `${id}.data`));
    } catch (error) {
      throw storageError(error);
    }
  }

  return { put, stat, get, delete: remove };
}
