// Type-level assertions for types.ts: each @ts-expect-error must stay an error.
import type { CreateTestInstance, TestActorInput, TestInstanceConfig } from '#kernel/index'
import type {
  ActRequest, Actor, CommitRequest, ModuleManifest, NestedActRequest, OpId, Pending, ReadActionContext,
  Reader, Request, WriteActionContext, NodeInput, ReadAction, WriteAction, PostAction, OpenRegistration,
  SecurityRegistration, SubSelector, Operation, RightsRule, Gate, MountTarget, DeriveHandler, ComputedNode,
} from '#kernel/types'

const streamKey: OpId = { epoch: 'intake', time: 1, nonce: 'stream' }
export const streamContinuation: ActRequest = { path: '/chat', action: 'send', args: {}, opId: { ...streamKey, nonce: 'continuation' }, anchor: streamKey }
export const wireContinuation: Request = { t: 'act', req: 'continue', ...streamContinuation, anchor: streamKey }
export const nestedRead: NestedActRequest = { path: '/counter', action: 'read', args: {} }
export const keyedNestedWrite: NestedActRequest = { path: '/counter', action: 'increment', args: 1, key: 'increment' }

// @ts-expect-error the kernel derives the nested idempotency key
export const nestedWithOpId: NestedActRequest = { ...keyedNestedWrite, opId: streamKey }

// @ts-expect-error only the outer request may name a stream anchor
export const nestedWithAnchor: NestedActRequest = { ...keyedNestedWrite, anchor: streamKey }

// @ts-expect-error logical nested keys are names, not call ordinals
export const nestedWithOrdinal: NestedActRequest = { ...keyedNestedWrite, key: 1 }

export async function readContextSurface(ctx: ReadActionContext): Promise<unknown> {
  const nested: Promise<unknown> = ctx.act(nestedRead)
  const value: unknown = await nested
  // @ts-expect-error a read action has no change builder
  ctx.change
  // @ts-expect-error a read action has no external I/O surface
  ctx.io
  // @ts-expect-error nested requests cannot choose their idempotency key
  ctx.act({ ...keyedNestedWrite, opId: streamKey })
  // @ts-expect-error nested requests cannot override the outer stream anchor
  ctx.act({ ...keyedNestedWrite, anchor: streamKey })
  return value
}

export async function writeContextSurface(ctx: WriteActionContext): Promise<unknown> {
  ctx.change.patch('/counter', { $inc: { value: 1 } })
  const io = ctx.io
  const value: unknown = await ctx.act(keyedNestedWrite)
  return { io, value }
}

export function requiresNestedCall(ctx: Omit<ReadActionContext, 'act'>): ReadActionContext {
  // @ts-expect-error every native action context supplies nested calls
  return ctx
}

const testModule: ModuleManifest = {
  id: 'example',
  types: [{ name: 'example.form', module: 'example', security: 'user-capability',
    schema: { type: 'object', properties: { title: { type: 'string' } } }, version: 0,
    actions: { submit: { kind: 'setuid', args: { type: 'string' }, handler: async () => 'accepted' } },
  }],
  security: [], open: [],
}
export const testConfig: TestInstanceConfig<'reader' | 'form'> = {
  modules: [testModule],
  seed: [{ $path: '/form', $type: 'example.form', title: 'Contact' }],
  actors: {
    reader: { kind: 'credential', credential: { token: 'issued-test-credential' }, origin: '127.0.0.1' },
    form: { kind: 'node', node: '/form' },
  },
}

export const testSeedWithIdentity: TestInstanceConfig = {
  ...testConfig,
  // @ts-expect-error test seeds cannot choose kernel-owned node identities
  seed: [{ $path: '/form', $type: 'example.form', $id: 'chosen' }],
}

export const testSeedWithoutPath: TestInstanceConfig = {
  ...testConfig,
  // @ts-expect-error every seed input is an explicitly addressed native write
  seed: [{ $type: 'example.form', title: 'Contact' }],
}

export const testActorWithClaims: TestInstanceConfig = {
  ...testConfig,
  actors: {
    // @ts-expect-error test actors use the real factory, never caller-supplied identity or claims
    reader: { kind: 'credential', principal: 'u:reader', claims: ['admins'] },
  },
}

export const testActorWithTwoInputs: TestInstanceConfig = {
  ...testConfig,
  actors: {
    // @ts-expect-error session input selects either a credential or a capability node
    reader: { kind: 'node', node: '/form', credential: { token: 'issued-test-credential' } },
  },
}

export function rawActorInput(actor: Actor): TestActorInput {
  // @ts-expect-error a session actor is an output of the factory, never its input
  return actor
}

export async function testActorSurface(create: CreateTestInstance, commit: CommitRequest): Promise<void> {
  const test = await create({
    modules: [testModule], seed: [],
    actors: { reader: { kind: 'credential', origin: '127.0.0.1' } },
  })
  const actor: Actor = test.actors.reader.actor
  const reader: Reader = test.actors.reader
  const readResult = await reader.read({ node: '/form' })
  const action: Pending = test.actors.reader.act(streamContinuation)
  const mutation: Pending = test.actors.reader.commit(commit)
  const outcome = await action.outcome
  const chunks: AsyncIterable<unknown> = action.chunks
  // @ts-expect-error actor names come from the configuration
  test.actors.unknown
  // @ts-expect-error native actor operations do not expose a legacy tree
  test.actors.reader.tree
  // @ts-expect-error action calls still require schema-validated arguments
  test.actors.reader.act({ path: '/form', action: 'submit' })
  // @ts-expect-error direct commits still require their idempotency key
  test.actors.reader.commit({ changes: [] })
  void [actor, readResult, mutation, outcome, chunks]
}

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
