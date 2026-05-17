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

  it('rejects removed @mutation alias', () => {
    assert.throws(
      () => parseJSDoc('* @mutation\n'),
      (err: unknown) =>
        err instanceof Error && err.name === 'JSDocError' && /mutation/.test(err.message),
    );
  });

  it('rejects removed @query alias', () => {
    assert.throws(
      () => parseJSDoc('* @query\n'),
      (err: unknown) =>
        err instanceof Error && err.name === 'JSDocError' && /query/.test(err.message),
    );
  });
});
