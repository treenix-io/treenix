import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { it, type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { KernelError } from '#errors';
import { actionPublicationPath } from '#kernel/action-publication';
import { createInstance } from '#kernel/instance';
import { openNativeRuntime } from '#kernel/runtime';
import { createMemoryStore } from '#kernel/store/memory';
import { createMemoryBlobStore } from '#kernel/blob-store-memory';
import { drainSession } from '#kernel/session-delivery';
import { R, W, A, type ActionIoScope, type Credential, type Io, type ModuleManifest, type Node, type OpId, type Position, type Session } from '#kernel/types';

declare module '#kernel/types' { interface Io { sourceTest?: { call(input: unknown): Promise<unknown> } } }
const refused = (code: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === code;
function event() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Open genuine caller/admin lanes on the configured source-owning module. */
async function fixture(t: TestContext, options: { directory?: string; credential?: Credential; callerCredential?: Credential; grants?: boolean; provider?: (input: unknown, scope: ActionIoScope) => Promise<unknown> } = {}) {
  const module: ModuleManifest = { id: 'source-contract', security: [
    { type: 'uix.action-publication', context: 'acl', handler: input => input.admin ? R | W | A : R },
  ], open: [], sourceIo: { exchange: async (io, input) => { assert.ok(io.sourceTest); return io.sourceTest.call(input); } }, types: [
    { name: 'source.document', module: 'source-contract', version: 0, security: 'user-capability', schema: { type: 'object', properties: { count: { type: 'number' } } }, actions: {
      edit: { kind: 'write', args: { type: 'object', required: ['value'], properties: { value: { type: 'number' } }, additionalProperties: false }, handler: async () => 'compiled' },
      inspect: { kind: 'read', args: {}, handler: async () => 'compiled-read' },
      elevated: { kind: 'setuid', args: {}, handler: async () => 'compiled-setuid' },
    } },
    { name: 'dir', module: 'source-contract', version: 0, security: 'ordinary', schema: {}, actions: {} },
    { name: 'uix.source', module: 'source-contract', version: 0, security: 'ordinary', schema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] }, actions: {} },
    { name: 'uix.action-publication', module: 'source-contract', version: 0, security: 'ordinary', schema: { type: 'object', properties: {} }, actions: {} },
  ] };
  const calls: unknown[] = [];
  const scopes: ActionIoScope[] = [];
  const io = (scope: ActionIoScope): Io => { scopes.push(scope); return { sourceTest: { async call(input) {
    scope.assertActive(); calls.push(input);
    const value = await (options.provider?.(input, scope) ?? Promise.resolve(input));
    scope.assertActive(); return value;
  } } }; };
  const id = options.directory ?? randomUUID();
  const root = createMemoryStore({ domain: id });
  let saved: Position | undefined;
  const opened = options.directory === undefined ? await createInstance({ id, root: { kind: 'store', store: root }, blobs: createMemoryBlobStore(), io, modules: [module], provisioning: {
    writerEpoch: 1, domains: [{ store: root, epoch: id, persistent: false }], credentialTtlMs: 60_000,
    counter: { load: async () => saved, save: async pos => { saved = pos; }, freshEpoch: async floor => floor + 1 },
    bootstrap: { kind: 'fresh', admin: { path: '/admin', name: 'admin', password: randomUUID() } },
  } }) : await openNativeRuntime({ id, directory: options.directory, firstAdmin: { path: '/admin', name: 'admin', password: 'source-password' }, credentialTtlMs: 60_000, modules: [module], io, installerCredential: options.credential });
  const instance = 'instance' in opened ? opened.instance : opened;
  const deliveries: Promise<void>[] = [];
  let closed = false;
  async function close() { if (closed) return; closed = true; await opened.close(); await Promise.all(deliveries); }
  t.after(close);
  async function open(credential?: Credential) {
    const session = await instance.openSession(credential);
    const welcome = await session.lane[Symbol.asyncIterator]().next();
    assert.ok(!welcome.done && welcome.value.t === 'welcome');
    const intake = welcome.value.intake;
    deliveries.push(drainSession(session));
    return { session, credential: welcome.value.credential ?? credential, key: (): OpId => ({ epoch: intake, time: Date.now(), nonce: randomUUID() }) };
  }
  const admin = await open(options.credential ?? instance.setupCredential);
  async function node(path: string): Promise<Node> { const copy = (await admin.session.read({ node: path })).copies[0]; assert.ok('node' in copy); return copy.node; }
  if (options.credential === undefined) {
    await admin.session.commit({ opId: admin.key(), changes: [
      { op: 'put', node: { $path: '/doc', $type: 'source.document', count: 0, $acl: [{ subject: { group: 'public' }, grant: R | W }] } },
      { op: 'put', node: { $path: '/draft', $type: 'uix.source', source: 'return "draft";', $acl: [{ subject: { group: 'public' }, grant: R | W }] } },
      { op: 'put', node: { $path: '/private', $type: 'dir', secret: 91 } },
      { op: 'patch', path: '/sys/types/source.document', ops: { $set: { $acl: [{ subject: { group: 'public' }, grant: R | W }] } } },
    ] }).outcome;
    if (options.grants) {
    const document = await node('/doc');
    await admin.session.commit({ opId: admin.key(), expect: { nodes: [{ path: '/doc', rev: document.$rev }] }, changes: [
      { op: 'patch', path: '/private', ops: { $set: { $acl: [{ subject: { group: `n:${document.$id}` }, grant: R }] } } },
      { op: 'patch', path: '/doc', ops: { $set: { $acl: [{ subject: { group: 'public' }, grant: R | W }, { subject: { group: `n:${document.$id}` }, grant: R | W }] } } },
    ] }).outcome;
    }
  }
  const caller = await open(options.callerCredential);
  async function draft(source: string) { await caller.session.commit({ opId: caller.key(), changes: [{ op: 'patch', path: '/draft', ops: { $set: { source } } }] }).outcome; }
  async function publish(action: string, extra: Record<string, unknown> = {}) {
    return admin.session.act({ path: '/sys/types/source.document', action: 'publish_action', args: { action, draft: '/draft', ...extra }, opId: admin.key() }).outcome;
  }
  return { instance, admin, caller, module, calls, scopes, node, draft, publish, close };
}

it('keeps ordinary drafts inactive and publishes one protected immutable native generation', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const generation = f.instance.registry.digest;
  await f.draft('ctx.change.patch(ctx.node.$path, {$set:{count:data.value}}); return ctx.caller.principal;');
  assert.equal(f.instance.registry.digest, generation);
  assert.equal((await f.caller.session.act({ path: '/doc', action: 'edit', args: { value: 2 }, opId: f.caller.key() }).outcome).value, 'compiled');
  await assert.rejects(f.caller.session.act({ path: '/sys/types/source.document', action: 'publish_action', args: { action: 'edit', draft: '/draft' }, opId: f.caller.key() }).outcome, refused('FORBIDDEN'));
  await f.publish('edit');
  assert.notEqual(f.instance.registry.digest, generation);
  const snapshot = await f.node(actionPublicationPath('source.document', 'edit'));
  assert.equal(snapshot.draftRev, (await f.node('/draft')).$rev);
  const history = (await f.admin.session.read({ history: snapshot.$path })).history;
  assert.equal(history?.length, 1);
  await assert.rejects(f.caller.session.commit({ opId: f.caller.key(), changes: [{ op: 'patch', path: snapshot.$path, ops: { $set: { source: 'return 999;' } } }] }).outcome, refused('FORBIDDEN'));
  await f.draft('return 999;');
  const result = await f.caller.session.act({ path: '/doc', action: 'edit', args: { value: 7 }, opId: f.caller.key() }).outcome;
  assert.ok(typeof result.value === 'string' && result.value.startsWith('anon:'));
  assert.equal((await f.node('/doc')).count, 7);
  await assert.rejects(f.caller.session.act({ path: '/doc', action: 'edit', args: { value: 'bad' }, opId: f.caller.key() }).outcome, refused('INVALID'));
  assert.equal(f.instance.registry.module(f.module.id).security.length, 1);
});

it('keeps executor rights genuine and refuses atomic partial writes', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { grants: true });
  await f.draft('const r=await ctx.read.read({node:"/private"}); return {secret:r.copies[0].node.secret,caller:ctx.caller.principal,executor:ctx.executor.principal};');
  await f.publish('elevated');
  const outcome = await f.caller.session.act({ path: '/doc', action: 'elevated', args: {}, opId: f.caller.key() }).outcome;
  assert.ok(typeof outcome.value === 'object' && outcome.value !== null && 'secret' in outcome.value && outcome.value.secret === 91);
  assert.ok('executor' in outcome.value && outcome.value.executor === `n:${(await f.node('/doc')).$id}`);
  await f.draft('ctx.change.patch("/doc",{$set:{count:8}}); ctx.change.patch("/private",{$set:{secret:0}}); return 1;');
  await f.publish('edit');
  await assert.rejects(f.caller.session.act({ path: '/doc', action: 'edit', args: { value: 1 }, opId: f.caller.key() }).outcome, refused('FORBIDDEN'));
  assert.equal((await f.node('/doc')).count, 0);
  assert.equal((await f.node('/private')).secret, 91);
});

it('allows explicit new declarations and genuine nested actions without exposing host facilities', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  await f.draft('return {host:typeof process,network:typeof fetch,loader:typeof require,result:await ctx.act({path:"/doc",action:"inspect",args:{}})};');
  await f.publish('new_read', { definition: { kind: 'read', args: {} } });
  const outcome = await f.caller.session.act({ path: '/doc', action: 'new_read', args: {} }).outcome;
  assert.deepEqual(outcome.value, { host: 'undefined', network: 'undefined', loader: 'undefined', result: 'compiled-read' });
  await assert.rejects(f.publish('bad', { definition: { kind: 'read', args: {}, io: true } }), refused('INVALID'));
  await f.draft('ctx.change.patch("/doc",{$set:{count:3}});');
  await f.publish('read_writer', { definition: { kind: 'read', args: {} } });
  await assert.rejects(f.caller.session.act({ path: '/doc', action: 'read_writer', args: {} }).outcome, refused('INVALID'));
  assert.equal((await f.node('/doc')).count, 0);
});

it('requires actual caller execution rights independently of source publication authority', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  await f.draft('ctx.change.patch("/doc",{$set:{count:data.value}}); return data.value;');
  await f.publish('edit');
  await f.admin.session.commit({ opId: f.admin.key(), changes: [{ op: 'patch', path: '/doc', ops: { $set: { $acl: [{ subject: { group: 'public' }, grant: R }] } } }] }).outcome;
  await assert.rejects(f.caller.session.act({ path: '/doc', action: 'edit', args: { value: 4 }, opId: f.caller.key() }).outcome, refused('FORBIDDEN'));
  assert.equal((await f.node('/doc')).count, 0);
  assert.equal((await f.admin.session.act({ path: '/doc', action: 'edit', args: { value: 4 }, opId: f.admin.key() }).outcome).value, 4);
});

it('rejects publication when the genuine draft read changes during owned compiler completion', { timeout: 10_000 }, async t => {
  const f=await fixture(t);
  await f.draft('return 1;');
  const generation=f.instance.registry.digest, stopped=event(), release=event();
  const terminate=Worker.prototype.terminate;
  let held=false;
  t.mock.method(Worker.prototype,'terminate',async function(this:Worker) {
    const result=await terminate.call(this);
    if(!held){held=true;stopped.resolve();await release.promise;}
    return result;
  });
  const publication=f.publish('edit');
  await stopped.promise;
  await f.draft('return 2;');
  release.resolve();
  await assert.rejects(publication,refused('CONFLICT'));
  assert.equal(f.instance.registry.digest,generation);
  assert.equal((await f.caller.session.act({path:'/doc',action:'edit',args:{value:1},opId:f.caller.key()}).outcome).value,'compiled');
  await assert.rejects(f.admin.session.read({node:actionPublicationPath('source.document','edit')}),refused('NOT_FOUND'));
});

it('cancels actual publication while its owned compiler is active without installing source', { timeout: 10_000 }, async t => {
  const f=await fixture(t);
  await f.draft('return 1;');
  const generation=f.instance.registry.digest, started=event(), exited=event();
  const on=Worker.prototype.on;
  let observed=false;
  t.mock.method(Worker.prototype,'on',function(this:Worker,event:Parameters<Worker['on']>[0],listener:Parameters<Worker['on']>[1]) {
    if(event==='message'&&!observed){
      observed=true;
      on.call(this,'online',started.resolve);
      on.call(this,'exit',exited.resolve);
    }
    return on.call(this,event,listener);
  });
  const pending=f.admin.session.act({path:'/sys/types/source.document',action:'publish_action',args:{draft:'/draft',action:'edit'},opId:f.admin.key()});
  await started.promise;
  f.admin.session.cancel(pending.id);
  await assert.rejects(pending.outcome,refused('CANCELLED'));
  await exited.promise;
  assert.equal(f.instance.registry.digest,generation);
  await assert.rejects(f.admin.session.read({node:actionPublicationPath('source.document','edit')}),refused('NOT_FOUND'));
});

it('cancels actual scoped external IO and refuses late results', { timeout: 10_000 }, async t => {
  const entered = event(), aborted = event(), release = event();
  const f = await fixture(t, { provider: async (_input, scope) => { scope.signal.addEventListener('abort', aborted.resolve, { once: true }); entered.resolve(); await release.promise; return 'late'; } });
  await f.draft('try { await ctx.io.exchange("owned"); } catch (error) { if(error.code!=="CANCELLED") throw error; } ctx.change.patch("/doc",{$set:{count:10}}); return 10;');
  await f.publish('external', { definition: { kind: 'write', args: {}, io: true } });
  const pending = f.caller.session.act({ path: '/doc', action: 'external', args: {}, opId: f.caller.key() });
  await entered.promise;
  f.caller.session.cancel(pending.id);
  await aborted.promise;
  await assert.rejects(pending.outcome, refused('CANCELLED'));
  release.resolve();
  assert.equal((await f.node('/doc')).count, 0);
  assert.deepEqual(f.calls, ['owned']);
  assert.ok(f.scopes[0].signal.aborted);
});

it('refuses an in-flight old generation after canonical source replacement', { timeout: 10_000 }, async t => {
  const entered = event(), release = event();
  const f = await fixture(t, { provider: async () => { entered.resolve(); await release.promise; return 1; } });
  await f.draft('await ctx.io.exchange(1); ctx.change.patch("/doc",{$set:{count:10}}); return 10;');
  await f.publish('external', { definition: { kind: 'write', args: {}, io: true } });
  const pending = f.caller.session.act({ path: '/doc', action: 'external', args: {}, opId: f.caller.key() });
  await entered.promise;
  await f.draft('return 22;');
  await f.publish('external');
  release.resolve();
  await assert.rejects(pending.outcome, refused('CONFLICT'));
  assert.equal((await f.node('/doc')).count, 0);
  assert.equal((await f.caller.session.act({ path: '/doc', action: 'external', args: {}, opId: f.caller.key() }).outcome).value, 22);
});

it('allows handled provider failures and keeps byte exhaustion terminal', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { provider: async () => { throw new KernelError('UNAVAILABLE', 'Provider failed'); } });
  await f.draft('try { await ctx.io.exchange(1); } catch (error) { if(!(error instanceof Error)||error.code!=="UNAVAILABLE") throw error; ctx.change.patch("/doc",{$set:{count:10}}); return error.code; }');
  await f.publish('external', { definition: { kind: 'write', args: {}, io: true } });
  assert.equal((await f.caller.session.act({ path: '/doc', action: 'external', args: {}, opId: f.caller.key() }).outcome).value, 'UNAVAILABLE');
  assert.equal((await f.node('/doc')).count, 10);
  await f.draft('return await __call("io",JSON.stringify(["undeclared",1]));');
  await f.publish('external');
  await assert.rejects(f.caller.session.act({ path: '/doc', action: 'external', args: {}, opId: f.caller.key() }).outcome, refused('FORBIDDEN'));
  assert.deepEqual(f.calls, [1]);
  await f.draft('try { await ctx.read.read({node:"/"+"x".repeat(1024*1024)}); } catch(error) { if(error.code!=="BUDGET") throw error; } ctx.change.patch("/doc",{$set:{count:20}}); return 20;');
  await f.publish('external');
  await assert.rejects(f.caller.session.act({ path: '/doc', action: 'external', args: {}, opId: f.caller.key() }).outcome, refused('BUDGET'));
  assert.equal((await f.node('/doc')).count, 10);
});

it('streams through actual per-piece atomic native decisions and replays accepted outcomes once', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  await f.draft('ctx.change.patch("/doc",{$inc:{count:1}}); yield ctx.node.count; ctx.change.patch("/doc",{$inc:{count:1}}); yield ctx.node.count; return ctx.node.count;');
  await f.publish('stream', { definition: { kind: 'write', args: {} }, stream: true });
  const opId = f.caller.key();
  const request = { path: '/doc', action: 'stream', args: {}, opId };
  const pending = f.caller.session.act(request);
  const chunks: unknown[] = [];
  for await (const chunk of pending.chunks) chunks.push(chunk);
  assert.deepEqual(chunks, [0, 1]);
  assert.equal((await pending.outcome).value, 2);
  assert.equal((await f.node('/doc')).count, 2);
  assert.equal((await f.caller.session.act(request).outcome).value, 2);
  assert.equal((await f.node('/doc')).count, 2);
});

it('cold-restores protected source generations and refuses missing snapshots', { timeout: 10_000 }, async t => {
  await mkdir(resolve('./temp'), { recursive: true });
  const directory = await mkdtemp(resolve('./temp/native-action-source-'));
  const first = await fixture(t, { directory });
  await first.draft('ctx.change.patch("/doc",{$inc:{count:data.value}}); return ctx.node.count+data.value;');
  await first.publish('edit');
  const credential = first.admin.credential;
  const callerCredential=first.caller.credential;
  assert.ok(callerCredential);
  const request={path:'/doc',action:'edit',args:{value:42},opId:first.caller.key()};
  assert.equal((await first.caller.session.act(request).outcome).value,42);
  const digest = first.instance.registry.digest;
  await first.close();
  const second = await fixture(t, { directory, credential, callerCredential });
  assert.equal(second.instance.registry.digest, digest);
  const result = await second.caller.session.act(request).outcome;
  assert.equal(result.value, 42);
  assert.equal((await second.node('/doc')).count, 42);
  await assert.rejects(second.admin.session.commit({ opId: second.admin.key(), changes: [{ op: 'remove', path: actionPublicationPath('source.document', 'edit') }] }).outcome, refused('FORBIDDEN'));
});


it('interrupts hostile CPU and unresolvable guest promises at the actual native deadline', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  await f.draft('ctx.change.patch("/doc",{$set:{count:10}}); for (;;) {}');
  await f.publish('edit');
  await f.admin.session.commit({ opId: f.admin.key(), changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { actionMs: 1000 } } }] }).outcome;
  await assert.rejects(f.caller.session.act({ path: '/doc', action: 'edit', args: { value: 1 }, opId: f.caller.key() }).outcome, refused('BUDGET'));
  assert.equal((await f.node('/doc')).count, 0);
  await f.draft('await new Promise(()=>{}); return 1;');
  await f.publish('edit');
  await assert.rejects(f.caller.session.act({ path: '/doc', action: 'edit', args: { value: 1 }, opId: f.caller.key() }).outcome, refused('BUDGET'));
  assert.equal((await f.node('/doc')).count, 0);
});

it('refuses cold startup when the accepted protected action source physically disappears', { timeout: 10_000 }, async t => {
  await mkdir(resolve('./temp'), { recursive: true });
  const directory = await mkdtemp(resolve('./temp/native-action-source-lost-'));
  const first = await fixture(t, { directory });
  await first.draft('return data.value;');
  await first.publish('edit');
  const credential = first.admin.credential;
  assert.ok(credential);
  const source = actionPublicationPath('source.document', 'edit');
  await first.close();
  const retained = await mkdtemp(resolve('./temp/native-action-source-retained-'));
  await rename(resolve(directory, source.slice(1), '$'), resolve(retained, 'source.json'));
  await assert.rejects(fixture(t, { directory, credential }), (error: unknown) => error instanceof KernelError
    && (error.code === 'CONFLICT' || error.code === 'INVALID' || error.code === 'UNAVAILABLE'));
});

it('cancels a streaming source after its accepted piece and keeps late work inactive', { timeout: 10_000 }, async t => {
  const entered = event(), release = event();
  const f = await fixture(t, { provider: async () => { entered.resolve(); await release.promise; return 1; } });
  await f.draft('ctx.change.patch("/doc",{$inc:{count:1}}); yield ctx.node.count; await ctx.io.exchange(1); ctx.change.patch("/doc",{$inc:{count:1}}); return 2;');
  await f.publish('stream', { stream: true, definition: { kind: 'write', args: {}, io: true } });
  const pending = f.caller.session.act({ path: '/doc', action: 'stream', args: {}, opId: f.caller.key() });
  const chunks = pending.chunks[Symbol.asyncIterator]();
  assert.deepEqual(await chunks.next(), { done: false, value: 0 });
  await entered.promise;
  f.caller.session.cancel(pending.id);
  await assert.rejects(pending.outcome, refused('CANCELLED'));
  release.resolve();
  assert.equal((await f.node('/doc')).count, 1);
});


it('keeps a second genuine lane responsive during hostile CPU and terminates the owned VM on actual cancellation', { timeout: 10_000 }, async t => {
  const entered=event();
  const f=await fixture(t,{provider:async()=>{entered.resolve();return 1;}});
  await f.draft('await ctx.io.exchange("busy"); ctx.change.patch("/doc",{$set:{count:100}}); for(;;){}');
  await f.publish('busy',{definition:{kind:'write',args:{},io:true}});
  const pending=f.caller.session.act({path:'/doc',action:'busy',args:{},opId:f.caller.key()});
  await entered.promise;
  const second=await f.instance.openSession();
  const welcome=await second.lane[Symbol.asyncIterator]().next();
  assert.ok(!welcome.done&&welcome.value.t==='welcome');
  const delivery=drainSession(second);
  try {
    const read=await second.read({node:'/doc'});
    assert.ok('node' in read.copies[0]&&read.copies[0].node.count===0);
    await second.commit({opId:{epoch:welcome.value.intake,time:Date.now(),nonce:randomUUID()},changes:[{op:'patch',path:'/draft',ops:{$set:{source:'return "still inactive";'}}}]}).outcome;
    f.caller.session.cancel(pending.id);
    await assert.rejects(pending.outcome,refused('CANCELLED'));
    assert.equal((await f.node('/doc')).count,0);
  } finally { second.close(); await delivery; }
});

it('allows a caught missing-node read followed by a genuine native change', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  await f.draft('try { await ctx.read.read({node:"/missing"}); } catch(error) { if(!(error instanceof Error)||error.code!=="NOT_FOUND") throw error; ctx.change.patch("/doc",{$set:{count:31}}); return error.code; }');
  await f.publish('edit');
  assert.equal((await f.caller.session.act({path:'/doc',action:'edit',args:{value:31},opId:f.caller.key()}).outcome).value, 'NOT_FOUND');
  assert.equal((await f.node('/doc')).count, 31);
});
