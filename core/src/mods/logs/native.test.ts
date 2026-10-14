import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { it } from 'node:test';
import { openNativeDeployment } from '#server/native-deployment';
import { createLogsInput } from './input';
import { KernelError } from '#errors';

it('keeps each deployment input separate and releases its actual subscriber', () => {
  const first = createLogsInput(),
    second = createLogsInput();
  const received: string[] = [];
  first.emit({ t: 1, level: 'info', msg: 'first' });
  second.emit({ t: 2, level: 'info', msg: 'second' });
  const close = first.subscribe((entry) => received.push(entry.msg));
  assert.deepEqual(received, ['first']);
  close();
  first.emit({ t: 3, level: 'info', msg: 'after retirement' });
  assert.deepEqual(received, ['first']);
  const release = first.subscribe((entry) => received.push(entry.msg));
  assert.deepEqual(received, ['first', 'after retirement']);
  release();
  const other: string[] = [];
  second.subscribe((entry) => other.push(entry.msg))();
  assert.deepEqual(other, ['second']);
});

it('refuses bounded deployment input overflow loudly without losing admitted messages', () => {
  const input = createLogsInput();
  for (let i = 0; i < 1000; i++) input.emit({ t: i, level: 'info', msg: String(i) });
  assert.throws(
    () => input.emit({ t: 1000, level: 'info', msg: 'overflow' }),
    (error) => error instanceof KernelError && error.code === 'BUDGET',
  );
  const received: number[] = [];
  input.subscribe((entry) => received.push(entry.t))();
  assert.equal(received.length, 1000);
  assert.equal(received.at(-1), 999);
});

it(
  'provisions a real dynamic Fs logs mount, appends through autostart and reads after cold reopen',
  { timeout: 15_000 },
  async (t) => {
    const parent = resolve('../../temp/native-logs-fixtures');
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'instance-')),
      logs = join(directory, 'logs');
    const config = {
      runtime: {
        id: `logs:${randomUUID()}`,
        directory: join(directory, 'root'),
        credentialTtlMs: 60_000,
        mountDirectories: { logs },
        firstAdmin: { path: '/admin', name: 'Admin', password: 'native-logs-fixture' },
      },
      modules: [
        { id: '@treenx/core/logs', entry: new URL('./kernel.ts', import.meta.url).href },
        {
          id: '@treenx/core/autostart',
          entry: new URL('../autostart/kernel.ts', import.meta.url).href,
        },
      ],
      persistentLogs: { directory: 'logs' },
    };
    const first = await openNativeDeployment(config);
    t.after(() => first.close());
    const credential = first.instance.setupCredential;
    assert.ok(credential !== undefined);
    const session = await first.instance.openSession(credential);
    const lane = session.lane[Symbol.asyncIterator]();
    const welcome = await lane.next();
    assert.ok(!welcome.done && welcome.value.t === 'welcome');
    let intake = welcome.value.intake,
      changed = () => {},
      generation = 0;
    const delivery = (async () => {
      for (;;) {
        const next = await lane.next();
        if (next.done) return;
        if (next.value.t === 'end') throw next.value.error;
        if (
          next.value.t === 'pos' &&
          next.value.coverage !== true &&
          next.value.intake !== undefined
        )
          intake = next.value.intake;
        generation++;
        changed();
      }
    })();
    t.after(async () => {
      session.close();
      await delivery;
    });
    session.sub({ children: '/sys/logs' });
    await first.instance.prepareServices();
    first.logs.emit({ t: 101, level: 'warn', msg: 'owned persistent message' });
    let id: string | undefined, recordPath: string | undefined;
    for (;;) {
      const seen = generation;
      const result = await session.read({ children: '/sys/logs' });
      const nodes = result.copies.map((copy) => {
        if ('error' in copy) throw copy.error;
        return copy.node;
      });
      const found = nodes.find((node) => node.msg === 'owned persistent message');
      if (found !== undefined) {
        id = found.$id;
        recordPath = found.$path.slice('/sys/logs/'.length);
        break;
      }
      if (seen === generation)
        await new Promise<void>((resolve) => {
          changed = resolve;
        });
    }
    const queried = await session.act({
      path: '/sys/logs',
      action: 'query',
      args: {},
      opId: { epoch: intake, time: Date.now(), nonce: randomUUID() },
    }).outcome;
    assert.ok(queried !== undefined);
    assert.ok(recordPath !== undefined);
    assert.equal(
      JSON.parse(await readFile(join(logs, recordPath, '$'), 'utf8')).msg,
      'owned persistent message',
    );
    session.close();
    await delivery;
    await first.close();
    const reopened = await openNativeDeployment(config);
    t.after(() => reopened.close());
    const saved = await reopened.instance.openSession(
      await reopened.instance.auth.login({ account: '/admin', password: 'native-logs-fixture' }),
    );
    const frames = saved.lane[Symbol.asyncIterator]();
    await frames.next();
    const drain = (async () => {
      while (!(await frames.next()).done) {}
    })();
    t.after(async () => {
      saved.close();
      await drain;
    });
    const result = await saved.read({ children: '/sys/logs' });
    const nodes = result.copies.map((copy) => {
      if ('error' in copy) throw copy.error;
      return copy.node;
    });
    const copy = nodes.find((node) => node.$id === id);
    assert.ok(copy !== undefined);
    assert.equal(copy.msg, 'owned persistent message');
  },
);
