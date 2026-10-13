import type { Handler } from './context';

export interface Registration {
  readonly type: string;
  readonly context: string;
  readonly handler: Handler;
  readonly meta?: Record<string, unknown>;
}

export type RegistrationEvent = Registration | { readonly type: string; readonly context: string; readonly remove: true };

interface RegistrationCapture {
  declarations?: Map<string, Registration>;
  observers?: Set<(registration: RegistrationEvent) => void>;
}

declare global {
  var __treenxRegistrationCapture: RegistrationCapture | undefined;
}

const capture = globalThis.__treenxRegistrationCapture ??= {};
const declarations = capture.declarations ??= new Map<string, Registration>();
const observers = capture.observers ??= new Set<(registration: RegistrationEvent) => void>();

export function recordRegistration(registration: RegistrationEvent): void {
  const key = `${registration.type}:${registration.context}`;
  if ('remove' in registration) declarations.delete(key);
  else if (!declarations.has(key)) declarations.set(key, registration);
  for (const observer of observers) observer(registration);
}

/** Replay declarations independently of the server's module collection lifetime. */
export function observeRegistrations(observer: (registration: RegistrationEvent) => void): () => void {
  for (const registration of declarations.values()) observer(registration);
  observers.add(observer);
  return () => { observers.delete(observer); };
}
