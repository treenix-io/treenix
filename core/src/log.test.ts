import assert from 'node:assert';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { addOnLog, createLogger, interceptConsole, logStats, matchesLogGrep, queryLogs, setDebug } from './log.js';

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

// jre7 regression: the buffer must keep filling even while log listeners
// (the factory log→tree wire) are attached — it used to freeze after boot —
// and it must stay bounded, evicting oldest first.
describe('ring buffer', () => {
  const original = console.info

  // interceptConsole is once-per-process — install the muted wrapper once for
  // the whole suite; per-test re-intercept would silently no-op.
  before(() => {
    console.info = () => {} // mute the terminal; intercept wraps this
    interceptConsole()
  })

  after(() => {
    console.info = original
  })

  it('keeps filling while a listener is attached (frozen-buffer regression)', () => {
    const seen: string[] = []
    addOnLog(e => seen.push(e.msg))

    console.info('with-listener-marker')

    assert.equal(seen.filter(m => m === 'with-listener-marker').length, 1, 'listener must receive the entry')
    assert.equal(queryLogs({ grep: 'with-listener-marker' }).length, 1, 'buffer must capture it too')
  })

  it('a console flood stays bounded at max and keeps the newest entries', () => {
    const { max } = logStats()

    for (let i = 0; i < max + 500; i++) console.info(`flood-${i}`)

    assert.ok(logStats().buffered <= max)
    const entries = queryLogs({ grep: 'flood-' })
    assert.ok(entries.length <= max)
    assert.ok(entries.some(e => e.msg === `flood-${max + 499}`), 'newest entry must be present')
    assert.ok(!entries.some(e => e.msg === 'flood-0'), 'oldest entry must be evicted')
  })
})
