// defineAgentScope — DX-friendly helper for mod authors.
// Maps the user-facing { read, write, exec } shape to internal Capability fields.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defineAgentScope, type AgentScope } from './capability';

describe('defineAgentScope', () => {
  it('translates read/write/exec → readPaths/writePaths/allowedExec', () => {
    const scope: AgentScope = defineAgentScope({
      plan: {
        read: ['/board/data/*', '/refunds/*'],
        write: ['/agents/*/runs/*'],
        exec: ['ai.plan.*'],
      },
      work: {
        read: ['/board/data/*', '/refunds/*', '/orders/*'],
        write: ['/board/data/*', '/refunds/*'],
        exec: ['refund.requestReview', 'board.task.submit'],
      },
    });

    assert.equal(scope.$type, 'agent.scope');
    assert.deepEqual(scope.plan.readPaths, ['/board/data/*', '/refunds/*']);
    assert.deepEqual(scope.plan.writePaths, ['/agents/*/runs/*']);
    assert.deepEqual(scope.plan.allowedExec, ['ai.plan.*']);
    assert.deepEqual(scope.work.allowedExec, ['refund.requestReview', 'board.task.submit']);
  });

  it('plan and work are independently usable as Capability', () => {
    const scope = defineAgentScope({
      plan: { read: ['/x'], write: [], exec: [] },
      work: { read: ['/y'], write: ['/y/*'], exec: ['action.do'] },
    });
    // Each block must be Capability-shaped (used directly by executeWithCapability)
    assert.ok('readPaths' in scope.plan);
    assert.ok('writePaths' in scope.plan);
    assert.ok('allowedExec' in scope.plan);
    assert.ok('readPaths' in scope.work);
  });
});
