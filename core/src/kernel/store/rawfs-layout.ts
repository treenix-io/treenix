import { createHash } from 'node:crypto';
import { lstat, open, opendir, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { KernelError } from '#errors';
import { safeJsonParse } from '#util/json';
import { isRecord } from '#util/is-record';
import { assertPathSafe } from '#util/path-safety';
import { stableJson } from '#util/stable-json';
import type { Budget, StoredNode, StoredWrite } from '#kernel/types';
import type { FsPhysicalLayout } from './fs';
import { assertStoredJson } from './fs-journal';
import { fsAddress } from './fs-layout';
import { durableDirectory, durableWrite, missing, syncDirectory } from './fs-io';
import { decodeJsonBody, getMime, type RawFsCodecs } from './rawfs-codec';

type Cost = { nodes: number; bytes: number; exprWork: number };
type Body = Record<string, unknown> & { $type: string; $id?: string };

/** Check the physical allowance before allocating or decoding file contents. */
function check(cost: Cost, budget: Budget): void {
  if (
    Date.now() > budget.deadline ||
    cost.nodes > budget.nodes ||
    cost.bytes > budget.bytes ||
    cost.exprWork > budget.exprWork
  )
    throw new KernelError('BUDGET', 'Raw filesystem allowance exceeded');
}

/** Read file bytes in bounded chunks; absent optional metadata is handled by its caller. */
async function text(root: string, file: string, cost: Cost, budget: Budget): Promise<string> {
  await assertPathSafe(root, file);
  const handle = await open(file, 'r');
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      check(cost, budget);
      const buffer = Buffer.alloc(Math.min(64 * 1024, budget.bytes - cost.bytes + 1));
      const { bytesRead } = await handle.read(buffer);
      cost.bytes += bytesRead;
      cost.exprWork++;
      check(cost, budget);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Reject structural metadata supplied by files before it enters native storage. */
function body(value: unknown): Body {
  if (
    !isRecord(value) ||
    typeof value.$type !== 'string' ||
    value.$type.length === 0 ||
    (value.$id !== undefined && (typeof value.$id !== 'string' || value.$id.length === 0)) ||
    '$path' in value ||
    '$pos' in value ||
    '$rev' in value
  )
    throw new KernelError('INVALID', 'Malformed raw filesystem node body');
  assertStoredJson(value);
  return { ...value, $type: value.$type, ...(value.$id === undefined ? {} : { $id: value.$id }) };
}

/** Adapt authored files to the existing journaled Fs owner without changing their extensions. */
export function createRawFsLayout(
  codecs: RawFsCodecs,
  logicalBase: string,
  rootDirectory: string,
): FsPhysicalLayout {
  const prepared = new Map<string, { node: StoredNode; content?: string; metadata: string }>();
  const outer = (path: string) =>
    logicalBase === '/' ? path : path === '/' ? logicalBase : `${logicalBase}${path}`;
  const metadataPath = (root: string, path: string) =>
    join(root, '.treenix', 'rawfs', `${createHash('sha256').update(path).digest('hex')}.json`);

  /** Resolve one address without allowing symlinks or hidden author files into this namespace. */
  async function address(root: string, path: string): Promise<string> {
    fsAddress(path);
    if (
      path
        .split('/')
        .slice(1)
        .some((part) => part.startsWith('.'))
    )
      throw new KernelError('FORBIDDEN', 'Hidden files are outside the raw filesystem namespace');
    let file = root;
    for (const part of path === '/' ? [] : path.slice(1).split('/')) {
      file = join(file, part);
      await assertPathSafe(root, file);
      try {
        if ((await lstat(file)).isSymbolicLink())
          throw new KernelError('FORBIDDEN', 'Raw filesystem symlinks are not allowed');
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    return file;
  }

  /** Retain native identity and attached components separately from Markdown's authored fields. */
  async function metadata(
    root: string,
    path: string,
    cost: Cost,
    budget: Budget,
  ): Promise<Body | undefined> {
    let source: string;
    try {
      source = await text(root, metadataPath(root, path), cost, budget);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    const value: unknown = safeJsonParse(source);
    if (!isRecord(value) || value.path !== path)
      throw new KernelError('INVALID', 'Raw filesystem metadata address differs');
    return body(value.node);
  }

  /** Encode the actual stored node; unsupported binary writes fail before journal publication. */
  async function prepare(root: string, write: StoredWrite) {
    const file = await address(root, write.path);
    let current;
    try {
      current = await lstat(file);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (write.node === null) return undefined;
    if (current !== undefined && current.isDirectory() !== (write.node.$type === 't.dir'))
      throw new KernelError('INVALID', 'Raw filesystem entry kind differs from its node');
    const { $path, $pos, $rev, $id, ...fields } = write.node;
    const persisted: Body = { ...fields, ...($id.startsWith('p:') ? {} : { $id }) };
    if (write.node.$type === 't.dir')
      return { node: write.node, metadata: JSON.stringify({ path: write.path, node: persisted }) };
    const mime = getMime(file),
      codec = codecs[mime];
    let content: string | undefined;
    const extra: Body = { ...persisted };
    if (mime === 'application/json') {
      content = `${JSON.stringify(persisted, null, 2)}\n`;
    } else if (codec !== undefined) {
      if (codec.type !== write.node.$type)
        throw new KernelError('INVALID', 'Raw file codec differs from its node type');
      content = await codec.encode(write.node, outer(write.path));
      for (const key of codec.fields) delete extra[key];
    } else {
      if (write.node.$type !== mime)
        throw new KernelError('INVALID', 'Raw file type differs from its extension');
      if (current === undefined || !current.isFile())
        throw new KernelError('INVALID', 'Raw file metadata requires an existing file');
    }
    return {
      node: write.node,
      content,
      metadata: JSON.stringify({ path: write.path, node: extra }),
    };
  }

  return {
    externalMetadata: ['.treenix/rawfs'],
    writeSafe: async (root, path) => {
      await address(root, path);
    },
    release: () => prepared.clear(),
    async preflight(commit) {
      prepared.clear();
      const cost = { nodes: 0, bytes: 0, exprWork: 0 };
      for (const write of commit.writes) {
        const result = await prepare(rootDirectory, write);
        cost.nodes++;
        cost.exprWork++;
        if (result !== undefined) {
          cost.bytes +=
            Buffer.byteLength(result.metadata) + Buffer.byteLength(result.content ?? '');
          prepared.set(write.path, result);
        }
        check(cost, commit.maintenanceLimits!.budget);
      }
      return cost;
    },
    async scan(root, pos, range, budget, quarantine) {
      const path =
        'node' in range ? range.node : 'children' in range ? range.children : range.subtree;
      const cost = { nodes: 0, bytes: 0, exprWork: 0 };
      const nodes: StoredNode[] = [],
        hashes = new Map<string, string>();
      const faults: import('#kernel/types').StorageFaultChange[] = [];

      /** Decode one charged physical entry, retaining codec-independent metadata. */
      async function entry(path: string): Promise<boolean> {
        cost.nodes++;
        cost.exprWork++;
        check(cost, budget);
        const file = await address(root, path),
          stat = await lstat(file);
        let fields: Body;
        try {
          const retained = await metadata(root, path, cost, budget);
          if (stat.isDirectory()) fields = retained ?? { $type: 't.dir' };
          else {
            const mime = getMime(file),
              codec = codecs[mime];
            if (mime === 'application/json')
              fields = body(decodeJsonBody(await text(root, file, cost, budget)));
            else if (codec !== undefined) {
              const decoded = await codec.decode(
                await text(root, file, cost, budget),
                path,
                outer(path),
              );
              const { $path: decodedPath, ...value } = decoded;
              if (decodedPath !== path)
                throw new KernelError('INVALID', 'Raw file codec changed its address');
              fields = body({ ...retained, ...value });
            } else
              fields = {
                ...retained,
                $type: mime,
                meta: {
                  size: stat.size,
                  modified: stat.mtime.toISOString(),
                  created: stat.birthtime.toISOString(),
                },
              };
          }
          const node = { ...fields, $path: path, $id: fields.$id ?? `p:${path}`, $pos: pos };
          nodes.push(node);
          hashes.set(path, createHash('sha256').update(stableJson(node)).digest('hex'));
        } catch (error) {
          if (
            !quarantine ||
            !(
              error instanceof SyntaxError ||
              (error instanceof KernelError && error.code === 'INVALID')
            )
          )
            throw error;
          faults.push({ path, fault: { code: 'INVALID', invalid: 'chain' } });
        }
        return stat.isDirectory();
      }

      /** Walk only the requested depth, charging enumeration even for excluded hidden files. */
      async function walk(path: string, deep: boolean): Promise<void> {
        const file = await address(root, path);
        for await (const child of await opendir(file, { bufferSize: 1 })) {
          cost.exprWork++;
          check(cost, budget);
          if (child.name.startsWith('.')) continue;
          const next = `${path === '/' ? '' : path}/${child.name}`;
          const directory = await entry(next);
          if (directory && deep) await walk(next, true);
        }
      }

      const file = await address(root, path);
      try {
        await lstat(file);
      } catch (error) {
        if (missing(error)) return { nodes, hashes, faults, cost };
        throw error;
      }
      if ('children' in range) await walk(path, false);
      else if ((await entry(path)) && 'subtree' in range) await walk(path, true);
      return { nodes, hashes, faults, cost };
    },
    async write(root, write) {
      const file = await address(root, write.path);
      const sidecar = metadataPath(root, write.path);
      if (write.node === null) {
        for (const target of [file, sidecar]) {
          await assertPathSafe(root, target);
          try {
            if ((await lstat(target)).isDirectory()) await rmdir(target);
            else await unlink(target);
            await syncDirectory(dirname(target));
          } catch (error) {
            if (!missing(error)) throw error;
          }
        }
        return;
      }
      const result = prepared.get(write.path) ?? (await prepare(root, write));
      if (result === undefined)
        throw new KernelError('INVALID', 'Raw file publication lacks its node');
      if (write.node.$type === 't.dir') await durableDirectory(file);
      else if (result.content !== undefined) await durableWrite(root, file, result.content);
      if (getMime(file) !== 'application/json' || write.node.$type === 't.dir')
        await durableWrite(root, sidecar, result.metadata);
      return stableJson(write.node);
    },
  };
}
