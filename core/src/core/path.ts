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
  if (!candidate.startsWith(parent) || candidate === parent) return false;
  if (directOnly) {
    const rest = parent === '/' ? candidate.slice(1) : candidate.slice(parent.length + 1);
    return !rest.includes('/');
  }

  return true;
}

/** Validate a tree path — rejects traversal, double-slash, null bytes */
export function assertSafePath(path: string): void {
  if (!path.startsWith('/')) throw new Error(`Invalid path: must start with /`);
  if (path.includes('\0')) throw new Error(`Invalid path: null byte`);
  if (path.includes('//')) throw new Error(`Invalid path: double slash`);
  if (path.split('/').some(s => s === '..')) throw new Error(`Invalid path: traversal`);
}
