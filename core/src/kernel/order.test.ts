import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { KernelError } from '#errors'
import { between, isOrderKey } from './order'

// Deterministic, so a failing sequence replays.
function prng(seed: number): () => number {
  let s = seed
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function insertAt(list: string[], i: number): string {
  const key = between(list[i - 1], list[i])
  if (i > 0) assert.ok(list[i - 1] < key, `${list[i - 1]} < ${key}`)
  if (i < list.length) assert.ok(key < list[i], `${key} < ${list[i]}`)
  list.splice(i, 0, key)
  return key
}

function assertAscending(list: readonly string[]): void {
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1] < list[i], `${list[i - 1]} < ${list[i]}`)
}

const isInvalid = (e: unknown) => e instanceof KernelError && e.code === 'INVALID'

describe('order keys', () => {
  it('keys sort as plain strings in list order under random inserts', () => {
    const random = prng(7)
    const list: string[] = []
    for (let n = 0; n < 2000; n++) insertAt(list, Math.floor(random() * (list.length + 1)))

    assert.deepEqual([...list].sort(), list)
    assert.equal(new Set(list).size, list.length)
  })

  it('a key fits between every pair of neighbours and at both ends', () => {
    const random = prng(11)
    const list: string[] = []
    for (let n = 0; n < 300; n++) insertAt(list, Math.floor(random() * (list.length + 1)))

    for (let i = 0; i <= list.length; i++) {
      const key = between(list[i - 1], list[i])
      assertAscending([...list.slice(0, i), key, ...list.slice(i)])
    }
  })

  it('repeated inserts into the same gap keep the order', () => {
    const afterFirst = [between()]
    const beforeLast = [between()]
    for (let n = 0; n < 300; n++) {
      insertAt(afterFirst, 1)
      insertAt(beforeLast, beforeLast.length - 1)
    }

    assertAscending(afterFirst)
    assertAscending(beforeLast)
  })

  it('10 000 appends keep keys within 8 characters', () => {
    const list = [between()]
    for (let n = 0; n < 10_000; n++) insertAt(list, list.length)

    assert.ok(Math.max(...list.map((key) => key.length)) <= 8)
  })

  it('10 000 prepends keep keys within 8 characters', () => {
    const list = [between()]
    for (let n = 0; n < 10_000; n++) insertAt(list, 0)

    assert.ok(Math.max(...list.map((key) => key.length)) <= 8)
  })

  it('keys from any earlier scheme stay valid bounds at both ends', () => {
    for (const key of ['zzzzV', 'zzzzzzzzzz', '0000V', '00001', 'z', '1', 'V5x']) {
      assert.ok(key < between(key), `after ${key}`)
      assert.ok(between(undefined, key) < key, `before ${key}`)
      assert.ok(isOrderKey(between(key)) && isOrderKey(between(undefined, key)), key)
    }
  })

  it('rejects bounds out of order and malformed keys', () => {
    assert.throws(() => between('b', 'a'), isInvalid)
    assert.throws(() => between('a', 'a'), isInvalid)
    for (const key of ['', 'a0', 'a-b', 'é'])
      assert.throws(() => between(key), isInvalid, JSON.stringify(key))
  })
})
