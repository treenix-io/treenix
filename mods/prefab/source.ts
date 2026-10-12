import type { NodeInput } from '@treenx/core/kernel/types';
import { prefabInput, resolvePrefabPath } from '@treenx/core/mod/prefab-path';
import {
  SOURCE_TYPE,
  sourceBody,
  translatedFields,
  type PrefabNode,
  type PrefabState,
  type ReferenceMap,
} from '#prefab/data';

/** Keep relative and explicitly absolute template addresses distinct in the source tree. */
export function sourcePath(catalog: string, path: string): string {
  const root = `${catalog}/source/${path.startsWith('/') ? 'absolute' : 'relative'}`;
  return path === '.' || path === '/' ? root : `${root}/${path.replace(/^\//, '')}`;
}

/** Map both source branches into the original deployment address space. */
export function sourceMaps(catalog: string, target: string): readonly ReferenceMap[] {
  return [
    { from: `${catalog}/source/relative`, to: target },
    { from: `${catalog}/source/absolute`, to: '/' },
  ];
}

/** Build an instance from accepted source data and retain its translated per-field base. */
export function prefabCopy(
  source: PrefabNode,
  path: string,
  state: Omit<PrefabState, 'src' | 'base'>,
): NodeInput {
  const body = sourceBody(source);
  const base = translatedFields(body, state.sourceRoot, state.targetRoot, state.maps);
  return { ...prefabInput(body, path), ...base, $prefab: { ...state, src: source.$path, base } };
}

/** Materialize each declaration as inert data and redirect its internal references to source records. */
export function sourceRecords(catalog: string, nodes: readonly NodeInput[]): readonly NodeInput[] {
  const records = new Map<string, NodeInput>();
  const links = nodes.map((node) => ({
    from: resolvePrefabPath(node.$path, '/', true),
    to: sourcePath(catalog, node.$path),
    exact: true,
  }));
  records.set(`${catalog}/source`, { $path: `${catalog}/source`, $type: 't.dir' });

  for (const node of nodes) {
    const path = sourcePath(catalog, node.$path);
    const previous = records.get(path);
    if (previous !== undefined && previous.implicit !== true) continue;
    const data = translatedFields(node, '/', '/', links);
    records.set(path, {
      $path: path,
      $type: SOURCE_TYPE,
      body: { ...prefabInput(node, node.$path), ...data },
    });
    const branch = `${catalog}/source/${node.$path.startsWith('/') ? 'absolute' : 'relative'}`;
    let parent = path.slice(0, path.lastIndexOf('/'));
    while (parent.length >= branch.length) {
      if (!records.has(parent)) {
        const suffix = parent.slice(branch.length);
        const rawPath = node.$path.startsWith('/') ? suffix || '/' : suffix.slice(1) || '.';
        records.set(parent, {
          $path: parent,
          $type: SOURCE_TYPE,
          implicit: true,
          body: { $path: rawPath, $type: 't.dir' },
        });
      }
      parent = parent.slice(0, parent.lastIndexOf('/'));
    }
  }

  return [...records.values()].sort(
    (left, right) => left.$path.split('/').length - right.$path.split('/').length,
  );
}

/** Replace source fields inside their inert record, preserving the record's identity and template path. */
export function updatedSource(source: PrefabNode, data: Record<string, unknown>): NodeInput {
  const body = sourceBody(source);
  const input = {
    $path: body.$path,
    $type: body.$type,
    ...(body.$v === undefined ? {} : { $v: body.$v }),
    ...data,
    ...(body.$prefab === undefined ? {} : { $prefab: body.$prefab }),
  };
  return source.$type === SOURCE_TYPE
    ? { ...prefabInput(source, source.$path), body: input }
    : input;
}
