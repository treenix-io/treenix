import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import prefabModule from '@treenx/mods/prefab/kernel';
import { drainSession } from '@treenx/core/kernel/session-delivery';
import type { Node, Session } from '@treenx/core/kernel/types';
import { openNativeRuntime } from '../../core/src/kernel/runtime';
import { installNativeSeeds } from '@treenx/mods/prefab/install';
import createNativeDoc from '../doc/kernel';
import createNativeOnboarding from './kernel';

/** Read accepted native copies and surface schema failures at their source. */
async function read(session: Session, path: string): Promise<Node> {
  const copy = (await session.read({ node: path })).copies[0];
  assert.ok('node' in copy);
  return copy.node;
}

it(
  'opens the existing welcome route, edits a real Markdown file and retains native identity after reopen',
  { timeout: 15000 },
  async (test) => {
    const parent = fileURLToPath(
      new URL('../../../temp/native-rawfs-first-pass/', import.meta.url),
    );
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'instance-'));
    const docs = join(directory, 'docs');
    await mkdir(docs);
    await writeFile(
      join(docs, 'welcome.md'),
      '---\ntitle: Welcome\nsection: start\n---\n\n# Heading\n\nRead [next](./next.md).\n',
    );
    await writeFile(join(docs, 'next.md'), '# Next\n\nSecond document.\n');
    await writeFile(
      join(docs, 'settings.json'),
      JSON.stringify({
        $type: 'doc.page',
        title: 'Settings',
        content: { type: 'doc', content: [] },
      }),
    );
    const document = createNativeDoc(),
      onboarding = createNativeOnboarding();
    assert.ok(document.seeds);
    assert.ok(onboarding.seeds);
    const input = {
      id: randomUUID(),
      directory: join(directory, 'root'),
      credentialTtlMs: 60000,
      firstAdmin: { path: '/admin', name: 'admin', password: 'fixture-password' },
      modules: [document.manifest, onboarding.manifest, (await prefabModule()).manifest],
      mountDirectories: { docs },
      rawfsCodecs: document.rawfsCodecs,
    };
    const runtimes: Awaited<ReturnType<typeof openNativeRuntime>>[] = [];
    const deliveries: Promise<void>[] = [];
    test.after(async () => {
      for (const runtime of runtimes.reverse()) await runtime.close();
      await Promise.all(deliveries);
    });

    /** Register only acquired owners so failed construction remains a visible failure. */
    async function open() {
      const runtime = await openNativeRuntime(input);
      runtimes.push(runtime);
      return runtime;
    }

    const first = await open();
    assert.ok(first.instance.setupCredential);
    const credential = first.instance.setupCredential;
    const installer = await first.instance.openSession(credential);
    deliveries.push(drainSession(installer));
    await installNativeSeeds(installer, {
      sources: [...document.seeds.sources, ...onboarding.seeds.sources],
      prefabs: [...document.seeds.prefabs, ...onboarding.seeds.prefabs],
      opId: { epoch: first.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
    });
    await first.close();

    const runtime = await open();
    const session = await runtime.instance.openSession(credential);
    deliveries.push(drainSession(session));
    assert.equal((await read(session, '/sys/routes/_index')).$ref, '/docs/welcome.md');
    const page = await read(session, '/docs/welcome.md');
    assert.equal(page.$type, 'doc.page');
    assert.equal(page.title, 'Welcome');
    assert.equal(page.$id, 'p:/docs/welcome.md');
    assert.ok(JSON.stringify(page.content).includes('/docs/next.md'));
    assert.equal((await read(session, '/docs/settings.json')).title, 'Settings');
    const children = await session.read({ children: '/docs', window: { limit: 10 } });
    assert.equal(children.copies.length, 3);

    await session.commit({
      opId: { epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
      changes: [
        {
          op: 'patch',
          path: page.$path,
          ops: {
            $set: {
              title: 'Edited welcome',
              '#frontmatter.title': 'Edited welcome',
              note: 'Retained native metadata',
            },
          },
        },
      ],
    }).outcome;
    assert.ok((await readFile(join(docs, 'welcome.md'), 'utf8')).includes('# Edited welcome'));
    await runtime.close();

    const reopened = await open();
    const reader = await reopened.instance.openSession(credential);
    deliveries.push(drainSession(reader));
    const edited = await read(reader, page.$path);
    assert.equal(edited.$id, page.$id);
    assert.equal(edited.title, 'Edited welcome');
    assert.equal(edited.note, 'Retained native metadata');
  },
);
