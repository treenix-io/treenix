// Type-level assertions for types.ts: each @ts-expect-error must stay an error.
import type { NodeInput, ReadAction, WriteAction, PostAction, OpenRegistration, SecurityRegistration, SubSelector, Operation, RightsRule, Gate, MountTarget, DeriveHandler, ComputedNode } from './types'

// @ts-expect-error a computed node never carries the rights of its sources
export const computedWithOwner: ComputedNode = { $path: '/a', $id: 'n1', $type: 't', $rev: 'r1', $owner: 'u:bob' }

const derive: DeriveHandler = async () => ({ members: [] })

// @ts-expect-error a View reading past the kernel is executed by its node: the reader's rights cannot apply there
export const readerWithSources: MountTarget = { kind: 'view', derive, executor: 'reader', sources: ['/crm'] }

export const nodeWithSources: MountTarget = { kind: 'view', derive, executor: 'node', sources: ['/crm'] }

// @ts-expect-error a gate cannot refuse with a code that steers retries
export const conflictGate: Gate = async () => ({ refuse: 'CONFLICT' })

export const quotaGate: Gate = async () => ({ refuse: 'BUDGET' })

export const fileApprovalGate: Gate = async (operation) =>
  operation.kind === 'upload' || operation.kind === 'download' ? { refuse: 'REFUSED' } : 'pass'

// @ts-expect-error a download names the node and the field holding the reference
export const downloadWithoutField: Operation = { kind: 'download', path: '/a' }

export const postStream: PostAction = {
  kind: 'write',
  args: {},
  post: { '': { $inc: { n: 1 } } },
  // @ts-expect-error an action with post is one atomic ChangeSet, never a stream
  async *handler() {
    yield 1
  },
}

export const postOnly: PostAction = { kind: 'write', args: {}, post: { '': { $inc: { n: 1 } } } }

export const streaming: WriteAction = {
  kind: 'write',
  io: true,
  args: {},
  async *handler(ctx) {
    ctx.change.patch('/chat/m1', { $set: { text: 'Hel' } })
    yield 'Hel'
    ctx.change.patch('/chat/m1', { $set: { text: 'Hello' } })
    yield 'lo'
    return { done: true }
  },
}

// @ts-expect-error $id in write input is rejected
export const withId: NodeInput = { $path: '/a', $type: 't', $id: 'chosen' }

// @ts-expect-error $rev in write input is rejected
export const withRev: NodeInput = { $path: '/a', $type: 't', $rev: 'chosen' }

export const plain: NodeInput = { $path: '/a', $type: 't', title: 'x', '#stats': { $type: 's', n: 1 } }

export const readAction: ReadAction = {
  kind: 'read',
  args: {},
  handler: async (ctx) => {
    // @ts-expect-error a read action has no change builder
    ctx.change.put({ $path: '/b', $type: 't' })
    return ctx.node.$id
  },
}

// @ts-expect-error a security registration needs a matching handler
export const badSecurity: SecurityRegistration = { type: 't', context: 'acl', handler: 42 }

export const open: OpenRegistration = { type: 't', context: 'react', handler: () => null }

// @ts-expect-error history is read-only, not subscribable
export const subHistory: SubSelector = { history: '/a' }

export const subChildren: SubSelector = { children: '/a', window: { limit: 10 } }

export const chatFeed: SubSelector = { children: '/chat/room', sort: [['time', -1]], window: { limit: 100, evict: true } }

// @ts-expect-error eviction is a flag, not a policy name
export const evictPolicy: SubSelector = { children: '/a', window: { limit: 10, evict: 'oldest' } }

// @ts-expect-error an act operation carries its arguments
export const opWithoutArgs: Operation = { kind: 'act', path: '/a', action: 'pay' }

// @ts-expect-error rules see no node fields
export const fieldRule: RightsRule = ({ component }) => (component.public === true ? 1 : 0)
