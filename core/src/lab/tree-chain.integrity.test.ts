import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const EXPECTED_SHA256 = '18b333bcb453fcb63b7f79ce6e2f47eda650d4ee78e96bcda8de13c7ca2f6064';

test('lab/tree-chain.ts remains outside the core simplification', async () => {
  const source = await readFile(new URL('./tree-chain.ts', import.meta.url));
  const actual = createHash('sha256').update(source).digest('hex');
  assert.equal(actual, EXPECTED_SHA256);
});
