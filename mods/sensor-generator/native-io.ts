import { setTimeout } from 'node:timers/promises';
import type { ActionIoBinding } from '@treenx/core/kernel/types';

declare module '@treenx/core/kernel/types' {
  interface Io {
    readonly sensorGenerator?: { wait(ms: number): Promise<void> };
  }
}

/** Bind scan pacing to the current native action's cancellation and frame lifetime. */
export const bindIo: ActionIoBinding = (scope) => ({
  sensorGenerator: {
    async wait(ms) {
      scope.assertActive();
      await setTimeout(ms, undefined, { signal: scope.signal });
      scope.assertActive();
    },
  },
});
