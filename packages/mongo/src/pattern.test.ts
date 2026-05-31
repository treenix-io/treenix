// buildPattern: the _path regex driving getChildren/scanChildren depth scans.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPattern } from './index';

describe('buildPattern', () => {
  it('depth 1 matches direct children only', () => {
    const re = buildPattern('/a', 1);
    assert.ok(re.test('/a/b'));
    assert.ok(!re.test('/a/b/c'));
  });

  it('depth 2 matches two levels', () => {
    const re = buildPattern('/a', 2);
    assert.ok(re.test('/a/b'));
    assert.ok(re.test('/a/b/c'));
    assert.ok(!re.test('/a/b/c/d'));
  });

  it('depth -1 matches all descendants (deep)', () => {
    const re = buildPattern('/a', -1);
    assert.ok(re.test('/a/b'));
    assert.ok(re.test('/a/b/c'));
    assert.ok(re.test('/a/b/c/d'));
    assert.ok(!re.test('/other/b'));
  });

  it('depth -1 from root matches everything', () => {
    const re = buildPattern('/', -1);
    assert.ok(re.test('/a'));
    assert.ok(re.test('/a/b/c'));
  });
});
