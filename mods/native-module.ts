import type { Class } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import { buildTypeDef, buildRegisteredTypeDef, type RegisteredTypeDefOptions } from '@treenx/core/kernel/typedef';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';
import type { ActionDef, ModuleManifest, OpenRegistration, SecurityClass, SecurityRegistration } from '@treenx/core/kernel/types';
import type { TypeSchema } from '@treenx/core/schema/types';

/** Compile explicitly owned schema/action data through the native type compiler. */
export function nativeSchemaModule(id: string, definitions: readonly Omit<RegisteredTypeDefOptions, 'module'>[],
  security: readonly SecurityRegistration[] = [], classes: readonly OpenRegistration[] = []): ModuleManifest {
  const types = definitions.map(definition => buildRegisteredTypeDef({ ...definition, module: id }));
  return { ...declareOpenModule(id, [
    ...classes,
    ...definitions.map(definition => ({ type: definition.name, context: 'schema', handler: () => definition.schema })),
    ...types.flatMap(type => Object.entries(type.actions).map(([name, handler]) => ({
      type: type.name, context: `action:${name}`, handler,
    }))),
  ]), types, security };
}

/** Class implementations and parsed schemas are supplied by their authored module, never a registry. */
export function nativeClassModule(id: string, classes: Readonly<Record<string, Class<object>>>,
  schemas: readonly (TypeSchema & { $id: string })[]): ModuleManifest {
  const byName = new Map(schemas.map(schema => [schema.$id, schema]));
  const owned = Object.entries(classes).map(([name, cls]) => {
    const schema = byName.get(name);
    if (schema === undefined) throw new KernelError('INVALID', `Owned class has no schema: ${id}:${name}`);
    return { name, cls, schema, type: buildTypeDef(cls, { name, module: id, security: 'ordinary', schema }) };
  });
  return { ...declareOpenModule(id, owned.flatMap(({ name, cls, schema, type }) => [
    { type: name, context: 'class', handler: cls },
    ...Object.entries(type.actions).map(([action, handler]) => ({ type: name, context: `action:${action}`, handler })),
    { type: name, context: 'schema', handler: () => schema },
  ])), types: owned.map(entry => entry.type), security: [] };
}

export interface NativeClassDeclaration {
  readonly cls: Class<object>;
  readonly security: SecurityClass;
  readonly meta?: Record<string, unknown>;
}

/** Compose authored dynamic action families and class behavior inside one explicit native owner. */
export function nativeDeclaredModule(id: string, schemas: Readonly<Record<string, TypeSchema>>,
  actions: Readonly<Record<string, Readonly<Record<string, ActionDef>>>>,
  classes: Readonly<Record<string, NativeClassDeclaration>>, security: readonly SecurityRegistration[]): ModuleManifest {
  const types = Object.entries(schemas).map(([name, schema]) => {
    const declaration = classes[name];
    if (declaration !== undefined) Object.assign(declaration.cls, { $type: name });
    return declaration === undefined
      ? buildRegisteredTypeDef({ name, module: id, security: 'ordinary', schema, methods: [], actions: actions[name] })
      : buildTypeDef(declaration.cls, { name, module: id, security: declaration.security, schema, actions: actions[name] });
  });
  const open: OpenRegistration[] = [];
  for (const [name, declaration] of Object.entries(classes)) open.push({ type: name, context: 'class',
    handler: declaration.meta === undefined ? declaration.cls : { handler: declaration.cls, meta: declaration.meta } });
  for (const [name, schema] of Object.entries(schemas)) open.push({ type: name, context: 'schema', handler: () => schema });
  for (const type of types) for (const [name, handler] of Object.entries(type.actions))
    open.push({ type: type.name, context: `action:${name}`, handler });
  return { ...declareOpenModule(id, open), types, security };
}
