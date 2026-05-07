import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseJSDoc } from '#schema/extract-schemas-oxc';

describe('parseJSDoc — kind tag whitelist', () => {
  it('rejects unknown tag without @x- prefix (typo detection)', () => {
    assert.throws(
      () => parseJSDoc('* @reaad\n'),
      (err: unknown) =>
        err instanceof Error && err.name === 'JSDocError' && /reaad/.test(err.message),
    );
  });

  it('accepts @x-foo escape for module-specific tags (hyphen support)', () => {
    const result = parseJSDoc('* @x-craftistry-special myValue\n');
    assert.equal(result['x-craftistry-special'], 'myValue');
  });

  it('extracts @read as kind="read"', () => {
    const result = parseJSDoc('* @read\n');
    assert.equal(result.kind, 'read');
  });

  it('extracts @write as kind="write"', () => {
    const result = parseJSDoc('* @write\n');
    assert.equal(result.kind, 'write');
  });

  it('extracts @io as io=true (modifier)', () => {
    const result = parseJSDoc('* @io\n');
    assert.equal(result.io, true);
  });

  it('extracts @read @io combo as kind="read" io=true', () => {
    const result = parseJSDoc('* @read\n* @io\n');
    assert.equal(result.kind, 'read');
    assert.equal(result.io, true);
  });

  it('throws on @read @write mutual exclusivity', () => {
    assert.throws(
      () => parseJSDoc('* @read\n* @write\n'),
      (err: unknown) =>
        err instanceof Error && err.name === 'JSDocError' && /mutual|exclusiv|both|conflict/i.test(err.message),
    );
  });

  it('extracts @mutation as alias for kind="write" (graceful migration)', () => {
    const result = parseJSDoc('* @mutation\n');
    assert.equal(result.kind, 'write');
  });

  it('extracts @query as alias for kind="read" (graceful migration)', () => {
    const result = parseJSDoc('* @query\n');
    assert.equal(result.kind, 'read');
  });

  it('throws on @mutation @read conflict (alias mismatch)', () => {
    assert.throws(
      () => parseJSDoc('* @mutation\n* @read\n'),
      (err: unknown) => err instanceof Error && err.name === 'JSDocError',
    );
  });
});
