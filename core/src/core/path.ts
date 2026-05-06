// ── Path utils ──

export function dirname(path: string): string | null {
  if (path === '/') return null;
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return '/';
  return path.slice(0, idx);
}

export function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

export function join(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

export function isChildPath(parent: string, candidate: string, directOnly = true): boolean {
  if (candidate === parent) return false;
  // Must match parent + '/' to avoid /board matching /boards
  const prefix = parent === '/' ? '/' : parent + '/';
  if (!candidate.startsWith(prefix)) return false;
  if (directOnly) {
    const rest = candidate.slice(prefix.length);
    return rest.length > 0 && !rest.includes('/');
  }

  return true;
}

/** Check resolved filesystem path is inside root using segment boundary (not just startsWith) */
export function isInsideRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(root + '/');
}

/** Validate a tree path — rejects traversal, dot segments, trailing slash, double-slash, null bytes,
 *  backslash, percent-escaped sequences (paths are stored literally — no encoding layer). */
export function assertSafePath(path: string): void {
  if (!path.startsWith('/')) throw new Error(`Invalid path: must start with /: ${JSON.stringify(path)}`);
  if (path.includes('\0')) throw new Error(`Invalid path: null byte`);
  if (path.includes('\\')) throw new Error(`Invalid path: backslash at ${JSON.stringify(path)}`);
  if (/%[0-9a-f]{2}/i.test(path)) throw new Error(`Invalid path: percent-escape at ${JSON.stringify(path)}`);
  if (path.includes('//')) throw new Error(`Invalid path: double slash at ${JSON.stringify(path)}`);
  if (path !== '/' && path.endsWith('/')) throw new Error(`Invalid path: trailing slash at ${JSON.stringify(path)}`);
  const segments = path.split('/');
  for (const s of segments) {
    if (s === '..') throw new Error(`Invalid path: traversal`);
    if (s === '.') throw new Error(`Invalid path: dot segment at ${JSON.stringify(path)}`);
  }
}
