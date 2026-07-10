import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const EXPECTED_SHA256 = '8ec3e91050ab0e1f54886669be903a62a2dba1a30e1f6d17af6d372f119a783d';

test('lab/tree-chain.ts remains outside the core simplification', async () => {
  const source = await readFile(new URL('./tree-chain.ts', import.meta.url));
  const actual = createHash('sha256').update(source).digest('hex');
  assert.equal(actual, EXPECTED_SHA256);
});
