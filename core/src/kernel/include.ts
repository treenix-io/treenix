import { assertSafePath } from '#core/path';
import { KernelError } from '#errors';
import { getByPath } from '#kernel/update-ops';
import type { IncludeSpec, Path } from '#kernel/types';

/** Reject paths that cannot be used as reader selectors. */
export function assertReadPath(value: Path): void {
  try {
    assertSafePath(value);
  } catch (error) {
    console.error(error);
    throw new KernelError('INVALID', 'Invalid selector path');
  }
}

/** Reject include graphs that exceed the caller's traversal budget. */
export function assertIncludeDepth(
  include: readonly IncludeSpec[] | undefined,
  limit: number,
): void {
  const pending = [...(include ?? [])].map((spec) => ({ spec, depth: 1 }));
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (item.depth > limit) throw new KernelError('BUDGET', 'Include depth exceeded');
    if ('path' in item.spec) assertReadPath(item.spec.path);
    else {
      if (item.spec.ref.length === 0)
        throw new KernelError('INVALID', 'Include needs a reference field');
      for (const spec of item.spec.then ?? []) pending.push({ spec, depth: item.depth + 1 });
    }
  }
}

/** Resolve a projected reference field while enforcing the path boundary. */
function reference(node: Readonly<Record<string, unknown>>, field: string): Path | undefined {
  const value = getByPath(node, field);
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    assertReadPath(value);
    return value;
  }
  if (typeof value === 'object' && '$ref' in value && typeof value.$ref === 'string') {
    assertReadPath(value.$ref);
    return value.$ref;
  }
  throw new KernelError('INVALID', 'Include field does not contain a reference');
}

/** Follow projected references; absent and unreadable targets still pass through the owning reader. */
export async function followIncludes<
  T extends { readonly visible: Readonly<Record<string, unknown>> },
>(
  base: T | undefined,
  specs: readonly IncludeSpec[],
  read: (path: Path) => Promise<T | null>,
  accept: (value: T) => void,
  check: () => void,
): Promise<void> {
  for (const spec of specs) {
    check();
    const path =
      'path' in spec
        ? spec.path
        : base === undefined
          ? undefined
          : reference(base.visible, spec.ref);
    if (path === undefined) continue;
    const value = await read(path);
    if (value === null) continue;
    accept(value);
    if ('ref' in spec && spec.then !== undefined)
      await followIncludes(value, spec.then, read, accept, check);
  }
}
