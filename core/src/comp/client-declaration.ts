import { actionMethods, AsyncGenFn, compileNeeds, type CompOptions } from './index';
import { predictionCtx, runWithExecCtx } from './context';
import { normalizeType, type Class, type NodeData } from '#core/component';
import type { JsonSchema } from '#kernel/types';

interface ClientTypeBehavior {
  readonly type: string;
  readonly contexts: readonly string[];
  readonly defaults: () => Record<string, unknown>;
  readonly predictions: Readonly<
    Record<
      string,
      (node: Pick<NodeData, '$path' | '$type'>, component: object, data: unknown) => unknown
    >
  >;
}

interface ClientClassDeclaration extends ClientTypeBehavior {
  readonly kind: 'class';
}

export interface ClientSchemaDeclaration extends ClientTypeBehavior {
  readonly kind: 'schema';
  readonly schema: () => JsonSchema;
  readonly createReader: () => Pick<ClientSchemaDeclaration, 'schema' | 'defaults'>;
}

export type ClientTypeDeclaration = ClientClassDeclaration | ClientSchemaDeclaration;

/** Capture authored client behavior without consulting registration state at execution time. */
export function declareClientType<T extends object>(
  type: string,
  cls: Class<T>,
  options?: CompOptions<T>,
): ClientTypeDeclaration {
  Object.assign(cls, { $type: normalizeType(type) });
  const methods = actionMethods(cls);
  const needs = compileNeeds(methods, options);
  const predictions: Record<string, ClientTypeDeclaration['predictions'][string]> = {};
  for (const { name, method } of methods) {
    if (options?.noOptimistic?.includes(name) || needs.has(name) || method instanceof AsyncGenFn)
      continue;
    predictions[name] = (node, component, data) =>
      runWithExecCtx(predictionCtx(node, component), () => method.call(component, data, undefined));
  }
  return Object.freeze({
    type: normalizeType(type),
    kind: 'class',
    contexts: Object.freeze(['class', ...methods.map((method) => `action:${method.name}`)]),
    defaults: () => Object.fromEntries(Object.entries(new cls())),
    predictions: Object.freeze(predictions),
  });
}

/** Resolve only authored top-level property defaults, without constructing a schema until needed. */
export function declareClientSchema(type: string, schema: () => JsonSchema): ClientTypeDeclaration {
  const createReader = () => {
    let resolved: JsonSchema | undefined;
    const read = () => (resolved ??= schema());
    return {
      schema: read,
      defaults: () => {
        const defaults: Record<string, unknown> = {};
        for (const [key, property] of Object.entries(read().properties ?? {}))
          if ('default' in property) defaults[key] = property.default;
        return defaults;
      },
    };
  };
  return Object.freeze({
    type: normalizeType(type),
    kind: 'schema',
    contexts: Object.freeze(['schema']),
    ...createReader(),
    createReader,
    predictions: Object.freeze({}),
  });
}
