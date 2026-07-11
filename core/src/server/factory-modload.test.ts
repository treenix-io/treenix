// Boot policy: a failed mod load aborts treenix() (core-ns6p.1).
// Own file on purpose: the boot scans internal+engine mod dirs, whose imports
// irreversibly mutate process globals (interceptConsole install) — running this
// next to other factory tests breaks their console assumptions.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { A, createNode, R, S, W } from '#core';
import { isModLoaded } from '#mod';
import { treenix } from './factory';

let tmp: string;
let prevUntrusted: string | undefined;

function rootNode() {
  const n = createNode('/', 'root');
  n.$acl = [{ g: 'system', p: R | W | A | S }];
  return n;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'treenix-modload-'));
  // Ambient TREENIX_UNTRUSTED_MODS_DIR=1 would make loadAllMods skip extraDirs
  // entirely (R4-BOOT-1), so the broken mod never loads and the branch under test
  // is silently bypassed. Force trust for the duration (core-ns6p.1).
  prevUntrusted = process.env.TREENIX_UNTRUSTED_MODS_DIR;
  delete process.env.TREENIX_UNTRUSTED_MODS_DIR;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (prevUntrusted === undefined) delete process.env.TREENIX_UNTRUSTED_MODS_DIR;
  else process.env.TREENIX_UNTRUSTED_MODS_DIR = prevUntrusted;
});

describe('mod load failure (core-ns6p.1)', () => {
  it('boot rejects with AggregateError and skips seed when a mod fails to load', async () => {
    const modsDir = join(tmp, 'mods');
    mkdirSync(join(modsDir, 'broken'), { recursive: true });
    writeFileSync(join(modsDir, 'broken', 'server.ts'), `throw new Error('boom');\n`);

    let seeded = false;

    await assert.rejects(
      treenix({
        modsDir,
        autostart: false,
        seed: async () => { seeded = true; },
        rootNode: rootNode(),
      }),
      (e: unknown) => e instanceof AggregateError && e.message.includes('broken'),
    );

    assert.equal(seeded, false, 'seed must not run on a failed fail-fast boot');
  });

  it('allowPartialMods boots past a broken mod, keeps good mods, logs each failure', async () => {
    const modsDir = join(tmp, 'mods');
    mkdirSync(join(modsDir, 'broken'), { recursive: true });
    writeFileSync(join(modsDir, 'broken', 'server.ts'), `throw new Error('boom');\n`);
    mkdirSync(join(modsDir, 'good-mod'), { recursive: true });
    writeFileSync(join(modsDir, 'good-mod', 'server.ts'), `export const ok = true;\n`);

    const origError = console.error;
    const errorCalls: unknown[][] = [];
    console.error = (...args: unknown[]) => { errorCalls.push(args); };

    try {
      const t = await treenix({
        modsDir,
        allowPartialMods: true,
        autostart: false,
        seed: async () => {},
        rootNode: rootNode(),
      });
      await t.stop();

      assert.equal(isModLoaded('good-mod'), true, 'good mod must load despite the broken sibling');
      const logged = errorCalls.some(args =>
        args.some(a => typeof a === 'string' && a.includes('broken')),
      );
      assert.equal(logged, true, 'each mod-load failure must be logged loudly');
    } finally {
      console.error = origError;
    }
  });
});
