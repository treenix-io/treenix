import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { exprWork } from './eval'
import { createSiftTest } from './expr'
import { DEFAULT_LIMITS } from './types'

type Q = Record<string, unknown>

const matches = (q: Q, node: Q) => createSiftTest(q, DEFAULT_LIMITS)(node, exprWork(DEFAULT_LIMITS))

const U_D7FF = String.fromCharCode(0xd7ff)
const U_E000 = String.fromCharCode(0xe000)
const U_FFFF = String.fromCharCode(0xffff)
const GRIN = String.fromCodePoint(0x1f600)
const GRIN_SWEAT = String.fromCodePoint(0x1f605)

// Each row as Mongo 7 answers it: a query, then the nodes it is tested on with the answer.
const SEMANTICS: [string, Q, [Q, boolean][]][] = [
  ['equality matches the value or any element of an array, one level deep', { a: 1 }, [
    [{ a: 1 }, true], [{ a: [1, 2] }, true], [{ a: [[1]] }, false], [{ a: '1' }, false], [{ a: true }, false], [{}, false]]],
  ['null matches null, a null element and a missing value, not an empty array', { a: null }, [
    [{}, true], [{ a: null }, true], [{ a: [null] }, true], [{ a: [] }, false], [{ a: 0 }, false]]],
  ['a dotted path reads the field of each document in an array, not of arrays inside it', { 'a.b': 1 }, [
    [{ a: { b: 1 } }, true], [{ a: [{ b: 1 }] }, true], [{ a: [{ b: [1, 2] }] }, true], [{ a: [[{ b: 1 }]] }, false], [{ a: [1, { b: 1 }] }, true]]],
  ['a path is missing below a scalar and at a document without the field, but gives nothing past other elements', { 'a.b': null }, [
    [{ a: 5 }, true], [{ a: [{ c: 1 }] }, true], [{ a: [{ b: 1 }, { c: 1 }] }, true], [{ a: [1, 2] }, false], [{ a: [] }, false],
    [{ a: [[{ b: 1 }]] }, false], [{ a: [null] }, false]]],
  ['arrays expand at any level of a path', { 'a.b.c': 1 }, [
    [{ a: [{ b: [{ c: 1 }] }] }, true], [{ a: { b: { c: [0, 1] } } }, true], [{ a: { b: [[{ c: 1 }]] } }, false]]],
  ['a numeric segment reads a position of an array and a field of a document', { 'a.0': 1 }, [
    [{ a: [1, 2] }, true], [{ a: { '0': 1 } }, true], [{ a: [{ '0': 1 }] }, true], [{ a: [[1]] }, false]]],
  ['the element a position ends the path at is tested whole', { 'a.1': 3 }, [
    [{ a: [[1, 2], 3] }, true], [{ a: [[1], [2, 3]] }, false]]],
  ['a document element without the numbered field is missing', { 'a.0': null }, [
    [{ a: [{ b: 1 }] }, true], [{ a: [1, 2] }, false], [{ a: [] }, false]]],
  ['a path continues into the element at a position', { 'a.0.b': 1 }, [
    [{ a: [[{ b: 1 }]] }, true], [{ a: [{ b: 1 }] }, true]]],
  ['a path does not continue past a scalar at a position', { 'a.0.b': null }, [
    [{ a: [true, 0] }, false], [{ a: [null] }, false], [{ a: [{ c: 1 }] }, true]]],
  ['a string has no positions', { 'a.0': { $exists: true } }, [
    [{ a: 'x' }, false], [{ a: [[]] }, true], [{ a: [] }, false]]],
  ['length is a field name, never an array property', { 'a.length': 2 }, [
    [{ a: [1, 2] }, false], [{ a: { length: 2 } }, true], [{ a: [{ length: 2 }] }, true]]],
  ['$ne holds only if no value equals', { a: { $ne: 1 } }, [
    [{ a: [1, 2] }, false], [{ a: [[1]] }, true], [{ a: [null] }, true], [{}, true]]],
  ['$ne null is present and not null everywhere', { a: { $ne: null } }, [
    [{}, false], [{ a: [null] }, false], [{ a: [] }, true], [{ a: 0 }, true]]],
  ['$nin holds only if no element is in the list', { a: { $nin: [1, 2] } }, [
    [{ a: [2, 3] }, false], [{ a: [3] }, true], [{}, true]]],
  ['$ne null past an array of scalars holds: the path gives nothing there', { 'a.b': { $ne: null } }, [
    [{ a: [1, 2] }, true], [{ a: [{ c: 1 }] }, false], [{ a: [{ b: 1 }] }, true]]],
  ['a comparison holds between values of one type only', { a: { $gt: 1 } }, [
    [{ a: 5 }, true], [{ a: [1, 2] }, true], [{ a: '5' }, false], [{ a: [[5]] }, false], [{ a: true }, false]]],
  ['$gte null is equality with null', { a: { $gte: null } }, [
    [{}, true], [{ a: null }, true], [{ a: [] }, false], [{ a: 0 }, false]]],
  ['$gt null matches nothing', { a: { $gt: null } }, [
    [{ a: null }, false], [{}, false], [{ a: 1 }, false]]],
  ['booleans order false before true', { a: { $gte: false } }, [
    [{ a: true }, true], [{ a: false }, true], [{ a: 0 }, false]]],
  ['strings order by code point', { a: { $gt: 'a' } }, [
    [{ a: 'x' }, true], [{ a: 'A' }, false], [{ a: 5 }, false]]],
  ['a character above U+FFFF orders after U+E000', { a: { $gt: U_E000 } }, [
    [{ a: GRIN }, true], [{ a: U_D7FF }, false]]],
  ['U+E000 to U+FFFF order before a character above U+FFFF', { a: { $lt: GRIN } }, [
    [{ a: U_E000 }, true], [{ a: U_FFFF }, true], [{ a: GRIN_SWEAT }, false]]],
  ['$in matches a value or an element of one type', { a: { $in: [1, 'x'] } }, [
    [{ a: 'x' }, true], [{ a: [3, 1] }, true], [{ a: '1' }, false], [{ a: [[1]] }, false]]],
  ['$in with null matches a missing value and a null element', { a: { $in: [null] } }, [
    [{}, true], [{ a: [null] }, true], [{ a: [] }, false]]],
  ['$in [] matches nothing', { a: { $in: [] } }, [[{ a: 1 }, false], [{}, false]]],
  ['$nin [] matches everything', { a: { $nin: [] } }, [[{}, true], [{ a: 1 }, true]]],
  ['$exists holds for null and an empty array', { a: { $exists: true } }, [
    [{ a: null }, true], [{ a: [] }, true], [{}, false]]],
  ['$exists false holds only if no document on the path has the field', { 'a.b': { $exists: false } }, [
    [{ a: [{ c: 1 }] }, true], [{ a: [{ b: 1 }, { c: 1 }] }, false], [{ a: [1] }, true]]],
  ['$size tests an array itself, never its elements', { a: { $size: 1 } }, [
    [{ a: [[1]] }, true], [{ a: [[1], [2, 3]] }, false], [{ a: 1 }, false]]],
  ['$size 0 matches an empty array only', { a: { $size: 0 } }, [[{ a: [] }, true], [{ a: [[]] }, false]]],
  ['$size at a dotted path', { 'a.b': { $size: 1 } }, [[{ a: [{ b: [1] }] }, true], [{ a: { b: [1, 2] } }, false]]],
  ['$all holds when each item is equal to some value', { a: { $all: [1, 2] } }, [
    [{ a: [2, 1, 3] }, true], [{ a: [[1, 2]] }, false], [{ a: [1] }, false]]],
  ['$all over a scalar', { a: { $all: [1] } }, [[{ a: 1 }, true], [{ a: [1, 5] }, true]]],
  ['$all [] matches nothing', { a: { $all: [] } }, [[{ a: [] }, false], [{ a: [1] }, false]]],
  ['$all of $elemMatch holds when each finds an element', { a: { $all: [{ $elemMatch: { b: 1 } }, { $elemMatch: { c: 1 } }] } }, [
    [{ a: [{ b: 1 }, { c: 1 }] }, true], [{ a: [{ b: 1 }] }, false]]],
  ['value-form $elemMatch tests one element with all its operators', { a: { $elemMatch: { $gt: 1, $lt: 3 } } }, [
    [{ a: [0, 2] }, true], [{ a: [0, 5] }, false], [{ a: [[2]] }, false], [{ a: 2 }, false]]],
  ['value-form $elemMatch tests the element itself, an array included', { a: { $elemMatch: { $elemMatch: { $gt: 0 } } } }, [
    [{ a: [[1]] }, true], [{ a: [1] }, false]]],
  ['value-form $ne on an array element compares the array whole', { a: { $elemMatch: { $ne: 1 } } }, [
    [{ a: [[1]] }, true], [{ a: [1, 1] }, false]]],
  ['value-form $exists holds for any element', { a: { $elemMatch: { $exists: true } } }, [
    [{ a: [[]] }, true], [{ a: [] }, false]]],
  ['object-form $elemMatch tests one element with all its fields', { a: { $elemMatch: { b: 1, c: 2 } } }, [
    [{ a: [{ b: 1, c: 2 }] }, true], [{ a: [{ b: 1 }, { c: 2 }] }, false]]],
  ['object-form $elemMatch tests documents and arrays, never scalars', { a: { $elemMatch: {} } }, [
    [{ a: [1, 2] }, false], [{ a: [{}] }, true], [{ a: [[1]] }, true]]],
  ['a missing field in object-form $elemMatch is null for documents and arrays only', { a: { $elemMatch: { b: null } } }, [
    [{ a: [1] }, false], [{ a: [{ c: 1 }] }, true], [{ a: [[1]] }, true]]],
  ['object-form $elemMatch reads an array element by its positions', { a: { $elemMatch: { '0': 1 } } }, [
    [{ a: [[1]] }, true], [{ a: [{ '0': 1 }] }, true], [{ a: [1] }, false]]],
  ['groups inside object-form $elemMatch test the same element', { a: { $elemMatch: { $or: [{ b: 1 }, { c: 1 }] } } }, [
    [{ a: [{ c: 1 }] }, true], [{ a: [{ d: 1 }] }, false]]],
  ['$not negates its operators', { a: { $not: { $gt: 1 } } }, [
    [{ a: [1, 2] }, false], [{ a: 1 }, true], [{}, true], [{ a: [[5]] }, true]]],
  ['$not negates its operators together', { a: { $not: { $gt: 1, $lt: 5 } } }, [[{ a: 3 }, false], [{ a: 7 }, true]]],
  ['$not of $not', { a: { $not: { $not: { $gt: 1 } } } }, [[{ a: 2 }, true], [{ a: 0 }, false]]],
  ['$or matches any branch', { $or: [{ a: 1 }, { b: 1 }] }, [[{ b: 1 }, true], [{ c: 1 }, false]]],
  ['$nor matches no branch', { $nor: [{ a: 1 }] }, [[{ a: [1, 2] }, false], [{}, true]]],
  ['each condition of $and matches any value on its own', { $and: [{ a: { $gt: 0 } }, { a: { $lt: 2 } }] }, [[{ a: [0, 5] }, true]]],
  ['each operator of a field matches any value on its own', { a: { $gt: 0, $lt: 2 } }, [[{ a: [0, 5] }, true], [{ a: [5] }, false]]],
  ['an empty query matches every node', {}, [[{}, true], [{ a: 1 }, true]]],
]

describe('expression semantics, as Mongo answers', () => {
  for (const [rule, q, rows] of SEMANTICS) {
    it(rule, () => {
      for (const [node, expected] of rows) assert.equal(matches(q, node), expected, `${JSON.stringify(q)} on ${JSON.stringify(node)}`)
    })
  }

  it('a Date or a Map is a value: it equals no primitive and has no fields', () => {
    assert.equal(matches({ a: 1 }, { a: new Date(1) }), false)
    assert.equal(matches({ a: { $gte: 0 } }, { a: new Date(1) }), false)
    assert.equal(matches({ a: { $exists: true } }, { a: new Date(1) }), true)
    assert.equal(matches({ 'a.size': null }, { a: new Map([['size', 1]]) }), true)
  })

  it('NaN in a node orders with nothing and equals no operand', () => {
    for (const q of [{ a: { $lt: 1 } }, { a: { $gte: -Infinity } }, { a: { $lte: Infinity } }, { a: { $in: [0, 1] } }])
      assert.equal(matches(q, { a: Number.NaN }), false, JSON.stringify(q))
    assert.equal(matches({ a: { $ne: 1 } }, { a: Number.NaN }), true)
  })

  it('an undefined field is missing', () => {
    assert.equal(matches({ a: null }, { a: undefined }), true)
    assert.equal(matches({ a: { $exists: true } }, { a: undefined }), false)
  })

  it('-0 equals 0', () => {
    assert.equal(matches({ a: 0 }, { a: -0 }), true)
    assert.equal(matches({ a: { $in: [0] } }, { a: [-0] }), true)
  })

  it('only own fields are read: an inherited field is missing', () => {
    assert.equal(matches({ a: 1 }, Object.create({ a: 1 })), false)
    assert.equal(matches({ 'a.b': null }, { a: Object.create({ b: 1 }) }), true)
  })
})
