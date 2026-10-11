import { KernelError } from '#errors';
import { prepareCredential } from '#kernel/auth/credentials';
import { credentialScope } from '#kernel/auth/crypto';
import type { AuthReadSource } from '#kernel/session';
import { hashAgentKey, timingSafeCompare, AGENT_SESSION_TTL } from '#security/agent';
import { R, W, type ActionDef, type ChangeMember, type Principal, type StoredNode, type TypeDef } from '#kernel/types';

export const PAIRING_MODULE = 'treenix.auth';
type PairingOperation = 'initPair' | 'approve' | 'connect' | 'revoke' | 'reset';
const operations = new Map<Function, PairingOperation>();

/** Only these compiled handlers acquire the auth owner's accepted-state transition. */
function action(operation: PairingOperation, args: ActionDef['args']): ActionDef {
  async function handler(): Promise<void> {
    throw new KernelError('INVALID', 'Auth-owned action is not bound');
  }
  operations.set(handler, operation);
  return { kind: 'setuid', args, handler };
}

const text = { type: 'string', minLength: 1 };
const keyArgs = { type: 'object', properties: { key: text }, required: ['key'], additionalProperties: false };
const emptyArgs = { type: 'object', properties: {}, additionalProperties: false };
export const pairingTypes: readonly TypeDef[] = [
  {
    name: 't.agent.port', module: PAIRING_MODULE, security: 'user-capability', version: 0, actionsOnly: true,
    schema: { type: 'object', properties: {
      label: { type: 'string' }, status: { enum: ['idle', 'pending', 'approved', 'revoked'] },
      connected: { type: 'boolean' }, connectedAt: { type: 'number' },
    }, required: ['status'], additionalProperties: false },
    actions: {
      initPair: action('initPair', { ...keyArgs, properties: { key: text, scope: { type: 'array', items: text } } }),
      approve: action('approve', emptyArgs), connect: action('connect', keyArgs),
      revoke: action('revoke', emptyArgs), reset: action('reset', emptyArgs),
    },
  },
  {
    name: 't.agent.pairing', module: PAIRING_MODULE, security: 'ordinary', version: 0, actionsOnly: true, actions: {},
    schema: { type: 'object', properties: { portId: text, hash: text, account: text,
      scope: { type: 'array', items: text } }, required: ['portId', 'account', 'scope'], additionalProperties: false },
  },
];

/** A type name alone cannot grant the trusted compiled handler's authority. */
export function pairingOperation(type: TypeDef, definition: ActionDef): PairingOperation | undefined {
  if (type.module !== PAIRING_MODULE || type.name !== 't.agent.port' || definition.kind !== 'setuid'
    || definition.handler === undefined) return undefined;
  return operations.get(definition.handler);
}

/** Closed state contains the key hash and account binding; the public port carries only lifecycle state. */
export function pairingPath(id: string): string {
  return `/sys/agent-pairing/${id}`;
}

/** Preserve unrelated grants while replacing this account's pairing grant once. */
function accountAcl(port: StoredNode, principal: Principal, approved: boolean) {
  const acl = [];
  for (const entry of port.$acl ?? []) {
    if ('group' in entry.subject && entry.subject.group === principal) continue;
    acl.push(entry);
  }
  if (approved) acl.push({ subject: { group: principal }, grant: R | W });
  return acl;
}

interface PairingState extends StoredNode {
  readonly portId: string;
  readonly hash?: string;
  readonly account: string;
  readonly scope: readonly string[];
}

/** Decode persisted schema data loudly; malformed trusted state cannot disappear behind a filter. */
function pairingState(node: StoredNode | null, port: StoredNode): PairingState {
  if (node === null || node.$type !== 't.agent.pairing' || node.portId !== port.$id
    || node.hash !== undefined && typeof node.hash !== 'string' || node.account !== `/auth/users/agent-${port.$id}` || !Array.isArray(node.scope)
    || !node.scope.every(path => typeof path === 'string'))
    throw new KernelError('INVALID', 'Agent pairing state is invalid');
  return { ...node, portId: port.$id, ...(typeof node.hash === 'string' ? { hash: node.hash } : {}), account: node.account, scope: node.scope };
}

/** Compute the auth owner's constrained transition inside the action's existing Writer barrier. */
export async function preparePairing(operation: PairingOperation, port: StoredNode, args: unknown, read: AuthReadSource):
  Promise<{ readonly authChanges: readonly ChangeMember[]; readonly portChange?: ChangeMember; readonly value: unknown }> {
  const closed = pairingPath(port.$id);
  if (operation === 'initPair') {
    if (port.status !== 'idle') throw new KernelError('CONFLICT', 'Agent port is not idle');
    if (typeof args !== 'object' || args === null || !('key' in args) || typeof args.key !== 'string')
      throw new KernelError('INVALID', 'Agent key is absent');
    const scope = credentialScope('scope' in args ? args.scope : [port.$path]);
    if (scope === undefined || scope.length === 0) throw new KernelError('INVALID', 'Agent scope is empty');
    for (const path of scope) if (path !== port.$path && !path.startsWith(`${port.$path}/`))
      throw new KernelError('INVALID', 'Agent scope exceeds the port subtree');
    return { authChanges: [
      { op: 'put', node: { $path: closed, $type: 't.agent.pairing', portId: port.$id,
        hash: hashAgentKey(args.key), account: `/auth/users/agent-${port.$id}`, scope } },
    ], portChange: { op: 'patch', path: port.$path, ops: { $set: { status: 'pending', connected: false } } }, value: { status: 'pending' } };
  }
  const state = pairingState(await read.node(closed), port);
  const account = await read.node(state.account);
  if (operation === 'approve') {
    if (port.status !== 'pending' || account !== null) throw new KernelError('CONFLICT', 'Agent cannot be approved');
    return { authChanges: [
      { op: 'put', node: { $path: state.account, $type: 't.user', name: `agent-${port.$id}`, status: 'active' } },
    ], portChange: { op: 'patch', path: port.$path, ops: { $set: { status: 'approved' } } }, value: { status: 'approved' } };
  }
  if (operation === 'connect') {
    if (typeof args !== 'object' || args === null || !('key' in args) || typeof args.key !== 'string')
      throw new KernelError('INVALID', 'Agent key is absent');
    if (state.hash === undefined || !timingSafeCompare(hashAgentKey(args.key), state.hash)) throw new KernelError('FORBIDDEN', 'Agent key differs');
    if (port.status === 'pending') return { authChanges: [], value: { status: 'pending' } };
    if (port.status !== 'approved') throw new KernelError('FORBIDDEN', 'Agent pairing is not approved');
    if (account === null || account.$type !== 't.user' || account.status !== 'active')
      throw new KernelError('UNAUTHENTICATED', 'Agent account is unavailable');
    const issued = prepareCredential(account.$id, { expiresAt: Date.now() + AGENT_SESSION_TTL, scope: state.scope });
    const principal: Principal = `u:${account.$id}`;
    return { authChanges: [{ op: 'put', node: issued.node }],
      portChange: { op: 'patch', path: port.$path, ops: { $set: { connected: true, connectedAt: Date.now(), $acl: accountAcl(port, principal, true) } } }, value: { status: 'approved', credential: issued.credential, principal } };
  }
  if (operation === 'revoke') {
    if (port.status !== 'approved' || account === null) throw new KernelError('CONFLICT', 'Agent cannot be revoked');
    return { authChanges: [
      { op: 'patch', path: state.account, ops: { $set: { status: 'blocked' } } },
      { op: 'patch', path: closed, ops: { $unset: { hash: true } } },
    ], portChange: { op: 'patch', path: port.$path, ops: { $set: { status: 'revoked', connected: false, $acl: accountAcl(port, `u:${account.$id}`, false) } } }, value: { status: 'revoked' } };
  }
  return { authChanges: [
    ...(account === null ? [] : [{ op: 'remove' as const, path: state.account }]),
    { op: 'remove', path: closed },
  ], portChange: { op: 'patch', path: port.$path, ops: { $set: { status: 'idle', connected: false, ...(account === null ? {} : { $acl: accountAcl(port, `u:${account.$id}`, false) }) }, $unset: { connectedAt: true } } }, value: { status: 'idle' } };
}
