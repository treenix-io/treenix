import type { Class } from '#core/component';
import type { NeedSpec } from '#comp/needs';
import type { ActionMethod } from '#comp/index';
import type { SecurityClass } from '#kernel/types';

export interface RegisteredClass {
  readonly cls: Class<object>;
  readonly security: SecurityClass;
}

export interface RegisteredMethod extends ActionMethod {
  readonly needs?: readonly NeedSpec[];
}

interface Implementations {
  readonly classes: WeakMap<object, Map<string, RegisteredClass>>;
  readonly methods: WeakMap<object, RegisteredMethod>;
}

declare global {
  var __treenxComponentImplementations: Implementations | undefined;
}

const implementations = globalThis.__treenxComponentImplementations ??= { classes: new WeakMap(), methods: new WeakMap() };

export function recordClass(type: string, cls: Class<object>, security: SecurityClass): void {
  let definitions = implementations.classes.get(cls);
  if (!definitions) { definitions = new Map(); implementations.classes.set(cls, definitions); }
  definitions.set(type, { cls, security });
}

export function registeredClass(type: string, handler: object): RegisteredClass | undefined {
  return implementations.classes.get(handler)?.get(type);
}

export function recordMethod(handler: object, method: RegisteredMethod): void {
  implementations.methods.set(handler, method);
}

export function registeredMethod(handler: object): RegisteredMethod | undefined {
  return implementations.methods.get(handler);
}
