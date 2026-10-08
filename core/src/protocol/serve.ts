import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { KernelError } from '#errors'
import { tokenHash } from '#kernel/auth/crypto'
import type { AuthAdmission } from '#kernel/auth-factory'
import type { InstanceFoundationWithAuth } from '#kernel/instance'
import { createNodeLane, type NodeLane, type NodeLaneCommand } from '#kernel/lane'
import type { Credential, Request } from '#kernel/types'

export function networkAddress(input: string): { address: string; bucket: string } {
  const family = isIP(input)
  if (family === 4) return { address: input, bucket: input }
  if (family !== 6) throw new KernelError('INVALID', 'Invalid network origin')
  const address = new URL(`http://[${input.split('%')[0]}]`).hostname.slice(1, -1)
  const [left, right] = address.split('::'), before = left === '' ? [] : left.split(':'), after = right === undefined || right === '' ? [] : right.split(':')
  const words = right === undefined ? before : [...before, ...Array<string>(8 - before.length - after.length).fill('0'), ...after]
  if (words.slice(0, 5).every(word => Number.parseInt(word, 16) === 0) && words[5] === 'ffff') {
    const a = Number.parseInt(words[6], 16), b = Number.parseInt(words[7], 16)
    const ipv4 = `${a >>> 8}.${a & 255}.${b >>> 8}.${b & 255}`
    return { address: ipv4, bucket: ipv4 }
  }
  return { address, bucket: `${words.slice(0, 4).map(word => Number.parseInt(word, 16).toString(16)).join(':')}/64` }
}

interface ServedLane {
  readonly id: string
  readonly lane: NodeLane
  readonly admission: AuthAdmission
  readonly credentialHash: string
  readonly origin: string
  attached: boolean
  close(reason?: KernelError): void
}

function command(request: Request): NodeLaneCommand {
  switch (request.t) {
    case 'read':
      return { ...request, selector: request.selector }
    case 'sub': return request
    case 'commit':
      if (request.expect?.selectors?.some(input => 'history' in input.selector)) throw new KernelError('INVALID', 'Historical preconditions are not available on this binding')
      return request
    case 'cancel': case 'unsub': case 'act': return request
    default: throw new KernelError('INVALID', 'Unsupported lane command')
  }
}

export function createTwpServing(instance: InstanceFoundationWithAuth) {
  const lanes = new Map<string, ServedLane>(), buckets = new Map<string, number>()
  let opening = 0, closed = false
  function available(): void { if (closed) throw new KernelError('UNAVAILABLE', 'Serving is closed') }
  function authorized(id: string, credential: Credential | undefined, origin: string): ServedLane {
    available()
    const found = lanes.get(id)
    if (found === undefined || credential === undefined || tokenHash(credential.token) !== found.credentialHash || origin !== found.origin)
      throw new KernelError('UNAUTHENTICATED', 'Lane authorization failed')
    found.admission.assertActive()
    return found
  }
  return {
    async open(hi: Extract<Request, { t: 'hi' }>, credential: Credential | undefined, origin: string) {
      available()
      if (hi.cache !== undefined) throw new KernelError('INVALID', 'Cache claims are not available on this binding')
      if (hi.credential !== undefined && credential !== undefined && hi.credential.token !== credential.token)
        throw new KernelError('UNAUTHENTICATED', 'Conflicting credentials')
      const token = credential?.token ?? hi.credential?.token
      const supplied = token === undefined ? undefined : { token }
      if (lanes.size + opening >= instance.limits().maxLanes) throw new KernelError('BUDGET', 'Lane limit reached')
      opening++
      let admission: AuthAdmission | undefined
      try {
        admission = await instance.auth.openCredential(supplied, origin)
        available()
        const bucket = admission.actor.principal.startsWith('anon:') ? `ip:${networkAddress(origin).bucket}` : admission.actor.principal
        const count = buckets.get(bucket) ?? 0
        if (count >= instance.limits().lanesPerOrigin) throw new KernelError('BUDGET', 'Origin lane limit reached')
        const bound = admission, issuedCredential = supplied === undefined ? bound.resolution.credential : undefined
        const effective = supplied ?? issuedCredential
        if (effective === undefined) throw new KernelError('UNAVAILABLE', 'Auth factory did not issue a credential')
        const lane = createNodeLane({ ...instance.nodeLaneOptions(bound), issuedCredential })
        bound.assertActive()
        const id = randomBytes(16).toString('hex')
        let ended = false
        const onAbort = () => record.close()
        const record: ServedLane = { id, lane, admission: bound, origin, attached: false, credentialHash: tokenHash(effective.token),
          close(reason) {
            if (ended) return
            ended = true
            lanes.delete(id)
            const left = buckets.get(bucket)! - 1
            if (left === 0) buckets.delete(bucket); else buckets.set(bucket, left)
            bound.signal.removeEventListener('abort', onAbort)
            lane.close(reason)
            bound.close(reason)
          } }
        lanes.set(id, record); buckets.set(bucket, count + 1)
        bound.signal.addEventListener('abort', onAbort, { once: true })
        bound.assertActive()
        return { id, ...(issuedCredential === undefined ? {} : { credential: issuedCredential }) }
      } catch (error) { admission?.close(); throw error }
      finally { opening-- }
    },
    dispatch(id: string, credential: Credential | undefined, origin: string, requests: readonly Request[]): void {
      const found = authorized(id, credential, origin), decoded = requests.map(command)
      found.lane.touch()
      for (const request of decoded) found.lane.accept(request)
    },
    attach(id: string, credential: Credential | undefined, origin: string) {
      const found = authorized(id, credential, origin)
      if (found.attached) throw new KernelError('CONFLICT', 'Lane already has a reader')
      found.attached = true; found.lane.touch()
      return { frames: found.lane.frames, close: found.close }
    },
    close() {
      if (closed) return
      closed = true
      for (const record of lanes.values()) record.close()
    },
  }
}
export type TwpServing = ReturnType<typeof createTwpServing>
