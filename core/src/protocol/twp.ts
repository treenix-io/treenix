import { viewOwner,isSelector,change as nativeChange } from '#kernel/input-boundary';
import { safeJsonParse } from '#util/json';
import { assertSafePath } from '#core/path';
import { KernelError } from '#errors';
import { serializeKernel } from '#kernel/serialization';
import type {
AclEntry,Component,ComputedNode,ErrorCopy,Credential,Frame,Node,NodeCopy,NodeInput,
ActionDescriptor,LaneOwnership,LaneProducer,OpId,Position,Preconditions,Principal,ReadResult,Request,Row
} from '#kernel/types';
import { isRecord } from '#util/is-record';
export { isSelector } from '#kernel/input-boundary'

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const bits = (value: unknown): value is number => integer(value) && value <= 7
const optional = <T>(value: unknown, test: (input: unknown) => input is T): value is T | undefined => value === undefined || test(value)
const array = <T>(value: unknown, test: (input: unknown) => input is T): value is T[] => Array.isArray(value) && value.every(item => test(item))
const keys = (value: Record<string, unknown>, names: readonly string[]) => Object.keys(value).every(name => names.includes(name))
const principal = (value: unknown): value is Principal => typeof value === 'string' && /^(u:|n:|anon:).+/.test(value)

function path(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try { assertSafePath(value); return true }
  catch { throw new KernelError('INVALID', 'Invalid wire path') }
}
export function isPosition(value: unknown): value is Position {
  return isRecord(value) && keys(value, ['instance', 'epoch', 'seq']) && text(value.instance) && integer(value.epoch) && integer(value.seq)
}
function opId(value: unknown): value is OpId {
  return isRecord(value) && keys(value, ['epoch', 'time', 'nonce']) && text(value.epoch) && integer(value.time) && text(value.nonce)
}
function credential(value: unknown): value is Credential {
  return isRecord(value) && keys(value, ['token']) && text(value.token)
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
function node(value: unknown): value is Node {
  return isRecord(value) && text(value.$id) && text(value.$rev) && nodeFields(value)
}
function preconditions(value: unknown): value is Preconditions {
  return isRecord(value) && keys(value, ['nodes', 'absent', 'selectors'])
    && (value.nodes === undefined || Array.isArray(value.nodes) && value.nodes.every(item => isRecord(item)
      && keys(item, ['path', 'rev']) && path(item.path) && text(item.rev)))
    && optional(value.absent, input => array(input, path))
    && (value.selectors === undefined || Array.isArray(value.selectors) && value.selectors.every(item => isRecord(item)
      && keys(item, ['selector', 'at']) && isSelector(item.selector) && array(item.at, isPosition)))
}
function actionDescriptor(value: unknown): value is ActionDescriptor {
  return isRecord(value) && keys(value, ['modules', 'type', 'kind', 'id', 'rev']) && text(value.modules)
    && text(value.type) && text(value.id) && text(value.rev)
    && (value.kind === 'read' || value.kind === 'write' || value.kind === 'setuid')
}
export function isRequest(value: unknown): value is Request {
  if (!isRecord(value)) return false
  switch (value.t) {
    case 'hi': return keys(value, ['t', 'credential', 'cache']) && optional(value.credential, credential)
      && (value.cache === undefined || Array.isArray(value.cache) && value.cache.every(item => isRecord(item)
        && keys(item, ['id', 'ver']) && text(item.id) && text(item.ver)))
    case 'read': return keys(value, ['t', 'req', 'selector']) && text(value.req) && isSelector(value.selector)
    case 'sub': return keys(value, ['t', 'sub', 'selector']) && text(value.sub) && isSelector(value.selector) && !('history' in value.selector)
    case 'unsub': return keys(value, ['t', 'sub']) && text(value.sub)
    case 'cancel': return keys(value, ['t', 'req']) && text(value.req)
    case 'act': return keys(value, ['t', 'req', 'path', 'component', 'action', 'args', 'opId', 'anchor', 'pre'])
      && text(value.req) && path(value.path) && text(value.action) && (value.component === undefined || value.component === ''
        || typeof value.component === 'string' && /^#[^.#\0]+$/.test(value.component))
      && 'args' in value && optional(value.opId, opId) && optional(value.anchor, opId) && optional(value.pre, actionDescriptor)
    case 'commit': return keys(value, ['t', 'req', 'changes', 'expect', 'opId']) && text(value.req)
      && array(value.changes, nativeChange) && optional(value.expect, preconditions) && opId(value.opId)
    default: return false
  }
}

const errorCodes = new Set(['NOT_FOUND', 'FORBIDDEN', 'CONFLICT', 'INVALID', 'UNKNOWN_TYPE', 'CROSS_DOMAIN', 'READ_ONLY',
  'BUDGET', 'REFUSED', 'UNKNOWN_OUTCOME', 'EXPIRED', 'KEY_REUSED', 'UNAVAILABLE', 'GENERATION', 'CANCELLED', 'UNAUTHENTICATED'])
function error(value: unknown): value is Extract<Frame, { t: 'fail' }>['error'] {
  return isRecord(value) && keys(value, ['code', 'message']) && typeof value.code === 'string' && errorCodes.has(value.code) && typeof value.message === 'string'
}
function copy(value: unknown): value is NodeCopy {
  if (!isRecord(value) || !text(value.ver)) return false
  return 'node' in value ? keys(value, ['node', 'bits', 'ver']) && node(value.node) && bits(value.bits)
    : keys(value, ['id', 'path', 'error', 'sort', 'query', 'ver']) && text(value.id) && path(value.path) && error(value.error) && optional(value.sort, isRecord) && optional(value.query, isRecord)
}
function viewError(value: unknown): value is ErrorCopy { return copy(value) && 'error' in value }
function computed(value: unknown): value is ComputedNode { return node(value) && value.$acl === undefined && value.$owner === undefined }
function row(value: unknown): value is Row { return isRecord(value) && text(value.key) }
export function isReadResult(value: unknown): value is ReadResult {
  return isRecord(value) && keys(value, ['list', 'copies', 'computed', 'viewErrors', 'rows', 'history', 'at', 'next', 'viewOwner', 'action', 'ownership'])
    && optional(value.viewOwner, viewOwner) && optional(value.action, actionDescriptor) && optional(value.ownership, laneOwnership)
    && array(value.list, text) && array(value.copies, copy) && array(value.at, isPosition) && optional(value.next, text)
    && optional(value.viewErrors, input => array(input, viewError)) && optional(value.computed, input => array(input, computed)) && optional(value.rows, input => array(input, row))
    && (value.history === undefined || Array.isArray(value.history) && value.history.every(item => isRecord(item)
      && keys(item, ['address', 'path', 'executor', 'caller', 'opId', 'before', 'after', 'kind']) && path(item.path)
      && (item.kind === 'commit' || item.kind === 'reconcile' || item.kind === 'kernel')
      && isRecord(item.address) && keys(item.address, ['pos', 'id']) && isPosition(item.address.pos) && text(item.address.id)
      && typeof item.executor === 'string' && /^(kernel$|(?:u:|n:|anon:|external:).+)/.test(item.executor)
      && typeof item.caller === 'string' && /^(kernel$|(?:u:|n:|anon:|external:).+)/.test(item.caller) && optional(item.opId, opId)
      && (item.before === null || item.before === 'unknown' || node(item.before)) && (item.after === null || node(item.after))))
}
function laneOwnership(value: unknown): value is LaneOwnership {
  return isRecord(value) && keys(value, ['roots', 'fixed']) && array(value.fixed, text)
    && array(value.roots, (root): root is LaneOwnership['roots'][number] => isRecord(root) && keys(root, ['id', 'covered', 'cursor', 'query'])
      && text(root.id) && text(root.cursor) && array(root.covered, text) && optional(root.query, isRecord))
}
function laneProducer(value: unknown): value is LaneProducer {
  return isRecord(value) && ('req' in value ? keys(value, ['req']) && text(value.req)
    : keys(value, ['sub', 'gen']) && text(value.sub) && integer(value.gen))
}

function laneChange(value: unknown): boolean {
  if (!isRecord(value)) return false
  switch (value.op) {
    case 'put': return keys(value, ['op', 'copy']) && copy(value.copy)
    case 'del': return keys(value, ['op', 'id']) && text(value.id)
    case 'list': return optional(value.ownership, laneOwnership) && keys(value, ['op', 'sub', 'gen', 'diff', 'covered', 'next', 'ownership']) && text(value.sub) && integer(value.gen) && listDiff(value.diff)
      && optional(value.covered, input => array(input, text)) && optional(value.next, text)
    case 'patch': return keys(value, ['op', 'id', 'base', 'delta', 'ver', 'bits']) && text(value.id) && text(value.base)
      && text(value.ver) && bits(value.bits) && isRecord(value.delta) && keys(value.delta, ['set', 'unset'])
      && optional(value.delta.set, isRecord) && optional(value.delta.unset, input => array(input, item => typeof item === 'string'))
    default: return false
  }
}
function listDiff(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => isRecord(item)
    && ('add' in item ? keys(item, ['add']) && text(item.add) : keys(item, ['remove']) && text(item.remove)))
}
export function isFrame(value: unknown): value is Frame {
  if (!isRecord(value)) return false
  switch (value.t) {
    case 'welcome': return keys(value, ['t', 'principal', 'intake', 'credential']) && principal(value.principal) && text(value.intake) && optional(value.credential, credential)
    case 'done': return keys(value, ['t', 'req', 'pos', 'value']) && text(value.req) && optional(value.pos, isPosition)
    case 'fail': return keys(value, ['t', 'req', 'error']) && optional(value.req, text) && error(value.error)
    case 'chunk': return keys(value, ['t', 'req', 'data']) && text(value.req) && 'data' in value
    case 'end': return keys(value, ['t', 'sub', 'error']) && text(value.sub) && error(value.error)
    case 'reset': return keys(value, ['t', 'sub', 'gen']) && text(value.sub) && integer(value.gen)
    case 'pos':
      return (
        keys(value, ['t', 'pos', 'changes', 'coverage', 'intake', 'producer']) && optional(value.producer, laneProducer) &&
        isPosition(value.pos) &&
        Array.isArray(value.changes) &&
        value.changes.every(laneChange) &&
        (value.coverage === undefined
          ? optional(value.intake, text)
          : value.coverage === true &&
            value.intake === undefined &&
            value.producer === undefined &&
            value.changes.every(
              (item) => isRecord(item) && (item.op === 'del' || item.op === 'list'),
            ))
      )
    case 'snap': case 'result': return keys(value, ['t', 'sub', 'gen', value.t === 'snap' ? 'list' : 'diff', 'covered', 'copies', 'computed', 'viewErrors', 'rows', 'at', 'next', 'viewOwner', 'action', 'ownership', 'foreign'])
      && optional(value.foreign, input => array(input, text))
      && optional(value.ownership, laneOwnership) && optional(value.viewOwner, viewOwner) && optional(value.action, actionDescriptor)
      && text(value.sub) && integer(value.gen) && (value.t === 'snap' ? array(value.list, text) : listDiff(value.diff))
      && array(value.copies, copy) && array(value.at, isPosition) && optional(value.next, text) && optional(value.covered, input => array(input, text))
      && optional(value.viewErrors, input => array(input, viewError)) && optional(value.computed, input => array(input, computed)) && optional(value.rows, input => array(input, row))
    default: return false
  }
}

export function decodeJson(input: Uint8Array | string, limit: number): unknown {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input).byteLength : input.byteLength
  if (bytes > limit) throw new KernelError('BUDGET', 'Wire request is too large')
  try {
    const json = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input)
    return safeJsonParse(json)
  } catch { throw new KernelError('INVALID', 'Malformed wire JSON') }
}
export function decodeRequests(input: Uint8Array | string, limit: number): readonly Request[] {
  const value = decodeJson(input, limit), batch: unknown[] = Array.isArray(value) ? value : [value]
  if (!array(batch, isRequest)) throw new KernelError('INVALID', 'Malformed wire request')
  return batch
}
export function decodeFrame(input: Uint8Array | string, limit: number): Frame {
  const value = decodeJson(input, limit)
  if (!isFrame(value)) throw new KernelError('INVALID', 'Malformed wire frame')
  return value
}
export function encodeFrame(frame: Frame): string {
  return serializeKernel(frame)
}
