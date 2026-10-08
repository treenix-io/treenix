import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { check, sources } from './tree-client-boundary';

describe('mod transport boundary', () => {
  it('views import consumer operations without access to the transport or mutable cache', () => {
    const violations = [...sources(import.meta.dirname)].flatMap(path => check(readFileSync(path, 'utf8'), path));
    assert.deepEqual(violations, []);
  });

  it('rejects aliases, namespaces, focused imports and dynamic bypasses', () => {
    for (const source of [
      "import { trpc as remote } from '@treenx/react'",
      'import { set as persist } from "@treenx/react/hooks"',
      "import * as client from '@treenx/react'",
      "import { get } from '@treenx/react/tree/cache'",
      "export { tree as store } from '@treenx/react'",
      "const client = await import('@treenx/react/tree/trpc')",
    ]) assert.equal(check(source, 'view.tsx').length, 1);
    assert.deepEqual(check("import { treeClient, useSave, useActions } from '@treenx/react'", 'view.tsx'), []);
  });
});
