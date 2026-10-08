import { assertSafePath } from '#core/path'
import { KernelError } from '#errors'
import { DUMMY_HASH, passwordPath, verifyPassword } from '#kernel/auth/crypto'
import type { AuthReadSource, AuthSource } from '#kernel/session'
import type { NodeId, Path, Registry } from '#kernel/types'

export interface LoginInput {
  readonly account: Path
  readonly password: string
  readonly scope?: readonly Path[]
}
export interface LoginProof {
  readonly accountId: NodeId
  readonly passwordId: NodeId
  readonly passwordHash: string
}
const unauthenticated = () => new KernelError('UNAUTHENTICATED', 'Invalid login')

async function passwordRecord(read: AuthReadSource, registry: Registry, accountId: NodeId) {
  const node = await read.node(passwordPath(accountId))
  if (node === null) return null
  if (registry.type(node.$type).name !== 't.credentials' || node.accountId !== accountId || typeof node.hash !== 'string')
    throw new KernelError('INVALID', 'Invalid accepted password record')
  return Object.freeze({ passwordId: node.$id, passwordHash: node.hash })
}

export async function authenticateLogin(source: AuthSource, registry: Registry, input: Pick<LoginInput, 'account' | 'password'>): Promise<LoginProof> {
  const { account: path, password } = input
  assertSafePath(path)
  const snapshot = await source.read(async read => {
    const account = await read.node(path)
    if (account === null || registry.type(account.$type).name !== 't.user') return null
    const record = await passwordRecord(read, registry, account.$id)
    return record === null ? null : Object.freeze({ accountId: account.$id, status: account.status, ...record })
  })
  // The accepted read barrier ends before scrypt; issuance rechecks its auth inputs in Writer order.
  const matches = await verifyPassword(password, snapshot === null ? DUMMY_HASH : snapshot.passwordHash)
  if (snapshot === null || !matches || snapshot.status !== 'active') throw unauthenticated()
  return Object.freeze({ accountId: snapshot.accountId, passwordId: snapshot.passwordId, passwordHash: snapshot.passwordHash })
}

export async function recheckLogin(read: AuthReadSource, registry: Registry, proof: LoginProof): Promise<void> {
  const account = await read.nodeById(proof.accountId)
  if (account === null || account.$id !== proof.accountId || registry.type(account.$type).name !== 't.user' || account.status !== 'active')
    throw unauthenticated()
  const current = await passwordRecord(read, registry, proof.accountId)
  if (current === null || current.passwordId !== proof.passwordId || current.passwordHash !== proof.passwordHash) throw unauthenticated()
}
