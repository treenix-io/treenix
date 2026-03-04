// Treenity Prefab Deploy — Layer 4
// Source path addresses prefab in tree (/sys/mods/{mod}/prefabs/{name}).
// Actual data comes from in-memory registry (functions can't live in tree).

import { type NodeData } from '#core';
import { getPrefab, getSeedPrefabs, type PrefabEntry } from '#mod/prefab';
import { type Tree } from '#tree';
import { OpError } from './errors';

export type DeployOpts = {
  allowAbsolute?: boolean;
  params?: unknown;
};

// /sys/mods/{mod}/prefabs/{name} → [mod, name]
function parseSourcePath(source: string): [string, string] | null {
  const m = source.match(/\/sys\/mods\/([^/]+)\/prefabs\/([^/]+)$/);
  return m ? [m[1], m[2]] : null;
}

function resolvePath(nodePath: string, target: string): string {
  if (nodePath === '.') return target;
  if (nodePath.startsWith('/')) return nodePath;
  return target === '/' ? `/${nodePath}` : `${target}/${nodePath}`;
}

/** Core deploy loop — shared by deployPrefab and deployByKey */
async function deployNodes(
  store: Tree,
  prefab: PrefabEntry,
  target: string,
  opts?: DeployOpts,
): Promise<{ deployed: number; skipped: number }> {
  let nodes = prefab.nodes;
  if (prefab.setup) {
    nodes = await prefab.setup([...nodes], opts?.params);
  }

  let deployed = 0;
  let skipped = 0;

  for (const node of nodes) {
    const isAbsolute = node.$path.startsWith('/');

    if (isAbsolute && !opts?.allowAbsolute) {
      throw new OpError('BAD_REQUEST', `Absolute path "${node.$path}" not allowed without allowAbsolute`);
    }

    const resolvedPath = resolvePath(node.$path, target);

    // Idempotent: skip if exists
    if (await store.get(resolvedPath)) {
      skipped++;
      continue;
    }

    const { $rev, $path, ...rest } = node;
    await store.set({ ...rest, $path: resolvedPath } as NodeData);
    deployed++;
  }

  return { deployed, skipped };
}

/** Deploy prefab by source path (/sys/mods/{mod}/prefabs/{name}) */
export async function deployPrefab(
  store: Tree,
  source: string,
  target: string,
  opts?: DeployOpts,
): Promise<{ deployed: number; skipped: number }> {
  const parsed = parseSourcePath(source);
  if (!parsed) throw new OpError('BAD_REQUEST', `Invalid prefab path: ${source}`);

  const prefab = getPrefab(parsed[0], parsed[1]);
  if (!prefab) throw new OpError('NOT_FOUND', `Prefab not found: ${source}`);

  return deployNodes(store, prefab, target, opts);
}

/** Deploy prefab by mod+name directly (no path parsing) */
export async function deployByKey(
  store: Tree,
  mod: string,
  name: string,
  target: string,
  opts?: DeployOpts,
): Promise<{ deployed: number; skipped: number }> {
  const prefab = getPrefab(mod, name);
  if (!prefab) throw new OpError('NOT_FOUND', `Prefab not found: ${mod}/${name}`);

  return deployNodes(store, prefab, target, opts);
}

/** Deploy all seed prefabs. Respects TENANT env (only core-tier seeds). */
export async function deploySeedPrefabs(store: Tree): Promise<void> {
  const isTenant = !!process.env.TENANT;
  const seeds = getSeedPrefabs();

  for (const [mod, prefab] of seeds) {
    if (isTenant && prefab.meta?.tier !== 'core') continue;
    await deployNodes(store, prefab, '/', { allowAbsolute: true, params: { store } });
  }
}
