import type { CacheClaimLimits, LaneCache } from '#client/lane-cache'
import { KernelError } from '#errors'
import type { Connection, Credential, Frame, Request } from '#kernel/types'
import { decodeFrame } from '#protocol/twp'
import { isRecord } from '#util/is-record'

export interface TwpHttpClientOptions {
  readonly url: string
  readonly credential?: Credential
  /** Supplies claims from the same borrowed cache and credential passed to the native client. */
  readonly cache?: LaneCache
  readonly limits?: CacheClaimLimits
  readonly headers?: HeadersInit
  readonly signal?: AbortSignal
  readonly frameBytes?: number
  readonly heartbeatMs?: number
}

async function refusal(response: Response): Promise<never> {
  const body = await response.text()
  let frame: Frame
  try {
    frame = decodeFrame(body, 64 * 1024)
  } catch (error) {
    console.error(error)
    throw new KernelError(response.status === 401 ? 'UNAUTHENTICATED' : 'UNAVAILABLE', `HTTP request failed (${response.status})`)
  }
  if (frame.t !== 'fail') throw new KernelError('INVALID', 'Malformed HTTP failure')
  throw new KernelError(frame.error.code, frame.error.message)
}

/** Opens an HTTP TWP transport, offering bounded claims from the borrowed cache. */
export async function openTwpHttp(options: TwpHttpClientOptions) {
  const controller = new AbortController(), signal = options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal])
  const url = options.url.replace(/\/$/, ''), headers = new Headers(options.headers)
  if (options.credential !== undefined) {
    const bearer = `Bearer ${options.credential.token}`, supplied = headers.get('Authorization')
    if (supplied !== null && supplied !== bearer) throw new KernelError('UNAUTHENTICATED', 'Conflicting HTTP credentials')
    headers.set('Authorization', bearer)
  }
  headers.set('Content-Type', 'application/json')
  const credentials = headers.has('Authorization') ? 'omit' : 'include'
  const cache = options.cache?.reconnectClaims(options.credential, options.limits)
  const hello: Request = {
    t: 'hi',
    ...(options.credential === undefined ? {} : { credential: options.credential }),
    ...(cache === undefined || cache.length === 0 ? {} : { cache }),
  }
  const response = await fetch(`${url}/twp`, { method: 'POST', headers, credentials, signal, body: JSON.stringify(hello) })
  if (!response.ok) return refusal(response)
  const locator: unknown = await response.json()
  if (!isRecord(locator) || typeof locator.lane !== 'string' || locator.lane.length === 0)
    throw new KernelError('INVALID', 'Malformed HTTP lane locator')
  const lane = locator.lane
  headers.set('TWP-Lane', lane)
  let send = Promise.resolve(), outstanding = 0
  function post(request: Request | readonly Request[]): void {
    signal.throwIfAborted()
    if (outstanding >= 16) throw new KernelError('BUDGET', 'HTTP input buffer exceeded')
    const body = JSON.stringify(request)
    outstanding++
    send = send.then(async () => {
      const response = await fetch(`${url}/twp`, { method: 'POST', headers, credentials, signal, body })
      if (!response.ok) await refusal(response)
    }).catch(error => {
      if (!signal.aborted) {
        if (!(error instanceof KernelError)) console.error(error)
        controller.abort(error instanceof KernelError ? error : new KernelError('UNAVAILABLE', 'HTTP input failed'))
      }
    }).finally(() => { outstanding-- })
  }
  const heartbeat = setInterval(() => { if (!signal.aborted && outstanding === 0) post([]) }, options.heartbeatMs ?? 15_000)
  function close(): void { clearInterval(heartbeat); controller.abort(new KernelError('CANCELLED', 'HTTP client closed')) }
  async function* frames(): AsyncGenerator<Frame> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await fetch(`${url}/twp/lane/${encodeURIComponent(lane)}`, { headers, credentials, signal })
      if (!response.ok) await refusal(response)
      if (response.body === null) throw new KernelError('INVALID', 'Missing HTTP event stream')
      reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8', { fatal: true }), limit = options.frameBytes ?? 40 * 1024 * 1024
      let parts: Uint8Array[] = [], length = 0, bytes = 0, data: string[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        let start = 0
        while (start < value.length) {
          const newline = value.indexOf(10, start), end = newline < 0 ? value.length : newline
          const part = value.subarray(start, end)
          parts.push(part); length += part.length
          if (bytes + length > limit) throw new KernelError('BUDGET', 'HTTP event frame budget exceeded')
          if (newline < 0) break
          const lineBytes = new Uint8Array(length)
          let offset = 0
          for (const part of parts) { lineBytes.set(part, offset); offset += part.length }
          const line = decoder.decode(lineBytes).replace(/\r$/, '')
          bytes += length + 1; length = 0; parts = []
          if (line === '') {
            if (data.length !== 0) yield decodeFrame(data.join('\n'), limit)
            data = []; bytes = 0
          } else if (line.startsWith('data:')) data.push(line.slice(line[5] === ' ' ? 6 : 5))
          start = newline + 1
        }
      }
      if (length !== 0 || data.length !== 0) throw new KernelError('INVALID', 'Truncated HTTP event frame')
    } catch (error) {
      if (signal.aborted) throw signal.reason
      throw error
    } finally {
      try { await reader?.cancel() } finally { reader?.releaseLock(); close() }
    }
  }
  const connection: Connection = { send: post, frames: { [Symbol.asyncIterator]: frames } }
  return { ...connection, close, lane }
}
