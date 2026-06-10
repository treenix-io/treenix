// In-process TWP transport — two Conn endpoints joined back-to-back.
// Frames cross as-is (no serialization). Delivery is deferred to a microtask
// so send() never re-enters the receiver synchronously.

import type { Conn } from './peer';
import type { Frame } from './frames';

type End = { cbs: Set<(f: unknown) => void>; closed: boolean };

export function createLoopback(): [Conn, Conn] {
  const a: End = { cbs: new Set(), closed: false };
  const b: End = { cbs: new Set(), closed: false };

  const make = (self: End, other: End): Conn => ({
    send(frame: Frame) {
      if (self.closed) throw new Error('loopback: closed');
      queueMicrotask(() => {
        if (other.closed) return;
        for (const cb of other.cbs) cb(frame);
      });
    },
    onFrame(cb) {
      self.cbs.add(cb);
      return () => self.cbs.delete(cb);
    },
    close() {
      self.closed = true;
      self.cbs.clear();
    },
  });

  return [make(a, b), make(b, a)];
}
