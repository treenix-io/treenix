import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { R, W, type Node, type Position } from '@treenx/core/kernel/types';
import { createInstance } from '../../core/src/kernel/instance';
import { createMemoryStore } from '@treenx/core/kernel/store/memory';
import { createMemoryBlobStore } from '@treenx/core/kernel/blob-store-memory';
import { drainSession } from '@treenx/core/kernel/session-delivery';
import createNativeSensor from './kernel';
import createNativeGenerator from '../sensor-generator/kernel';

it(
  'streams registered readings and runs the configured sensor with its latest ten readings',
  { timeout: 10000 },
  async (test) => {
    const sensor = createNativeSensor(),
      generator = createNativeGenerator();
    const id = randomUUID(),
      store = createMemoryStore({ domain: id });
    let saved: Position | undefined;
    const instance = await createInstance({
      id,
      root: { kind: 'store', store },
      blobs: createMemoryBlobStore(),
      modules: [sensor.manifest, generator.manifest],
      io: generator.io,
      provisioning: {
        writerEpoch: 1,
        domains: [{ store, epoch: randomUUID(), persistent: false }],
        credentialTtlMs: 60000,
        counter: {
          async load() {
            return saved;
          },
          async save(position) {
            saved = position;
          },
          async freshEpoch(floor) {
            return floor + 1;
          },
        },
        bootstrap: {
          kind: 'fresh',
          admin: { path: '/admin', name: 'admin', password: randomUUID() },
        },
      },
    });
    test.after(() => instance.close());
    const admin = await instance.openSession(instance.setupCredential),
      delivery = drainSession(admin);
    test.after(async () => {
      admin.close();
      await delivery;
    });
    const key = () => ({
      epoch: instance.writer.intake.epoch,
      time: Date.now(),
      nonce: randomUUID(),
    });

    /** Read real projections without hiding refusals. */
    async function read(path: string): Promise<Node> {
      const copy = (await admin.read({ node: path })).copies[0];
      if ('error' in copy) throw copy.error;
      return copy.node;
    }
    /** Use native actions for all sensor mutations. */
    async function act(action: string, args: unknown = {}) {
      return (await admin.act({ path: '/sensor', action, args, opId: key() }).outcome).value;
    }

    await admin.commit({
      opId: key(),
      changes: [
        { op: 'put', node: { $path: '/sensor', $type: 'examples.demo.sensor', baseValue: 20 } },
        { op: 'put', node: { $path: '/generator', $type: 'examples.demo.generator' } },
      ],
    }).outcome;
    const scan = admin.act({
      path: '/generator',
      action: 'scan',
      args: { count: 3, delay: 0 },
      opId: key(),
    });
    const pieces: unknown[] = [];
    for await (const piece of scan.chunks) pieces.push(piece);
    await scan.outcome;
    assert.equal(pieces.length, 3);
    const scanned = (await admin.read({ children: '/generator' })).copies;
    assert.equal(scanned.length, 3);
    for (const copy of scanned) {
      if ('error' in copy) throw copy.error;
      assert.equal(copy.node.$type, 'examples.demo.sensor.reading');
    }

    await act('setBase', { value: 50 });
    assert.equal((await read('/sensor')).baseValue, 50);
    for (let i = 0; i < 11; i++) await act('tick');
    const retained = (await admin.read({ children: '/sensor' })).copies;
    assert.equal(retained.length, 10);
    const retainedIds = new Set(
      retained.map((copy) => {
        if ('error' in copy) throw copy.error;
        assert.ok(
          typeof copy.node.value === 'number' && copy.node.value >= 45 && copy.node.value <= 57,
        );
        return copy.node.$id;
      }),
    );

    const current = await read('/sensor');
    await admin.commit({
      opId: key(),
      expect: { nodes: [{ path: '/sensor', rev: current.$rev }] },
      changes: [
        {
          op: 'patch',
          path: '/sensor',
          ops: {
            $set: {
              $acl: [{ subject: { group: `n:${current.$id}` }, grant: R | W }],
            },
          },
        },
      ],
    }).outcome;
    const observer = await instance.openSession(instance.setupCredential);
    observer.sub({ children: '/sensor' });
    let acceptReading = (_node: Node) => {};
    const arrived = new Promise<Node>((resolve) => {
      acceptReading = resolve;
    });
    const observed = (async () => {
      for await (const frame of observer.lane) {
        if (frame.t !== 'pos' || frame.coverage === true) continue;
        for (const change of frame.changes) {
          if (change.op !== 'put') continue;
          if ('error' in change.copy) throw change.copy.error;
          if (
            change.copy.node.$type === 'examples.demo.sensor.reading' &&
            !retainedIds.has(change.copy.node.$id)
          )
            acceptReading(change.copy.node);
        }
      }
    })();
    test.after(async () => {
      observer.close();
      await observed;
    });
    const nodeSession = await instance.openNodeSession('/sensor');
    const service = sensor.manifest.security[0];
    assert.ok(service.context === 'service');
    const run = await service.handler(await read('/sensor'), nodeSession);
    test.after(async () => {
      nodeSession.close();
      await run.stop();
    });
    assert.equal((await arrived).seq, 11);
    assert.equal((await admin.read({ children: '/sensor' })).copies.length, 10);
  },
);
