import { KernelError } from '#errors'

interface Piece {
  readonly data: unknown
  readonly taken: () => void
  readonly reject: (reason: unknown) => void
}

interface Pull {
  readonly resolve: (result: IteratorResult<unknown, void>) => void
  readonly reject: (reason: unknown) => void
}

/** Holds one piece until its sole consumer takes it; neither side owns an output queue. */
export function createChunkChannel(onReturn: () => void) {
  let piece: Piece | undefined
  let pull: Pull | undefined
  let ended = false
  let failure: unknown

  /** Releases a waiting producer and consumer when the owning request ends. */
  function end(error?: unknown): void {
    if (ended) return
    ended = true
    failure = error
    if (piece !== undefined) {
      piece.reject(error ?? new KernelError('CANCELLED', 'Chunk delivery ended'))
      piece = undefined
    }
    if (pull !== undefined) {
      if (error === undefined) pull.resolve({ done: true, value: undefined })
      else pull.reject(error)
      pull = undefined
    }
  }

  /** Resolves delivery only when next() takes this piece, and observes its producer's lifetime. */
  async function deliver(data: unknown, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (ended) throw failure ?? new KernelError('CANCELLED', 'Chunk consumer ended')
    if (piece !== undefined) throw new KernelError('INVALID', 'Chunk delivery is already pending')
    if (pull !== undefined) {
      const waiting = pull
      pull = undefined
      waiting.resolve({ done: false, value: data })
      return
    }

    let abort = () => {}
    try {
      await new Promise<void>((resolve, reject) => {
        const held: Piece = { data, taken: resolve, reject }
        piece = held
        abort = () => {
          if (piece !== held) return
          piece = undefined
          reject(signal.reason)
        }
        signal.addEventListener('abort', abort, { once: true })
      })
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  const chunks: AsyncIterableIterator<unknown, void, undefined> = {
    /** Takes one piece, or reserves the single pending pull. */
    next() {
      if (ended)
        return failure === undefined
          ? Promise.resolve({ done: true, value: undefined })
          : Promise.reject(failure)
      if (pull !== undefined)
        return Promise.reject(new KernelError('INVALID', 'Concurrent chunk pull'))
      if (piece !== undefined) {
        const held = piece
        piece = undefined
        held.taken()
        return Promise.resolve({ done: false, value: held.data })
      }
      return new Promise((resolve, reject) => {
        pull = { resolve, reject }
      })
    },
    /** Ends this request's piece consumption without closing another request's lane. */
    async return() {
      if (!ended) {
        end()
        onReturn()
      }
      return { done: true, value: undefined }
    },
    [Symbol.asyncIterator]() {
      return chunks
    },
  }

  return { chunks, deliver, end }
}
