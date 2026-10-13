import { actionMethods, AsyncGenFn, compileNeeds, type CompOptions } from './index';
import { predictionCtx, runWithExecCtx } from './context';
import { normalizeType, type Class, type NodeData } from '#core/component';

interface ClientTypeBehavior {
  readonly type: string;
  readonly contexts: readonly string[];
  readonly defaults: () => Record<string, unknown>;
  readonly predictions: Readonly<Record<string, (node: Pick<NodeData, '$path' | '$type'>, component: object, data: unknown) => unknown>>;
}

interface ClientClassDeclaration extends ClientTypeBehavior {
  readonly kind: 'class';
}

interface ClientSchemaDeclaration extends ClientTypeBehavior {
  readonly kind: 'schema';
  readonly createDefaults: () => ClientTypeBehavior['defaults'];
}

export type ClientTypeDeclaration = ClientClassDeclaration | ClientSchemaDeclaration;

interface ClientDefaultSchema {
  readonly properties?: Readonly<Record<string, { readonly default?: unknown }>>;
}

/** Capture authored client behavior without consulting registration state at execution time. */
export function declareClientType<T extends object>(type: string, cls: Class<T>, options?: CompOptions<T>): ClientTypeDeclaration {
  const methods = actionMethods(cls);
  const needs = compileNeeds(methods, options);
  const predictions: Record<string, ClientTypeDeclaration['predictions'][string]> = {};
  for (const { name, method } of methods) {
    if (options?.noOptimistic?.includes(name) || needs.has(name) || method instanceof AsyncGenFn) continue;
    predictions[name] = (node, component, data) =>
      runWithExecCtx(predictionCtx(node, component), () => method.call(component, data, undefined));
  }
  return Object.freeze({ type: normalizeType(type), kind: 'class',
    contexts: Object.freeze(['class', ...methods.map(method => `action:${method.name}`)]),
    defaults: () => Object.fromEntries(Object.entries(new cls())),
    predictions: Object.freeze(predictions) });
}

/** Resolve only authored top-level property defaults, without constructing a schema until needed. */
export function declareClientSchema(type: string, schema: () => ClientDefaultSchema): ClientTypeDeclaration {
  const createDefaults = () => {
    let resolved: ClientDefaultSchema | undefined;
    return () => {
      resolved ??= schema();
      const defaults: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(resolved.properties ?? {}))
        if ('default' in property) defaults[key] = property.default;
      return defaults;
    };
  };
  return Object.freeze({ type: normalizeType(type), kind: 'schema',
    contexts: Object.freeze(['schema']),
    defaults: createDefaults(), createDefaults,
    predictions: Object.freeze({}),
  });
}
