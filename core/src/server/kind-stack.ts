// Execution-kind stack — tracks the chain of in-flight actions across nested
// `executeAction` calls so propagation rules can fail fast at entry, before the
// callee's handler runs.
//
// Rules (caller × target):
//   read         → read    OK
//   read         → write   throw KIND_VIOLATION (read cannot trigger writes)
//   read         → io      throw KIND_VIOLATION (read cannot leak side effects)
//   read+io      → read    OK
//   read+io      → write   throw
//   read+io      → io      OK
//   write/*      → *       OK
//
// Empty stack (out-of-band: bootstrap, seeds, migrations) → all targets allowed.

import { AsyncLocalStorage } from 'node:async_hooks';
import { OpError } from '#errors';

export type KindFrame = {
  kind: 'read' | 'write';
  io: boolean;
  path: string;
  action: string;
};

const stack = new AsyncLocalStorage<KindFrame[]>();

export function currentFrame(): KindFrame | undefined {
  const s = stack.getStore();
  return s?.[s.length - 1];
}

export function assertCanCall(target: { kind: 'read' | 'write'; io: boolean }): void {
  const caller = currentFrame();
  if (!caller) return; // out-of-band entry: allow

  if (caller.kind === 'read' && target.kind === 'write') {
    throw new OpError(
      'KIND_VIOLATION',
      `read action ${caller.action} cannot invoke write action ${target ? '' : ''}`.trim(),
    );
  }
  if (caller.kind === 'read' && target.io && !caller.io) {
    throw new OpError(
      'KIND_VIOLATION',
      `read action ${caller.action} (no io) cannot invoke io target`,
    );
  }
}

export function runWithFrame<T>(frame: KindFrame, fn: () => Promise<T>): Promise<T> {
  const current = stack.getStore() ?? [];
  return stack.run([...current, frame], fn);
}
