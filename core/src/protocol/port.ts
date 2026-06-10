// TWP postMessage transport — Conn over a MessagePort-like channel.
// One adapter serves every port flavor: MessageChannel ports, Worker /
// SharedWorker ports, iframe contentWindow channels, React Native WebView
// bridges, Node worker_threads. Frames cross via structured clone — no
// JSON.stringify on this path.
//
// Security (spec §7): pass a DEDICATED port (MessageChannel/worker port),
// never a broadcast window. Window-level handshakes that dispense ports must
// verify event.origin BEFORE handing the port to this adapter.

import type { Frame } from './frames';
import type { Conn } from './peer';

/** Structural MessagePort — browser and Node worker_threads both satisfy it
 *  (core compiles without DOM libs). */
export type PortLike = {
  postMessage(value: unknown): void;
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
  /** Browser ports require start() after addEventListener; Node's is a no-op-safe call. */
  start?(): void;
  close?(): void;
};

export function createPortConn(port: PortLike): Conn {
  const cbs = new Set<(f: unknown) => void>();
  let closed = false;

  const onMessage = (e: { data: unknown }) => {
    for (const cb of cbs) cb(e.data);
  };
  port.addEventListener('message', onMessage);
  port.start?.();

  return {
    send(frame: Frame) {
      if (closed) throw new Error('port-conn: closed');
      port.postMessage(frame);
    },
    onFrame(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    close() {
      if (closed) return;
      closed = true;
      cbs.clear();
      port.removeEventListener('message', onMessage);
      port.close?.();
    },
  };
}
