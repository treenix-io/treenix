// Boot policy: a failed mod load aborts treenix() (core-ns6p.1).
// Own file on purpose: the boot scans internal+engine mod dirs, whose imports
// irreversibly mutate process globals (interceptConsole install) — running this
// next to other factory tests breaks their console assumptions.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createNode } from '#core';
import { treenix } from './factory';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'treenix-modload-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('mod load failure (core-ns6p.1)', () => {
  it('boot rejects with AggregateError when a mod fails to load', async () => {
    const modsDir = join(tmp, 'mods');
    mkdirSync(join(modsDir, 'broken'), { recursive: true });
    writeFileSync(join(modsDir, 'broken', 'server.ts'), `throw new Error('boom');\n`);

    await assert.rejects(
      treenix({
        modsDir,
        autostart: false,
        seed: async () => {},
        rootNode: createNode('/', 'root'),
      }),
      (e: unknown) => e instanceof AggregateError && e.message.includes('broken'),
    );
  });
});
