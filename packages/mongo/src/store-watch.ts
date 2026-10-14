import { randomUUID } from 'node:crypto';
import { KernelError } from '@treenx/core/errors';
import { assertSafePath } from '@treenx/core';
import type { Budget, ExternalReporter, Path } from '@treenx/core/kernel/types';
import type {
  ChangeStream,
  CommandStartedEvent,
  CommandSucceededEvent,
  Document,
  MongoClient,
} from 'mongodb';
import { MongoServerError } from 'mongodb';
import { wireTransaction, type OwnedTransaction } from '#owner-transactions';
import { locatorKey, type PhysicalLocator } from '#store-locator';
import type { JournalReadLedger } from '#journal-units';

export interface MongoWatchHooks {
  readonly client: MongoClient;
  readonly database: string;
  readonly collection: string;
  readonly logicalBase: string;
  readonly epoch: string;
  readonly physicalLimit: number;
  owns(transaction: OwnedTransaction, budget: Budget): Promise<boolean>;
  locator(key: string, ledger: JournalReadLedger): Promise<PhysicalLocator | null>;
  checkpoint(budget: Budget): Promise<Document | undefined>;
  acknowledge(token: Document, transaction?: OwnedTransaction): Promise<void>;
  forget(): Promise<void>;
  start(resuming: boolean): Promise<(established: boolean) => Promise<void>>;
  pin(): () => Promise<void>;
}

interface WatchImage extends Document {
  readonly _id: unknown;
  readonly operationType: unknown;
  readonly documentKey: unknown;
  readonly fullDocument: unknown;
  readonly lsid?: unknown;
  readonly txnNumber?: unknown;
}

type WatchResult = { readonly event: WatchImage } | { readonly error: unknown };

/** Retain a buffered cursor failure until the ordered consumer can handle it. */
function observeNext(stream: ChangeStream<Document, WatchImage>): Promise<WatchResult> {
  return stream.next().then(
    (event) => ({ event }),
    (error) => ({ error }),
  );
}

export interface ReportedDocument {
  readonly path: Path;
  readonly id: string;
  readonly documentKey: Readonly<Record<string, unknown>>;
}

/** Decode generated resume metadata at the driver boundary without changing its BSON fields. */
function token(value: unknown): Document {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new KernelError('INVALID', 'Malformed Mongo change-stream resume token');
  return { ...value };
}

/** Keep physical node payloads out of the observed event and reject oversized metadata on the server. */
function watchProjection(limit: number): Document[] {
  const image = {
    _id: '$_id',
    operationType: '$operationType',
    documentKey: '$documentKey',
    lsid: '$lsid',
    txnNumber: '$txnNumber',
    fullDocument: {
      $cond: [
        { $eq: [{ $type: '$fullDocument' }, 'object'] },
        { _path: '$fullDocument._path', _tid: '$fullDocument._tid', _type: '$fullDocument._type' },
        null,
      ],
    },
  };
  return [
    { $replaceWith: { $cond: [{ $lte: [{ $bsonSize: image }, limit] }, image, '$operationType'] } },
  ];
}

/** Observe one native collection with a single buffered event and an exact startup command fence. */
export function createMongoReporter(
  hooks: MongoWatchHooks,
  report: (document: ReportedDocument) => void,
  signal?: AbortSignal,
): ExternalReporter {
  const release = hooks.pin();
  const comment = randomUUID();
  let resolveReady: () => void = () => {};
  let rejectReady: (error: unknown) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let request: number | undefined;
  let resolveAggregate: () => void = () => {};
  let stream: ChangeStream<Document, WatchImage> | undefined;
  let closing: Promise<void> | undefined;

  /** Bind readiness to this watch's exact public aggregate request. */
  function started(event: CommandStartedEvent): void {
    if (
      event.commandName === 'aggregate' &&
      event.databaseName === hooks.database &&
      event.command.aggregate === hooks.collection &&
      event.command.comment === comment
    )
      request = event.requestId;
  }

  /** Preserve firstBatch events while permitting initial kernel reconciliation to begin. */
  function succeeded(event: CommandSucceededEvent): void {
    if (event.commandName === 'aggregate' && event.requestId === request) resolveAggregate();
  }

  /** Close only this owned observation cursor and release its target pin once. */
  function close(): Promise<void> {
    if (closing !== undefined) return closing;
    hooks.client.off('commandStarted', started);
    hooks.client.off('commandSucceeded', succeeded);
    signal?.removeEventListener('abort', aborted);
    closing = Promise.resolve()
      .then(async () => {
        await stream?.close();
      })
      .finally(release);
    return closing;
  }

  /** Abort startup promptly while the actual cursor close owns subsequent cleanup. */
  function aborted(): void {
    rejectReady(signal?.reason);
    void close().catch((error) => console.error(error));
  }

  hooks.client.on('commandStarted', started);
  hooks.client.on('commandSucceeded', succeeded);
  signal?.addEventListener('abort', aborted, { once: true });

  /** Start observation before returning the reporter, leaving all event delivery ordered by its consumer. */
  async function begin(fresh = false) {
    signal?.throwIfAborted();
    const budget = {
      nodes: 1,
      bytes: Number.MAX_SAFE_INTEGER,
      exprWork: Number.MAX_SAFE_INTEGER,
      deadline: Date.now() + 5000,
    };
    const resumeAfter = fresh ? undefined : await hooks.checkpoint(budget);
    const finish = await hooks.start(resumeAfter !== undefined);
    let established = false;
    try {
      const aggregate = new Promise<void>((resolve) => {
        resolveAggregate = resolve;
      });
      const opened = hooks.client
        .db(hooks.database)
        .collection(hooks.collection)
        .watch<Document, WatchImage>(watchProjection(hooks.physicalLimit), {
          fullDocument: 'updateLookup',
          batchSize: 1,
          comment,
          promoteValues: false,
          ...(resumeAfter === undefined ? {} : { resumeAfter }),
        });
      stream = opened;
      signal?.throwIfAborted();
      const first = observeNext(opened);
      await Promise.race([
        aggregate,
        first.then((result) => {
          if ('error' in result) throw result.error;
          return aggregate;
        }),
      ]);
      signal?.throwIfAborted();
      established = true;
      return { opened, first };
    } finally {
      await finish(established);
    }
  }

  /** Reestablish observation before requesting bounded current-state recovery after oplog loss. */
  async function recoverObservation() {
    await stream?.close();
    await hooks.forget();
    return begin(true);
  }

  let startupReset = false;
  const beginning = begin().catch(async (error) => {
    if (!(error instanceof MongoServerError) || error.codeName !== 'ChangeStreamHistoryLost')
      throw error;
    console.error(error);
    startupReset = true;
    return recoverObservation();
  });
  /** Failed startup always retires its pin even if the consumer never enters iteration. */
  function failed(error: unknown): void {
    rejectReady(error);
    void close().catch((cleanupError) => console.error(cleanupError));
  }
  void beginning.then(resolveReady, failed);

  return {
    ready,
    async *[Symbol.asyncIterator]() {
      try {
        let { opened, first } = await beginning;
        let next = first;
        if (startupReset) yield { t: 'reset', epoch: hooks.epoch };
        for (;;) {
          signal?.throwIfAborted();
          let event: WatchImage;
          try {
            const result = await next;
            if ('error' in result) throw result.error;
            event = result.event;
          } catch (error) {
            if (signal?.aborted) throw signal.reason;
            if (
              !(error instanceof MongoServerError) ||
              error.codeName !== 'ChangeStreamHistoryLost'
            )
              throw error;
            console.error(error);
            ({ opened, first } = await recoverObservation());
            next = first;
            yield { t: 'reset', epoch: hooks.epoch };
            continue;
          }
          const resume = token(event._id);
          const budget = {
            nodes: 1,
            bytes: Number.MAX_SAFE_INTEGER,
            exprWork: Number.MAX_SAFE_INTEGER,
            deadline: Date.now() + 5000,
          };
          const transaction =
            event.lsid === undefined && event.txnNumber === undefined
              ? undefined
              : wireTransaction(event.lsid, event.txnNumber);
          if (transaction !== undefined && (await hooks.owns(transaction, budget))) {
            await hooks.acknowledge(resume, transaction);
            signal?.throwIfAborted();
            next = observeNext(opened);
            continue;
          }
          if (
            event.operationType === 'invalidate' ||
            event.operationType === 'drop' ||
            event.operationType === 'rename'
          ) {
            ({ opened, first } = await recoverObservation());
            next = first;
            yield { t: 'reset', epoch: hooks.epoch };
            continue;
          }
          if (
            event.operationType !== 'insert' &&
            event.operationType !== 'replace' &&
            event.operationType !== 'update' &&
            event.operationType !== 'delete'
          )
            throw new KernelError('INVALID', 'Unexpected Mongo change-stream operation');
          const key = token(event.documentKey);
          const ledger = {
            budget,
            physicalLimit: hooks.physicalLimit,
            physicalBytes: 0,
            logicalBytes: 0,
          };
          const prior = await hooks.locator(
            locatorKey(hooks.database, hooks.collection, key),
            ledger,
          );
          let path: string, id: string;
          const current: unknown = event.fullDocument;
          if (current === null) {
            if (prior === null)
              throw new KernelError(
                'UNAVAILABLE',
                'Mongo deleted document has no accepted locator',
              );
            path = prior.path;
            id = prior.id;
          } else {
            if (
              typeof current !== 'object' ||
              !('_path' in current) ||
              typeof current._path !== 'string' ||
              !('_tid' in current) ||
              typeof current._tid !== 'string' ||
              current._tid.length === 0
            )
              throw new KernelError('INVALID', 'Malformed Mongo external identity');
            assertSafePath(current._path);
            path =
              hooks.logicalBase === '/'
                ? current._path
                : current._path === '/'
                  ? hooks.logicalBase
                  : `${hooks.logicalBase}${current._path}`;
            id = current._tid;
            if (
              !('_type' in current) ||
              typeof current._type !== 'string' ||
              current._type.length === 0
            )
              throw new KernelError('INVALID', 'Malformed Mongo external type');
            if (
              prior !== null &&
              (prior.path !== path || prior.id !== id || prior.type !== current._type)
            )
              throw new KernelError(
                'INVALID',
                'Mongo external edit changes accepted document identity',
              );
          }
          report({ path, id, documentKey: key });
          yield [path];
          await hooks.acknowledge(resume);
          signal?.throwIfAborted();
          next = observeNext(opened);
        }
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw error;
      } finally {
        await close();
      }
    },
  };
}
