import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { openNativeDeployment } from '#server/native-deployment';
import { drainSession } from '#kernel/session-delivery';
import type { Node, Session } from '#kernel/types';

/** Read accepted copies so startup schema and permission failures remain visible. */
async function read(session: Session, path: string): Promise<Node> {
  const copy = (await session.read({ node: path })).copies[0];
  assert.ok('node' in copy);
  return copy.node;
}

it(
  'installs the named core and auth seeds while retaining the actual bootstrap account across restart',
  { timeout: 15000 },
  async (test) => {
    const parent = fileURLToPath(
      new URL('../../../../temp/native-core-seeds-first-pass/', import.meta.url),
    );
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'instance-'));
    const config = {
      runtime: {
        id: randomUUID(),
        directory,
        credentialTtlMs: 60000,
        firstAdmin: { path: '/admin', name: 'admin', password: 'fixture-password' },
      },
      modules: [
        ...['platform', 'auth', 'autostart'].map((name) => ({
          id: `@treenx/core/${name}`,
          entry: new URL(`../mods/${name}/kernel.ts`, import.meta.url).href,
        })),
        {
          id: '@treenx/core/prefab',
          entry: new URL('../../../mods/prefab/kernel.ts', import.meta.url).href,
        },
      ],
      seedFilter: ['core', 'auth'],
    };
    const runtimes: Awaited<ReturnType<typeof openNativeDeployment>>[] = [];
    const deliveries: Promise<void>[] = [];
    test.after(async () => {
      for (const runtime of runtimes.reverse()) await runtime.close();
      await Promise.all(deliveries);
    });

    /** Track only acquired runtimes; bootstrap errors must fail this workflow directly. */
    async function open() {
      const runtime = await openNativeDeployment(config);
      runtimes.push(runtime);
      return runtime;
    }

    const first = await open();
    assert.ok(first.instance.setupCredential);
    const credential = first.instance.setupCredential;
    const session = await first.instance.openSession(credential);
    deliveries.push(drainSession(session));
    const account = await read(session, '/admin');
    assert.equal(account.$type, 't.user');
    assert.equal((await read(session, '/sys/autostart')).$type, 't.autostart');
    assert.equal((await read(session, '/sys/routes')).$type, 't.dir');
    assert.equal((await read(session, '/sys/mods/core/prefabs/seed')).mod, 'core');
    assert.equal((await read(session, '/sys/mods/auth/prefabs/seed')).mod, 'auth');
    assert.equal((await read(session, '/proc')).$type, 't.mount-point');
    await first.close();

    const reopened = await open();
    const login = await reopened.instance.auth.login({
      account: '/admin',
      password: 'fixture-password',
    });
    const reader = await reopened.instance.openSession(login);
    deliveries.push(drainSession(reader));
    assert.equal((await read(reader, '/admin')).$id, account.$id);
    assert.equal((await read(reader, '/sys/mods/core/prefabs/seed')).mod, 'core');
  },
);
