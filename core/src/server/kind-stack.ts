// Execution-kind stack — tracks the chain of in-flight actions across nested
// `executeAction` calls so propagation rules can fail fast at entry, before the
// callee's handler runs.
//
// Rules (caller × target):
//   read         → read    OK
//   read         → write   throw FORBIDDEN (read cannot trigger writes)
//   read         → io      throw FORBIDDEN (read cannot leak side effects)
//   write/*      → *       OK
//
// Empty stack (out-of-band: bootstrap, seeds, migrations) → all targets allowed.

import { AsyncLocalStorage } from 'node:async_hooks';
import { KernelError } from '#errors';

export type KindFrame = {
  kind: 'read' | 'write';
  io: boolean;
  path: string;
  action: string;
  callerBound?: boolean;
};

const stack = new AsyncLocalStorage<KindFrame[]>();

export function currentFrame(): KindFrame | undefined {
  const s = stack.getStore();
  return s?.[s.length - 1];
}

export function assertCanCall(target: { kind: 'read' | 'write'; io: boolean }): void {
  if (target.kind === 'read' && target.io) {
    throw new KernelError('FORBIDDEN', 'Read actions cannot declare external effects');
  }
  const caller = currentFrame();
  if (!caller) return; // out-of-band entry: allow

  if (caller.kind === 'read' && target.kind === 'write') {
    throw new KernelError(
      'FORBIDDEN',
      `read action ${caller.action} cannot invoke write target (${target.kind}${target.io ? '+io' : ''})`,
    );
  }
}

export function runWithFrame<T>(frame: KindFrame, fn: () => Promise<T>): Promise<T> {
  const current = stack.getStore() ?? [];
  return stack.run([...current, frame], fn);
}

/** Detach into a FRESH frame stack — the escape hatch for long-run jobs
 *  (core-gk8.5). Caller frames are deliberately not inherited: a job outlives
 *  its spawning action, so a lingering parent frame would be a lie. Fail
 *  closed: read frames cannot detach — that would launder writes past
 *  assertCanCall. The guard lives HERE (not in startJob) so no caller of the
 *  escape hatch can skip it. */
export function runDetached<T>(frame: KindFrame, fn: () => Promise<T>): Promise<T> {
  const caller = currentFrame();
  if (caller?.kind === 'read') {
    throw new KernelError(
      'FORBIDDEN',
      `read action ${caller.action} cannot detach ${frame.action} (${frame.kind}${frame.io ? '+io' : ''})`,
    );
  }
  return stack.run([frame], fn);
}
