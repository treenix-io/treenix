import type { Class } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import { buildTypeDef, buildRegisteredTypeDef, type RegisteredTypeDefOptions } from '@treenx/core/kernel/typedef';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';
import type { ModuleManifest, OpenRegistration, SecurityRegistration } from '@treenx/core/kernel/types';
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
