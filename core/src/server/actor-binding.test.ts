// core-anz4.14 — actor-bound trees: attribution must survive every mutation lane.
// Contract under test: the ctx forwarded to the underlying tree's mutation verbs
// carries the full ActorContext (exactly what mods/audit getActor(ctx) consumes),
// and neither node payloads nor wire input can override the bound actor.
//
// NO clearRegistry here: the autostart integration test relies on module-level
// registrations ('#mods/autostart/service'); type names are unique to this file.

import '#mods/autostart/service';

import { A, createNode, type NodeData, R, register, S, W } from '#core';
import { withAcl } from '#security/acl-tree';
import type { Session } from '#security/sessions';
import { createMemoryTree, type PatchOp, type Tree } from '#tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ActionCtx, type ActorContext, buildActor, executeAction, withActor } from './actions';
import { treenix } from './factory';

type Recorded = { verb: 'set' | 'patch' | 'remove'; path: string; ctx: unknown };

function probeTree(inner: Tree): { tree: Tree; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const tree: Tree = {
    ...inner,
    set: (node: NodeData, ctx?: unknown) => { recorded.push({ verb: 'set', path: node.$path, ctx }); return inner.set(node, ctx); },
    patch: (path: string, ops: PatchOp[], ctx?: unknown) => { recorded.push({ verb: 'patch', path, ctx }); return inner.patch(path, ops, ctx); },
    remove: (path: string, ctx?: unknown) => { recorded.push({ verb: 'remove', path, ctx }); return inner.remove(path, ctx); },
  };
  return { tree, recorded };
}

// Mirror of mods/audit with-audit.ts getActor — the actual consumer of this contract.
function actorOf(ctx: unknown): ActorContext | undefined {
  if (ctx && typeof ctx === 'object' && 'actor' in ctx) {
    const a = (ctx as Record<string, unknown>).actor;
    if (a && typeof a === 'object' && 'id' in a) return a as ActorContext;
  }
  return undefined;
}

describe('actor-bound ctx.tree in actions (core-anz4.14)', () => {
  it('handler cross-node write carries the rich actor; payload actor cannot override it', async () => {
    register('anz414w', 'schema', () => ({
      $id: 'anz414w', title: 'W', type: 'object' as const, properties: {},
      methods: { fanout: { arguments: [] } },
    }));
    register('anz414w', 'action:fanout', async (ctx: ActionCtx) => {
      (ctx.node as NodeData & { count?: number }).count = 1;
      // Payload carries a forged `actor` FIELD — it is data, never ctx.
      await ctx.tree.set({ $path: '/other', $type: 'leaf', actor: { id: 'evil' } });
    });

    const mem = createMemoryTree();
    await mem.set({ $path: '/', $type: 'root', $acl: [{ g: 'authenticated', p: R | W | S }] });
    await mem.set(createNode('/n', 'anz414w'));
    const { tree: probe, recorded } = probeTree(mem);
    const acl = withAcl(probe, 'user:alice', ['u:user:alice', 'authenticated']);

    const actor: ActorContext = { id: 'user:alice', action: 'fanout', requestId: 'req-1' };
    await executeAction(acl, '/n', undefined, undefined, 'fanout', undefined, {
      userId: 'user:alice', claims: ['u:user:alice', 'authenticated'], actor,
    });

    // Foreign-path write: rich actor (action + requestId), NOT bare {id}, NOT the payload's.
    const foreign = recorded.find(r => r.verb === 'set' && r.path === '/other');
    assert.ok(foreign, 'foreign write not observed');
    assert.deepEqual(actorOf(foreign.ctx), actor);

    // The action's own draft commit is attributed too.
    const own = recorded.find(r => r.verb === 'patch' && r.path === '/n');
    assert.ok(own, 'own-draft commit not observed');
    assert.deepEqual(actorOf(own.ctx), actor);
  });

  it('direct verb without bound actor falls back to the ACL default stamp', async () => {
    const mem = createMemoryTree();
    await mem.set({ $path: '/', $type: 'root', $acl: [{ g: 'authenticated', p: R | W | S }] });
    const { tree: probe, recorded } = probeTree(mem);
    const acl = withAcl(probe, 'user:alice', ['authenticated']);

    // Node payload smuggles an `actor` field — must not become ctx identity.
    await acl.set({ $path: '/spoof', $type: 'leaf', actor: { id: 'evil' } });

    const rec = recorded.find(r => r.path === '/spoof');
    assert.ok(rec);
    assert.deepEqual(actorOf(rec.ctx), { id: 'user:alice' });
  });
});

describe('withActor (core-anz4.14)', () => {
  it('stamps the bound actor on every verb and preserves other ctx fields', async () => {
    const { tree: probe, recorded } = probeTree(createMemoryTree());
    const bound = withActor(probe, { id: 'service:/svc/x' });

    await bound.set({ $path: '/a', $type: 'leaf' }, { opId: 'op-1' });
    await bound.remove('/a');

    const setRec = recorded.find(r => r.verb === 'set');
    assert.deepEqual(setRec?.ctx, { opId: 'op-1', actor: { id: 'service:/svc/x' } });
    const rmRec = recorded.find(r => r.verb === 'remove');
    assert.deepEqual(actorOf(rmRec?.ctx), { id: 'service:/svc/x' });
  });

  it('inner binds refine: the more specific outer wrap wins, explicit in-process ctx.actor wins over both', async () => {
    const { tree: probe, recorded } = probeTree(createMemoryTree());
    const layered = withActor(withActor(probe, { id: 'system:autostart' }), { id: 'service:/svc/y' });

    await layered.set({ $path: '/b', $type: 'leaf' });
    assert.equal(actorOf(recorded[0].ctx)?.id, 'service:/svc/y');

    const explicit: ActorContext = { id: 'user:alice', action: 'nested', requestId: 'r2' };
    await layered.set({ $path: '/c', $type: 'leaf' }, { actor: explicit });
    assert.deepEqual(actorOf(recorded[1].ctx), explicit);
  });
});

describe('buildActor — the one session→actor mapping (core-anz4.14)', () => {
  it('carries workload session metadata and the caller opId', () => {
    const session: Session = {
      userId: 'agent-workload:r-1', claims: ['agents'],
      onBehalfOf: 'user:kriz', taskPath: '/board/tasks/1', runPath: '/agents/x/runs/r-1',
    };
    assert.deepEqual(buildActor(session, 'doit', 'op-9'), {
      id: 'agent-workload:r-1', action: 'doit', requestId: 'op-9',
      onBehalfOf: 'user:kriz', taskPath: '/board/tasks/1', runPath: '/agents/x/runs/r-1',
    });
  });

  it('mints a requestId without opId; absent metadata stays absent', () => {
    const a = buildActor({ userId: 'u1' }, 'go');
    assert.equal(a.id, 'u1');
    assert.equal(a.action, 'go');
    assert.equal(typeof a.requestId, 'string');
    assert.equal(a.onBehalfOf, undefined);
    assert.equal(a.taskPath, undefined);
    assert.equal(a.runPath, undefined);
  });
});

describe('autostart service attribution (core-anz4.14)', () => {
  it('a service write is attributed as service:<path>, not anonymous', async () => {
    register('anz414svc', 'service', async (node: NodeData, ctx) => {
      await ctx.tree.set({ $path: '/srv/out', $type: 'leaf', ok: 1 });
      return { stop: async () => {} };
    });

    const recorded: Recorded[] = [];
    const rootNode = createNode('/', 'root');
    rootNode.$acl = [{ g: 'system', p: R | W | A | S }];

    const app = await treenix({
      modsDir: false,
      autostart: true,
      rootNode,
      seed: async (t) => {
        await t.set({ $path: '/sys/autostart', $type: 'autostart' });
        await t.set(createNode('/srv/writer', 'anz414svc'));
        await t.set({ $path: '/sys/autostart/srv-writer', $type: 'ref', $ref: '/srv/writer' });
      },
      // withAudit's position: whatever ctx arrives here is what audit journals.
      wrapTree: (inner) => ({
        ...inner,
        set: (node: NodeData, ctx?: unknown) => { recorded.push({ verb: 'set', path: node.$path, ctx }); return inner.set(node, ctx); },
      }),
    });

    try {
      const rec = recorded.find(r => r.path === '/srv/out');
      assert.ok(rec, `service write not observed; saw [${recorded.map(r => r.path).join(',')}]`);
      assert.equal(actorOf(rec.ctx)?.id, 'service:/srv/writer');
    } finally {
      await app.stop();
    }
  });
});
