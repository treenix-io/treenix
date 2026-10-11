import { Worker } from 'node:worker_threads';
import { KernelError } from '#errors';
import { getActionLifetime } from '#kernel/current-action';
import { change, isSelector, keys, path, text } from '#kernel/input-boundary';
import type { ActionDef, ModuleManifest, PublishedActionSource, ReadActionContext, WriteActionContext } from '#kernel/types';
import type { SourceWorkerConfig, SourceWorkerRequest, SourceWorkerReply, SourceSyncReply, SourceWorkerError } from '#kernel/source-worker-port';
import { serializeRequest } from '#kernel/request';
import { isRecord } from '#util/is-record';

const SOURCE_BYTES = 1024 * 1024;
const workerUrl = new URL(import.meta.url.endsWith('.ts') ? './source-worker-bootstrap.ts' : './source-worker.js', import.meta.url);

export interface ActionSourceVerificationScope {
  readonly signal: AbortSignal;
  assertActive(): void;
}

/** Syntax verification owns a bounded worker and cannot execute source on the server thread. */
export async function verifyActionSource(source: string, stream: boolean, scope?: ActionSourceVerificationScope): Promise<void> {
  scope?.assertActive();
  if (Buffer.byteLength(source) > SOURCE_BYTES) throw new KernelError('BUDGET', 'Action source exceeds its byte limit');
  const configuration: SourceWorkerConfig = { source, stream, verify: true };
  const worker = new Worker(workerUrl, { workerData: configuration, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8 } });
  let abort = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new KernelError('BUDGET', 'Action source verification exceeded its deadline')), 5_000);
      abort = () => { clearTimeout(timer); reject(scope!.signal.reason); void worker.terminate(); };
      scope?.signal.addEventListener('abort', abort, { once: true });
      if (scope?.signal.aborted) abort();
      worker.on('message', (message: SourceWorkerRequest) => {
        if (message.kind === 'verified') { clearTimeout(timer); resolve(); }
        else if (message.kind === 'failed') { clearTimeout(timer); reject(new KernelError('INVALID', 'Invalid native action source')); }
        else { clearTimeout(timer); reject(new KernelError('INVALID', 'Unexpected source verification reply')); }
      });
      worker.on('error', error => { clearTimeout(timer); reject(error); });
      worker.on('exit', () => { clearTimeout(timer); reject(new KernelError('UNAVAILABLE', 'Source verification worker ended')); });
    });
  } finally {
    await worker.terminate();
    scope?.signal.removeEventListener('abort', abort);
  }
  scope?.assertActive();
}

/** Only the genuine executor frame admits reads, effects, external ports and byte charges. */
async function* executeSource(
  published: PublishedActionSource,
  manifest: ModuleManifest,
  context: ReadActionContext | WriteActionContext,
  args: unknown
): AsyncGenerator<unknown, unknown, undefined> {
  const lifetime = getActionLifetime();
  const ports = published.definition.kind !== 'read' && published.definition.io === true ? Object.keys(manifest.sourceIo ?? {}) : [];
  const configuration: SourceWorkerConfig = { publication: published, args, ports, writing: 'change' in context, verify: false };
  const worker = new Worker(workerUrl, { workerData: configuration, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8 } });
  let ended = false;
  let ready: { resolve(value: { done: boolean; value: unknown }): void; reject(error: unknown): void } | undefined;
  let failure: unknown;
  /** Reject host work after cancellation or worker shutdown. */
  function active(): void {
    lifetime.assertActive();
    if (ended) throw new KernelError('CANCELLED', 'Source worker ended');
  }

  /** Serialize a host result and account for its transferred bytes. */
  function encoded(value: unknown): string {
    const result = serializeRequest(value);
    lifetime.chargeBytes(Buffer.byteLength(result));
    return result;
  }

  /** Stop the worker and reject the current request when execution cannot continue. */
  function stop(error: unknown): void {
    failure = error;
    ended = true;
    ready?.reject(error);
    void worker.terminate();
  }

  /** Send a reply only while this action remains active. */
  function send(message: SourceWorkerReply): void {
    active();
    worker.postMessage(message);
  }

  /** Route guest requests through the action's authorized host context. */
  async function dispatch(method: 'read' | 'act' | 'io', value: unknown): Promise<unknown> {
    active();
    if (method === 'read') {
      if (!isSelector(value)) throw new KernelError('INVALID', 'Invalid source selector');
      return context.read.read(value);
    }
    if (method === 'act') {
      if (!isRecord(value) || !keys(value, ['path', 'action', 'component', 'args', 'key']) || !path(value.path) || !text(value.action)
        || value.component !== undefined && typeof value.component !== 'string' || value.key !== undefined && !text(value.key))
        throw new KernelError('INVALID', 'Invalid source nested action');
      return context.act({ path: value.path, action: value.action, component: value.component, args: value.args, key: value.key });
    }
    if (!('change' in context) || published.definition.kind === 'read' || published.definition.io !== true
      || !Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || !Object.hasOwn(manifest.sourceIo ?? {}, value[0]))
      throw new KernelError('FORBIDDEN', 'Undeclared source I/O');
    if (context.io === undefined) throw new KernelError('UNAVAILABLE', 'Source I/O is not bound');
    return manifest.sourceIo![value[0]](context.io, value[1]);
  }

  /** Preserve kernel error codes and mark budget or cancellation failures terminal. */
  function refusal(error: unknown): SourceWorkerError {
    const failure = error instanceof KernelError ? error : new KernelError('UNAVAILABLE', error instanceof Error ? error.message : 'Native bridge failed');
    let terminal = failure.code === 'BUDGET' || failure.code === 'CANCELLED';
    try { active(); } catch { terminal = true; }
    return { code: failure.code, message: failure.message, terminal };
  }

  /** Serve synchronous reads, staged changes, and byte-charge requests. */
  function sync(message: Extract<SourceWorkerRequest, { kind: 'sync' }>): void {
    let reply: SourceSyncReply;
    try {
      active();
      if (message.method === 'charge') {
        if (typeof message.input !== 'number' || !Number.isSafeInteger(message.input) || message.input < 0) throw new KernelError('INVALID', 'Invalid source byte charge');
        lifetime.chargeBytes(message.input);
        reply = { value: null };
      } else if (message.method === 'get') {
        switch (message.input) {
          case 'node': reply = { value: context.node }; break;
          case 'needs': reply = { value: context.needs }; break;
          case 'caller': reply = { value: context.caller }; break;
          case 'executor': reply = { value: context.executor }; break;
          default: throw new KernelError('INVALID', 'Unknown source context field');
        }
      } else {
        if (!('change' in context)) throw new KernelError('FORBIDDEN', 'Read source cannot stage changes');
        const value = message.input;
        if (!change(value)) throw new KernelError('INVALID', 'Invalid source change');
        switch (value.op) {
          case 'put': context.change.put(value.node); break;
          case 'patch': context.change.patch(value.path, value.ops); break;
          case 'remove': context.change.remove(value.path); break;
          case 'move': context.change.move(value.from, value.to); break;
          case 'restore': context.change.restore(value.record); break;
          case 'undo': context.change.undo(value.record); break;
        }
        reply = { value: null };
      }
    } catch (error) {
      reply = { error: refusal(error) };
    }
    const header = new Int32Array(message.bytes, 0, 2), output = new Uint8Array(message.bytes, 8);
    try {
      const bytes = Buffer.from(message.method === 'charge' ? serializeRequest(reply) : encoded(reply));
      if (bytes.length > output.length) throw new KernelError('BUDGET', 'Source reply exceeds its owned buffer');
      output.set(bytes); Atomics.store(header, 1, bytes.length);
    } catch (error) {
      const bytes = Buffer.from(serializeRequest({ error: refusal(error) }));
      output.set(bytes); Atomics.store(header, 1, bytes.length);
    }
    Atomics.store(header, 0, 1); Atomics.notify(header, 0);
  }
  const aborted = () => stop(lifetime.signal.reason);
  lifetime.signal.addEventListener('abort', aborted, { once: true });
  worker.on('error', stop);
  worker.on('exit', () => { if (!ended) stop(new KernelError('UNAVAILABLE', 'Source worker ended')); });
  worker.on('message', (message: SourceWorkerRequest) => {
    if (message.kind === 'sync') { sync(message); return; }
    if (ended) return;
    if (message.kind === 'call') {
      void dispatch(message.method, message.input).then(value => {
        send({ kind: 'reply', id: message.id, result: encoded(value === undefined ? null : value) });
      }).catch(error => {
        if (ended) return;
        worker.postMessage({ kind: 'refused', id: message.id, error: refusal(error) } satisfies SourceWorkerReply);
      });
    } else if (message.kind === 'failed') stop(new KernelError(message.error.code, message.error.message));
    else if (message.kind === 'piece') {
      try { active(); ready!.resolve({ done: message.done, value: message.value }); } catch (error) { stop(error); }
    } else stop(new KernelError('INVALID', 'Unexpected source worker reply'));
  });
  try {
    for (;;) {
      if (failure !== undefined) throw failure;
      active();
      const result = await new Promise<{ done: boolean; value: unknown }>((resolve, reject) => {
        ready = { resolve, reject };
        send({ kind: 'next' });
      });
      ready = undefined;
      if (result.done) return result.value;
      yield result.value;
    }
  } finally {
    ended = true;
    lifetime.signal.removeEventListener('abort', aborted);
    await worker.terminate();
  }
}

/** Bind a verified source publication to the host action interface. */
export function sourceAction(published: PublishedActionSource, manifest: ModuleManifest): ActionDef {
  const definition = published.definition;
  if (published.stream && definition.kind !== 'read' && definition.post !== undefined) throw new KernelError('INVALID', 'Streaming source cannot declare post');
  if (definition.kind === 'read') return { ...definition, handler: published.stream
    ? async function* (context: ReadActionContext, args: unknown) { return yield* executeSource(published, manifest, context, args); }
    : async (context: ReadActionContext, args: unknown) => (await executeSource(published, manifest, context, args).next()).value };
  if (definition.post !== undefined) return { ...definition, handler: async (context: WriteActionContext, args: unknown) => (await executeSource(published, manifest, context, args).next()).value };
  return { ...definition, handler: published.stream
    ? async function* (context: WriteActionContext, args: unknown) { return yield* executeSource(published, manifest, context, args); }
    : async (context: WriteActionContext, args: unknown) => (await executeSource(published, manifest, context, args).next()).value };
}
