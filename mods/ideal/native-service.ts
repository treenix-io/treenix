import { randomUUID } from 'node:crypto';
import { getComponent } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import type { ChangeMember, Node, NodeInput, OpId, Selector, ServiceRun, Session } from '@treenx/core/kernel';
import type { IdeasBoard } from './types';

/** Watches eligible ideas and commits their approval against the exact child selection read. */
export async function nativeIdealService(node: Node, session: Session): Promise<ServiceRun> {
  const board = getComponent<IdeasBoard>(node, 'ideal.board');
  if (board === undefined) throw new KernelError('INVALID', 'Ideal service node has no board component');
  const selector = {
    children: node.$path,
    where: { $type: 'ideal.idea', status: 'new', votes: { $gte: board.autoApproveThreshold } },
  } satisfies Selector;
  const sub = session.sub(selector);
  let intake: string | undefined;
  let stopping = false;
  let requested = false;
  let initialReconciliation = false;
  let work: Promise<void> | undefined;
  let readyResolve = () => {};
  let readyReject = (_error: unknown) => {};
  let failService = (_error: unknown) => {};
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const failure = new Promise<never>((_resolve, reject) => {
    failService = reject;
  });
  void failure.catch(() => {});

  /** Reads the current matching set and commits it against that exact selector version. */
  async function approveEligible(): Promise<void> {
    const selected = await session.read(selector);
    if (selected.copies.length === 0) return;

    const changes = selected.copies.map((copy): ChangeMember => {
      if ('error' in copy) throw copy.error;
      const { $id: _id, $rev: _rev, ...authored } = copy.node;
      const node: NodeInput = { ...authored, status: 'approved' };
      return { op: 'put', node };
    });

    if (intake === undefined) throw new KernelError('INVALID', 'Service has no current mutation intake');
    const opId: OpId = { epoch: intake, time: Date.now(), nonce: randomUUID() };
    try {
      await session.commit({ changes, expect: { selectors: [{ selector, at: selected.at }] }, opId }).outcome;
    } catch (error) {
      if (error instanceof KernelError && error.code === 'CONFLICT') return;
      throw error;
    }
  }

  /** Serializes coalesced reconciliation requests while the lane pump keeps draining. */
  async function reconcileRequested(): Promise<void> {
    while (requested && !stopping) {
      requested = false;
      await approveEligible();
      if (!initialReconciliation) {
        initialReconciliation = true;
        readyResolve();
      }
    }
  }

  /** Starts at most one worker and restarts it if an event arrived during its final pass. */
  function requestReconciliation(): void {
    requested = true;
    if (work !== undefined || stopping) return;

    const task = reconcileRequested();
    work = task;
    void task.then(
      () => {
        if (work === task) work = undefined;
        if (requested && !stopping) requestReconciliation();
      },
      error => {
        if (work === task) work = undefined;
        readyReject(error);
        failService(error);
      },
    );
  }

  const pump = (async () => {
    try {
      for await (const frame of session.lane) {
        if (frame.t === 'welcome') intake = frame.intake;
        if (frame.t === 'pos' && frame.coverage !== true && frame.intake !== undefined) intake = frame.intake;
        if (frame.t === 'end' && frame.sub === sub) throw frame.error;
        if (frame.t === 'snap' && frame.sub === sub) {
          requestReconciliation();
        } else if (frame.t === 'pos' && frame.coverage !== true && frame.changes.length > 0) {
          requestReconciliation();
        }
      }
      if (!stopping) throw new KernelError('CANCELLED', 'Ideal service lane ended');
    } catch (error) {
      readyReject(error);
      failService(error);
      throw error;
    }
  })();
  const done = Promise.race([pump, failure]);
  void done.catch(readyReject);

  try {
    await ready;
  } catch (error) {
    stopping = true;
    throw error;
  }

  return {
    done,
    async stop() {
      stopping = true;
      const [pumpResult, workResult] = await Promise.allSettled([pump, work ?? Promise.resolve()]);
      if (pumpResult.status === 'rejected') throw pumpResult.reason;
      if (workResult.status === 'rejected') throw workResult.reason;
    },
  };
}
