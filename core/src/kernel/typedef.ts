import { actionMethods, AsyncGenFn, compileNeeds, type ActionMethod, type Class, type CompOptions } from '#comp/index'
import type { NeedSpec } from '#comp/needs'
import { KernelError } from '#errors'
import type { MethodSchema, TypeSchema } from '#schema/types'
import { assertSafeSiftQuery } from './expr'
import { assertPost } from './post'
import { DEFAULT_LIMITS, type ActionDef, type Limits, type ReadActionContext, type Selector, type TypeDef } from './types'

export type TypeDefOptions<T> = Pick<TypeDef, 'name' | 'module' | 'security'> & {
  schema: TypeSchema
  needs?: CompOptions<T>['needs']
  limits?: Limits
}

function selector(spec: NeedSpec): Selector {
  switch (spec.kind) {
    case 'path': return { node: spec.path }
    case 'children': return { children: spec.path }
    case 'field-ref': return { node: '.', include: [{ ref: spec.field }] }
    case 'sibling': throw new KernelError('INVALID', 'Action needs address nodes; sibling components are part of the own node')
  }
}

function action(method: ActionMethod['method'], schema: MethodSchema, needs: ActionDef['needs'], limits: Limits): ActionDef {
  if (schema.arguments.length > 1) throw new KernelError('INVALID', 'An action takes at most one data argument')
  const argument = schema.arguments[0]
  const { name: argumentName, ...args } = argument ?? { name: '' }
  const kind = schema.kind ?? 'write'
  const stream = method instanceof AsyncGenFn
  if (schema.streaming !== undefined && schema.streaming !== stream) throw new KernelError('INVALID', 'The streaming schema differs from the method')
  if (schema.pre !== undefined) assertSafeSiftQuery(schema.pre, limits)
  if (schema.post !== undefined) {
    assertPost(schema.post)
    if (stream) throw new KernelError('INVALID', 'A streaming action cannot declare post')
    for (const target of Object.keys(schema.post)) {
      if (target !== '' && !Object.hasOwn(needs ?? {}, target)) throw new KernelError('INVALID', `Post target is not a declared need: ${target}`)
    }
  }
  const common = { args, needs, pre: schema.pre }
  const plain = async function(this: object, ctx: ReadActionContext, data: unknown): Promise<unknown> {
    return method.call(this, data, ctx.needs)
  }
  const streaming = function(this: object, ctx: ReadActionContext, data: unknown): AsyncGenerator<unknown, unknown, undefined> {
    return Reflect.apply(method, this, [data, ctx.needs])
  }
  // The wrappers share source text; the generation must change when their captured method changes.
  const handler = stream ? streaming : plain
  Object.defineProperty(handler, 'implementation', { value: method, enumerable: true })
  if (kind === 'read') {
    if (schema.io || schema.post !== undefined) throw new KernelError('INVALID', 'A read action cannot declare I/O or post')
    return { ...common, kind, handler }
  }
  if (schema.post !== undefined) return { ...common, kind, io: schema.io, post: schema.post, handler: plain }
  return { ...common, kind, io: schema.io, handler }
}

export function buildTypeDef<T extends object>(cls: Class<T>, options: TypeDefOptions<T>): TypeDef {
  const { schema, name, module, security, limits = DEFAULT_LIMITS } = options
  const methods = actionMethods(cls).filter(method => !method.name.startsWith('_'))
  const schemas = new Map(Object.entries(schema.methods ?? {}).filter(([name]) => !name.startsWith('_')))
  const compiledNeeds = compileNeeds(methods, { needs: options.needs })
  const actions: Record<string, ActionDef> = {}
  for (const { name, method } of methods) {
    const generated = schemas.get(name)
    if (generated === undefined) throw new KernelError('INVALID', `Missing action schema: ${name}`)
    const specs = compiledNeeds.get(name)
    const needs = specs && Object.fromEntries(specs.map(spec => [spec.key, selector(spec)]))
    Object.defineProperty(actions, name, { value: action(method, generated, needs, limits), enumerable: true })
    schemas.delete(name)
  }
  if (schemas.size !== 0) throw new KernelError('INVALID', 'The schema declares actions absent from the class')
  const { methods: methodSchemas, version = 0, actionsOnly, aliases, ...fields } = schema
  return { name, module, security, schema: fields, version, actionsOnly, aliases, actions }
}
