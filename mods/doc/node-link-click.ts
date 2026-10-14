type ClosestCapable = {
  closest?: (selector: string) => {
    getAttribute?: (name: string) => string | null;
    dataset?: Record<string, string | undefined>;
  } | null;
};

export function getNodeLinkPath(target: EventTarget | ClosestCapable | null): string | null {
  if (
    !target ||
    typeof target !== 'object' ||
    typeof (target as ClosestCapable).closest !== 'function'
  ) {
    return null;
  }

  const link = (target as ClosestCapable).closest?.('a[data-node-path]');
  if (!link) return null;

  return link.getAttribute?.('data-node-path') ?? link.dataset?.nodePath ?? null;
}

export function buildNodeLinkHref(path: string, pathname: string, search = ''): string {
  if (pathname.startsWith('/t')) return `/t${path}${search}`;
  if (pathname === '/v' || pathname.startsWith('/v/')) return `/v${path}`;
  return path;
}
