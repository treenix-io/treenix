import { actionMethods, AsyncGenFn, compileNeeds, type ActionMethod, type Class, type CompOptions } from '#comp/index'
import type { NeedSpec } from '#comp/needs'
import type { RegisteredMethod } from '#comp/registration'
import { assertSafeSchema } from '#comp/validate'
import { KernelError } from '#errors'
import type { MethodSchema, TypeSchema } from '#schema/types'
import { assertSafeSiftQuery } from './expr'
import { assertPost } from './post'
import { DEFAULT_LIMITS, type ActionDef, type Limits, type Post, type ReadActionContext, type Selector, type TypeDef, type Where } from './types'

export type TypeDefOptions<T> = Pick<TypeDef, 'name' | 'module' | 'security'> & {
  schema: TypeSchema
  needs?: CompOptions<T>['needs']
  limits?: Limits
}

export type RegisteredTypeDefOptions = Pick<TypeDef, 'name' | 'module' | 'security'> & {
  readonly schema: TypeSchema
  readonly methods: readonly RegisteredMethod[]
  readonly actions?: Readonly<Record<string, ActionDef>>
  readonly limits?: Limits
  readonly prototype?: object
}

/** Captures authored helpers and accessors so later prototype edits cannot alter a registered type. */
function componentPrototype(input: object | undefined): object | undefined {
  if (input === undefined) return undefined
  const prototype = {}, descriptors = Object.getOwnPropertyDescriptors(input)
  Reflect.deleteProperty(descriptors, 'constructor')
  Object.defineProperties(prototype, descriptors)
  return Object.freeze(prototype)
}

/** Runs class behavior against component data without storing methods or accessors in the node. */
function receiver(component: object, prototype: object | undefined): object {
  if (prototype === undefined) return component
  return new Proxy(component, {
    get(target, key, own) { return Object.hasOwn(target, key) ? Reflect.get(target, key, own) : Reflect.get(prototype, key, own) },
    set(target, key, value, own) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key)
      if (!Object.hasOwn(target, key) && descriptor !== undefined && !('value' in descriptor)) return Reflect.set(prototype, key, value, own)
      return Reflect.set(target, key, value)
    },
  })
}

function selector(spec: NeedSpec): Selector {
  switch (spec.kind) {
    case 'path': return { node: spec.path }
    case 'children': return { children: spec.path }
    case 'field-ref': return { node: '.', include: [{ ref: spec.field }] }
    case 'sibling': throw new KernelError('INVALID', 'Action needs address nodes; sibling components are part of the own node')
  }
}

function assertExpressions(pre: Where | undefined, post: Post | undefined, needs: ActionDef['needs'], limits: Limits, stream: boolean): void {
  if (pre !== undefined) assertSafeSiftQuery(pre, limits)
  if (post !== undefined) {
    assertPost(post)
    if (stream) throw new KernelError('INVALID', 'A streaming action cannot declare post')
    for (const target of Object.keys(post)) {
      if (target !== '' && !Object.hasOwn(needs ?? {}, target)) throw new KernelError('INVALID', `Post target is not a declared need: ${target}`)
    }
  }
}

function action(method: ActionMethod['method'], schema: MethodSchema, needs: ActionDef['needs'], limits: Limits, prototype?: object): ActionDef {
  if (schema.arguments.length > 1) throw new KernelError('INVALID', 'An action takes at most one data argument')
  const argument = schema.arguments[0]
  const { name: argumentName, ...args } = argument ?? { name: '' }
  const kind = schema.kind ?? 'write'
  const stream = method instanceof AsyncGenFn
  if (schema.streaming !== undefined && schema.streaming !== stream) throw new KernelError('INVALID', 'The streaming schema differs from the method')
  assertExpressions(schema.pre, schema.post, needs, limits, stream)
  const common = { args, needs, pre: schema.pre }
  const plain = async function(this: object, ctx: ReadActionContext, data: unknown): Promise<unknown> {
    return method.call(receiver(this, prototype), data, ctx.needs)
  }
  const streaming = function(this: object, ctx: ReadActionContext, data: unknown): AsyncGenerator<unknown, unknown, undefined> {
    return Reflect.apply(method, receiver(this, prototype), [data, ctx.needs])
  }
  // The wrappers share source text; the generation must change when their captured method changes.
  const handler = stream ? streaming : plain
  Object.defineProperty(handler, 'implementation', { value: method, enumerable: true })
  if (prototype !== undefined) Object.defineProperty(handler, 'receiver', { value: Object.getOwnPropertyDescriptors(prototype), enumerable: true })
  if (kind === 'read') {
    if (schema.io || schema.post !== undefined) throw new KernelError('INVALID', 'A read action cannot declare I/O or post')
    return { ...common, kind, handler }
  }
  if (schema.post !== undefined) return { ...common, kind, io: schema.io, post: schema.post, handler: plain }
  return { ...common, kind, io: schema.io, handler }
}

export function buildTypeDef<T extends object>(cls: Class<T>, options: TypeDefOptions<T>): TypeDef {
  const methods = actionMethods(cls).filter(method => !method.name.startsWith('_'))
  const compiledNeeds = compileNeeds(methods, { needs: options.needs })
  return buildRegisteredTypeDef({ ...options, prototype: cls.prototype,
    methods: methods.map(method => ({ ...method, needs: compiledNeeds.get(method.name) })) })
}

export function buildRegisteredTypeDef(options: RegisteredTypeDefOptions): TypeDef {
  const { schema, name, module, security, limits = DEFAULT_LIMITS } = options
  const prototype = componentPrototype(options.prototype)
  const methods = options.methods.filter(method => !method.name.startsWith('_'))
  const schemas = new Map(Object.entries(schema.methods ?? {}).filter(([name]) => !name.startsWith('_')))
  const actions: Record<string, ActionDef> = { ...options.actions }
  for (const [name, declared] of Object.entries(actions)) {
    assertSafeSchema(declared.args, 'action arguments')
    assertExpressions(declared.pre, declared.kind === 'read' ? undefined : declared.post, declared.needs, limits, declared.handler instanceof AsyncGenFn)
    schemas.delete(name)
  }
  for (const { name, method, needs: specs } of methods) {
    if (Object.hasOwn(actions, name)) throw new KernelError('CONFLICT', `Action declared twice: ${name}`)
    const generated = schemas.get(name)
    if (generated === undefined) throw new KernelError('INVALID', `Missing action schema: ${name}`)
    const needs = specs && Object.fromEntries(specs.map(spec => [spec.key, selector(spec)]))
    Object.defineProperty(actions, name, { value: action(method, generated, needs, limits, prototype), enumerable: true })
    schemas.delete(name)
  }
  if (schemas.size !== 0) throw Object.assign(new KernelError('INVALID', 'The schema declares actions without a native implementation'), { type: name, actions: [...schemas.keys()] })
  const { methods: methodSchemas, version = 0, actionsOnly, aliases, ...fields } = schema
  return { name, module, security, schema: fields, version, actionsOnly, aliases, actions }
}
