import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { durableWrite, syncDirectory } from '#kernel/store/fs-io';

import {
  planKernelUpgrade,
  upgradeObject,
  type UpgradeDocument,
  type UpgradeOptions,
  type UpgradePlan,
} from '#tools/upgrade-kernel-plan';

export interface UpgradeFile {
  readonly name: string;
  readonly hash: string;
  readonly bytes: number;
  readonly path?: string;
}

export interface FsUpgradePlan {
  readonly root: string;
  readonly files: readonly UpgradeFile[];
  readonly conversion: UpgradePlan;
  readonly completed?: true;
}

export interface UpgradeBounds {
  readonly files: number;
  readonly bytes: number;
}

const hash = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');

/** The component-namespace prerequisite remains distinct from completed native-data conversion. */
export async function fsUpgradeVersion(root: string): Promise<1 | 2> {
  const entry = await lstat(root);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('INVALID_SOURCE_ROOT');
  const version = (await readFile(join(root, '.treenix-version'), 'utf8')).trim();
  if (version !== '1') throw new Error('REQUIRES_DATA_VERSION_1');
  try {
    const upgraded = (await readFile(join(root, '.treenix-kernel-version'), 'utf8')).trim();
    if (upgraded !== '2') throw new Error('INVALID_KERNEL_DATA_VERSION');
    return 2;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    return 1;
  }
}

/** A concurrent growing file must not allocate beyond the admitted byte allowance. */
async function readBounded(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    if ((await handle.stat()).size > limit) throw new Error('BUDGET');
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit - bytes + 1));
      const result = await handle.read(chunk);
      if (result.bytesRead === 0) return Buffer.concat(chunks, bytes);
      bytes += result.bytesRead;
      if (bytes > limit) throw new Error('BUDGET');
      chunks.push(chunk.subarray(0, result.bytesRead));
    }
  } finally {
    await handle.close();
  }
}

/** Refuse inaccessible input before reading or copying any of its bytes. */
function allowed(name: string): void {
  if (name.startsWith('.env') || ['secrets', 'old'].includes(name))
    throw new Error('DENIED_SOURCE_PATH');
}

/** Match the physical file address used by the filesystem node owner. */
function nodePath(name: string): string | undefined {
  if (!name.endsWith('.json')) return undefined;
  const parts = name.split('/');
  if (parts.includes('.treenix') || parts.includes('.git')) return undefined;
  if (parts.at(-1) === '$.json') parts.pop();
  else parts[parts.length - 1] = parts[parts.length - 1].slice(0, -5);
  return `/${parts.join('/')}`;
}

/** Inventory explicit offline input with a finite byte/file allowance and no symlink traversal. */
export async function planFsUpgrade(
  root: string,
  options: UpgradeOptions,
  bounds: UpgradeBounds,
): Promise<FsUpgradePlan> {
  root = resolve(root);
  if ((await fsUpgradeVersion(root)) === 2) {
    return {
      root,
      files: [],
      completed: true,
      conversion: { version: 2, documents: [], retired: [], findings: [], inputHash: '' },
    };
  }
  const files: UpgradeFile[] = [];
  const documents: UpgradeDocument[] = [];
  let bytes = 0;

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      allowed(entry.name);
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('SYMLINK_SOURCE');
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        if (files.length >= bounds.files) throw new Error('BUDGET');
        const body = await readBounded(file, bounds.bytes - bytes);
        bytes += body.length;
        const name = relative(root, file).split('\\').join('/');
        const path = nodePath(name);
        files.push({
          name,
          hash: hash(body),
          bytes: body.length,
          ...(path === undefined ? {} : { path }),
        });
        if (path !== undefined)
          documents.push({ path, body: upgradeObject(JSON.parse(body.toString('utf8'))) });
      } else throw new Error('UNSUPPORTED_SOURCE_ENTRY');
    }
  }
  await walk(root);
  return { root, files, conversion: planKernelUpgrade(documents, options) };
}

/** Write an exclusive durable artifact without replacing an earlier backup or plan. */
async function exclusive(file: string, body: Buffer | string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(file));
}

/** Preserve all inventoried bytes; a changed source refuses the backup before apply becomes available. */
export async function backupFsUpgrade(plan: FsUpgradePlan, backup: string): Promise<void> {
  if (plan.completed) throw new Error('UPGRADE_ALREADY_COMPLETED');
  backup = resolve(backup);
  if (backup === plan.root || backup.startsWith(`${plan.root}/`))
    throw new Error('BACKUP_INSIDE_SOURCE');
  await mkdir(backup, { recursive: false });
  for (const file of plan.files) {
    const body = await readBounded(join(plan.root, file.name), file.bytes);
    if (hash(body) !== file.hash) throw new Error('SOURCE_CHANGED');
    await exclusive(join(backup, 'files', file.name), body);
  }
  await exclusive(join(backup, 'plan.json'), JSON.stringify(plan));
}

/** Resume the exact backed-up conversion; unrelated edits refuse, and the version advances last. */
export async function applyFsUpgrade(plan: FsUpgradePlan, backup: string): Promise<void> {
  const recorded = await readFile(join(backup, 'plan.json'), 'utf8');
  if (recorded !== JSON.stringify(plan)) throw new Error('BACKUP_PLAN_CHANGED');
  if (plan.conversion.findings.some((finding) => finding.severity === 'error'))
    throw new Error('UNRESOLVED_UPGRADE');
  const documents = new Map(
    plan.conversion.documents.map((document) => [document.path, document.body]),
  );
  const retired = new Set(plan.conversion.retired);
  for (const file of plan.files) {
    const source = join(plan.root, file.name);
    const saved = await readBounded(join(backup, 'files', file.name), file.bytes);
    if (hash(saved) !== file.hash) throw new Error('BACKUP_CHANGED');
    const body = file.path === undefined ? undefined : documents.get(file.path);
    if (file.path !== undefined && retired.has(file.path)) {
      const destination = join(backup, 'retired', file.name);
      try {
        const current = await readFile(source);
        if (hash(current) !== file.hash) throw new Error('SOURCE_CHANGED');
        await mkdir(dirname(destination), { recursive: true });
        try {
          await readFile(destination);
          throw new Error('RETIRED_TARGET_OCCUPIED');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        await rename(source, destination);
        await syncDirectory(dirname(source));
        await syncDirectory(dirname(destination));
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        if (hash(await readFile(destination)) !== file.hash)
          throw new Error('RETIRED_SOURCE_CHANGED');
      }
      continue;
    }
    if (file.path !== undefined && body === undefined) throw new Error('INCOMPLETE_PLAN');
    const after = body === undefined ? saved : Buffer.from(`${JSON.stringify(body, null, 2)}\n`);
    const current = hash(await readBounded(source, Math.max(file.bytes, after.length)));
    if (current === hash(after)) continue;
    if (current !== file.hash) throw new Error('SOURCE_CHANGED');
    if (body === undefined) continue;
    await durableWrite(plan.root, source, after);
  }
  const originals = new Set(
    plan.files.flatMap((file) => (file.path === undefined ? [] : [file.path])),
  );
  for (const document of plan.conversion.documents) {
    if (originals.has(document.path)) continue;
    const source = join(plan.root, document.path.slice(1), '$.json');
    const after = Buffer.from(`${JSON.stringify(document.body, null, 2)}\n`);
    try {
      const existing = await readFile(source);
      if (hash(existing) !== hash(after)) throw new Error('NEW_TARGET_OCCUPIED');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      await durableWrite(plan.root, source, after);
    }
  }
  await durableWrite(plan.root, join(plan.root, '.treenix-kernel-version'), '2\n');
}
