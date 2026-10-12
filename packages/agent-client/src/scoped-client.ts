import type { TwpClient } from '@treenx/core/client/twp';
import type {
  ChangeMember,
  IncludeSpec,
  Preconditions,
  Selector,
  SubSelector,
} from '@treenx/core/kernel/types';

/** Resolve SDK-relative addresses while preserving the explicit absolute-path escape hatch. */
export function agentPath(base: string, relative: string): string {
  if (relative.startsWith('/')) return relative;
  const suffix = relative.replace(/^\.\//, '').replace(/^\.?$/, '');
  return suffix ? `${base}/${suffix}` : base;
}

/** Translate native requests without replacing their lane, cache, cancellation, or operation keys. */
export function scopeAgentClient(client: TwpClient, base: string): TwpClient {
  const path = (relative: string) => agentPath(base, relative);

  function include(spec: IncludeSpec): IncludeSpec {
    if ('path' in spec) return { ...spec, path: path(spec.path) };
    return spec.then === undefined ? spec : { ...spec, then: spec.then.map(include) };
  }

  function selector(input: SubSelector): SubSelector;
  function selector(input: Selector): Selector;
  function selector(input: Selector): Selector {
    if ('history' in input) return { ...input, history: path(input.history) };
    const included = input.include === undefined ? {} : { include: input.include.map(include) };
    return 'node' in input
      ? { ...input, ...included, node: path(input.node) }
      : { ...input, ...included, children: path(input.children) };
  }

  function change(input: ChangeMember): ChangeMember {
    switch (input.op) {
      case 'put':
        return { ...input, node: { ...input.node, $path: path(input.node.$path) } };
      case 'patch':
      case 'remove':
        return { ...input, path: path(input.path) };
      case 'move':
      case 'adopt':
        return { ...input, from: path(input.from), to: path(input.to) };
      case 'restore':
      case 'undo':
        return input;
    }
  }

  function expect(input: Preconditions): Preconditions {
    return {
      ...input,
      ...(input.nodes === undefined
        ? {}
        : { nodes: input.nodes.map((node) => ({ ...node, path: path(node.path) })) }),
      ...(input.absent === undefined ? {} : { absent: input.absent.map(path) }),
      ...(input.selectors === undefined
        ? {}
        : {
            selectors: input.selectors.map((entry) => ({
              ...entry,
              selector: selector(entry.selector),
            })),
          }),
    };
  }

  return {
    ...client,
    read: (input, signal) => client.read(selector(input), signal),
    sub: (input, changed, refused) => client.sub(selector(input), changed, refused),
    act: (input, signal) => client.act({ ...input, path: path(input.path) }, signal),
    commit: (input, signal) =>
      client.commit(
        {
          ...input,
          changes: input.changes.map(change),
          ...(input.expect === undefined ? {} : { expect: expect(input.expect) }),
        },
        signal,
      ),
  };
}
