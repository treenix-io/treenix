import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { createChunkChannel } from '#util/chunk-channel'

const code = (expected: KernelError['code']) => (error: unknown) =>
  error instanceof KernelError && error.code === expected

describe('one-owner chunk handoff', { timeout: 10_000 }, () => {
  it('holds the producer until take and rejects a second retained piece or waiting pull', async () => {
    const channel = createChunkChannel(() => {})
    const controller = new AbortController()
    let taken = false
    const data = { message: 'one' }
    const delivery = channel.deliver(data, controller.signal).then(() => {
      taken = true
    })
    await assert.rejects(channel.deliver('two', controller.signal), code('INVALID'))
    assert.equal(taken, false)
    assert.deepEqual(await channel.chunks.next(), { done: false, value: data })
    await delivery
    assert.equal(taken, true)

    const next = channel.chunks.next()
    await assert.rejects(channel.chunks.next(), code('INVALID'))
    await channel.deliver(undefined, controller.signal)
    assert.deepEqual(await next, { done: false, value: undefined })
    channel.end()
    assert.deepEqual(await channel.chunks.next(), { done: true, value: undefined })
  })

  it('consumer return cancels a held producer exactly once', async () => {
    let returned = 0
    const channel = createChunkChannel(() => {
      returned++
    })
    const delivery = channel.deliver('held', new AbortController().signal)
    const ended = assert.rejects(delivery, code('CANCELLED'))
    assert.ok(channel.chunks.return)
    await channel.chunks.return()
    await channel.chunks.return()
    await ended
    assert.equal(returned, 1)
    assert.deepEqual(await channel.chunks.next(), { done: true, value: undefined })
  })

  it('abort releases a held producer and request failure releases a waiting consumer', async () => {
    const controller = new AbortController()
    const channel = createChunkChannel(() => {})
    const delivery = channel.deliver('held', controller.signal)
    const rejected = assert.rejects(delivery, code('CANCELLED'))
    controller.abort(new KernelError('CANCELLED', 'Producer ended'))
    await rejected

    const pull = channel.chunks.next()
    const finished = assert.rejects(pull, code('UNAVAILABLE'))
    channel.end(new KernelError('UNAVAILABLE', 'Owner ended'))
    await finished
    await assert.rejects(channel.chunks.next(), code('UNAVAILABLE'))
  })
})
