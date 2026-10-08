import { ancestorPaths, dirname } from '#core/path'
import { KernelError } from '#errors'
import { isRecord } from '#util/is-record'
import { validBits, type ChainNode, type RightsAlert } from './rights'
import { treeEnsure, treeNavigate, treeRemove, treeWalk, type TreeNode } from './store/nested-map'
import type { AclEntry, Path, Principal, StoredNode, Subject } from './types'

// ACL and owner are decoded here because accepted external Store edits can break their shape.
export type ChainInput = Pick<StoredNode, '$path' | '$id' | '$type'> & Readonly<Record<string, unknown>>

function principal(raw: unknown): raw is Principal {
  return typeof raw === 'string' && /^(?:u|n|anon):.+$/.test(raw)
}

function subject(raw: unknown): Subject | undefined {
  if (!isRecord(raw) || Object.keys(raw).length !== 1) return undefined
  if (typeof raw.group === 'string' && raw.group.length !== 0) return { group: raw.group }
  if (raw.owner === true) return { owner: true }
  return undefined
}

function acl(raw: unknown): readonly AclEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const entries: AclEntry[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || Object.keys(entry).length !== 2) return undefined
    const who = subject(entry.subject)
    if (who === undefined) return undefined
    if (Object.hasOwn(entry, 'grant') && validBits(entry.grant)) entries.push({ subject: Object.freeze(who), grant: entry.grant })
    else if (Object.hasOwn(entry, 'deny') && validBits(entry.deny)) entries.push({ subject: Object.freeze(who), deny: entry.deny })
    else return undefined
  }
  return Object.freeze(entries.map(entry => Object.freeze(entry)))
}

export function decodeChainNode(input: ChainInput): ChainNode {
  const alerts: RightsAlert[] = []
  const bad = (field: string) => alerts.push({ path: input.$path, field, error: new KernelError('INVALID', 'Uncomputable stored rights') })
  const hasAcl = input.$acl !== undefined, hasOwner = input.$owner !== undefined
  const entries = hasAcl ? acl(input.$acl) : []
  const owner = input.$owner
  let invalid: ChainNode['invalid']
  if (entries === undefined) { invalid = 'chain'; bad('$acl') }
  if (hasOwner && !principal(owner)) { invalid = 'chain'; bad('$owner') }
  const types = new Set([input.$type])
  for (const [key, component] of Object.entries(input)) {
    if (!key.startsWith('#')) continue
    if (!isRecord(component) || typeof component.$type !== 'string' || component.$type.length === 0) {
      invalid ??= 'node'; bad(`${key}.$type`)
    } else types.add(component.$type)
  }
  return Object.freeze({ path: input.$path, id: input.$id, types: Object.freeze([...types]),
    acl: entries ?? [], hasAcl, hasOwner, invalid, alerts: Object.freeze(alerts),
    ...principal(owner) ? { owner } : {},
  })
}

const subjectKey = (who: Subject) => 'group' in who ? `group:${who.group}` : 'owner'

export function createChainIndex() {
  const nodes = new Map<Path, ChainNode>()
  const children = new Map<Path, Set<Path>>()
  const grants = new Map<string, Set<Path>>()
  const boundaries: TreeNode<ChainNode> = { children: new Map() }
  let ownerGrants: Map<Principal, Set<Path>> | undefined
  function unindex(node: ChainNode): void {
    for (const entry of node.acl) {
      if (!('grant' in entry) || entry.grant === 0) continue
      const key = subjectKey(entry.subject), paths = grants.get(key)
      paths?.delete(node.path)
      if (paths?.size === 0) grants.delete(key)
    }
  }
  return {
    put(input: ChainInput): ChainNode {
      const node = decodeChainNode(input)
      const previous = nodes.get(node.path)
      if (previous !== undefined) unindex(previous)
      if (node.hasOwner || previous?.hasOwner || [...node.acl, ...previous?.acl ?? []].some(entry => 'owner' in entry.subject)) ownerGrants = undefined
      nodes.set(node.path, node)
      const parent = dirname(node.path)
      if (parent !== null) {
        let paths = children.get(parent)
        if (paths === undefined) { paths = new Set(); children.set(parent, paths) }
        paths.add(node.path)
      }
      if (node.hasAcl || node.hasOwner) treeEnsure(boundaries, node.path).data = node
      else treeRemove(boundaries, node.path)
      for (const entry of node.acl) {
        if (!('grant' in entry) || entry.grant === 0) continue
        const key = subjectKey(entry.subject)
        let paths = grants.get(key)
        if (paths === undefined) { paths = new Set(); grants.set(key, paths) }
        paths.add(node.path)
      }
      return node
    },
    remove(path: Path): void {
      const previous = nodes.get(path)
      if (previous !== undefined) unindex(previous)
      if (previous?.hasOwner || previous?.acl.some(entry => 'owner' in entry.subject)) ownerGrants = undefined
      nodes.delete(path)
      const parent = dirname(path)
      if (parent !== null) {
        const paths = children.get(parent)
        paths?.delete(path)
        if (paths?.size === 0) children.delete(parent)
      }
      treeRemove(boundaries, path)
    },
    get: (path: Path): ChainNode | undefined => nodes.get(path),
    *children(path: Path): Iterable<ChainNode> {
      for (const child of children.get(path) ?? []) yield nodes.get(child)!
    },
    chain(path: Path): readonly ChainNode[] {
      const chain: ChainNode[] = []
      for (const ancestor of ancestorPaths(path)) {
        const node = nodes.get(ancestor)
        if (node !== undefined) chain.push(node)
      }
      return chain
    },
    *boundaries(path: Path): Iterable<ChainNode> {
      const start = treeNavigate(boundaries, path)
      if (start === undefined) return
      for (const node of treeWalk(start)) if (node.data !== undefined) yield node.data
    },
    grants(subject: Subject): Iterable<Path> {
      return grants.get(subjectKey(subject))?.values() ?? []
    },
    *grantsTo(principal: Principal): Iterable<Path> {
      const paths = new Set(grants.get(`group:${principal}`))
      if (ownerGrants === undefined) {
        ownerGrants = new Map()
        for (const path of grants.get('owner') ?? []) {
          let owner: Principal | undefined
          for (const ancestor of ancestorPaths(path)) owner = nodes.get(ancestor)?.owner ?? owner
          if (owner === undefined) continue
          let targets = ownerGrants.get(owner)
          if (targets === undefined) { targets = new Set(); ownerGrants.set(owner, targets) }
          targets.add(path)
        }
      }
      for (const path of ownerGrants.get(principal) ?? []) paths.add(path)
      yield* paths
    },
  }
}
