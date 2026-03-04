// Pre/post condition warnings (Design by Contract)
// @pre fields warn if empty before action; @post fields warn if unchanged after

import { registerType } from '#comp';
import { createNode, register } from '#core';
import { clearRegistry } from '#core/index.test';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { executeAction } from './actions';

// Test component with pre/post conditions declared in schema
class Ticket {
  status = '';
  assignee = '';
  resolvedAt = 0;

  close() {
    this.status = 'closed';
    this.resolvedAt = Date.now();
  }

  noop() {
    // intentionally does nothing — postcondition should warn
  }
}

describe('pre/post action conditions', () => {
  beforeEach(() => {
    clearRegistry();
    registerType('test.ticket', Ticket);
    // Schema with pre/post arrays
    register('test.ticket', 'schema', () => ({
      $id: 'test.ticket',
      type: 'object',
      properties: {
        status: { type: 'string' },
        assignee: { type: 'string' },
        resolvedAt: { type: 'number' },
      },
      methods: {
        close: {
          description: 'Close the ticket',
          pre: ['status', 'assignee'],
          post: ['status', 'resolvedAt'],
          arguments: [],
        },
        noop: {
          description: 'Does nothing',
          post: ['status'],
          arguments: [],
        },
      },
    }));
  });

  afterEach(() => clearRegistry());

  it('warns when @pre fields are empty', async () => {
    const store = createMemoryTree();
    await store.set({ ...createNode('/t/1', 'test.ticket'), status: '', assignee: '' });

    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: any[]) => warnings.push(args.join(' '));

    try {
      await executeAction(store, '/t/1', undefined, undefined, 'close');
    } finally {
      console.warn = orig;
    }

    assert.ok(warnings.some(w => w.includes('[pre]') && w.includes('status')), 'should warn about empty status');
    assert.ok(warnings.some(w => w.includes('[pre]') && w.includes('assignee')), 'should warn about empty assignee');
  });

  it('no pre warning when fields are filled', async () => {
    const store = createMemoryTree();
    await store.set({ ...createNode('/t/2', 'test.ticket'), status: 'open', assignee: 'alice' });

    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: any[]) => warnings.push(args.join(' '));

    try {
      await executeAction(store, '/t/2', undefined, undefined, 'close');
    } finally {
      console.warn = orig;
    }

    assert.ok(!warnings.some(w => w.includes('[pre]')), `unexpected pre warnings: ${warnings}`);
  });

  it('warns when @post fields are unchanged', async () => {
    const store = createMemoryTree();
    await store.set({ ...createNode('/t/3', 'test.ticket'), status: 'open', assignee: 'bob' });

    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: any[]) => warnings.push(args.join(' '));

    try {
      await executeAction(store, '/t/3', undefined, undefined, 'noop');
    } finally {
      console.warn = orig;
    }

    assert.ok(warnings.some(w => w.includes('[post]') && w.includes('status')),
      `should warn about unchanged status. Warnings: ${warnings}`);
  });

  it('no post warning when fields change', async () => {
    const store = createMemoryTree();
    await store.set({ ...createNode('/t/4', 'test.ticket'), status: 'open', assignee: 'alice' });

    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: any[]) => warnings.push(args.join(' '));

    try {
      await executeAction(store, '/t/4', undefined, undefined, 'close');
    } finally {
      console.warn = orig;
    }

    assert.ok(!warnings.some(w => w.includes('[post]')), `unexpected post warnings: ${warnings}`);
  });
});
