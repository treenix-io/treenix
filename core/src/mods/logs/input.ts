import { KernelError } from '#errors';
import type { LogEntry } from '#log';

/** An explicit deployment owns its input; process-wide console listeners are not an admission source. */
export interface LogsInput {
  emit(entry: LogEntry): void;
  subscribe(receive: (entry: LogEntry) => void): () => void;
}

declare module '#kernel/manifest' {
  interface NativeModuleHost { readonly logs?: LogsInput; }
}

/** Retain bounded startup messages until this deployment's writer has admitted its input. */
export function createLogsInput(): LogsInput {
  let receive: ((entry: LogEntry) => void) | undefined;
  const pending: LogEntry[] = [];
  let bytes = 0;
  return {
    emit(entry) {
      if (receive !== undefined) { receive(entry); return; }
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (pending.length === 1000 || bytes + size > 8 * 1024 * 1024)
        throw new KernelError('BUDGET', 'Deployment log input is full');
      pending.push({ ...entry });
      bytes += size;
    },
    subscribe(next) {
      if (receive !== undefined) throw new KernelError('CONFLICT', 'Deployment log input already has a writer');
      let admitted = 0;
      try {
        for (const entry of pending) {
          next(entry);
          admitted++;
          bytes -= Buffer.byteLength(JSON.stringify(entry));
        }
      } finally { pending.splice(0, admitted); }
      receive = next;
      return () => { if (receive === next) receive = undefined; };
    },
  };
}
