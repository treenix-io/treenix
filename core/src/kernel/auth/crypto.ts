import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { KernelError } from '#errors'
import { isRecord } from '#util/is-record'
import type { Path } from '#kernel/types'
import { assertSafePath } from '#core/path'

export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex')
export const credentialPath = (token: string): string => `/auth/sessions/${tokenHash(token)}`
export const passwordPath = (accountId: string): string => `/auth/credentials/${tokenHash(accountId)}`

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 64, (error, value) => error ? reject(error) : resolve(value)))
  return `${salt.toString('hex')}:${key.toString('hex')}`
}

// Pre-computed dummy hash for constant-time login (prevents timing-based user enumeration)
export const DUMMY_HASH = `${randomBytes(16).toString('hex')}:${randomBytes(64).toString('hex')}`

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(hash)) throw new KernelError('INVALID', 'Malformed password hash')
  const [salt, stored] = hash.split(':')
  const key = await new Promise<Buffer>((resolve, reject) =>
    scrypt(password, Buffer.from(salt, 'hex'), 64, (error, value) => error ? reject(error) : resolve(value)))
  return timingSafeEqual(Buffer.from(stored, 'hex'), key)
}

export function credentialScope(value: unknown): readonly Path[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new KernelError('INVALID', 'Credential scope must be an array')
  const paths: Path[] = []
  for (const path of value) {
    if (typeof path !== 'string') throw new KernelError('INVALID', 'Credential scope must contain paths')
    try { assertSafePath(path) } catch (error) {
      console.error(error)
      throw new KernelError('INVALID', 'Invalid credential scope path')
    }
    paths.push(path)
  }
  return Object.freeze([...new Set(paths)].sort())
}

export interface AnonymousIdentity {
  readonly instance: string
  readonly id: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly scope?: readonly Path[]
}

export function signAnonymous(identity: AnonymousIdentity, key: string): string {
  const body = Buffer.from(JSON.stringify(identity)).toString('base64url')
  const signature = createHmac('sha256', Buffer.from(key, 'hex')).update(body).digest('base64url')
  return `anon.${body}.${signature}`
}

export function verifyAnonymous(token: string, key: string, instance: string, now: number): AnonymousIdentity {
  const invalid = () => new KernelError('UNAUTHENTICATED', 'Invalid credential')
  const [prefix, body, signature, extra] = token.split('.')
  if (prefix !== 'anon' || body === undefined || signature === undefined || extra !== undefined) throw invalid()
  const expected = createHmac('sha256', Buffer.from(key, 'hex')).update(body).digest('base64url')
  if (signature.length !== expected.length) throw invalid()
  const actualBytes = Buffer.from(signature), expectedBytes = Buffer.from(expected)
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) throw invalid()
  let value: unknown
  try { value = JSON.parse(Buffer.from(body, 'base64url').toString()) }
  catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause
    throw invalid()
  }
  if (!isRecord(value) || value.instance !== instance || typeof value.id !== 'string' || !/^[0-9a-f]{32}$/.test(value.id)
    || Object.keys(value).some(field => !['instance', 'id', 'issuedAt', 'expiresAt', 'scope'].includes(field))
    || typeof value.issuedAt !== 'number' || !Number.isFinite(value.issuedAt) || value.issuedAt > now
    || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= now) throw invalid()
  let scope: readonly Path[] | undefined
  try { scope = credentialScope(value.scope) } catch (error) {
    if (error instanceof KernelError && error.code === 'INVALID') throw invalid()
    throw error
  }
  return { instance, id: value.id, issuedAt: value.issuedAt, expiresAt: value.expiresAt, ...(scope === undefined ? {} : { scope }) }
}
