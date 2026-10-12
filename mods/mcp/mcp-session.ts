import { randomUUID } from 'node:crypto';
import { isRef } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import type { ChangeMember, CommitRequest, IncludeSpec, Node, OpId, Preconditions, ReadResult, Selector, Session } from '@treenx/core/kernel/types';
import type { NativeMcpCoordinates, NativeMcpToolInputs } from '#mcp/native-types';

/** Consume the binding's lane so native mutation outcomes retain delivery ordering. */
export async function createMcpSession(session: Session, systemPath = '/sys/mcp/catalog', coordinates: NativeMcpCoordinates = {}) {
  const branch = coordinates.branchPath;
  if (branch !== undefined) {
    const copy = (await session.read({ node: branch })).copies[0];
    if ('error' in copy) throw copy.error;
    if (copy.node.$type !== 't.branch') throw new KernelError('INVALID', 'MCP branch coordinates require a readable branch declaration');
  }
  const view = branch === undefined ? undefined : `${branch}/tree`;

  function actual(path: string): string {
    if (view === undefined) return path;
    if (path === '/.branch') return branch!;
    if (path.startsWith('/.branch/')) throw new KernelError('INVALID', 'The branch control window has no child namespace');
    return `${view}${path === '/' ? '' : path}`;
  }

  function presented(path: string): string {
    if (view === undefined) return path;
    if (path === branch) return '/.branch';
    if (path === view) return '/';
    return path.startsWith(`${view}/`) ? path.slice(view.length) : path;
  }

  function refs(value: unknown, map: (path: string) => string): void {
    if (value === null || typeof value !== 'object') return;
    if (isRef(value)) value.$ref = map(value.$ref);
    for (const child of Object.values(value)) refs(child, map);
  }

  function node<T extends Node>(value: T): T {
    const copy = structuredClone(value);
    refs(copy, presented);
    return { ...copy, $path: presented(copy.$path) };
  }

  function result(value: ReadResult): ReadResult {
    if (view === undefined) return value;
    return { ...value, copies: value.copies.map(copy => 'node' in copy
      ? { ...copy, node: node(copy.node) } : { ...copy, path: presented(copy.path) }),
      ...(value.viewOwner === undefined ? {} : { viewOwner: { ...value.viewOwner, path: presented(value.viewOwner.path) } }),
      ...(value.computed === undefined ? {} : { computed: value.computed.map(item => node(item)) }),
      ...(value.viewErrors === undefined ? {} : { viewErrors: value.viewErrors.map(item => ({ ...item, path: presented(item.path) })) }),
      ...(value.history === undefined ? {} : { history: value.history.map(item => ({ ...item, path: presented(item.path),
        before: item.before === null || item.before === 'unknown' ? item.before : node(item.before),
        after: item.after === null ? null : node(item.after) })) }) };
  }

  function include(value: IncludeSpec): IncludeSpec {
    return 'path' in value ? { path: actual(value.path) } : { ...value,
      ...(value.then === undefined ? {} : { then: value.then.map(include) }) };
  }

  function selector(value: Selector): Selector {
    if ('history' in value) return { ...value, history: actual(value.history) };
    const selected = 'node' in value ? { ...value, node: actual(value.node) } : { ...value, children: actual(value.children) };
    return { ...selected, ...(value.include === undefined ? {} : { include: value.include.map(include) }) };
  }

  function expect(value: Preconditions | undefined): Preconditions | undefined {
    if (value === undefined || view === undefined) return value;
    return { ...value, ...(value.nodes === undefined ? {} : { nodes: value.nodes.map(item => ({ ...item, path: actual(item.path) })) }),
      ...(value.absent === undefined ? {} : { absent: value.absent.map(actual) }),
      ...(value.selectors === undefined ? {} : { selectors: value.selectors.map(item => ({ ...item, selector: selector(item.selector) })) }) };
  }

  function change(value: ChangeMember): ChangeMember {
    if (view === undefined) return value;
    if (value.op === 'restore' || value.op === 'undo') return value;
    if (value.op === 'move' || value.op === 'adopt') return { ...value, from: actual(value.from), to: actual(value.to) };
    if (value.op === 'put') {
      const copy = structuredClone(value.node);
      refs(copy, actual);
      return { ...value, node: { ...copy, $path: actual(copy.$path) } };
    }
    if (value.op === 'patch') {
      const ops = structuredClone(value.ops);
      refs(ops, actual);
      return { ...value, path: actual(value.path), ops };
    }
    return { ...value, path: actual(value.path) };
  }
  const lane = session.lane[Symbol.asyncIterator]();
  const first = await lane.next();
  if (first.done || first.value.t !== 'welcome') throw new KernelError('UNAVAILABLE', 'MCP session has no welcome');
  let intake = first.value.intake;

  const done = (async () => {
    for (;;) {
      const frame = await lane.next();
      if (frame.done) return;
      if (frame.value.t === 'pos' && frame.value.coverage !== true && frame.value.intake !== undefined) intake = frame.value.intake;
    }
  })();

  // The HTTP owner cancels its lane when the response ends. Other failures remain loud.
  void done.catch(error => {
    if (error instanceof KernelError && (error.code === 'CANCELLED' || error.code === 'UNAUTHENTICATED')) return;
    console.error(error);
  });

  function key(): OpId {
    return { epoch: intake, time: Date.now(), nonce: randomUUID() };
  }

  /** Consume streamed action pieces so an MCP call can return its final outcome. */
  async function execute(input: NativeMcpToolInputs['execute']) {
    const pending = session.act({ ...input, path: actual(input.path), opId: input.opId ?? key() });
    for await (const _piece of pending.chunks) {}
    return pending.outcome;
  }

  return {
    done,
    async get_node(input: NativeMcpToolInputs['get_node']) {
      return result(await session.read({ node: actual(input.path) }));
    },
    async list_children(input: NativeMcpToolInputs['list_children']) {
      return result(await session.read({ children: actual(input.path) }));
    },
    execute,
    async deploy_prefab(input: NativeMcpToolInputs['deploy_prefab']) {
      return (await execute({ path: input.source, action: 'deploy', args: {
        target: actual(input.target), ...(input.allowAbsolute === undefined ? {} : { allowAbsolute: input.allowAbsolute }),
      } })).value;
    },
    async commit(input: Omit<CommitRequest, 'opId'> & { opId?: OpId }) {
      return session.commit({ ...input, changes: input.changes.map(change), expect: expect(input.expect), opId: input.opId ?? key() }).outcome;
    },
    async set_node(input: NativeMcpToolInputs['set_node']) {
      return session.commit({ changes: [change({ op: 'put', node: input.node })], expect: expect(input.expect), opId: input.opId ?? key() }).outcome;
    },
    async remove_node(input: NativeMcpToolInputs['remove_node']) {
      return session.commit({ changes: [change({ op: 'remove', path: input.path })], expect: expect(input.expect), opId: input.opId ?? key() }).outcome;
    },
    async catalog() {
      return session.act({ path: systemPath, action: 'catalog', args: {} }).outcome;
    },
    async describe_type(input: NativeMcpToolInputs['describe_type']) {
      return session.act({ path: systemPath, action: 'describe_type', args: input }).outcome;
    },
    async search_types(input: NativeMcpToolInputs['search_types']) {
      return session.act({ path: systemPath, action: 'search_types', args: input }).outcome;
    },
  };
}

export type McpSession = Awaited<ReturnType<typeof createMcpSession>>;
