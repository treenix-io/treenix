import { createHash } from 'node:crypto'

import { createRegistryMap } from '#core/registry-map'
import { KernelError } from '#errors'
import { stableJson } from '#util/stable-json'
import type { ActionDef, ModuleId, ModuleManifest, Registry, SecurityClass, SecurityContext, SecurityHandlers, SecurityRegistration, TypeDef, TypeName } from './types'

export interface TypeOwnership {
  readonly module: ModuleId
  readonly security: SecurityClass
}
export interface RegistryOptions {
  readonly ownership?: (name: TypeName) => TypeOwnership | undefined
  readonly published?: () => void
}
type SecurityEntries = { -readonly [C in SecurityContext]?: SecurityHandlers[C] }

function freezeData<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) freezeData(child, seen)
  return Object.freeze(value)
}

function copyAction(action: ActionDef): ActionDef {
  const common = { args: structuredClone(action.args), needs: structuredClone(action.needs), pre: structuredClone(action.pre) }
  if (action.kind === 'read') return { ...action, ...common }
  if (action.post !== undefined) return { ...action, ...common, post: structuredClone(action.post) }
  return { ...action, ...common }
}

export function copyManifest(manifest: ModuleManifest): ModuleManifest {
  return Object.freeze({
    ...manifest,
    types: Object.freeze(manifest.types.map(def => freezeData({
      ...def, schema: structuredClone(def.schema), aliases: def.aliases && [...def.aliases],
      actions: Object.fromEntries(Object.entries(def.actions).map(([name, action]) => [name, copyAction(action)])),
    }))),
    security: Object.freeze(manifest.security.map(entry => entry.context === 'migrate'
      ? freezeData({ ...entry, handler: entry.handler.map(step => ({ ...step })) }) : Object.freeze({ ...entry }))),
    open: Object.freeze(manifest.open.map(entry => Object.freeze({ ...entry }))),
  })
}

function isSecurityContext(context: string): context is SecurityContext {
  return context === 'acl' || context === 'migrate' || context === 'mount' || context === 'service' || context === 'derive'
}

export function canonical(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null) return ['null']
  switch (typeof value) {
    case 'undefined': return ['undefined']
    case 'string': case 'boolean': return [typeof value, value]
    case 'number':
      if (!Number.isFinite(value)) throw new KernelError('INVALID', 'Non-finite manifest value')
      return ['number', value]
    case 'symbol': {
      const key = Symbol.keyFor(value)
      if (key === undefined) throw new KernelError('INVALID', 'A manifest symbol must have a global key')
      return ['symbol', key]
    }
    case 'bigint': throw new KernelError('INVALID', 'A manifest cannot contain bigint')
  }

  if (ancestors.has(value)) throw new KernelError('INVALID', 'Cyclic module manifest')
  ancestors.add(value)
  const entries = () => Object.keys(value).sort().map(key => [key, canonical(Reflect.get(value, key), ancestors)])
  let result: unknown
  if (typeof value === 'function') result = ['function', Function.prototype.toString.call(value), entries()]
  else if (Array.isArray(value)) result = ['array', value.map(item => canonical(item, ancestors))]
  else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== null && prototype !== Object.prototype) throw new KernelError('INVALID', 'A manifest value must be plain data or a function')
    result = ['object', entries()]
  }
  ancestors.delete(value)
  return result
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function digest(modules: ReadonlyMap<string, ModuleManifest>): string {
  const manifests = [...modules.values()].sort((a, b) => compare(a.id, b.id)).map(manifest => ({
    ...manifest,
    types: [...manifest.types].sort((a, b) => compare(a.name, b.name)).map(def => ({ ...def, aliases: def.aliases && [...def.aliases].sort(compare) })),
    security: [...manifest.security].sort((a, b) => compare(a.type, b.type) || compare(a.context, b.context)),
    open: [...manifest.open].sort((a, b) => compare(a.type, b.type) || compare(a.context, b.context)),
  }))
  return createHash('sha256').update(stableJson(canonical(manifests))).digest('hex')
}

function setSecurity(entries: SecurityEntries, registration: SecurityRegistration): void {
  switch (registration.context) {
    case 'acl': entries.acl = registration.handler; break
    case 'migrate': entries.migrate = registration.handler; break
    case 'mount': entries.mount = registration.handler; break
    case 'service': entries.service = registration.handler; break
    case 'derive': entries.derive = registration.handler; break
  }
}

export function createRegistry(options: RegistryOptions = {}): Registry {
  let modules = new Map<string, ModuleManifest>()
  // Removing a generation does not relinquish its type ownership or security class.
  let owners = new Map<string, TypeOwnership>()
  let types = new Map<string, TypeDef>()
  let security = new Map<string, SecurityEntries>()
  let open = createRegistryMap<unknown>()
  let generation = digest(modules)

  return {
    get digest() { return generation },
    type(name) {
      const def = types.get(name)
      if (def === undefined) throw new KernelError('UNKNOWN_TYPE', `Unknown type: ${name}`)
      return def
    },
    security(type, context) {
      const name = types.get(type)?.name
      const entries = name === undefined ? undefined : security.get(name)
      return entries && Object.hasOwn(entries, context) ? entries[context] : undefined
    },
    handler(type, context) { return open.get(types.get(type)?.name ?? type)?.get(context) },
    publish(manifest) {
      const nextModules = new Map(modules)
      nextModules.set(manifest.id, copyManifest(manifest))
      const nextOwners = new Map(owners)
      const nextTypes = new Map<string, TypeDef>()
      const nextSecurity = new Map<string, SecurityEntries>()
      const nextOpen = createRegistryMap<unknown>()

      for (const published of nextModules.values()) for (const def of published.types) {
        if (def.module !== published.id) throw new KernelError('FORBIDDEN', `Type owner differs from publisher: ${def.name}`)
        for (const name of [def.name, ...def.aliases ?? []]) {
          if (options.ownership !== undefined) {
            const accepted = options.ownership(name)
            if (accepted === undefined || accepted.module !== def.module || accepted.security !== def.security) {
              throw new KernelError('FORBIDDEN', `Type publication differs from accepted ownership: ${name}`)
            }
          }
          const owner = nextOwners.get(name)
          if (owner && (owner.module !== published.id || owner.security !== def.security)) {
            throw new KernelError('FORBIDDEN', `Type ownership or security class changed: ${name}`)
          }
          if (nextTypes.has(name)) throw new KernelError('INVALID', `Duplicate type name: ${name}`)
          nextOwners.set(name, { module: published.id, security: def.security })
          nextTypes.set(name, def)
        }
      }

      for (const published of nextModules.values()) {
        for (const registration of published.security) {
          const def = nextTypes.get(registration.type)
          if (def === undefined) throw new KernelError('UNKNOWN_TYPE', `Unknown security type: ${registration.type}`)
          if (def.module !== published.id) throw new KernelError('FORBIDDEN', `Foreign security registration: ${registration.type}`)
          if (def.security === 'ordinary' && ['mount', 'service', 'derive'].includes(registration.context)) {
            throw new KernelError('FORBIDDEN', `Capability handler on an ordinary type: ${registration.type}`)
          }
          let entries = nextSecurity.get(def.name)
          if (entries === undefined) { entries = {}; nextSecurity.set(def.name, entries) }
          if (Object.hasOwn(entries, registration.context)) throw new KernelError('INVALID', 'Duplicate security registration')
          setSecurity(entries, registration)
        }
        for (const registration of published.open) {
          if (isSecurityContext(registration.context)) throw new KernelError('FORBIDDEN', `Security context in open registrations: ${registration.context}`)
          if (registration.context.trim().length === 0) throw new KernelError('INVALID', 'An open context needs a name')
          const name = nextTypes.get(registration.type)?.name ?? registration.type
          let entries = nextOpen.get(name)
          if (entries === undefined) { entries = new Map(); nextOpen.set(name, entries) }
          if (entries.has(registration.context)) throw new KernelError('CONFLICT', `Open context already registered: ${registration.type}:${registration.context}`)
          entries.set(registration.context, registration.handler)
        }
      }

      const nextDigest = digest(nextModules)
      modules = nextModules
      owners = nextOwners
      types = nextTypes
      security = nextSecurity
      open = nextOpen
      generation = nextDigest
      options.published?.()
      return generation
    },
  }
}
