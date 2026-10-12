import { randomUUID } from 'node:crypto';
import { getComponent } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import type { ServiceHandler, SubId } from '@treenx/core/kernel/types';
import type { AiPool } from '#agent/types';
import { optionalPoolNode, poolChildren, poolNode, type PoolConfig } from '#agent/native-pool';
import { jobInput } from '#agent/native-pool-run';

/** Owns one event-driven scheduler while each model runs through a separately admitted native action. */
export const nativePoolService: ServiceHandler = async (node, session) => {
  const declared = getComponent<PoolConfig>(node, 'ai.pool-service');
  if (declared === undefined)
    throw new KernelError('INVALID', 'Agent service configuration is absent');
  const config = declared;
  const lane = session.lane[Symbol.asyncIterator]();
  const welcome = await lane.next();
  if (welcome.done || welcome.value.t !== 'welcome')
    throw new KernelError('UNAVAILABLE', 'Agent service did not open');
  let intake = welcome.value.intake;
  let stopping = false;
  let requested = false;
  let scheduling: Promise<void> | undefined;
  let initialized = false;
  let conflicts = 0;
  const running = new Map<string, Promise<void>>();
  const divisions = new Map<string, SubId>();
  const subs = [
    session.sub({ children: config.tasksPath }),
    session.sub({ node: config.poolPath }),
    session.sub({ children: config.poolPath }),
    session.sub({ children: config.workersPath }),
    session.sub({ children: config.orgPath }),
    session.sub({ children: config.branchesPath }),
  ];
  let fail = (_error: unknown) => {};
  const failure = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  void failure.catch(() => {});

  /** Uses the delivered intake for every new operation; model continuations keep their accepted keys. */
  function act(action: string, args: unknown) {
    return session.act({
      path: node.$path,
      action,
      args,
      opId: { epoch: intake, time: Date.now(), nonce: randomUUID() },
    });
  }

  /** Watches the actual Org divisions so composed posts wake the same scheduler as standalone agents. */
  async function watchDivisions(): Promise<void> {
    const selected = new Set<string>();
    const root = await optionalPoolNode(session, config.orgPath);
    for (const division of root === undefined ? [] : await poolChildren(session, config.orgPath)) {
      if (division.$type !== 'org.division') continue;
      selected.add(division.$path);
      if (!divisions.has(division.$path))
        divisions.set(division.$path, session.sub({ children: division.$path }));
    }
    for (const [path, sub] of divisions)
      if (!selected.has(path)) {
        session.unsub(sub);
        divisions.delete(path);
      }
  }

  /** Waits for the atomic claim, while continuing to drain the worker's streamed pieces. */
  function launch(job: ReturnType<typeof jobInput.parse>): Promise<void> {
    const pending = act('run', job);
    let started = () => {};
    let refused = (_error: unknown) => {};
    const ready = new Promise<void>((resolve, reject) => {
      started = resolve;
      refused = reject;
    });
    void ready.catch(() => {});
    const chunks = (async () => {
      for await (const _piece of pending.chunks) started();
    })();
    const done = Promise.all([chunks, pending.outcome]).then(() => {
      started();
    });
    running.set(job.agentPath, done);
    void done.then(
      () => {
        running.delete(job.agentPath);
        request();
      },
      (error) => {
        running.delete(job.agentPath);
        refused(error);
        if (
          stopping &&
          error instanceof KernelError &&
          (error.code === 'CANCELLED' || error.code === 'UNAUTHENTICATED')
        )
          return;
        if (error instanceof KernelError && error.code === 'CONFLICT') {
          request();
          return;
        }
        fail(error);
      },
    );
    return ready;
  }

  /** Rescans delivered changes, records the visible queue, and claims only available slots. */
  async function schedule(): Promise<void> {
    while (requested && !stopping) {
      requested = false;
      if (!initialized) {
        await act('recover', {}).outcome;
        initialized = true;
      }
      await watchDivisions();
      await act('reviews', {}).outcome;
      const jobs = jobInput
        .array()
        .parse(await act('select', {}).outcome.then((outcome) => outcome.value));
      const pool = getComponent<AiPool>(await poolNode(session, config.poolPath), 'ai.pool');
      if (pool === undefined)
        throw new KernelError('INVALID', 'Agent service has no concurrency pool');
      const available = Math.max(0, pool.maxConcurrent - pool.active.length);
      await act('queue', { agents: jobs.slice(available).map((job) => job.agentPath) }).outcome;
      for (const job of jobs.slice(0, available)) {
        if (stopping) return;
        if (!running.has(job.agentPath)) {
          try {
            await launch(job);
          } catch (error) {
            if (!(error instanceof KernelError) || error.code !== 'CONFLICT') throw error;
          }
        }
      }
      conflicts = 0;
    }
  }

  /** Coalesces events without retaining an unbounded work queue. */
  function request(): void {
    requested = true;
    if (stopping || scheduling !== undefined) return;
    const pending = schedule();
    scheduling = pending;
    void pending.then(
      () => {
        if (scheduling === pending) scheduling = undefined;
        if (requested && !stopping) request();
      },
      (error) => {
        if (scheduling === pending) scheduling = undefined;
        // Grant changes during startup require a fresh admitted read, with bounded OCC retries.
        if (
          !stopping &&
          error instanceof KernelError &&
          error.code === 'CONFLICT' &&
          ++conflicts < 3
        ) {
          request();
          return;
        }
        if (
          !(
            stopping &&
            error instanceof KernelError &&
            (error.code === 'CANCELLED' || error.code === 'UNAUTHENTICATED')
          )
        )
          fail(error);
      },
    );
  }

  const pump = (async () => {
    try {
      for (;;) {
        const next = await lane.next();
        if (next.done) {
          if (!stopping) throw new KernelError('CANCELLED', 'Agent service lane ended');
          return;
        }
        const frame = next.value;
        if ((frame.t === 'fail' && frame.req === undefined) || frame.t === 'end') throw frame.error;
        if (frame.t === 'pos' && frame.coverage !== true && frame.intake !== undefined)
          intake = frame.intake;
        if (frame.t === 'snap' || (frame.t === 'pos' && frame.changes.length > 0)) request();
      }
    } finally {
      stopping = true;
    }
  })();
  request();
  const done = Promise.race([pump, failure]);
  return {
    done,
    async stop() {
      stopping = true;
      for (const sub of [...subs, ...divisions.values()]) session.unsub(sub);
      await Promise.all([
        pump,
        ...(scheduling === undefined ? [] : [scheduling]),
        ...running.values(),
      ]);
    },
  };
};
