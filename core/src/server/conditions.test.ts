// Pre/post condition warnings (Design by Contract)
// pre — a sift query over { node, needs } — warns when it does not hold before the action;
// the own node's post fields warn when the action leaves them unchanged

import { registerType } from '#comp';
import { createNode, register } from '#core';
import { clearRegistry } from '#testing';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { executeAction } from './actions';

// Test component with pre/post conditions declared in schema
class Ticket {
  status = '';
  assignee = '';
  closes = 0;

  close() {
    this.status = 'closed';
    this.closes += 1;
  }

  noop() {
    // intentionally does nothing — postcondition should warn
  }

  approve() {}
}

async function warningsOf(run: () => Promise<unknown>): Promise<string[]> {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(' '));

  try {
    await run();
  } finally {
    console.warn = orig;
  }
  return warnings;
}

describe('pre/post action conditions', () => {
  beforeEach(() => {
    clearRegistry();
    registerType('test.ticket', Ticket, { needs: { approve: ['review'] } });
    register('test.ticket', 'schema', () => ({
      $id: 'test.ticket',
      title: 'test.ticket', type: 'object' as const,
      properties: {
        status: { type: 'string' },
        assignee: { type: 'string' },
        closes: { type: 'number' },
      },
      methods: {
        close: {
          description: 'Close the ticket',
          pre: { 'node.status': { $ne: '' }, 'node.assignee': { $ne: '' } },
          post: { '': { $set: { status: 'closed' }, $inc: { closes: 1 } } },
          arguments: [],
        },
        noop: {
          description: 'Does nothing',
          post: { '': { $set: { status: 'closed' } } },
          arguments: [],
        },
        approve: {
          description: 'Approve after review',
          pre: { 'needs.review.ok': true },
          arguments: [],
        },
      },
    }));
  });

  afterEach(() => clearRegistry());

  it('warns when pre does not hold', async () => {
    const tree = createMemoryTree();
    await tree.set({ ...createNode('/t/1', 'test.ticket'), status: '', assignee: '' });

    const warnings = await warningsOf(() => executeAction(tree, '/t/1', undefined, undefined, 'close'));

    assert.ok(warnings.some(w => w.includes('[pre]') && w.includes('test.ticket.close')), `warnings: ${warnings}`);
  });

  it('no pre warning when pre holds', async () => {
    const tree = createMemoryTree();
    await tree.set({ ...createNode('/t/2', 'test.ticket'), status: 'open', assignee: 'alice' });

    const warnings = await warningsOf(() => executeAction(tree, '/t/2', undefined, undefined, 'close'));

    assert.ok(!warnings.some(w => w.includes('[pre]')), `unexpected pre warnings: ${warnings}`);
  });

  it('pre reads the action needs', async () => {
    const tree = createMemoryTree();
    const review = (ok: boolean) => ({ $type: 'test.review', ok });
    await tree.set({ ...createNode('/t/5', 'test.ticket'), '#review': review(false) });
    await tree.set({ ...createNode('/t/6', 'test.ticket'), '#review': review(true) });

    const rejected = await warningsOf(() => executeAction(tree, '/t/5', undefined, undefined, 'approve'));
    const approved = await warningsOf(() => executeAction(tree, '/t/6', undefined, undefined, 'approve'));

    assert.ok(rejected.some(w => w.includes('[pre]') && w.includes('test.ticket.approve')), `warnings: ${rejected}`);
    assert.ok(!approved.some(w => w.includes('[pre]')), `unexpected pre warnings: ${approved}`);
  });

  it('warns when a post field of the own node is unchanged', async () => {
    const tree = createMemoryTree();
    await tree.set({ ...createNode('/t/3', 'test.ticket'), status: 'open', assignee: 'bob' });

    const warnings = await warningsOf(() => executeAction(tree, '/t/3', undefined, undefined, 'noop'));

    assert.ok(warnings.some(w => w.includes('[post]') && w.includes('status')),
      `should warn about unchanged status. Warnings: ${warnings}`);
  });

  it('no post warning when the fields change', async () => {
    const tree = createMemoryTree();
    await tree.set({ ...createNode('/t/4', 'test.ticket'), status: 'open', assignee: 'alice' });

    const warnings = await warningsOf(() => executeAction(tree, '/t/4', undefined, undefined, 'close'));

    assert.ok(!warnings.some(w => w.includes('[post]')), `unexpected post warnings: ${warnings}`);
  });
});
