import { randomUUID } from 'node:crypto';
import { KernelError } from '@treenx/core/errors';
import type { CommitRequest, OpId, Session } from '@treenx/core/kernel/types';
import type { NativeMcpToolInputs } from '#mcp/native-types';

/** Consume the binding's lane so native mutation outcomes retain delivery ordering. */
export async function createMcpSession(session: Session, systemPath = '/sys/mcp/catalog') {
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

  return {
    done,
    async get_node(input: NativeMcpToolInputs['get_node']) {
      return session.read({ node: input.path });
    },
    async list_children(input: NativeMcpToolInputs['list_children']) {
      return session.read({ children: input.path });
    },
    async execute(input: NativeMcpToolInputs['execute']) {
      return session.act({ ...input, opId: input.opId ?? key() }).outcome;
    },
    async commit(input: Omit<CommitRequest, 'opId'> & { opId?: OpId }) {
      return session.commit({ ...input, opId: input.opId ?? key() }).outcome;
    },
    async set_node(input: NativeMcpToolInputs['set_node']) {
      return session.commit({ changes: [{ op: 'put', node: input.node }], expect: input.expect, opId: input.opId ?? key() }).outcome;
    },
    async remove_node(input: NativeMcpToolInputs['remove_node']) {
      return session.commit({ changes: [{ op: 'remove', path: input.path }], expect: input.expect, opId: input.opId ?? key() }).outcome;
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
