import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createLogger, interceptConsole, logStats, matchesLogGrep, queryLogs, setDebug } from './log.js';

describe('createLogger', () => {
  const calls: { method: string; args: unknown[] }[] = []
  const originals = { debug: console.debug, info: console.info, warn: console.warn, error: console.error }

  beforeEach(() => {
    calls.length = 0
    for (const m of ['debug', 'info', 'warn', 'error'] as const) {
      (console as any)[m] = (...args: unknown[]) => calls.push({ method: m, args })
    }
  })

  afterEach(() => {
    Object.assign(console, originals)
    setDebug('')
  })

  it('info/warn/error always log with tag', () => {
    const log = createLogger('test')
    log.info('hello')
    log.warn('careful')
    log.error('boom')

    assert.equal(calls.length, 3)
    assert.deepStrictEqual(calls[0], { method: 'info', args: ['[test]', 'hello'] })
    assert.deepStrictEqual(calls[1], { method: 'warn', args: ['[test]', 'careful'] })
    assert.deepStrictEqual(calls[2], { method: 'error', args: ['[test]', 'boom'] })
  })

  it('debug is silent by default', () => {
    const log = createLogger('test')
    log.debug('hidden')
    assert.equal(calls.length, 0)
  })

  it('setDebug enables debug for specific name', () => {
    setDebug('foo')
    const foo = createLogger('foo')
    const bar = createLogger('bar')

    foo.debug('visible')
    bar.debug('hidden')

    assert.equal(calls.length, 1)
    assert.deepStrictEqual(calls[0], { method: 'debug', args: ['[foo]', 'visible'] })
  })

  it('setDebug("*") enables all', () => {
    setDebug('*')
    const log = createLogger('anything')
    log.debug('visible')
    assert.equal(calls.length, 1)
  })

  it('setDebug with comma-separated names', () => {
    setDebug('a, b')
    const a = createLogger('a')
    const b = createLogger('b')
    const c = createLogger('c')

    a.debug('yes')
    b.debug('yes')
    c.debug('no')

    assert.equal(calls.length, 2)
  })

  it('grep matching treats regex metacharacters literally', () => {
    assert.equal(matchesLogGrep('literal [tag] and (a+)+$', '[tag]'), true)
    assert.equal(matchesLogGrep('literal [tag] and (a+)+$', '(a+)+$'), true)
    assert.equal(matchesLogGrep('literal [tag] and (a+)+$', 'missing.*'), false)
  })

  it('queryLogs does not compile grep as a regexp', () => {
    assert.doesNotThrow(() => queryLogs({ grep: '[' }))
  })
})

// jre7 regression: the buffer is THE log store (the log→tree wire is cut) —
// it must keep filling forever and stay bounded, evicting oldest first.
describe('ring buffer', () => {
  const original = console.info

  afterEach(() => {
    console.info = original
  })

  it('a console flood stays bounded at max and keeps the newest entries', () => {
    console.info = () => {} // mute the terminal; intercept wraps this
    interceptConsole()
    const { max } = logStats()

    for (let i = 0; i < max + 500; i++) console.info(`flood-${i}`)

    assert.ok(logStats().buffered <= max)
    const entries = queryLogs({ grep: 'flood-' })
    assert.ok(entries.length <= max)
    assert.ok(entries.some(e => e.msg === `flood-${max + 499}`), 'newest entry must be present')
    assert.ok(!entries.some(e => e.msg === 'flood-0'), 'oldest entry must be evicted')
  })
})
