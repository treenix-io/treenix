import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { it, type TestContext } from 'node:test'
import { createTwpClient } from '#client/twp'
import { KernelError } from '#errors'
import { createInstance } from '#kernel/instance'
import { computeRights } from '#kernel/rights'
import { createReader } from '#kernel/reader'
import { createShardOwner } from '#kernel/authority/shard-owner'
import { drainSession } from '#kernel/session-delivery'
import { createMemoryStore } from '#kernel/store/memory'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import { R, W, DEFAULT_LIMITS, type ModuleManifest, type Position, type PositionCounter } from '#kernel/types'

const module: ModuleManifest = { id: 'shard-example', security: [], open: [], types: [{ name: 'shard.counter',
  module: 'shard-example', security: 'ordinary', version: 0, schema: {}, actions: {
    observeForeign: { kind: 'read', args: {}, handler: async ctx => {
      const result = await ctx.read.read({ node: '/remote/item' });
      const copy = result.copies[0];
      if (!('node' in copy)) throw copy.error;
      return copy.node.count;
    } },
    writeFromForeign: { kind: 'write', args: {}, handler: async ctx => {
      await ctx.read.read({ node: '/remote/item' });
      ctx.change.patch(ctx.node.$path, { $inc: { count: 1 } });
    } },
    increment: { kind: 'write', args: {}, handler: async ctx => {
      ctx.change.patch(ctx.node.$path, { $inc: { count: 1 } })
      return 'accepted'
    } },
    steps: { kind: 'write', args: {}, handler: async function* (ctx) {
      ctx.change.patch(ctx.node.$path, { $inc: { count: 1 } }); yield 'first'
      ctx.change.patch(ctx.node.$path, { $inc: { count: 1 } }); yield 'second'
      return 'finished'
    } },
  } }] }
const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected

/** Construct actual native actors, Writer decisions and ordered client lanes in each instance. */
async function instance(t: TestContext, shardPath?: string, modules: readonly ModuleManifest[] = [module]) {
  const id = randomUUID(), root = createMemoryStore({ domain: id })
  let saved: Position | undefined, epoch = 0
  const counter: PositionCounter = { async load() { return saved }, async save(pos) { saved = pos },
    async freshEpoch(floor) { epoch = Math.max(epoch, floor) + 1; return epoch } }
  const runtime = await createInstance({ id, shardPath, root: { kind: 'store', store: root }, modules,
    blobs: createMemoryBlobStore(), provisioning: { counter, writerEpoch: 1,
      domains: [{ store: root, epoch: randomUUID(), persistent: false }], credentialTtlMs: 60_000,
      bootstrap: { kind: 'fresh', admin: { path: '/admin', name: 'admin', password: randomUUID() } } } })
  assert.ok(runtime.setupCredential)
  const admin = await runtime.openSession(runtime.setupCredential), pumps = [drainSession(admin)]
  t.after(async () => { await runtime.close(); await Promise.all(pumps); root.close() })
  const key = () => ({ epoch: runtime.writer.intake.epoch, time: Date.now(), nonce: randomUUID() })
  const budget = () => ({ nodes: DEFAULT_LIMITS.readNodes, bytes: DEFAULT_LIMITS.readBytes,
    exprWork: DEFAULT_LIMITS.exprWork, deadline: Date.now() + DEFAULT_LIMITS.queryMs })
  return { runtime, admin, key, budget }
}

it('continues actual origin rights in a module-matched native shard lane', { timeout: 15_000 }, async t => {
  const origin = await instance(t), remote = await instance(t, '/remote')
  await origin.admin.commit({ opId: origin.key(), changes: [
    { op: 'patch', path: '/', ops: { $push: { $acl: { subject: { group: 'public' }, grant: R | W } } } },
    { op: 'put', node: { $path: '/remote', $type: 't.dir', $acl: [{ subject: { group: 'public' }, deny: W }] } },
  ] }).outcome
  await remote.admin.commit({ opId: remote.key(), changes: [
    { op: 'put', node: { $path: '/remote', $type: 't.dir' } },
    { op: 'put', node: { $path: '/remote/item', $type: 'shard.counter', count: 1 } },
  ] }).outcome
  const actor = await origin.runtime.auth.openCredential()
  t.after(() => actor.close())
  const source = origin.runtime.readerSource(origin.budget())
  const rights = await origin.runtime.writer.read(source.domains, async () => computeRights(actor.actor,
    source.resolve('/remote').chain('/remote'), origin.runtime.registry))
  const prefixReader = createReader({ registry: origin.runtime.registry, writer: origin.runtime.writer,
    admission: actor, source: origin.runtime.readerSource(origin.budget()), budget: origin.budget() })
  const prefix = await prefixReader.rightsPrefix('/remote')
  assert.deepEqual(prefix, rights.prefix)
  const dependencies = prefixReader.expect().dependencies
  assert.ok(dependencies !== undefined)
  assert.ok(dependencies.length > 0)
  const envelope = { actor: actor.actor, modules: origin.runtime.registry.digest, path: '/remote', prefix }
  await assert.rejects(remote.runtime.openShard({ ...envelope, modules: 'wrong' }), code('GENERATION'))
  const creditLane = await remote.runtime.openShard(envelope, actor.signal)
  assert.equal((await creditLane.poll())?.t, 'welcome')
  assert.equal(await creditLane.poll(), undefined)
  let notified = false
  const stopReady = creditLane.observeReady(() => { notified = true })
  creditLane.send({ t: 'read', req: 'credit-read', selector: { node: '/remote/item' } })
  assert.equal(notified, true)
  const creditResult = await creditLane.poll()
  assert.equal(creditResult?.t, 'done')
  assert.ok(creditResult?.t === 'done')
  assert.equal(creditResult.req, 'credit-read')
  assert.equal(await creditLane.poll(), undefined)
  stopReady()
  await creditLane.close()
  const deployment = await origin.runtime.auth.openCredential(origin.runtime.setupCredential)
  const owner = createShardOwner({ authority: { kind: 'shard', connect: remote.runtime.openShard },
    admission: deployment, limits: origin.runtime.limits,
    observe(listener) { return origin.runtime.writer.stream.observe(() => listener()) },
    async envelope(admission) {
      const allowance = origin.budget()
      const reader = createReader({ registry: origin.runtime.registry, writer: origin.runtime.writer,
        admission, source: origin.runtime.readerSource(allowance), budget: allowance })
      return { actor: admission.actor, modules: origin.runtime.registry.digest,
        path: '/remote', prefix: await reader.rightsPrefix('/remote') }
    } })
  t.after(async () => { await owner.close(); deployment.close() })
  const handle = await owner.open(actor)
  assert.equal(await owner.open(actor), handle)
  const connection = handle.connection
  assert.equal(connection.instance, remote.runtime.id)
  assert.equal(connection.intake, remote.runtime.writer.intake.epoch)
  assert.equal((await connection.read({ node: '/remote/item' })).copies.length, 1)
  const client = createTwpClient(connection, { close: () => { void connection.close() } })
  t.after(() => client.close())
  await client.ready
  const result = await client.read({ node: '/remote/item' })
  assert.equal(result.copies.length, 1)
  assert.ok('node' in result.copies[0])
  assert.equal(result.copies[0].node.count, 1)
  const key = () => client.key()
  await assert.rejects(client.commit({ opId: key(), changes: [
    { op: 'patch', path: '/remote/item', ops: { $inc: { count: 1 } } },
  ] }).outcome, code('FORBIDDEN'))
  const changed = new EventEmitter()
  const sub = client.sub({ node: '/remote/item' }, () => changed.emit('changed'))
  t.after(() => sub.close())
  await sub.ready
  const generation = client.cache.list(sub.id)?.gen
  assert.ok(generation !== undefined)
  await origin.admin.commit({ opId: origin.key(), changes: [{ op: 'patch', path: '/remote', ops: { $unset: { $acl: true } } }] }).outcome
  const nextRights = await origin.runtime.writer.read(source.domains, async () => computeRights(actor.actor,
    source.resolve('/remote').chain('/remote'), origin.runtime.registry))
  assert.notDeepEqual(nextRights.prefix, rights.prefix)
  while ((client.cache.list(sub.id)?.gen ?? generation) <= generation) await once(changed, 'changed')
  const originEpoch = origin.runtime.writer.intake.epoch
  const remoteEpoch = remote.runtime.writer.intake.epoch
  const remoteId = remote.runtime.writer.stream.cursor().pos.instance
  await origin.runtime.writer.publishShardIntake(remoteId, remoteEpoch)
  assert.notEqual(origin.runtime.writer.intake.epoch, originEpoch)
  assert.equal(origin.runtime.writer.intake.shards?.[remoteId], remoteEpoch)
  const sharedRequest = { opId: { ...key(), epoch: origin.runtime.writer.intake.epoch },
    changes: [{ op: 'patch' as const, path: '/remote/item', ops: { $inc: { count: 1 } } }] }
  const accepted = await client.commit(sharedRequest).outcome
  assert.deepEqual(await client.commit(sharedRequest).outcome, accepted)
  const admittedAdmin = await origin.runtime.auth.openCredential(origin.runtime.setupCredential)
  t.after(() => admittedAdmin.close())
  const adminRights = await origin.runtime.writer.read(source.domains, async () => computeRights(admittedAdmin.actor,
    source.resolve('/remote').chain('/remote'), origin.runtime.registry))
  const adminConnection = await remote.runtime.openShard({ ...envelope, actor: admittedAdmin.actor, prefix: adminRights.prefix }, admittedAdmin.signal)
  const adminClient = createTwpClient(adminConnection, { close: () => { void adminConnection.close() } })
  t.after(() => adminClient.close())
  await adminClient.ready
  await adminClient.act({ opId: adminClient.key(),
    path: '/remote/item', action: 'increment', args: null }).outcome
  const after = await remote.admin.read({ node: '/remote/item' })
  assert.ok('node' in after.copies[0])
  assert.equal(after.copies[0].node.count, 3)
})


it('opens the declared shard through an actual native origin Session without copying remote cache bodies', { timeout: 15_000 }, async t => {
  let receiver: Awaited<ReturnType<typeof instance>> | undefined
  let opens = 0
  const mountModule: ModuleManifest = { id: 'shard-mount', open: [], types: [{ name: 'shard.mount',
    module: 'shard-mount', version: 0, security: 'privileged-capability', schema: {}, actions: {} }],
    security: [{ type: 'shard.mount', context: 'mount', async handler() {
      const accepted = receiver
      assert.ok(accepted !== undefined)
      return { kind: 'authority', authority: { kind: 'shard', async connect(envelope, signal) {
        opens++
        return accepted.runtime.openShard(envelope, signal)
      } }, async close() {} }
    } }] }
  receiver = await instance(t, '/remote', [module, mountModule])
  const origin = await instance(t, undefined, [module, mountModule])
  await receiver.admin.commit({ opId: receiver.key(), changes: [
    { op: 'put', node: { $path: '/remote', $type: 't.dir' } },
    { op: 'put', node: { $path: '/remote/item', $type: 'shard.counter', count: 7 } },
  ] }).outcome
  await origin.admin.commit({ opId: origin.key(), changes: [
    { op: 'patch', path: '/', ops: { $push: { $acl: { subject: { group: 'public' }, grant: R } } } },
    { op: 'put', node: { $path: '/remote', $type: 't.dir', '#shard': { $type: 'shard.mount', pattern: '' } } },
    { op: 'put', node: { $path: '/local', $type: 'shard.counter', count: 0, link: '/remote/item' } },
  ] }).outcome
  const caller = await origin.runtime.openSession()
  t.after(() => caller.close())
  const result = await caller.read({ node: '/remote/item' })
  assert.equal(result.copies.length, 1)
  const copy = result.copies[0]
  assert.ok('node' in copy)
  assert.equal(copy.node.count, 7)
  const remoteCopy = (await receiver.admin.read({ node: '/remote/item' })).copies[0]
  assert.ok('node' in remoteCopy)
  assert.equal(copy.node.$id, remoteCopy.node.$id)
  assert.equal((await caller.read({ node: '/remote/item' })).copies.length, 1)
  assert.equal(opens, 1)
  await t.test('readonly includes retain the actual foreign producer and node identity', async () => {
    const included = await caller.read({ node: '/local', include: [{ ref: 'link' }] });
    assert.equal(included.copies.length, 2);
    assert.ok(included.at.some(position => position.instance === receiver.runtime.id));
    assert.ok(included.ownership?.roots[0].covered.includes(remoteCopy.node.$id));
    assert.equal((await origin.admin.act({ path: '/local', action: 'observeForeign', args: null }).outcome).value, 7);
  });
  await t.test('a local decision consuming an ordinary foreign read is denied atomically', async () => {
    await assert.rejects(origin.admin.act({ opId: origin.key(), path: '/local', action: 'writeFromForeign', args: null }).outcome, code('CROSS_DOMAIN'));
    const local = (await origin.admin.read({ node: '/local' })).copies[0];
    assert.ok('node' in local);
    assert.equal(local.node.count, 0);
  });
  const frames = caller.lane[Symbol.asyncIterator]()
  assert.equal((await frames.next()).value?.t, 'welcome')
  const sub = caller.sub({ node: '/remote/item' })
  const snapshot = (await frames.next()).value
  assert.ok(snapshot?.t === 'snap')
  assert.equal(snapshot.sub, sub)
  assert.ok('node' in snapshot.copies[0])
  assert.equal(snapshot.copies[0].node.$id, remoteCopy.node.$id)
  assert.deepEqual(snapshot.foreign, [receiver.runtime.id])
  await receiver.admin.commit({ opId: receiver.key(), changes: [
    { op: 'patch', path: '/remote/item', ops: { $inc: { count: 1 } } },
  ] }).outcome
  const update = (await frames.next()).value
  assert.ok(update?.t === 'pos')
  assert.equal(update.pos.instance, receiver.runtime.id)
  assert.equal(update.changes.length, 1)
  assert.equal(opens, 2)
  const request = { opId: origin.key(), changes: [
    { op: 'patch' as const, path: '/remote/item', ops: { $inc: { count: 1 } } },
  ] }
  const accepted = await origin.admin.commit(request).outcome
  assert.equal(accepted.pos?.instance, receiver.runtime.id)
  assert.deepEqual(await origin.admin.commit(request).outcome, accepted)
  assert.equal(origin.runtime.writer.intake.shards?.[receiver.runtime.id], receiver.runtime.writer.intake.epoch)
  await t.test('the owner-side native action retains its genuine decision owner', async () => {
  const action = await origin.admin.act({ opId: origin.key(), path: '/remote/item', action: 'increment', args: null }).outcome
  assert.equal(action.value, 'accepted')
  })
  const streamed = origin.admin.act({ opId: origin.key(), path: '/remote/item', action: 'steps', args: null })
  const pieces = (async () => { const values: unknown[] = []; for await (const value of streamed.chunks) values.push(value); return values })()
  assert.deepEqual(await pieces, ['first', 'second'])
  assert.equal((await streamed.outcome).value, 'finished')
  const final = (await receiver.admin.read({ node: '/remote/item' })).copies[0]
  assert.ok('node' in final)
  assert.equal(final.node.count, 12)
  assert.equal(opens, 2)
})


it('charges actual filtered shard scans cumulatively to the native action allowance', { timeout: 15_000 }, async t => {
  let firstRead = false;
  const queryModule: ModuleManifest = { ...module, types: [{ ...module.types[0], actions: {
    ...module.types[0].actions,
    scanTwice: { kind: 'read', args: {}, handler: async ctx => {
      const selector = { children: '/remote/scan', where: { count: { $lt: 0 } } };
      const first = await ctx.read.read(selector);
      assert.deepEqual(first.list, []);
      firstRead = true;
      await ctx.read.read(selector);
    } },
  } }] };
  let receiver: Awaited<ReturnType<typeof instance>> | undefined;
  const mountModule: ModuleManifest = { id: 'scan-shard-mount', open: [],
    types: [{ name: 'scan.shard', module: 'scan-shard-mount', version: 0, security: 'privileged-capability', schema: {}, actions: {} }],
    security: [{ type: 'scan.shard', context: 'mount', async handler() {
      const accepted = receiver;
      assert.ok(accepted !== undefined);
      return { kind: 'authority', authority: { kind: 'shard', connect: accepted.runtime.openShard }, async close() {} };
    } }] };
  receiver = await instance(t, '/remote', [queryModule, mountModule]);
  const origin = await instance(t, undefined, [queryModule, mountModule]);
  await receiver.admin.commit({ opId: receiver.key(), changes: [
    { op: 'put', node: { $path: '/remote', $type: 't.dir' } },
    { op: 'put', node: { $path: '/remote/scan', $type: 't.dir' } },
  ] }).outcome;
  for (let start = 0; start < 600; start += 80) {
    const changes = Array.from({ length: Math.min(80, 600 - start) }, (_, offset) => ({
      op: 'put' as const, node: { $path: `/remote/scan/item-${start + offset}`, $type: 'shard.counter', count: 1 },
    }));
    await receiver.admin.commit({ opId: receiver.key(), changes }).outcome;
  }
  await origin.admin.commit({ opId: origin.key(), changes: [
    { op: 'put', node: { $path: '/remote', $type: 't.dir', '#shard': { $type: 'scan.shard', pattern: '' } } },
    { op: 'put', node: { $path: '/local', $type: 'shard.counter', count: 0 } },
  ] }).outcome;
  await assert.rejects(origin.admin.act({ path: '/local', action: 'scanTwice', args: null }).outcome, code('BUDGET'));
  assert.equal(firstRead, true);
  const retained = await origin.admin.read({ node: '/remote/scan/item-0' });
  assert.ok('node' in retained.copies[0]);
  assert.equal(retained.copies[0].node.count, 1);
});
