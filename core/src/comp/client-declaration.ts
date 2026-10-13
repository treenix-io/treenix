import { actionMethods, AsyncGenFn, compileNeeds, type CompOptions } from './index';
import { predictionCtx, runWithExecCtx } from './context';
import { normalizeType, type Class, type NodeData } from '#core/component';

export interface ClientTypeDeclaration {
  readonly type: string;
  readonly defaults: () => Record<string, unknown>;
  readonly predictions: Readonly<Record<string, (node: Pick<NodeData, '$path' | '$type'>, component: object, data: unknown) => unknown>>;
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
  return Object.freeze({ type: normalizeType(type),
    defaults: () => Object.fromEntries(Object.entries(new cls())),
    predictions: Object.freeze(predictions) });
}
