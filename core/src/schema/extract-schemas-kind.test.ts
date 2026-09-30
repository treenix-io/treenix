import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KernelError } from '#errors';
import { parseJSDoc } from '#schema/extract-schemas-oxc';

const isJSDocError = (err: unknown) => err instanceof Error && err.name === 'JSDocError';

// A tag the kernel would refuse at run time: the JSDoc error carries the kernel's INVALID.
const isKernelInvalid = (err: unknown) =>
  isJSDocError(err) && err instanceof Error && err.cause instanceof KernelError && err.cause.code === 'INVALID';

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
    assert.equal(result.annotations['x-craftistry-special'], 'myValue');
  });

  it('extracts @read as kind="read"', () => {
    const result = parseJSDoc('* @read\n');
    assert.equal(result.kind, 'read');
  });

  it('extracts @write as kind="write"', () => {
    const result = parseJSDoc('* @write\n');
    assert.equal(result.kind, 'write');
  });

  it('extracts @setuid as kind="setuid"', () => {
    const result = parseJSDoc('* @setuid\n');
    assert.equal(result.kind, 'setuid');
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

  it('throws when @setuid meets another kind', () => {
    assert.throws(() => parseJSDoc('* @setuid @read\n'), isJSDocError);
    assert.throws(() => parseJSDoc('* @write\n* @setuid\n'), isJSDocError);
  });

  it('a kind or @io with a value throws', () => {
    for (const doc of ['* @setuid false\n', '* @setuid no\n', '* @io false\n', '* @read yes\n', '* @write @io off\n'])
      assert.throws(() => parseJSDoc(doc), isJSDocError, doc);
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

describe('parseJSDoc — type tags', () => {
  it('@version is a non-negative integer', () => {
    assert.equal(parseJSDoc('* @version 3\n').version, 3);
    assert.equal(parseJSDoc('* @version 0\n').version, 0);

    for (const bad of ['', '-1', '1.5', 'two', '01', '9007199254740993'])
      assert.throws(() => parseJSDoc(`* @version ${bad}\n`), isJSDocError, bad);
  });

  it('@version given twice throws', () => {
    assert.throws(() => parseJSDoc('* @version 1\n* @version 2\n'), isJSDocError);
  });

  it('@actionsOnly is a flag without a value', () => {
    assert.equal(parseJSDoc('* @actionsOnly\n').actionsOnly, true);
    assert.throws(() => parseJSDoc('* @actionsOnly false\n'), isJSDocError);
  });

  it('@alias lists earlier type names, across several tags', () => {
    assert.deepEqual(parseJSDoc('* @alias shop.item shop.product\n* @alias legacy.item\n').aliases, [
      'shop.item',
      'shop.product',
      'legacy.item',
    ]);
  });

  it('@alias without a name, with a repeated name or with a non-type name throws', () => {
    assert.throws(() => parseJSDoc('* @alias\n'), isJSDocError);
    assert.throws(() => parseJSDoc('* @alias shop.item\n* @alias shop.item\n'), isJSDocError);
    assert.throws(() => parseJSDoc('* @alias shop:item\n'), isJSDocError);
  });

  it('a JSDoc without type or action tags carries annotations only', () => {
    assert.deepEqual(parseJSDoc('* Title line\n* @format email\n'), { annotations: { title: 'Title line', format: 'email' } });
  });
});

describe('parseJSDoc — pre and post', () => {
  it('@pre is a sift query in JSON over { node, needs }', () => {
    assert.deepEqual(parseJSDoc('* @pre {"node.status": "open", "needs.stock.qty": {"$gt": 0}}\n').pre, {
      'node.status': 'open',
      'needs.stock.qty': { $gt: 0 },
    });
  });

  it('@post is update operators per target in JSON', () => {
    assert.deepEqual(parseJSDoc('* @post {"": {"$set": {"status": "done"}}, "stock": {"$inc": {"qty": -1}}}\n').post, {
      '': { $set: { status: 'done' } },
      stock: { $inc: { qty: -1 } },
    });
  });

  it('a JSON value runs over the following lines up to the next tag', () => {
    const doc = parseJSDoc(
      '* Close the ticket.\n* @pre {"node.status": "open",\n*   "node.assignee": {"$exists": true}}\n* @description Marks it closed\n',
    );

    assert.deepEqual(doc.pre, { 'node.status': 'open', 'node.assignee': { $exists: true } });
    assert.equal(doc.annotations.description, 'Marks it closed');
  });

  it('a field list is not JSON and throws', () => {
    assert.throws(() => parseJSDoc('* @pre count scores\n'), isJSDocError);
    assert.throws(() => parseJSDoc('* @post status\n'), isJSDocError);
  });

  it('@pre the evaluator refuses carries the kernel INVALID', () => {
    for (const pre of ['{"node.x": {"$where": "1"}}', '{"node.x": {"$regex": "a"}}', '["node.x"]', '"node.x"'])
      assert.throws(() => parseJSDoc(`* @pre ${pre}\n`), isKernelInvalid, pre);
  });

  it('@post that is not a Post carries the kernel INVALID', () => {
    for (const post of ['{"": {"$rename": {"a": "b"}}}', '{"": {"$inc": {"n": "1"}}}', '["status"]'])
      assert.throws(() => parseJSDoc(`* @post ${post}\n`), isKernelInvalid, post);
  });

  it('@pre or @post given twice throws', () => {
    assert.throws(() => parseJSDoc('* @pre {"node.a": 1}\n* @pre {"node.b": 1}\n'), isJSDocError);
    assert.throws(() => parseJSDoc('* @post {}\n* @post {}\n'), isJSDocError);
  });
});
