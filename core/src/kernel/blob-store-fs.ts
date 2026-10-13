import { link, mkdir, open, opendir, readFile, realpath, stat as fileStat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { safeJsonParse } from '#util/json';
import { KernelError } from '#errors';
import type { BlobBirth, BlobRef, BlobStore } from '#kernel/types';
import { isRecord } from '#util/is-record';
import { durableWrite, missing, syncDirectory } from '#kernel/store/fs-io';

interface Transfers {
  readonly readers: Map<string, number>;
  readonly writing: Set<string>;
  readonly retiring: Set<string>;
}

const physicalTransfers = new Map<string, WeakRef<Transfers>>();
const releasedTransfers = new FinalizationRegistry<{ path: string; reference: WeakRef<Transfers> }>(owner => {
  if (physicalTransfers.get(owner.path) === owner.reference) physicalTransfers.delete(owner.path);
});

/** Aliases of one physical carrier share transfer pins for their actual handle lifetime. */
function transfers(path: string): Transfers {
  const existing = physicalTransfers.get(path)?.deref();
  if (existing !== undefined) return existing;

  const state: Transfers = { readers: new Map(), writing: new Set(), retiring: new Set() };
  const reference = new WeakRef(state);
  physicalTransfers.set(path, reference);
  releasedTransfers.register(state, { path, reference });
  return state;
}

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
  directory = await realpath(directory);
  const owner = transfers(directory);

  /** Writes one stream with bounded in-flight memory and exclusive id ownership. */
  async function put(id: string, parts: AsyncIterable<Uint8Array>, type: string): Promise<BlobRef> {
    assertId(id);
    if (owner.writing.has(id) || owner.retiring.has(id)) throw new KernelError('CONFLICT', 'Blob transfer is active');
    owner.writing.add(id);
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
        await marker.writeFile(JSON.stringify({ ...result, bornAt: Date.now() }));
        await marker.sync();
      } finally {
        await marker.close();
      }
      await link(pending, metadata);
      await syncDirectory(directory);
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
    } finally { owner.writing.delete(id); }
  }

  /** Checks the marker against the actual file so corruption fails loudly. */
  async function stat(id: string): Promise<BlobRef> {
    assertId(id);
    try {
      if (owner.retiring.has(id)) throw new KernelError('NOT_FOUND', 'Blob is retired');
      const value: unknown = safeJsonParse(await readFile(join(directory, `${id}.json`), 'utf8'));
      if (isRecord(value) && value.retiredAt !== undefined) {
        if (typeof value.retiredAt !== 'number' || !Number.isFinite(value.retiredAt))
          throw new KernelError('INVALID', 'Blob retirement metadata is malformed');
        throw new KernelError('NOT_FOUND', 'Blob is retired');
      }
      const result = reference(value, id);
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
    assertId(id);
    if (owner.retiring.has(id)) throw new KernelError('NOT_FOUND', 'Blob is retired');
    owner.readers.set(id, (owner.readers.get(id) ?? 0) + 1);
    try {
      await stat(id);
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
    } finally {
      const count = owner.readers.get(id)! - 1;
      if (count === 0) owner.readers.delete(id);
      else owner.readers.set(id, count);
    }
  }

  /** Reads completed birth decisions without loading binary files or partial uploads. */
  async function* census(): AsyncIterable<BlobBirth> {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      assertId(id);
      const value: unknown = safeJsonParse(await readFile(join(directory, entry.name), 'utf8'));
      const ref = reference(value, id);
      if (!isRecord(value)
        || value.retiredAt !== undefined && (typeof value.retiredAt !== 'number' || !Number.isFinite(value.retiredAt)))
        throw new KernelError('INVALID', 'Blob birth metadata is malformed');

      let bornAt = value.bornAt;
      if (bornAt === undefined) {
        if (owner.writing.has(id) || owner.retiring.has(id))
          throw new KernelError('CONFLICT', 'Blob metadata adoption is active');
        owner.writing.add(id);
        try {
          // An unknown earlier birth gains a full orphan grace period from durable adoption.
          bornAt = Date.now();
          await durableWrite(directory, join(directory, entry.name), JSON.stringify({ ...ref, bornAt,
            ...(value.retiredAt === undefined ? {} : { retiredAt: value.retiredAt }) }));
        } finally { owner.writing.delete(id); }
      }
      if (typeof bornAt !== 'number' || !Number.isFinite(bornAt))
        throw new KernelError('INVALID', 'Blob birth metadata is malformed');
      yield { reference: ref, bornAt,
        ...(value.retiredAt === undefined ? {} : { retiredAt: value.retiredAt }) };
    }
  }

  /** Durably retires the identity before unlinking content; retry completes interrupted removal. */
  async function remove(id: string): Promise<void> {
    assertId(id);
    if (owner.readers.has(id) || owner.writing.has(id) || owner.retiring.has(id))
      throw new KernelError('CONFLICT', 'Blob transfer is active');
    owner.retiring.add(id);
    try {
      const file = join(directory, `${id}.json`);
      const value: unknown = safeJsonParse(await readFile(file, 'utf8'));
      const ref = reference(value, id);
      if (!isRecord(value) || typeof value.bornAt !== 'number' || !Number.isFinite(value.bornAt))
        throw new KernelError('INVALID', 'Blob birth metadata is malformed');
      if (value.retiredAt === undefined)
        await durableWrite(directory, file, JSON.stringify({ ...ref, bornAt: value.bornAt, retiredAt: Date.now() }));
      try { await unlink(join(directory, `${id}.data`)); }
      catch (error) { if (!missing(error)) throw error; }
      await syncDirectory(directory);
    } catch (error) {
      throw storageError(error);
    } finally { owner.retiring.delete(id); }
  }

  return { put, stat, get, census, delete: remove };
}
