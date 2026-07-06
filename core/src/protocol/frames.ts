// TWP frames — docs/research/twp-spec.md §5. Vocabulary is identical in both
// directions: a request is recognized by `op`, a response is matched by the
// issuer against its own outstanding ids, events carry `ev`.
// v1 deltas vs spec (deliberate): hi-frame handshake lands with the first
// reconnectable binding (core-nin.5); act carries `stream` (caller picks)
// until responder-side handler introspection is decided (spec §11).

import type { PatchOp } from '#tree/patch';
import type { ErrorCode } from '#errors';

// ── handshake (implemented by bindings, core-nin.3) ──

export type HiFrame = { v: number; op: 'hi'; token?: string; sess?: string; since?: number; caps?: string[] };
export type HiOkFrame = { op: 'hi'; ok: { sess: string; seq: number; actor: string | null; caps: string[] } };

// ── requests ──

export type GetFrame     = { id: number; op: 'get'; path: string; watch?: boolean };
export type ResolveFrame = { id: number; op: 'resolve'; path: string; watch?: boolean };
export type LsFrame      = {
  id: number; op: 'ls'; path: string;
  limit?: number; offset?: number; depth?: number;
  /** Caller predicate (callerWhere) + cursor pagination (core-92z). query is
   *  incompatible with watch/watchList until Stage 6d and with offset. */
  query?: Record<string, unknown>; cursor?: string;
  watch?: boolean;
  /** Folder membership interest (renamed from watchNew; dirty semantics per gk8.12). */
  watchList?: boolean;
};
// opId on writes: echoed back as `by` on resulting events (core-gk8.1).
// Dedup/idempotent retry for plain writes is NOT implemented yet — only act
// dedups today; echo-only until the write-dedup decision lands.
export type SetFrame     = { id: number; op: 'set'; path: string; node: Record<string, unknown>; opId?: string };
export type PatchFrame   = { id: number; op: 'patch'; path: string; ops: PatchOp[]; opId?: string };
export type RmFrame      = { id: number; op: 'rm'; path: string; opId?: string };
export type ActFrame     = {
  id: number; op: 'act'; path: string; action: string;
  type?: string; key?: string; data?: unknown; opId?: string;
  /** Subscribe to paths found in the result (R4-MOUNT-5: asserted, capped, R-filtered). */
  watch?: boolean;
  stream?: boolean;
};
export type PermFrame    = { id: number; op: 'perm'; path: string };
export type SubFrame     = { id: number; op: 'sub'; paths?: string[]; prefixes?: string[] };
export type UnsubFrame   = { id: number; op: 'unsub'; paths?: string[]; prefixes?: string[] };

export type ReqFrame =
  | GetFrame | ResolveFrame | LsFrame | SetFrame | PatchFrame | RmFrame
  | ActFrame | PermFrame | SubFrame | UnsubFrame;

// ── responses ──

/** Domain codes cross the wire as-is; INTERNAL covers non-OpError failures. */
export type WireErrorCode = ErrorCode | 'INTERNAL';

export type OkFrame  = { id: number; ok: unknown; at?: number };
export type ErrFrame = { id: number; err: { code: WireErrorCode; msg: string; data?: unknown } };
export type ChFrame  = { id: number; ch: unknown };
export type EndFrame = { id: number; end: true };
export type ResFrame = OkFrame | ErrFrame | ChFrame | EndFrame;

// ── events (emitter's feed; seq required once gk8.1 stamping lands) ──

export type SetEvent   = { seq?: number; ev: 'set'; path: string; node: Record<string, unknown>; by?: string };
export type PatchEvent = { seq?: number; ev: 'patch'; path: string; ops: PatchOp[]; rev?: number; by?: string };
export type RmEvent    = { seq?: number; ev: 'rm'; path: string; by?: string };
export type DirtyEvent = { seq?: number; ev: 'dirty'; path: string; reason?: 'plan' | 'visibility' | 'claims'; dead?: boolean };
export type ResetEvent = { ev: 'reset'; reason?: 'overflow' | 'resume' };
export type EventFrame = SetEvent | PatchEvent | RmEvent | DirtyEvent | ResetEvent;

// ── control ──

export type CancelFrame = { op: 'cancel'; id: number };
export type PingFrame   = { op: 'ping' };
export type PongFrame   = { op: 'pong' };
export type ByeFrame    = { op: 'bye'; reason?: string };
export type CtlFrame = CancelFrame | PingFrame | PongFrame | ByeFrame | HiFrame | HiOkFrame;

export type Frame = ReqFrame | ResFrame | EventFrame | CtlFrame;

// ── wire guards (frames arrive as unknown — shallow shape only; per-op field
//    validation happens in the dispatcher, which throws BAD_REQUEST loudly) ──

const REQ_OPS: ReadonlySet<string> = new Set(['get', 'resolve', 'ls', 'set', 'patch', 'rm', 'act', 'perm', 'sub', 'unsub']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function isReqFrame(v: unknown): v is ReqFrame {
  return isRecord(v) && typeof v.id === 'number' && typeof v.op === 'string' && REQ_OPS.has(v.op);
}

export function isResFrame(v: unknown): v is ResFrame {
  return isRecord(v) && typeof v.id === 'number' && !('op' in v)
    && ('ok' in v || 'err' in v || 'ch' in v || 'end' in v);
}

export function isEventFrame(v: unknown): v is EventFrame {
  return isRecord(v) && typeof v.ev === 'string';
}

export function isCancelFrame(v: unknown): v is CancelFrame {
  return isRecord(v) && v.op === 'cancel' && typeof v.id === 'number';
}

export function isPingFrame(v: unknown): v is PingFrame { return isRecord(v) && v.op === 'ping'; }
export function isPongFrame(v: unknown): v is PongFrame { return isRecord(v) && v.op === 'pong'; }
export function isByeFrame(v: unknown): v is ByeFrame { return isRecord(v) && v.op === 'bye'; }
export function isHiFrame(v: unknown): v is HiFrame | HiOkFrame { return isRecord(v) && v.op === 'hi'; }
