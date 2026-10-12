import { isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import { normalizeType, type TypeId } from '#core/component'
import { collectRegistrations, type Registration } from '#core/registration'
import { registeredClass, registeredMethod, type RegisteredClass, type RegisteredMethod } from '#comp/registration'
import { KernelError } from '#errors'
import type { TypeSchema } from '#schema/types'
import { copyManifest } from '#kernel/registry'
import { buildRegisteredTypeDef } from '#kernel/typedef'
import type { ActionDef, ActionIoBinding, Gate, ModuleManifest, OpenRegistration, Registry, SecurityContext, SecurityHandlers, SecurityRegistration, TypeDef } from '#kernel/types'
import type { NativeSeedDefinition } from '#kernel/seed-install'
import type { RawFsCodecs } from '#kernel/store/rawfs-codec'

export interface NativeModuleDeployment {
  readonly manifest: ModuleManifest
  readonly io?: ActionIoBinding
  readonly gates?: readonly Gate[]
  readonly seeds?: NativeSeedDefinition
  readonly rawfsCodecs?: RawFsCodecs
}
/** Host capabilities are declared by their owning deployment bindings. */
export interface NativeModuleHost {}
export type NativeModuleFactory = (host: NativeModuleHost) => NativeModuleDeployment | Promise<NativeModuleDeployment>

export interface NativeModuleExports { readonly default?: NativeModuleFactory }

/** Evaluate the declared deployment factory while its module collection is owned by the caller. */
export async function evaluateModuleFactory(entry: NativeModuleExports, host: NativeModuleHost = {}): Promise<NativeModuleDeployment | undefined> {
  if (entry.default === undefined) return undefined;
  if (typeof entry.default !== 'function') throw new KernelError('INVALID', 'Native module factory must be callable');
  return entry.default(host);
}


export interface CollectedModule extends ModuleManifest {
  readonly collectionId?: string
  readonly io?: ActionIoBinding
  readonly gates?: readonly Gate[]
  readonly seeds?: NativeSeedDefinition
  readonly rawfsCodecs?: RawFsCodecs
  readonly legacySecurity: readonly { readonly type: string; readonly context: SecurityContext }[]
  readonly legacyActions: readonly { readonly type: string; readonly name: string }[]
}

export interface NativeModuleDefinition {
  readonly collectionId: string;
  readonly factory: NativeModuleFactory;
}

interface Builder {
  readonly id: string
  readonly registrations: Map<string, Map<string, Registration>>
  readonly classes: Map<string, RegisteredClass>
  readonly security: SecurityRegistration[]
  readonly actions: Map<string, Map<string, ActionDef>>
  closed: boolean
  seeds?: NativeSeedDefinition
}

const builder = (id: string): Builder => ({ id, registrations: new Map(), classes: new Map(), security: [], actions: new Map(), closed: false })

interface CollectionState {
  readonly scope: AsyncLocalStorage<Builder>
  readonly modules: Map<string, CollectedModule>
  readonly imports: Map<string, CollectedModule>
  factories?: Map<string, NativeModuleDefinition>
  ambient: Builder
}

declare global {
  var __treenxModuleCollection: CollectionState | undefined
}

// Source and dist registrations share the legacy map and must share their import scope too.
const state: CollectionState = globalThis.__treenxModuleCollection ??= { scope: new AsyncLocalStorage<Builder>(), modules: new Map(), imports: new Map(), ambient: builder('ambient') }
const scope = state.scope, modules = state.modules
const factories = state.factories ??= new Map<string, NativeModuleDefinition>()

export function isSecurityContext(context: string): context is SecurityContext {
  return context === 'acl' || context === 'migrate' || context === 'mount' || context === 'service' || context === 'derive'
}

function current(): Builder {
  const active = scope.getStore() ?? state.ambient
  if (active.closed) throw new KernelError('INVALID', `Registration after module collection: ${active.id}`)
  return active
}

collectRegistrations(registration => {
  const active = current()
  let contexts = active.registrations.get(registration.type)
  if ('remove' in registration) {
    contexts?.delete(registration.context)
    if (registration.context === 'class') active.classes.delete(registration.type)
    if (contexts?.size === 0) active.registrations.delete(registration.type)
    return
  }
  if (!contexts) { contexts = new Map(); active.registrations.set(registration.type, contexts) }
  if (!contexts.has(registration.context)) {
    contexts.set(registration.context, registration)
    if (registration.context === 'class') {
      const definition = registeredClass(registration.type, registration.handler)
      if (definition) active.classes.set(registration.type, definition)
    }
  }
})

type KernelArguments = { [C in SecurityContext]: [type: TypeId, context: C, handler: SecurityHandlers[C]] }[SecurityContext]

export function registerKernel(...args: KernelArguments): void {
  const type = normalizeType(args[0]), active = current()
  if (active.security.some(entry => entry.type === type && entry.context === args[1])) throw new KernelError('CONFLICT', `Duplicate native security context: ${type}:${args[1]}`)
  switch (args[1]) {
    case 'acl': active.security.push({ type, context: args[1], handler: args[2] }); break
    case 'migrate': active.security.push({ type, context: args[1], handler: args[2] }); break
    case 'mount': active.security.push({ type, context: args[1], handler: args[2] }); break
    case 'service': active.security.push({ type, context: args[1], handler: args[2] }); break
    case 'derive': active.security.push({ type, context: args[1], handler: args[2] }); break
  }
}

/** Attach seed data to an implicitly collected module without replacing its compiled types and actions. */
export function registerKernelSeeds(seeds: NativeSeedDefinition): void {
  const active = current();
  if (active.seeds !== undefined) throw new KernelError('CONFLICT', 'Native seeds already have an owner');
  active.seeds = seeds;
}

export function registerKernelAction(type: TypeId, name: string, action: ActionDef): void {
  if (!name || name.trim() !== name || name.startsWith('_')) throw new KernelError('INVALID', 'Invalid public action name')
  const active = current(), normalized = normalizeType(type)
  let actions = active.actions.get(normalized)
  if (!actions) { actions = new Map(); active.actions.set(normalized, actions) }
  if (actions.has(name)) throw new KernelError('CONFLICT', `Duplicate native action: ${normalized}:${name}`)
  actions.set(name, action)
}

export function assertModuleSchema(type: string): void {
  const active = current(), contexts = active.registrations.get(type)
  if (!contexts?.has('class') && !contexts?.has('schema')) throw new KernelError('FORBIDDEN', `Schema outside the module's declared types: ${active.id}:${type}`)
}

function finish(active: Builder): CollectedModule {
  const types: TypeDef[] = [], open: OpenRegistration[] = [], legacySecurity: CollectedModule['legacySecurity'][number][] = []
  const legacyActions: CollectedModule['legacyActions'][number][] = []
  for (const [name, contexts] of active.registrations) {
    const schemaRegistration = contexts.get('schema'), classRegistration = contexts.get('class')
    if (schemaRegistration || classRegistration) {
      if (!schemaRegistration) throw new KernelError('INVALID', `Missing type schema: ${name}`)
      const schema: TypeSchema = schemaRegistration.handler()
      const definition = active.classes.get(name)
      if (classRegistration && !definition) throw new KernelError('INVALID', `Class without a type declaration: ${name}`)
      const methods: RegisteredMethod[] = []
      for (const registration of contexts.values()) if (registration.context.startsWith('action:')) {
        const method = registeredMethod(registration.handler)
        if (method) methods.push(method)
      }
      types.push(buildRegisteredTypeDef({ name, module: active.id, security: definition?.security ?? 'ordinary',
        schema, prototype: definition?.cls.prototype, methods, actions: Object.fromEntries(active.actions.get(name) ?? []) }))
    }
    for (const registration of contexts.values()) {
      if (isSecurityContext(registration.context)) legacySecurity.push({ type: name, context: registration.context })
      else if (registration.context.startsWith('action:')) {
        const actionName = registration.context.slice('action:'.length)
        const native = active.actions.get(name)?.get(actionName) ?? types.find(type => type.name === name)?.actions[actionName]
        if (native) open.push({ type: name, context: registration.context, handler: native })
        else if (actionName.startsWith('_') && registeredMethod(registration.handler)) {
          open.push({ type: name, context: registration.context, handler: registration.handler })
        }
        else {
          legacyActions.push({ type: name, name: actionName })
          open.push({ type: name, context: registration.context, handler: registration.handler })
        }
      } else open.push({ type: name, context: registration.context,
        handler: registration.meta === undefined ? registration.handler : { handler: registration.handler, meta: registration.meta } })
    }
  }
  for (const [type, actions] of active.actions) for (const [name, action] of actions) {
    if (!open.some(entry => entry.type === type && entry.context === `action:${name}`)) open.push({ type, context: `action:${name}`, handler: action })
  }
  return Object.freeze({ id: active.id, types: Object.freeze(types), security: Object.freeze([...active.security]), seeds: active.seeds,
    open: Object.freeze(open), legacySecurity: Object.freeze(legacySecurity), legacyActions: Object.freeze(legacyActions) })
}

export async function collectModule(id: string, importModule: () => Promise<unknown> | void, origin?: string, deployment?: () => NativeModuleDeployment | undefined, factory?: () => NativeModuleFactory | undefined): Promise<CollectedModule> {
  const active = builder(id)
  return scope.run(active, async () => {
    try {
      await importModule()
      const declared = deployment?.()
      const compiled = factory?.();
      if (compiled !== undefined && declared === undefined)
        throw new KernelError('INVALID', 'Native module factory returned no deployment');
      const manifest: CollectedModule = declared === undefined ? finish(active) : Object.freeze({
        ...copyManifest(declared.manifest), collectionId: id, io: declared.io, seeds: declared.seeds, rawfsCodecs: declared.rawfsCodecs,
        gates: declared.gates === undefined ? undefined : Object.freeze([...declared.gates]),
        legacySecurity: Object.freeze([]), legacyActions: Object.freeze([]),
      })
      if (compiled === undefined) {
        modules.set(id, manifest)
        if (origin !== undefined) state.imports.set(moduleOrigin(origin), manifest)
      } else {
        factories.set(origin === undefined ? id : moduleOrigin(origin), Object.freeze({ collectionId: id, factory: compiled }));
      }
      return manifest
    } finally {
      active.closed = true
    }
  })
}

/** Node imports share one identity for absolute filesystem paths and their file URLs. */
function moduleOrigin(origin: string): string {
  if (origin.startsWith('file:')) {
    const imported = new URL(origin), canonical = pathToFileURL(fileURLToPath(imported))
    canonical.search = imported.search
    canonical.hash = imported.hash
    return canonical.href
  }
  return isAbsolute(origin) ? pathToFileURL(origin).href : origin
}

export function getCollectedModule(id: string, origin?: string): CollectedModule | undefined {
  const manifest = origin === undefined ? modules.get(id) : state.imports.get(moduleOrigin(origin))
  if (manifest && (manifest.collectionId ?? manifest.id) !== id) throw new KernelError('CONFLICT', 'The imported module changed its identity')
  return manifest
}

/** Retrieve the compiled factory declaration without retaining any deployment resources. */
export function getModuleDefinition(id: string, origin?: string): NativeModuleDefinition | undefined {
  const definition = factories.get(origin === undefined ? id : moduleOrigin(origin));
  if (definition !== undefined && definition.collectionId !== id)
    throw new KernelError('CONFLICT', 'The imported module changed its identity');
  return definition;
}

/** Evaluate an imported factory inside its own collection for a fresh host lifetime. */
export async function instantiateModule(definition: NativeModuleDefinition, host: NativeModuleHost, origin?: string): Promise<CollectedModule> {
  let deployment: NativeModuleDeployment | undefined;
  return collectModule(definition.collectionId, async () => {
    deployment = await definition.factory(host);
  }, origin, () => deployment, () => definition.factory);
}

export function clearCollectedModules(): void { modules.clear(); state.imports.clear(); factories.clear() }

export function ambientModule(): CollectedModule { return finish(state.ambient) }
export function clearAmbientRegistrations(): void { state.ambient = builder('ambient') }

export function assertNoAmbientRegistrations(): void {
  if (state.ambient.registrations.size || state.ambient.security.length || state.ambient.actions.size) throw new KernelError('INVALID', 'Registrations outside module collection')
}

export function publishModules(registry: Registry, manifests: readonly CollectedModule[]): void {
  const identities = new Set<string>()
  for (const manifest of manifests) {
    if (identities.has(manifest.id)) throw new KernelError('CONFLICT', `Duplicate module identity: ${manifest.id}`)
    identities.add(manifest.id)
  }
  for (const manifest of manifests) if (manifest.legacyActions.length) {
    const legacy = manifest.legacyActions[0]
    throw Object.assign(new KernelError('INVALID', `Legacy action without a native declaration: ${legacy.type}:${legacy.name}`), { type: legacy.type, context: `action:${legacy.name}` })
  }
  for (const manifest of manifests) for (const legacy of manifest.legacySecurity) {
    if (!manifest.security.some(entry => entry.type === legacy.type && entry.context === legacy.context)) {
      throw Object.assign(new KernelError('INVALID', `Legacy security handler without a native declaration: ${legacy.type}:${legacy.context}`), legacy)
    }
  }
  for (const manifest of manifests) registry.publish(manifest)
}
