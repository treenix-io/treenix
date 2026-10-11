import { KernelError } from '#errors';
import type { ActionDef, JsonSchema, ModuleManifest, Registry, TypeDef } from '#kernel/types';

export type NativeActionDescription =
  | Pick<Extract<ActionDef, { kind: 'read' }>, 'kind' | 'args' | 'needs' | 'pre'>
  | Pick<Extract<ActionDef, { kind: 'write' | 'setuid' }>, 'kind' | 'args' | 'needs' | 'pre' | 'io' | 'post'>;

export interface NativeTypeDescription {
  readonly name: string;
  readonly module: string;
  readonly version: number;
  readonly schema: JsonSchema;
  readonly actions: Readonly<Record<string, NativeActionDescription>>;
}

/** Publish every data precondition and effect declaration without exposing executable handlers. */
function describeAction(action: ActionDef): NativeActionDescription {
  const common = { args: action.args, ...(action.needs === undefined ? {} : { needs: action.needs }),
    ...(action.pre === undefined ? {} : { pre: action.pre }) };
  if (action.kind === 'read') return { kind: action.kind, ...common };

  return { kind: action.kind, ...common, ...(action.io === undefined ? {} : { io: action.io }),
    ...(action.post === undefined ? {} : { post: action.post }) };
}

/** Expose data declarations while keeping implementation functions inside the actual registry. */
function describe(type: TypeDef, registry: Registry): NativeTypeDescription {
  return { name: type.name, module: type.module, version: type.version, schema: type.schema,
    actions: Object.fromEntries(Object.entries(type.actions).map(([name, action]) => [name, describeAction(action)])) };
}

/** The ownership node's ordinary read action supplies schema metadata under the live caller's projection. */
export function withTypeDescriptions(manifest: ModuleManifest, registry: Registry): ModuleManifest {
  return { ...manifest, types: manifest.types.map(type => type.name !== 't.type' ? type : {
    ...type, actions: { ...type.actions, describe_type: {
      kind: 'read', args: { type: 'object', additionalProperties: false },
      async handler(context) {
        const name = context.node.name;
        if (typeof name !== 'string') throw new KernelError('INVALID', 'Type ownership has no name');
        return describe(registry.type(name), registry);
      },
    } },
  }) };
}
