import type { Handler } from './context';

export interface Registration {
  readonly type: string;
  readonly context: string;
  readonly handler: Handler;
  readonly meta?: Record<string, unknown>;
}

export type RegistrationEvent = Registration | { readonly type: string; readonly context: string; readonly remove: true };

interface RegistrationCapture {
  readonly pending: RegistrationEvent[];
  collect?: (registration: RegistrationEvent) => void;
}

declare global {
  var __treenxRegistrationCapture: RegistrationCapture | undefined;
}

const capture = globalThis.__treenxRegistrationCapture ??= { pending: [] };

export function recordRegistration(registration: RegistrationEvent): void {
  if (capture.collect) capture.collect(registration);
  else capture.pending.push(registration);
}

export function collectRegistrations(collect: (registration: RegistrationEvent) => void): void {
  capture.collect = collect;
  for (const registration of capture.pending) collect(registration);
  capture.pending.length = 0;
}
