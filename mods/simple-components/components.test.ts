// Universal component tests — action contracts

import { randomUUID } from 'node:crypto';
import { KernelError } from '@treenx/core/errors';
import { createTestInstance } from '@treenx/core/kernel/testing';
import { drainSession } from '@treenx/core/kernel/session-delivery';
import { nativeSimpleComponentsManifest } from './native';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const manifest = nativeSimpleComponentsManifest();
function declaredAction(type: string, action: string) {
  const owner = manifest.types.find((owner) => owner.name === type);
  assert.ok(owner, `Native type is absent: ${type}`);
  return owner.actions[action];
}

/** Execute the authored action through a real native session, then read accepted state. */
async function execute<T extends object>(
  type: string,
  action: string,
  component: T,
  args: unknown = {},
) {
  const test = await createTestInstance({
    modules: [manifest],
    seed: [{ $path: '/component', $type: type, ...component }],
    actors: {},
  });
  const session = await test.instance.openSession(test.instance.setupCredential);
  const delivery = drainSession(session);
  try {
    await session.act({
      path: '/component',
      action,
      args,
      opId: { epoch: test.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
    }).outcome;
    const copy = (await session.read({ node: '/component' })).copies[0];
    if ('error' in copy) throw copy.error;
    Object.assign(component, copy.node);
  } finally {
    session.close();
    await delivery;
    await test.close();
  }
}

// ── simple.checklist ──

describe('simple.checklist', () => {
  it('registers add/toggle/remove actions', () => {
    assert.ok(declaredAction('simple.checklist', 'add'));
    assert.ok(declaredAction('simple.checklist', 'toggle'));
    assert.ok(declaredAction('simple.checklist', 'remove'));
  });

  it('add creates an item with id', async () => {
    const comp = { items: [] as { id: number; text: string; done: boolean }[] };
    await execute('simple.checklist', 'add', comp, { text: 'Buy milk' });
    assert.equal(comp.items.length, 1);
    assert.equal(comp.items[0].text, 'Buy milk');
    assert.equal(comp.items[0].done, false);
    assert.equal(typeof comp.items[0].id, 'number');
  });

  it('toggle flips done state by id', async () => {
    const comp = { items: [{ id: 1, text: 'A', done: false }] };
    await execute('simple.checklist', 'toggle', comp, { id: 1 });
    assert.equal(comp.items[0].done, true);
  });

  it('remove deletes item by id', async () => {
    const comp = {
      items: [
        { id: 1, text: 'A', done: false },
        { id: 2, text: 'B', done: false },
      ],
    };
    await execute('simple.checklist', 'remove', comp, { id: 1 });
    assert.equal(comp.items.length, 1);
    assert.equal(comp.items[0].text, 'B');
  });

  it('add throws on empty text', async () => {
    await assert.rejects(
      async () => {
        await execute('simple.checklist', 'add', { items: [] }, { text: '' });
      },
      (err: Error) => err instanceof KernelError && err.code === 'INVALID',
    );
  });

  it('toggle throws on invalid id', async () => {
    await assert.rejects(
      async () => {
        await execute('simple.checklist', 'toggle', { items: [] }, { id: 999 });
      },
      (err: Error) => err instanceof KernelError && err.code === 'NOT_FOUND',
    );
  });
});

// ── simple.tags ──

describe('simple.tags', () => {
  it('registers add/remove actions', () => {
    assert.ok(declaredAction('simple.tags', 'add'));
    assert.ok(declaredAction('simple.tags', 'remove'));
  });

  it('add appends a tag', async () => {
    const comp = { items: ['existing'] };
    await execute('simple.tags', 'add', comp, { tag: 'new' });
    assert.deepEqual(comp.items, ['existing', 'new']);
  });

  it('add deduplicates', async () => {
    const comp = { items: ['bug'] };
    await execute('simple.tags', 'add', comp, { tag: 'bug' });
    assert.equal(comp.items.length, 1);
  });

  it('remove deletes a tag', async () => {
    const comp = { items: ['a', 'b', 'c'] };
    await execute('simple.tags', 'remove', comp, { tag: 'b' });
    assert.deepEqual(comp.items, ['a', 'c']);
  });

  it('add throws on empty tag', async () => {
    await assert.rejects(
      async () => {
        await execute('simple.tags', 'add', { items: [] }, { tag: '  ' });
      },
      (err: Error) => err instanceof KernelError && err.code === 'INVALID',
    );
  });
});

// ── simple.estimate ──

describe('simple.estimate', () => {
  it('registers update action', () => {
    assert.ok(declaredAction('simple.estimate', 'update'));
  });

  it('update sets value and unit', async () => {
    const comp = { value: 0, unit: 'hours' };
    await execute('simple.estimate', 'update', comp, { value: 5, unit: 'points' });
    assert.equal(comp.value, 5);
    assert.equal(comp.unit, 'points');
  });

  it('update keeps unit if not provided', async () => {
    const comp = { value: 0, unit: 'days' };
    await execute('simple.estimate', 'update', comp, { value: 3 });
    assert.equal(comp.value, 3);
    assert.equal(comp.unit, 'days');
  });

  it('update throws on negative value', async () => {
    await assert.rejects(
      async () => {
        await execute('simple.estimate', 'update', { value: 0, unit: 'hours' }, { value: -1 });
      },
      (err: Error) => err instanceof KernelError && err.code === 'INVALID',
    );
  });
});

// ── simple.links ──

describe('simple.links', () => {
  it('registers add/remove actions', () => {
    assert.ok(declaredAction('simple.links', 'add'));
    assert.ok(declaredAction('simple.links', 'remove'));
  });

  it('add creates a link with id', async () => {
    const comp = { items: [] as { id: number; url: string; label: string }[] };
    await execute('simple.links', 'add', comp, { url: 'https://x.com', label: 'X' });
    assert.equal(comp.items.length, 1);
    assert.equal(comp.items[0].url, 'https://x.com');
    assert.equal(comp.items[0].label, 'X');
    assert.equal(typeof comp.items[0].id, 'number');
  });

  it('add uses empty label by default', async () => {
    const comp = { items: [] as { id: number; url: string; label: string }[] };
    await execute('simple.links', 'add', comp, { url: 'https://x.com' });
    assert.equal(comp.items[0].label, '');
  });

  it('remove deletes by id', async () => {
    const comp = {
      items: [
        { id: 1, url: 'a', label: '' },
        { id: 2, url: 'b', label: '' },
      ],
    };
    await execute('simple.links', 'remove', comp, { id: 1 });
    assert.equal(comp.items.length, 1);
    assert.equal(comp.items[0].url, 'b');
  });

  it('add throws on empty url', async () => {
    await assert.rejects(
      async () => {
        await execute('simple.links', 'add', { items: [] }, { url: '' });
      },
      (err: Error) => err instanceof KernelError && err.code === 'INVALID',
    );
  });
});

// ── simple.comments ──

describe('simple.comments', () => {
  it('registers add action', () => {
    assert.ok(declaredAction('simple.comments', 'add'));
  });

  it('add creates a comment with timestamp', async () => {
    const comp = { items: [] as { author: string; text: string; createdAt: number }[] };
    const before = Date.now();
    await execute('simple.comments', 'add', comp, { text: 'hello', author: 'bob' });
    assert.equal(comp.items.length, 1);
    assert.equal(comp.items[0].text, 'hello');
    assert.equal(comp.items[0].author, 'bob');
    assert.ok(comp.items[0].createdAt >= before);
  });

  it('add defaults author to anonymous', async () => {
    const comp: { items: { author: string; text: string; createdAt: number }[] } = { items: [] };
    await execute('simple.comments', 'add', comp, { text: 'hi' });
    assert.equal(comp.items[0].author, 'anonymous');
  });

  it('add throws on empty text', async () => {
    await assert.rejects(
      async () => {
        await execute('simple.comments', 'add', { items: [] }, { text: '' });
      },
      (err: Error) => err instanceof KernelError && err.code === 'INVALID',
    );
  });
});

// ── simple.time-track ──

describe('simple.time-track', () => {
  it('registers start/stop actions', () => {
    assert.ok(declaredAction('simple.time-track', 'start'));
    assert.ok(declaredAction('simple.time-track', 'stop'));
  });

  it('start creates an entry and sets running', async () => {
    const comp = { entries: [] as { start: number; end: number }[], running: false };
    const before = Date.now();
    await execute('simple.time-track', 'start', comp);
    assert.equal(comp.running, true);
    assert.equal(comp.entries.length, 1);
    assert.ok(comp.entries[0].start >= before);
    assert.equal(comp.entries[0].end, 0);
  });

  it('stop closes the entry and clears running', async () => {
    const before = Date.now();
    const comp = { entries: [{ start: before - 1000, end: 0 }], running: true };
    await execute('simple.time-track', 'stop', comp);
    assert.equal(comp.running, false);
    assert.ok(comp.entries[0].end >= before);
  });

  it('start throws if already running', async () => {
    await assert.rejects(
      async () => {
        await execute('simple.time-track', 'start', { entries: [], running: true });
      },
      (err: Error) => err instanceof KernelError && err.code === 'CONFLICT',
    );
  });

  it('stop throws if not running', async () => {
    await assert.rejects(
      async () => {
        await execute('simple.time-track', 'stop', { entries: [], running: false });
      },
      (err: Error) => err instanceof KernelError && err.code === 'CONFLICT',
    );
  });
});
