import { assertSafePath } from '#core/path'
import { KernelError } from '#errors'
import type { ActionQuery, AclEntry, ChangeMember, Component, Credential, IncludeSpec, Node, NodeInput, OpId, Position, Preconditions, Principal, Selector, UpdateOps, ViewOwner } from '#kernel/types'
import { isRecord } from '#util/is-record'

export const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
export const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export const bits = (value: unknown): value is number => integer(value) && value <= 7
export const optional = <T>(value: unknown, test: (input: unknown) => input is T): value is T | undefined => value === undefined || test(value)
export const array = <T>(value: unknown, test: (input: unknown) => input is T): value is T[] => Array.isArray(value) && value.every(item => test(item))
export const keys = (value: Record<string, unknown>, names: readonly string[]) => Object.keys(value).every(name => names.includes(name))
export const principal = (value: unknown): value is Principal => typeof value === 'string' && /^(u:|n:|anon:).+/.test(value)

/** Validate declaration provenance at the transport boundary. */
export function viewOwner(value: unknown): value is ViewOwner {
  return isRecord(value) && keys(value, ['path', 'component']) && path(value.path)
    && typeof value.component === 'string' && (value.component === '' || value.component.startsWith('#'))
}

export function path(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try { assertSafePath(value); return true }
  catch { throw new KernelError('INVALID', 'Invalid wire path') }
}
export function isPosition(value: unknown): value is Position {
  return isRecord(value) && keys(value, ['instance', 'epoch', 'seq']) && text(value.instance) && integer(value.epoch) && integer(value.seq)
}
export function opId(value: unknown): value is OpId {
  return isRecord(value) && keys(value, ['epoch', 'time', 'nonce']) && text(value.epoch) && integer(value.time) && text(value.nonce)
}
export function credential(value: unknown): value is Credential {
  return isRecord(value) && keys(value, ['token']) && text(value.token)
}
function include(value: unknown): value is IncludeSpec {
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const item = pending.pop()
    if (!isRecord(item)) return false
    if ('path' in item) { if (!keys(item, ['path']) || !path(item.path)) return false }
    else {
      if (!keys(item, ['ref', 'then']) || !text(item.ref) || item.then !== undefined && !Array.isArray(item.then)) return false
      if (Array.isArray(item.then)) pending.push(...item.then)
    }
  }
  return true
}
function window(value: unknown): value is NonNullable<Extract<Selector, { children: string }>['window']> {
  return isRecord(value) && keys(value, ['limit', 'after', 'evict']) && integer(value.limit) && value.limit > 0
    && optional(value.after, text) && (value.evict === undefined || value.evict === true)
}
/** Foreign action admission metadata is validated with the ordinary wire request. */
function actionQuery(value: unknown): value is ActionQuery {
  return isRecord(value) && keys(value, ['name', 'component']) && text(value.name)
    && (value.component === undefined || value.component === '' || typeof value.component === 'string' && /^#[^.#\0]+$/.test(value.component))
}
export function isSelector(value: unknown): value is Selector {
  if (!isRecord(value)) return false
  if ('node' in value) return keys(value, ['node', 'include', 'action']) && path(value.node) && optional(value.include, input => array(input, include)) && optional(value.action, actionQuery)
  if ('history' in value) return keys(value, ['history', 'after', 'window']) && path(value.history)
    && optional(value.after, isPosition) && optional(value.window, window)
  return keys(value, ['children', 'where', 'sort', 'window', 'include', 'queryFields']) && path(value.children)
    && optional(value.queryFields, input => array(input, text))
    && optional(value.where, isRecord) && optional(value.window, window) && optional(value.include, input => array(input, include))
    && (value.sort === undefined || Array.isArray(value.sort) && value.sort.every(item => Array.isArray(item) && item.length === 2
      && text(item[0]) && (item[1] === 1 || item[1] === -1)))
}
function acl(value: unknown): value is AclEntry {
  if (!isRecord(value) || !isRecord(value.subject)) return false
  const subject = value.subject
  if (!('owner' in subject ? keys(subject, ['owner']) && subject.owner === true : keys(subject, ['group']) && text(subject.group))) return false
  return 'grant' in value ? keys(value, ['subject', 'grant']) && bits(value.grant) : keys(value, ['subject', 'deny']) && bits(value.deny)
}
function component(value: unknown): value is Component {
  return isRecord(value) && text(value.$type) && optional(value.$order, text) && optional(value.$v, integer)
}
function nodeFields(value: Record<string, unknown>): boolean {
  return path(value.$path) && text(value.$type) && optional(value.$order, text) && optional(value.$v, integer)
    && optional(value.$owner, principal) && optional(value.$acl, input => array(input, acl))
    && Object.entries(value).every(([name, item]) => !name.startsWith('#') || component(item))
}
export function isNodeInput(value: unknown): value is NodeInput {
  return isRecord(value) && value.$id === undefined && value.$rev === undefined && value.$pos === undefined && nodeFields(value)
}
export function isNode(value: unknown): value is Node {
  return isRecord(value) && text(value.$id) && text(value.$rev) && nodeFields(value)
}
function update(value: unknown): value is UpdateOps {
  return isRecord(value) && keys(value, ['$set', '$unset', '$inc', '$push']) && optional(value.$set, isRecord)
    && optional(value.$push, isRecord) && (value.$unset === undefined || isRecord(value.$unset) && Object.values(value.$unset).every(item => item === true))
    && (value.$inc === undefined || isRecord(value.$inc) && Object.values(value.$inc).every(item => typeof item === 'number' && Number.isFinite(item)))
}
export function change(value: unknown): value is ChangeMember {
  if (!isRecord(value)) return false
  switch (value.op) {
    case 'put': return keys(value, ['op', 'node']) && isNodeInput(value.node)
    case 'patch': return keys(value, ['op', 'path', 'ops']) && path(value.path) && update(value.ops)
    case 'remove': return keys(value, ['op', 'path']) && path(value.path)
    case 'adopt':
      case 'move': return keys(value, ['op', 'from', 'to']) && path(value.from) && path(value.to)
    case 'restore': case 'undo': return keys(value, ['op', 'record']) && isRecord(value.record) && keys(value.record, ['pos', 'id'])
      && isPosition(value.record.pos) && text(value.record.id)
    default: return false
  }
}
export function preconditions(value: unknown): value is Preconditions {
  return isRecord(value) && keys(value, ['nodes', 'absent', 'selectors'])
    && (value.nodes === undefined || Array.isArray(value.nodes) && value.nodes.every(item => isRecord(item)
      && keys(item, ['path', 'rev']) && path(item.path) && text(item.rev)))
    && optional(value.absent, input => array(input, path))
    && (value.selectors === undefined || Array.isArray(value.selectors) && value.selectors.every(item => isRecord(item)
      && keys(item, ['selector', 'at']) && isSelector(item.selector) && array(item.at, isPosition)))
}
