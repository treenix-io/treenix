// Instance backup/restore — physical, stop-the-world (core-gk8.9).
// The backup set is the FIXPOINT of the config: root.json declares fs/rawfs mounts,
// and nodes inside those dirs may declare further mounts — discovered fs/rawfs roots
// join the set, mongo/federation mounts are listed in the manifest as NOT covered.
// Unlike mods/backup (logical export, credentials stripped), this copies bytes
// faithfully: node files keep their connection URIs — treat artifacts as secrets.

import { assertValidType, isCompKey, safeJsonParse } from '#core';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { NS_VERSION, readDataVersion, VERSION_FILE } from '#tree/migrate-component-namespace';

export class BackupError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

export interface BackupDirEntry {
  /** Mount root as declared in config/node — resolved against CWD, like the server does. */
  root: string;
  kind: 'fs' | 'rawfs';
  /** Location inside the artifact (dirs/0, dirs/1, ...). */
  artifactPath: string;
  /** Parsed node files (fs) — rawfs dirs have 0. */
  nodes: number;
  /** Non-node files (version marker, rawfs content, leftovers). */
  files: number;
}

export interface ExternalMount {
  /** dirRoot:relPath of the node declaring the mount. */
  at: string;
  type: string;
  detail: string;
}

export interface BackupManifest {
  treenixBackup: 1;
  createdAt: string;
  engineVersion: string;
  /** Basename of the config file (root.json / root.clean.json) — restored under the same name. */
  rootConfig: string;
  /** Config path as given to backup (CWD-relative or absolute) — in-place restore targets it. */
  rootConfigPath: string;
  dirs: BackupDirEntry[];
  /** Mounts whose data lives elsewhere (mongo, federation) — NOT in this artifact. */
  external: ExternalMount[];
  warnings: string[];
}

type Log = (line: string) => void;

const MANIFEST = 'manifest.json';

// Mount components on a node body: the node-level $type plus every '#' component.
function mountsIn(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const candidates = [body, ...Object.keys(body).filter(isCompKey).map((k) => body[k])];
  const out: Array<Record<string, unknown>> = [];
  for (const v of candidates) {
    if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).$type === 'string'
      && ((v as Record<string, unknown>).$type as string).startsWith('t.mount.')) {
      out.push(v as Record<string, unknown>);
    }
  }
  return out;
}

// Host + db/collection only — never the URI (credentials stay in the data files).
function externalDetail(mount: Record<string, unknown>): string {
  if (mount.$type === 't.mount.mongo') return `db=${mount.db ?? 'treenix'} collection=${mount.collection ?? 'nodes'}`;
  if (typeof mount.url === 'string') {
    try {
      const u = new URL(mount.url);
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      return '<invalid-url>';
    }
  }
  return '';
}

interface DirJob { root: string; kind: 'fs' | 'rawfs' }

function classifyMount(mount: Record<string, unknown>, at: string, queue: DirJob[], external: ExternalMount[]): void {
  const type = mount.$type as string;
  if (type === 't.mount.fs' || type === 't.mount.rawfs') {
    if (typeof mount.root !== 'string' || !mount.root) throw new BackupError('BAD_MOUNT', `${at}: ${type} without root`);
    queue.push({ root: mount.root, kind: type === 't.mount.fs' ? 'fs' : 'rawfs' });
  } else if (type === 't.mount.mongo' || type === 't.mount.tree.trpc') {
    external.push({ at, type, detail: externalDetail(mount) });
  }
  // overlay/query/types/mods/memory: derived or volatile — nothing to copy
}

// Copy an fs-adapter dir byte-faithfully while validating every *.json with the
// real parser and collecting mounts declared by the copied nodes.
async function copyFsDir(
  src: string, dest: string, dirRoot: string,
  queue: DirJob[], external: ExternalMount[], warnings: string[],
): Promise<{ nodes: number; files: number }> {
  let nodes = 0;
  let files = 0;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) {
        warnings.push(`${full}: symlink skipped (fs adapter ignores symlinks)`);
        continue;
      }
      const destFull = join(dest, relative(src, full));

      if (e.isDirectory()) {
        await mkdir(destFull, { recursive: true });
        await walk(full);
      } else if (e.name.endsWith('.json')) {
        const raw = await readFile(full);
        const body = safeJsonParse(raw.toString('utf-8'));
        assertValidType(body.$type);
        for (const m of mountsIn(body)) classifyMount(m, `${dirRoot}:${relative(src, full)}`, queue, external);
        await mkdir(dirname(destFull), { recursive: true });
        await writeFile(destFull, raw);
        nodes++;
      } else {
        await mkdir(dirname(destFull), { recursive: true });
        await cp(full, destFull);
        files++;
      }
    }
  }

  await mkdir(dest, { recursive: true });
  await walk(src);
  return { nodes, files };
}

async function countDir(dir: string): Promise<{ nodes: number; files: number }> {
  let nodes = 0;
  let files = 0;
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.endsWith('.json')) nodes++;
    else files++;
  }
  return { nodes, files };
}

async function engineVersion(): Promise<string> {
  const pkg = safeJsonParse(await readFile(join(import.meta.dirname, '../../package.json'), 'utf-8'));
  return pkg.version;
}

export async function backupInstance(rootJsonPath: string, outParent: string, log: Log = console.log): Promise<{ artifactDir: string; manifest: BackupManifest }> {
  let configRaw: string;
  try {
    configRaw = await readFile(resolve(rootJsonPath), 'utf-8');
  } catch (e) {
    throw new BackupError('NO_CONFIG', `cannot read config ${rootJsonPath}: ${(e as Error).message}`);
  }
  const rootNode = safeJsonParse(configRaw);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await mkdir(resolve(outParent), { recursive: true });
  const artifactDir = await mkdtemp(resolve(outParent, `treenix-backup-${stamp}-`)); // exclusive artifact dir, never merge

  await writeFile(join(artifactDir, basename(rootJsonPath)), configRaw);

  const queue: DirJob[] = [];
  const external: ExternalMount[] = [];
  const warnings: string[] = [];
  for (const m of mountsIn(rootNode)) classifyMount(m, basename(rootJsonPath), queue, external);
  if (queue.length === 0) warnings.push('config declares no fs/rawfs mounts — artifact contains config only');

  const dirs: BackupDirEntry[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const job = queue.shift()!;
    const src = resolve(job.root);
    if (seen.has(src)) continue;
    seen.add(src);

    try {
      const s = await stat(src);
      if (!s.isDirectory()) throw new BackupError('BAD_MOUNT', `${job.root}: not a directory`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new BackupError('BAD_MOUNT', `${job.root}: mount dir does not exist (run from the server CWD)`);
      throw e;
    }

    const artifactPath = `dirs/${dirs.length}`;
    const dest = join(artifactDir, artifactPath);
    log(`[backup] ${job.kind} ${job.root} → ${artifactPath}`);

    if (job.kind === 'fs') {
      const { nodes, files } = await copyFsDir(src, dest, job.root, queue, external, warnings);
      dirs.push({ root: job.root, kind: 'fs', artifactPath, nodes, files });
    } else {
      await cp(src, dest, { recursive: true, verbatimSymlinks: true });
      const { nodes, files } = await countDir(dest);
      dirs.push({ root: job.root, kind: 'rawfs', artifactPath, nodes: 0, files: nodes + files });
    }
  }

  for (const x of external) log(`[backup] NOT covered: ${x.type} at ${x.at} (${x.detail}) — back up that store separately`);
  for (const w of warnings) log(`[backup] warning: ${w}`);

  // Manifest written LAST — its presence marks a complete backup; verify/restore refuse without it.
  const manifest: BackupManifest = {
    treenixBackup: 1,
    createdAt: new Date().toISOString(),
    engineVersion: await engineVersion(),
    rootConfig: basename(rootJsonPath),
    rootConfigPath: rootJsonPath,
    dirs,
    external,
    warnings,
  };
  await writeFile(join(artifactDir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');

  log(`[backup] done: ${artifactDir} (${dirs.length} dirs, ${dirs.reduce((n, d) => n + d.nodes, 0)} nodes)`);
  return { artifactDir, manifest };
}

async function readManifest(artifactDir: string): Promise<BackupManifest> {
  let raw: string;
  try {
    raw = await readFile(join(artifactDir, MANIFEST), 'utf-8');
  } catch {
    throw new BackupError('NOT_A_BACKUP', `${artifactDir}: no ${MANIFEST} — not a backup artifact or backup was interrupted`);
  }
  const m = safeJsonParse(raw);
  if (m.treenixBackup !== 1) throw new BackupError('NOT_A_BACKUP', `${artifactDir}: unsupported artifact format ${m.treenixBackup}`);
  return m as BackupManifest;
}

// Re-parse every node file in a dir tree with the real parser. Read-only.
async function verifyFsDir(dir: string): Promise<{ nodes: number; files: number }> {
  let nodes = 0;
  let files = 0;
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = join(e.parentPath, e.name);
    if (e.name.endsWith('.json')) {
      try {
        const body = safeJsonParse(await readFile(full, 'utf-8'));
        assertValidType(body.$type);
      } catch (err) {
        throw new BackupError('CORRUPT_NODE', `${full}: ${(err as Error).message}`);
      }
      nodes++;
    } else {
      files++;
    }
  }

  const v = await readDataVersion(dir);
  if (v > NS_VERSION) throw new BackupError('VERSION_AHEAD', `${dir}: ${VERSION_FILE} is ${v}, this engine supports ${NS_VERSION} — upgrade the engine before restoring`);
  return { nodes, files };
}

export async function verifyArtifact(artifactDir: string, log: Log = console.log): Promise<BackupManifest> {
  const manifest = await readManifest(artifactDir);

  for (const d of manifest.dirs) {
    const dir = join(artifactDir, d.artifactPath);
    if (d.kind === 'fs') {
      const { nodes, files } = await verifyFsDir(dir);
      if (nodes !== d.nodes || files !== d.files) {
        throw new BackupError('COUNT_MISMATCH', `${dir}: manifest says ${d.nodes} nodes/${d.files} files, found ${nodes}/${files}`);
      }
    } else {
      const { nodes, files } = await countDir(dir);
      if (nodes + files !== d.files) throw new BackupError('COUNT_MISMATCH', `${dir}: manifest says ${d.files} files, found ${nodes + files}`);
    }
    log(`[verify] ok: ${d.kind} ${d.root} (${d.nodes} nodes, ${d.files} files)`);
  }

  return manifest;
}

export interface RestoreOpts {
  /** Target base for relative mount roots and the config file. Default: CWD. */
  into?: string;
  /** Move existing non-empty targets aside to <dir>.pre-restore-<ts> instead of refusing. */
  replace?: boolean;
}

export async function restoreArtifact(artifactDir: string, opts: RestoreOpts = {}, log: Log = console.log): Promise<BackupManifest> {
  const manifest = await verifyArtifact(artifactDir, () => {});
  const base = resolve(opts.into ?? '.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  // Plan all targets before touching anything — refuse-or-move decisions are made up front.
  const targets: Array<{ src: string; dest: string }> = [];
  for (const d of manifest.dirs) {
    if (opts.into && d.root.startsWith('/')) {
      throw new BackupError('ABSOLUTE_ROOT', `${d.root}: absolute mount root cannot be redirected with --into — restore in place`);
    }
    targets.push({ src: join(artifactDir, d.artifactPath), dest: resolve(base, d.root) });
  }

  for (const t of targets) {
    let occupied = false;
    try {
      occupied = (await readdir(t.dest)).length > 0;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (!occupied) continue;
    if (!opts.replace) throw new BackupError('TARGET_NOT_EMPTY', `${t.dest}: target dir is not empty — pass --replace to move it aside`);
    const aside = `${t.dest}.pre-restore-${stamp}`;
    log(`[restore] moving existing ${t.dest} → ${aside}`);
    await rename(t.dest, aside);
  }

  for (const t of targets) {
    log(`[restore] ${t.src} → ${t.dest}`);
    await cp(t.src, t.dest, { recursive: true, verbatimSymlinks: true });
  }

  const configTarget = opts.into ? join(base, manifest.rootConfig) : resolve(manifest.rootConfigPath);
  const configSrc = join(artifactDir, manifest.rootConfig);
  let existing: string | undefined;
  try {
    existing = await readFile(configTarget, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (existing === undefined) {
    await cp(configSrc, configTarget);
    log(`[restore] config → ${configTarget}`);
  } else if (existing !== await readFile(configSrc, 'utf-8')) {
    log(`[restore] WARNING: ${configTarget} differs from the artifact's config — kept the existing file, artifact copy at ${configSrc}`);
  }

  // Coherence check on the RESTORED data — proves the server will read what we wrote.
  for (const d of manifest.dirs) {
    if (d.kind !== 'fs') continue;
    const { nodes, files } = await verifyFsDir(resolve(base, d.root));
    if (nodes !== d.nodes || files !== d.files) {
      throw new BackupError('COUNT_MISMATCH', `${resolve(base, d.root)}: restored ${nodes} nodes/${files} files, expected ${d.nodes}/${d.files}`);
    }
  }

  for (const x of manifest.external) log(`[restore] NOT restored: ${x.type} at ${x.at} (${x.detail}) — restore that store separately`);
  log(`[restore] done: ${manifest.dirs.length} dirs verified`);
  return manifest;
}
