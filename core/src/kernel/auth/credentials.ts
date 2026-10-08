import { randomBytes } from 'node:crypto'
import { KernelError } from '#errors'
import { credentialPath, credentialScope } from '#kernel/auth/crypto'
import type { Credential, NodeId, NodeInput, Path } from '#kernel/types'

export interface AuthSessionInput extends NodeInput {
  readonly $type: 't.session'
  readonly accountId: NodeId
  readonly expiresAt: number
  readonly revoked: boolean
  readonly scope?: readonly Path[]
}
export interface PreparedCredential {
  readonly credential: Credential
  readonly node: AuthSessionInput
}

export function prepareCredential(accountId: NodeId, options: { readonly expiresAt: number; readonly scope?: readonly Path[] }): PreparedCredential {
  if (accountId.length === 0 || accountId.startsWith('p:') || !Number.isFinite(options.expiresAt)) {
    throw new KernelError('INVALID', 'Invalid credential provisioning')
  }
  const credential: Credential = Object.freeze({ token: randomBytes(32).toString('hex') })
  const scope = credentialScope(options.scope)
  const node: AuthSessionInput = Object.freeze({ $path: credentialPath(credential.token), $type: 't.session', accountId,
    expiresAt: options.expiresAt, revoked: false, ...(scope === undefined ? {} : { scope }) })
  return Object.freeze({ credential, node })
}
