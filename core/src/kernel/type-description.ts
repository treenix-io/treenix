import { nativeSystemManifest } from '#system/native-actions';
import { publishView } from '#kernel/uix-publication';
import { publishAction } from '#kernel/action-publication';
import { KernelError } from '#errors';
import type {
  ActionDef,
  JsonSchema,
  ModuleManifest,
  Registry,
  TypeDef,
  PublishedView,
} from '#kernel/types';

export type NativeActionDescription =
  | Pick<Extract<ActionDef, { kind: 'read' }>, 'kind' | 'args' | 'needs' | 'pre'>
  | Pick<
      Extract<ActionDef, { kind: 'write' | 'setuid' }>,
      'kind' | 'args' | 'needs' | 'pre' | 'io' | 'post'
    >;

export interface NativeTypeDescription {
  readonly name: string;
  readonly module: string;
  readonly version: number;
  readonly schema: JsonSchema;
  readonly actions: Readonly<Record<string, NativeActionDescription>>;
  readonly view?: PublishedView;
}

/** Publish every data precondition and effect declaration without exposing executable handlers. */
function describeAction(action: ActionDef): NativeActionDescription {
  const common = {
    args: action.args,
    ...(action.needs === undefined ? {} : { needs: action.needs }),
    ...(action.pre === undefined ? {} : { pre: action.pre }),
  };
  if (action.kind === 'read') return { kind: action.kind, ...common };

  return {
    kind: action.kind,
    ...common,
    ...(action.io === undefined ? {} : { io: action.io }),
    ...(action.post === undefined ? {} : { post: action.post }),
  };
}

/** Expose data declarations while keeping implementation functions inside the actual registry. */
function describe(type: TypeDef, registry: Registry): NativeTypeDescription {
  const view = registry.module(type.module).views?.[type.name];
  return {
    name: type.name,
    module: type.module,
    version: type.version,
    schema: type.schema,
    ...(view === undefined ? {} : { view }),
    actions: Object.fromEntries(
      Object.entries(type.actions).map(([name, action]) => [name, describeAction(action)]),
    ),
  };
}

/** The ownership node's ordinary read action supplies schema metadata under the live caller's projection. */
export function withTypeDescriptions(manifest: ModuleManifest, registry: Registry): ModuleManifest {
  if (manifest.id === 'treenix.system') {
    const system = nativeSystemManifest((name) => describe(registry.type(name), registry));
    return {
      ...manifest,
      types: manifest.types.map((type) =>
        type.name === 't.system' ? { ...type, actions: system.types[0].actions } : type,
      ),
    };
  }

  return {
    ...manifest,
    types: manifest.types.map((type) =>
      type.name !== 't.type'
        ? type
        : {
            ...type,
            actions: {
              ...type.actions,
              publish_action: {
                kind: 'write',
                args: {
                  type: 'object',
                  required: ['draft', 'action'],
                  additionalProperties: false,
                  properties: {
                    draft: { type: 'string' },
                    action: { type: 'string' },
                    definition: { type: 'object' },
                    stream: { type: 'boolean' },
                  },
                },
                handler: publishAction(registry),
              },
              publish_view: {
                kind: 'write',
                args: {
                  type: 'object',
                  required: ['draft'],
                  additionalProperties: false,
                  properties: { draft: { type: 'string' } },
                },
                handler: publishView,
              },
              describe_type: {
                kind: 'read',
                args: { type: 'object', additionalProperties: false },
                async handler(context) {
                  const name = context.node.name;
                  if (typeof name !== 'string')
                    throw new KernelError('INVALID', 'Type ownership has no name');
                  return describe(registry.type(name), registry);
                },
              },
            },
          },
    ),
  };
}
