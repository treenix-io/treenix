// Treenix Prefab Deploy — Layer 4
// Source path addresses prefab in tree (/sys/mods/{mod}/prefabs/{name}).
// Actual data comes from in-memory registry (functions can't live in tree).

import { type NodeData } from '#core';
import { getPrefab, getSeedPrefabs, type PrefabEntry } from '#mod/prefab';
import { type Tree } from '#tree';
import { OpError } from '#errors';

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
  tree: Tree,
  prefab: PrefabEntry,
  target: string,
  opts?: DeployOpts,
): Promise<{ deployed: string[]; skipped: string[] }> {
  let nodes = prefab.nodes;
  if (prefab.setup) {
    nodes = await prefab.setup([...nodes], opts?.params);
  }

  const deployed: string[] = [];
  const skipped: string[] = [];

  for (const node of nodes) {
    const isAbsolute = node.$path.startsWith('/');

    if (isAbsolute && !opts?.allowAbsolute) {
      throw new OpError('BAD_REQUEST', `Absolute path "${node.$path}" not allowed without allowAbsolute`);
    }

    const resolvedPath = resolvePath(node.$path, target);

    // Idempotent: skip if exists
    if (await tree.get(resolvedPath)) {
      skipped.push(resolvedPath);
      continue;
    }

    const { $rev, $path, ...rest } = node;
    await tree.set({ ...rest, $path: resolvedPath } as NodeData);
    deployed.push(resolvedPath);
  }

  return { deployed, skipped };
}

/** Deploy prefab by source path (/sys/mods/{mod}/prefabs/{name}) */
export async function deployPrefab(
  tree: Tree,
  source: string,
  target: string,
  opts?: DeployOpts,
): Promise<{ deployed: string[]; skipped: string[] }> {
  const parsed = parseSourcePath(source);
  if (!parsed) throw new OpError('BAD_REQUEST', `Invalid prefab path: ${source}`);

  const prefab = getPrefab(parsed[0], parsed[1]);
  if (!prefab) throw new OpError('NOT_FOUND', `Prefab not found: ${source}`);

  return deployNodes(tree, prefab, target, opts);
}

/** Deploy prefab by mod+name directly (no path parsing) */
export async function deployByKey(
  tree: Tree,
  mod: string,
  name: string,
  target: string,
  opts?: DeployOpts,
): Promise<{ deployed: string[]; skipped: string[] }> {
  const prefab = getPrefab(mod, name);
  if (!prefab) throw new OpError('NOT_FOUND', `Prefab not found: ${mod}/${name}`);

  return deployNodes(tree, prefab, target, opts);
}

/** Deploy seed prefabs. If filter provided, only deploy seeds whose mod is in the list. */
export async function deploySeedPrefabs(tree: Tree, filter?: string[]): Promise<void> {
  const isTenant = !!process.env.TENANT;
  const seeds = getSeedPrefabs();

  for (const [mod, prefab] of seeds) {
    const explicit = filter?.includes(mod);
    if (filter && !explicit) continue;
    // Tenant mode: only deploy core-tier seeds, unless explicitly listed in config
    if (isTenant && !explicit && prefab.meta?.tier !== 'core') continue;
    const result = await deployNodes(tree, prefab, '/', { allowAbsolute: true, params: { tree } });
    if (result.deployed.length > 0) {
      const parts = [`deployed ${result.deployed.length} — ${result.deployed.join(', ')}`];
      if (result.skipped.length > 0) parts.push(`skipped ${result.skipped.length} — ${result.skipped.join(', ')}`);
      console.log(`[seed] ${mod}: ${parts.join(' | ')}`);
    }
  }
}
