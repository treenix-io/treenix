import { createHash, randomUUID } from 'node:crypto'
import { normalizeType } from '#core/component'
import { passwordPath } from '#kernel/auth/crypto'
import { isRecord } from '#util/is-record'
import { assertSafePath } from '#core/path'
import type { Position } from '#kernel/types'

export interface UpgradeDocument {
  readonly path: string
  readonly body: Readonly<Record<string, unknown>>
}

export interface UpgradeFinding {
  readonly path: string
  readonly code: string
  readonly severity: 'change' | 'warning' | 'error'
}

export interface UpgradePlan {
  readonly version: 2
  readonly documents: readonly UpgradeDocument[]
  readonly findings: readonly UpgradeFinding[]
  readonly inputHash: string
  readonly retired: readonly string[]
}

export interface UpgradeOptions {
  readonly id?: () => string
  readonly validate: (component: Readonly<Record<string, unknown>>, path: string) => readonly string[]
  readonly anonymous?: { readonly instance: string; readonly key: string }
  readonly mongoClusters?: Readonly<Record<string, string>>
  readonly mongoPosition?: Position
  readonly resolveDeny?: (path: string, group: string, permission: number) => 'retain' | 'remove' | undefined
}

/** Validate an administrative plan artifact before either adapter uses its logical addresses. */
export function isUpgradePlan(value: unknown): value is UpgradePlan {
  if (!isRecord(value) || value.version !== 2 || typeof value.inputHash !== 'string'
    || !Array.isArray(value.documents) || !Array.isArray(value.retired) || !Array.isArray(value.findings)) return false
  const paths: string[] = []
  for (const document of value.documents) {
    if (!isRecord(document) || typeof document.path !== 'string' || !isRecord(document.body)
      || typeof document.body.$id !== 'string' || typeof document.body.$type !== 'string') return false
    paths.push(document.path)
  }
  for (const path of value.retired) {
    if (typeof path !== 'string') return false
    paths.push(path)
  }
  for (const path of paths) {
    try { assertSafePath(path) }
    catch (error) {
      if (!(error instanceof Error)) throw error
      return false
    }
  }
  for (const finding of value.findings) {
    if (!isRecord(finding) || typeof finding.path !== 'string' || typeof finding.code !== 'string'
      || (finding.severity !== 'error' && finding.severity !== 'change' && finding.severity !== 'warning')) return false
  }
  return true
}

/** Decode persisted external objects before conversion; owned documents stay typed thereafter. */
export function upgradeObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('INVALID_DOCUMENT')
  return Object.fromEntries(Object.entries(value))
}

/** Bind a plan to the exact logical input rather than an unstable enumeration order. */
export function upgradeInputHash(documents: readonly UpgradeDocument[]): string {
  const ordered = [...documents].sort((a, b) => a.path.localeCompare(b.path))
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
}

/** Refuse values that a JSON operator artifact cannot preserve byte-for-byte. */
function hasNonJsonPayload(body: Readonly<Record<string, unknown>>): boolean {
  const pending: unknown[] = [body]
  const seen = new WeakSet<object>()
  while (pending.length !== 0) {
    const value = pending.pop()
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return true
      continue
    }
    if (typeof value !== 'object' || seen.has(value)) return true
    seen.add(value)
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null) return true
    for (const field of Object.values(value)) pending.push(field)
  }
  return false
}

/** Produce a complete offline plan; errors prohibit applying any part of it. */
export function planKernelUpgrade(input: readonly UpgradeDocument[], options: UpgradeOptions): UpgradePlan {
  const findings: UpgradeFinding[] = []
  const documents = input.map(document => ({ path: document.path, body: upgradeObject(structuredClone(document.body)) }))
  const identities = new Map<string, string>()
  const accounts = new Map<string, string>()
  const paths = new Set<string>()
  const retired = new Set<string>()
  const id = options.id ?? randomUUID
  const report = (path: string, code: string, severity: UpgradeFinding['severity']) => findings.push({ path, code, severity })

  const byPath = new Map(documents.map(document => [document.path, document]))
  for (const document of documents) {
    if (document.body.$type !== 'moved' && document.body.$type !== 't.moved') continue
    const visited = new Set([document.path])
    let current = document
    for (;;) {
      const reference = current.body.$ref
      if (typeof reference !== 'string' || !reference.startsWith('/')) {
        report(document.path, 'INVALID_TOMBSTONE_TARGET', 'error')
        break
      }
      if (visited.has(reference)) { report(document.path, 'TOMBSTONE_CYCLE', 'error'); break }
      visited.add(reference)
      const target = byPath.get(reference)
      if (target === undefined) {
        retired.add(document.path)
        report(document.path, 'RETIRED_TARGETLESS_TOMBSTONE', 'warning')
        break
      }
      if (target.body.$type === 'moved' || target.body.$type === 't.moved') { current = target; continue }
      if (typeof document.body.$id !== 'string' || target.body.$id !== document.body.$id) {
        report(document.path, 'TOMBSTONE_IDENTITY_MISMATCH', 'error')
        break
      }
      retired.add(document.path)
      report(document.path, 'RESOLVED_MOVED_TOMBSTONE', 'change')
      break
    }
  }

  documents.sort((a, b) => Number(a.path.startsWith('/sys/trash/')) - Number(b.path.startsWith('/sys/trash/')))

  for (const document of documents) {
    const { path, body } = document
    if (hasNonJsonPayload(body)) report(path, 'NON_JSON_PAYLOAD_REQUIRES_REVIEW', 'error')
    if (retired.has(path)) continue
    if (!path.startsWith('/') || paths.has(path)) report(path, 'DUPLICATE_OR_INVALID_PATH', 'error')
    paths.add(path)
    if (body.$id === undefined) {
      body.$id = id()
      report(path, 'ASSIGNED_ID', 'change')
    }
    if (typeof body.$id !== 'string' || body.$id.length === 0) {
      report(path, 'INVALID_EXISTING_ID', 'error')
      continue
    }
    const identity = body.$id
    const previous = identities.get(body.$id)
    if (previous !== undefined && path.startsWith('/sys/trash/')) {
      body.$id = id()
      report(path, 'REIDENTIFIED_ARCHIVED_DUPLICATE', 'warning')
    } else if (previous !== undefined) report(path, 'DUPLICATE_ID', 'error')
    else identities.set(body.$id, path)
    if (body.$type === 't.user' && !path.startsWith('/sys/trash/')) {
      const name = path.startsWith('/auth/users/') ? path.slice('/auth/users/'.length) : body.name
      if (typeof name !== 'string' || name.length === 0 || accounts.has(name)) report(path, 'AMBIGUOUS_ACCOUNT', 'error')
      else {
        accounts.set(name, identity)
        if (accounts.has(identity) && accounts.get(identity) !== identity) report(path, 'AMBIGUOUS_ACCOUNT_ALIAS', 'error')
        accounts.set(identity, identity)
        if (body.name === undefined) { body.name = name; report(path, 'ACCOUNT_NAME_FROM_ADDRESS', 'change') }
        if (body.status === undefined) { body.status = 'pending'; report(path, 'PRESERVED_PENDING_ACCOUNT_DEFAULT', 'change') }
      }
    }
  }

  function principal(value: unknown, path: string): unknown {
    if (typeof value !== 'string') {
      report(path, 'INVALID_PRINCIPAL', 'error')
      return value
    }
    if (value.startsWith('anon:') || value.startsWith('n:')) return value
    const name = value.startsWith('u:') ? value.slice(2) : value
    const account = accounts.get(name)
    if (account !== undefined) return `u:${account}`
    if (value.startsWith('u:') && identities.has(name)) return value
    report(path, 'UNRESOLVED_PRINCIPAL', 'error')
    return value
  }

  for (const document of documents) {
    const { path, body } = document
    if (retired.has(path)) continue
    for (const key of ['$rev', '$refs', '$path']) {
      if (key in body) {
        delete body[key]
        report(path, `REMOVED_${key.slice(1).toUpperCase()}`, 'change')
      }
    }
    if ('$owner' in body) body.$owner = principal(body.$owner, path)
    for (const field of ['createdBy', 'branchOwner', 'actor', 'caller', 'by', 'onBehalfOf']) {
      if (field in body && typeof body[field] === 'string') body[field] = principal(body[field], path)
    }
    if ((body.$type === 't.session' || body.$type === 'session') && 'userId' in body) {
      const mapped = principal(body.userId, path)
      if (typeof mapped === 'string' && mapped.startsWith('u:')) body.accountId = mapped.slice(2)
      delete body.userId
      body.$type = 't.session'
      body.revoked = false
      if ('createdAt' in body) { delete body.createdAt; report(path, 'REMOVED_SESSION_CREATION_METADATA', 'change') }
      report(path, 'SESSION_ACCOUNT_ID', 'change')
      if (!/^\/auth\/sessions\/[0-9a-f]{64}$/.test(path)) report(path, 'SESSION_TOKEN_PATH_REQUIRES_VERIFICATION', 'error')
      if ('claims' in body) report(path, 'SESSION_CLAIMS_REQUIRE_REVIEW', 'error')
    }
    if ('$acl' in body) {
      let union = 0, maximum = 0
      if (!Array.isArray(body.$acl)) report(path, 'INVALID_ACL', 'error')
      else body.$acl = body.$acl.flatMap(value => {
        if (!isRecord(value)) { report(path, 'INVALID_ACL_ENTRY', 'error'); return [value] }
        const entry = value
        if ('subject' in entry) return [entry]
        if (typeof entry.g !== 'string' || typeof entry.p !== 'number' || !Number.isInteger(entry.p) || entry.p > 15) {
          report(path, 'INVALID_ACL_ENTRY', 'error')
          return [entry]
        }
        const group = entry.g.startsWith('u:') ? principal(entry.g, path) : entry.g
        const subject = group === 'owner' ? { owner: true } : { group }
        const bits = (entry.p & 7) | ((entry.p & 8) === 0 ? 0 : 1)
        if (entry.p > 0) { union |= bits; maximum = Math.max(maximum, entry.p) }
        report(path, entry.p <= 0 ? 'CONVERTED_DENY' : 'CONVERTED_GRANT', 'change')
        if ((entry.p & 8) !== 0) report(path, 'SUBSCRIBE_MERGED_INTO_READ', 'warning')
        if (entry.p <= 0) {
          const resolution = options.resolveDeny?.(path, entry.g, entry.p)
          if (resolution === undefined) report(path, 'STICKY_DENY_REQUIRES_REVIEW', 'error')
          if (resolution === 'remove') {
            report(path, 'REMOVED_EXPLICITLY_RESOLVED_DENY', 'warning')
            return []
          }
        }
        return [entry.p <= 0 ? { subject, deny: 7 } : { subject, grant: bits }]
      })
      if (union !== ((maximum & 7) | ((maximum & 8) === 0 ? 0 : 1))) report(path, 'ACL_GRANTS_NOW_UNION', 'warning')
    }
    if (path === '/sys/trash' || path.startsWith('/sys/trash/')) {
      body.$acl = [{ subject: { group: 'admins' }, grant: 7 }]
      report(path, 'ADMIN_ONLY_TRASH_ARCHIVE', 'change')
      if (body.$type === 't.trash.entry') {
        body.$type = 't.dir'
        report(path, 'ARCHIVED_TRASH_MARKER_AS_DIRECTORY', 'change')
      }
    }

    const components: Record<string, unknown>[] = [body]
    for (const [key, value] of Object.entries(body)) {
      if (!key.startsWith('#')) continue
      if (!isRecord(value)) { report(path, 'INVALID_COMPONENT', 'error'); continue }
      const component = upgradeObject(value)
      body[key] = component
      components.push(component)
      if ('$acl' in component) report(path, 'COMPONENT_ACL', 'error')
      if (key === '#credentials') {
        if (typeof body.$id !== 'string' || typeof component.hash !== 'string'
          || !/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(component.hash)) report(path, 'INVALID_PASSWORD_CREDENTIAL', 'error')
        else {
          const credentialPath = passwordPath(body.$id)
          if (paths.has(credentialPath)) report(path, 'PASSWORD_TARGET_OCCUPIED', 'error')
          else {
            paths.add(credentialPath)
            documents.push({ path: credentialPath, body: { $type: 't.credentials', $id: id(), accountId: body.$id, hash: component.hash,
              $acl: [{ subject: { group: 'admins' }, grant: 7 }] } })
            delete body[key]
            components.pop()
            report(path, 'SPLIT_CLOSED_PASSWORD', 'change')
          }
        }
      }
    }
    for (const component of components) {
      if (typeof component.$type !== 'string') {
        report(path, 'MISSING_COMPONENT_TYPE', 'error')
        continue
      }
      const originalType = component.$type
      const normalizedType = normalizeType(originalType)
      component.$type = normalizedType
      if (component.$type !== originalType) report(path, 'NORMALIZED_TYPE_NAME', 'change')
      if (normalizedType === 't.moved') report(path, 'TOMBSTONE_RESOLUTION_REQUIRED', 'error')
      if (normalizedType.startsWith('t.mount.')) {
        if (!('pattern' in component)) {
          component.pattern = ''
          report(path, 'ADDED_MOUNT_DESCENDANT_PATTERN', 'change')
        }
        if (component.$type === 't.mount.fs' || component.$type === 't.mount.rawfs') {
          if ('root' in component) {
            component.directory = component.root
            delete component.root
          }
          component.external = 'trusted'
          report(path, 'TRUSTED_FILESYSTEM_MOUNT', 'change')
        }
        if (component.$type === 't.mount.tree.trpc') {
          if ('path' in component) { component.remote = component.path; delete component.path }
          if (typeof component.token !== 'string' || component.token.length === 0 || typeof body.$id !== 'string')
            report(path, 'FEDERATION_CREDENTIAL_REQUIRED', 'error')
          else {
            const credential = `/sys/mount-credentials/${id()}`
            paths.add(credential)
            documents.push({ path: credential, body: { $type: 't.outbound-credential', $id: id(), token: component.token,
              $owner: `n:${body.$id}`, $acl: [{ subject: { group: 'admins' }, grant: 7 }] } })
            delete component.token
            component.credential = credential
            component.$type = 't.mount.federation'
            report(path, 'SPLIT_FEDERATION_CREDENTIAL', 'change')
          }
        }
        if (component.$type === 't.mount.mongo') {
          if (component.watch === true) component.external = 'trusted'
          if ('watch' in component) { delete component.watch; report(path, 'CONVERTED_MONGO_WATCH_POLICY', 'change') }
          if (typeof component.uri === 'string' && component.uri.length > 0) {
            const cluster = options.mongoClusters?.[component.uri]
            if (cluster === undefined) report(path, 'MONGO_CLOSED_BINDING_REQUIRED', 'error')
            else {
              component.cluster = cluster
              delete component.uri
              report(path, 'MONGO_SECRET_MOVED_TO_EXPLICIT_BINDING', 'change')
            }
          }
        }
        if (component.shared === false) { delete component.shared; report(path, 'REMOVED_UNSHARED_FLAG', 'change') }
        else if (component.shared === true) report(path, 'SHARED_MOUNT_REQUIRES_REVIEW', 'error')
      }
      if (originalType.toLowerCase().includes('quickjs')) report(path, 'QUICKJS_ACTION', 'error')
      if (normalizedType === 't.type' && 'actions' in component) {
        if (!isRecord(component.actions)) report(path, 'INVALID_STORED_ACTIONS', 'error')
        else for (const [name, source] of Object.entries(component.actions))
          if (typeof source === 'string') report(path, `STORED_QUICKJS_ACTION:${name}`, 'error')
      }
    }
  }
  if (options.anonymous !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(options.anonymous.key) || options.anonymous.instance.length === 0)
      report('/sys/auth-key', 'INVALID_ANONYMOUS_KEY', 'error')
    else if (paths.has('/sys/auth-key')) report('/sys/auth-key', 'ANONYMOUS_KEY_TARGET_OCCUPIED', 'error')
    else documents.push({ path: '/sys/auth-key', body: { $type: 't.auth-key', $id: id(), ...options.anonymous,
      $acl: [{ subject: { group: 'admins' }, grant: 7 }] } })
  } else if (accounts.size > 0 && !paths.has('/sys/auth-key')) report('/sys/auth-key', 'ANONYMOUS_KEY_PROVENANCE_REQUIRED', 'error')
  const accepted: UpgradeDocument[] = []
  const finalIds = new Set<string>()
  for (const document of documents) {
    if (retired.has(document.path)) continue
    if (typeof document.body.$id !== 'string' || finalIds.has(document.body.$id)) report(document.path, 'INVALID_FINAL_IDENTITY', 'error')
    else finalIds.add(document.body.$id)
    for (const code of options.validate(document.body, document.path)) report(document.path, code, 'error')
    accepted.push(document)
  }
  return { version: 2, documents: accepted, retired: [...retired], findings, inputHash: upgradeInputHash(input) }
}
