import { randomBytes } from 'node:crypto'
import { KernelError } from '#errors'
import { hashPassword, passwordPath } from '#kernel/auth/crypto'
import { A, R, W, type JsonSchema, type ModuleManifest, type NodeId, type NodeInput, type RuleInput, type TypeDef } from '#kernel/types'

export const AUTH_KEY_PATH = '/sys/auth-key'
export const AUTH_MODULE = 'treenix.auth'
const ALL = R | W | A
const groupPattern = '^(?!(?:u:|n:|anon:|public$|authenticated$)).+$'
const validGroup = new RegExp(groupPattern)

export function assertGroups(groups: readonly string[]): void {
  for (const group of groups) if (!validGroup.test(group)) throw new KernelError('INVALID', 'Reserved or empty group')
}

const schema = (properties: JsonSchema, required = Object.keys(properties)): JsonSchema =>
  ({ type: 'object', properties, required, additionalProperties: false })
const text = { type: 'string', minLength: 1 }
const secret = (input: RuleInput) => input.admin ? W : 0
const admin = (input: RuleInput) => input.admin ? ALL : R
const account = (input: RuleInput) => input.admin ? ALL : input.actor.principal === `u:${input.id}` ? R : 0
const definition = (name: string, shape: JsonSchema): TypeDef =>
  ({ name, module: AUTH_MODULE, security: 'ordinary', version: 0, schema: shape, actions: {}, actionsOnly: true })

export const authManifest: ModuleManifest = {
  id: AUTH_MODULE,
  types: [
    definition('t.user', schema({ name: text, status: { enum: ['active', 'pending', 'blocked'] } })),
    definition('t.groups', schema({ list: { type: 'array', items: { ...text, pattern: groupPattern } } })),
    definition('t.credentials', schema({ accountId: text, hash: { type: 'string', pattern: '^[0-9a-f]{32}:[0-9a-f]{128}$' } })),
    definition('t.session', schema({ accountId: text, expiresAt: { type: 'number' }, revoked: { type: 'boolean' },
      scope: { type: 'array', items: text } }, ['accountId', 'expiresAt', 'revoked'])),
    definition('t.auth-key', schema({ instance: text, key: { type: 'string', pattern: '^[0-9a-f]{64}$' } })),
  ],
  security: [
    { type: 't.user', context: 'acl', handler: account },
    { type: 't.groups', context: 'acl', handler: admin },
    ...['t.credentials', 't.session', 't.auth-key'].map(type => ({ type, context: 'acl' as const, handler: secret })),
  ],
  open: [],
}

export interface AdminInput {
  readonly path: string
  readonly name: string
  readonly password: string
}

export async function prepareAdmin(input: AdminInput) {
  const { path, name, password } = input
  const hash = await hashPassword(password)
  const account: NodeInput = { $path: path, $type: 't.user', name, status: 'active',
    '#groups': { $type: 't.groups', list: ['admins'] } }
  const passwordRecord = (accountId: NodeId): NodeInput =>
    ({ $path: passwordPath(accountId), $type: 't.credentials', accountId, hash })
  return { account, passwordRecord }
}

export function authKeyInput(instance: string): NodeInput {
  return { $path: AUTH_KEY_PATH, $type: 't.auth-key', instance, key: randomBytes(32).toString('hex') }
}
