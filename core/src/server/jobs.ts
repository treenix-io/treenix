// startJob — detached long-run job context (core-gk8.5).
// Runs escape the action envelope: no path lock, no Immer draft, no 10s
// ACTION_TIMEOUT. All job state goes to tree nodes (run records) through
// normal writes/subscriptions — the record, not an awaiting caller, is the
// source of truth (the gk8.6 restart scanner depends on this).
// Identity-agnostic: the body closes over what it needs (tree, actor).

import { mutationLock } from './commit';
import { type KindFrame, runDetached } from './kind-stack';

export type JobInfo = { label: string; startedAt: number };
export type JobResult = { ok: boolean; error?: unknown };
export type JobHandle = { signal: AbortSignal; done: Promise<JobResult> };

const jobs = new Map<JobInfo, Promise<JobResult>>();

/** Spawn a detached job. Returns immediately; `done` NEVER rejects — nobody
 *  is required to await a detached job, so a rejection would be unhandled.
 *  Recording failure into the run node is the BODY's responsibility; the
 *  catch here is the last resort (loud log + {ok:false}).
 *  Constraint: job bodies must not call comp getCtx() — the class-method ALS
 *  is not cleared by runDetached, so a revoked caller draft could leak in. */
export function startJob(
  label: string,
  body: (signal: AbortSignal) => Promise<void>,
  opts?: { timeoutMs?: number },
): JobHandle {
  // env read per call, not at module load — tests and ops can override live
  const timeoutMs = opts?.timeoutMs ?? (Number(process.env.JOB_TIMEOUT) || 600_000);
  const signal = AbortSignal.timeout(timeoutMs);
  const frame: KindFrame = { kind: 'write', io: true, path: label, action: 'job' };

  const info: JobInfo = { label, startedAt: Date.now() };
  // Detachment resets BOTH ambient ALS: kind stack (runDetached) and the
  // mutation-lock held-path set (core-anz4.21) — else the job inherits the
  // spawner's held paths and re-enters a lock nobody holds.
  const done = runDetached(frame, () => mutationLock.detach(() => body(signal))).then(
    (): JobResult => ({ ok: true }),
    (error): JobResult => {
      console.error(`[job] ${label} failed:`, error);
      return { ok: false, error };
    },
  ).finally(() => { jobs.delete(info); });
  jobs.set(info, done);

  return { signal, done };
}

export function runningJobs(): JobInfo[] {
  return [...jobs.keys()];
}

/** Await every in-flight job (including ones spawned while draining).
 *  Mandatory in afterEach of suites that start jobs: AbortSignal.timeout is
 *  unref'd, so a forgotten job either dies silently with the process or — if
 *  it holds a ref'd timer — hangs the test runner. */
export async function drainJobs(): Promise<void> {
  while (jobs.size > 0) {
    await Promise.all([...jobs.values()]);
  }
}
