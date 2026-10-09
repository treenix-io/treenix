import { assertSafePath } from '#core/path'
import { KernelError } from '#errors'
import type { createReader } from '#kernel/reader'
import type { ActionDef, IncludeSpec, Limits, Path, ReadResult, SubSelector } from '#kernel/types'

export interface ResolvedActionNeeds {
  readonly needs: Readonly<Record<string, ReadResult>>
  readonly targets: Readonly<Record<string, readonly Path[]>>
}

function relative(base: Path, value: Path): Path {
  let path = value
  if (!value.startsWith('/')) {
    const segments = base === '/' ? [] : base.slice(1).split('/')
    for (const segment of value.split('/')) {
      if (segment === '.') continue
      if (segment === '..') {
        if (segments.length === 0) throw new KernelError('INVALID', 'A need traverses above the root')
        segments.pop()
      } else segments.push(segment)
    }
    path = '/' + segments.join('/')
  }
  try { assertSafePath(path) } catch (error) {
    console.error(error)
    throw new KernelError('INVALID', 'Invalid action need path')
  }
  return path
}

function includes(base: Path, specs: readonly IncludeSpec[], limit: number, depth = 1): readonly IncludeSpec[] {
  if (depth > limit && specs.length !== 0) throw new KernelError('BUDGET', 'Include depth exceeded')
  return specs.map(spec => 'path' in spec ? { path: relative(base, spec.path) }
    : { ref: spec.ref, ...(spec.then === undefined ? {} : { then: includes(base, spec.then, limit, depth + 1) }) })
}

/** Resolve declared reads and the paths available to post operations. */
export async function resolveActionNeeds(
  needs: ActionDef['needs'],
  base: Path,
  reader: ReturnType<typeof createReader>,
  limits: Limits,
): Promise<ResolvedActionNeeds> {
  const results: (readonly [string, ReadResult])[] = [],
    targets: (readonly [string, readonly Path[]])[] = [];
  for (const [name, input] of Object.entries(needs ?? {})) {
    if ('history' in input) {
      results.push([name, await reader.read({ ...input, history: relative(base, input.history) })]);
      continue;
    }
    const include =
      input.include === undefined ? undefined : includes(base, input.include, limits.includeDepth);
    const selector: SubSelector =
      'node' in input
        ? { ...input, node: relative(base, input.node), include }
        : { ...input, children: relative(base, input.children), include };
    const result = await reader.read(selector);
    const copies = new Map(
      result.copies.map((copy) => ['node' in copy ? copy.node.$id : copy.id, copy]),
    );
    const paths = result.list.map((id) => {
      const copy = copies.get(id)!;
      if (!('node' in copy)) throw copy.error;
      return copy.node.$path;
    });
    results.push([name, result]);
    targets.push([name, paths]);
  }
  return { needs: Object.fromEntries(results), targets: Object.fromEntries(targets) };
}
