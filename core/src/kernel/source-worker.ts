import { parentPort, workerData } from 'node:worker_threads';
import { getQuickJS, type QuickJSHandle } from 'quickjs-emscripten';
import { KernelError } from '#errors';
import { serializeRequest } from '#kernel/request';
import { isRecord } from '#util/is-record';
import type { SourceWorkerConfig, SourceWorkerReply, SourceWorkerRequest, SourceSyncReply, SourceWorkerError } from '#kernel/source-worker-port';

class NativeSourceError extends KernelError {
  readonly terminal: boolean;

  /** Preserve whether a refused host operation must stop guest execution. */
  constructor(error: SourceWorkerError) {
    super(error.code, error.message);
    this.terminal = error.terminal === true;
  }
}

const MEMORY_BYTES = 8 * 1024 * 1024, STACK_BYTES = 512 * 1024;
const configuration: SourceWorkerConfig = workerData;
const port = parentPort;
if (port === null) throw new KernelError('INVALID', 'Source worker has no owning port');

/** Send a protocol message to the owning thread. */
function post(message: SourceWorkerRequest): void {
  port!.postMessage(message);
}

const bytes = new SharedArrayBuffer(1024 * 1024 + 8), header = new Int32Array(bytes, 0, 2);

/** Perform a synchronous host operation through the shared reply buffer. */
function sync(method: 'get' | 'change' | 'charge', input: unknown): unknown {
  Atomics.store(header, 0, 0);
  post({ kind: 'sync', method, input, bytes });
  Atomics.wait(header, 0, 0);
  const result: SourceSyncReply = JSON.parse(Buffer.from(new Uint8Array(bytes, 8, Atomics.load(header, 1))).toString());
  if ('error' in result) throw new NativeSourceError(result.error);
  return result.value;
}
let id = 0;
const calls = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();

/** Request an asynchronous read, nested action, or declared I/O operation. */
function callNative(method: string, input: unknown): Promise<unknown> {
  if (method !== 'read' && method !== 'act' && method !== 'io') throw new KernelError('INVALID', 'Unknown source bridge');
  return new Promise((resolve, reject) => {
    const key = ++id;
    calls.set(key, { resolve, reject });
    post({ kind: 'call', id: key, method, input });
  });
}

/** Run one published action inside its isolated QuickJS runtime. */
async function* execution(): AsyncGenerator<unknown, unknown, undefined> {
  if (configuration.verify) throw new KernelError('INVALID', 'Verification worker cannot execute actions');
  const published = configuration.publication, args = configuration.args;
  const engine = await getQuickJS();

  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(MEMORY_BYTES);
  runtime.setMaxStackSize(STACK_BYTES);
  const vm = runtime.newContext();
  let ended = false, fatal: unknown;
  let wake = () => {};
  let awakened = new Promise<void>(resolve => { wake = resolve; });
  const pending = new Set<Promise<void>>();
  const deferred = new Set<ReturnType<typeof vm.newPromise>>();

  /** Stop guest work after a terminal host failure. */
  function active(): void {
    if (fatal !== undefined) throw fatal;
  }
  /** Wake the event-driven promise-settlement loop. */
  function notify(): void {
    wake();
  }

  /** Serialize a value and charge its encoded size to the host. */
  function bytes(value: unknown): string {
    const encoded = serializeRequest(value);
    sync('charge', Buffer.byteLength(encoded));
    return encoded;
  }

  /** Decode guest JSON bytes after charging their size. */
  function decode(handle: QuickJSHandle): unknown {
    if (vm.typeof(handle) !== 'string') throw new KernelError('INVALID', 'Source bridge expects JSON bytes');
    const encoded = vm.getString(handle);
    sync('charge', Buffer.byteLength(encoded));
    const value: unknown = JSON.parse(encoded);
    return value;
  }

  /** Restore a structured guest error or map an unknown error to INVALID. */
  function guestError(handle: QuickJSHandle): KernelError {
    const value: unknown = vm.dump(handle);
    handle.dispose();
    if (isRecord(value) && typeof value.code === 'string') {
      const codes = ['NOT_FOUND','FORBIDDEN','CONFLICT','INVALID','UNKNOWN_TYPE','CROSS_DOMAIN','READ_ONLY','BUDGET','REFUSED','UNKNOWN_OUTCOME','EXPIRED','KEY_REUSED','UNAVAILABLE','GENERATION','CANCELLED','UNAUTHENTICATED'] as const;
      for (const code of codes) if (value.code === code) return new KernelError(code, typeof value.message === 'string' ? value.message : 'Native source execution failed');
    }
    return new KernelError('INVALID', 'Native source execution failed');
  }

  /** Convert a host failure into a guest exception and mark terminal failures. */
  function rejection(error: unknown): QuickJSHandle {
    if (error instanceof NativeSourceError && error.terminal || error instanceof KernelError && (error.code === 'BUDGET' || error.code === 'CANCELLED')) fatal = error;
    const handle = vm.newError({ name: 'KernelError', message: error instanceof Error ? error.message : 'Native bridge failed' });
    const code = vm.newString(error instanceof KernelError ? error.code : 'INVALID');
    try { vm.setProp(handle, 'code', code); } finally { code.dispose(); }
    return handle;
  }
  const call = vm.newFunction('native_call', (methodHandle, valueHandle) => {
    let method: string, value: unknown;
    try { active(); method = vm.getString(methodHandle); value = decode(valueHandle); }
    catch (error) { return { error: rejection(error) }; }
    const promise = vm.newPromise();
    deferred.add(promise);
    const task = Promise.resolve().then(async () => {
      try {
        const result = await callNative(method, value);
        if (ended) return;
        active();
        const handle = vm.newString(bytes(result === undefined ? null : result));
        try { promise.resolve(handle); } finally { handle.dispose(); }
      } catch (error) {
        if (ended) return;
        const handle = rejection(error);
        try { promise.reject(handle); } finally { handle.dispose(); }
      } finally { pending.delete(task); notify(); }
    });
    pending.add(task);
    return promise.handle;
  });
  const get = vm.newFunction('native_get', name => {
    try {
      active();
      return vm.newString(bytes(sync('get', vm.getString(name))));
    } catch (error) { return { error: rejection(error) }; }
  });
  const stage = vm.newFunction('native_change', handle => {
    try {
      active();
      sync('change', decode(handle));
      return vm.undefined;
    } catch (error) { return { error: rejection(error) }; }
  });
  vm.setProp(vm.global, '__call', call); call.dispose();
  vm.setProp(vm.global, '__get', get); get.dispose();
  vm.setProp(vm.global, '__change', stage); stage.dispose();

  /** Run queued guest continuations and event-driven host completions without polling. */
  async function settle(handle: QuickJSHandle): Promise<QuickJSHandle> {
    for (;;) {
      active();
      const jobs = runtime.executePendingJobs(64);
      if (jobs.error) throw guestError(jobs.error);
      active();
      const state = vm.getPromiseState(handle);
      if (state.type === 'fulfilled') {
        if (pending.size !== 0) { state.value.dispose(); throw new KernelError('INVALID', 'Source left an operation pending'); }
        return state.value;
      }
      if (state.type === 'rejected') throw guestError(state.error);
      if (jobs.value === 64) continue;
      await awakened;
      awakened = new Promise<void>(resolve => { wake = resolve; });
    }
  }
  /** Evaluate one guest expression and translate QuickJS failures. */
  function evaluate(code: string): QuickJSHandle {
    active();
    const result = vm.evalCode(code);
    if (result.error) throw guestError(result.error);
    return result.value;
  }
  try {
    const sourcePorts = configuration.ports;
    const initialization = evaluate(`
      const call = (method, value) => __call(method, JSON.stringify(value)).then(JSON.parse);
      const ctx = Object.freeze({
        get node() { return JSON.parse(__get('node')); }, get needs() { return JSON.parse(__get('needs')); },
        get caller() { return JSON.parse(__get('caller')); }, get executor() { return JSON.parse(__get('executor')); },
        read: Object.freeze({ read: selector => call('read', selector) }), act: request => call('act', request),
        ${configuration.writing ? `change: Object.freeze({
          put: node => __change(JSON.stringify({op:'put',node})), patch: (path,ops) => __change(JSON.stringify({op:'patch',path,ops})),
          remove: path => __change(JSON.stringify({op:'remove',path})), move: (from,to) => __change(JSON.stringify({op:'move',from,to})),
          restore: record => __change(JSON.stringify({op:'restore',record})) }),` : ''}
        io: Object.freeze(Object.fromEntries(${JSON.stringify(sourcePorts)}.map(name => [name, input => call('io',[name,input])]))),
      });
      const data = ${bytes(args === undefined ? null : args)};
      const execution = (async function${published.stream ? '*' : ''}(ctx,data) {\n${published.source}\n})(ctx,data);
    `);
    initialization.dispose();
    for (;;) {
      const promise = evaluate(published.stream ? 'execution.next()' : 'execution');
      let value: QuickJSHandle;
      try { value = await settle(promise); } finally { promise.dispose(); }
      vm.setProp(vm.global, '__result', value);
      value.dispose();
      const json = evaluate('JSON.stringify(__result)');
      let result: unknown;
      try { result = vm.typeof(json) === 'undefined' ? undefined : decode(json); } finally { json.dispose(); }
      if (!published.stream) return result;
      if (!isRecord(result) || typeof result.done !== 'boolean') throw new KernelError('INVALID', 'Invalid source iterator result');
      if (result.done) return result.value;
      yield result.value;
    }
  } finally {
    ended = true;
    for (const promise of deferred) promise.dispose();
    vm.dispose(); runtime.dispose();
  }
}


const iterator = execution();
port.on('message', (message: SourceWorkerReply) => {
  if (message.kind === 'next')
    void iterator.next().then(piece => post({ kind: 'piece', done: piece.done === true, value: piece.value }))
      .catch(error => post({ kind: 'failed', error: { code: error instanceof KernelError ? error.code : 'INVALID', message: 'Native source execution failed' } }));
  else {
    const pending = calls.get(message.id);
    if (pending === undefined) throw new KernelError('INVALID', 'Unowned source reply');
    calls.delete(message.id);
    if (message.kind === 'reply') pending.resolve(JSON.parse(message.result));
    else pending.reject(new NativeSourceError(message.error));
  }
});

if (configuration.verify) {
  const engine = await getQuickJS(), runtime = engine.newRuntime();
  runtime.setMemoryLimit(MEMORY_BYTES);
  runtime.setMaxStackSize(STACK_BYTES);
  const vm = runtime.newContext();
  try {
    const result = vm.evalCode(`(async function${configuration.stream?'*':''}(ctx,data){\n${configuration.source}\n})`, undefined, { compileOnly: true });
    if (result.error) {
      result.error.dispose();
      post({ kind: 'failed', error: { code: 'INVALID', message: 'Invalid source' } })
    } else {
      result.value.dispose();
      post({ kind: 'verified' })
    }
  } finally {
    vm.dispose();
    runtime.dispose()
  }
}
