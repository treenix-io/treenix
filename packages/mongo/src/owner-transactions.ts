import { Binary, Long, type ClientSession, type CommandStartedEvent, type MongoClient } from 'mongodb';
import { KernelError } from '@treenx/core/errors';

export interface OwnedTransaction {
  readonly session: Binary;
  readonly number: Long;
}

/** Preserve the exact BSON session subtype and signed transaction number on the wire. */
export function transactionKey(transaction: OwnedTransaction): string {
  const session = transaction.session;
  return `${session.sub_type}:${Buffer.from(session.buffer.subarray(0, session.position)).toString('base64')}:${transaction.number.toString()}`;
}

/** Decode third-party wire metadata loudly before it becomes owner recognition data. */
export function wireTransaction(session: unknown, number: unknown): OwnedTransaction {
  if (session === null || typeof session !== 'object' || !('id' in session)
    || !(session.id instanceof Binary) || !(number instanceof Long))
    throw new KernelError('INVALID', 'Malformed Mongo transaction identity');
  return { session: session.id, number };
}

/** Observe only registered owner sessions; retries obtain their identity from actual commands. */
export function createOwnedTransactions(client: MongoClient) {
  const sessions = new Map<string, { current?: OwnedTransaction }>();

  /** A command is recognized before the driver delivers it to the server. */
  function started(event: CommandStartedEvent): void {
    if (event.command.autocommit !== false) return;
    const transaction = wireTransaction(event.command.lsid, event.command.txnNumber);
    const key = transactionKey({ session: transaction.session, number: Long.ZERO });
    const owned = sessions.get(key);
    if (owned !== undefined) owned.current = transaction;
  }
  client.on('commandStarted', started);

  return {
    /** Register before starting a transaction, including every driver retry attempt. */
    register(session: ClientSession) {
      const identity = session.id;
      if (identity === undefined) throw new KernelError('INVALID', 'Mongo session has no identity');
      const key = transactionKey(wireTransaction(identity, Long.ZERO));
      if (sessions.has(key)) throw new KernelError('INVALID', 'Mongo owner session is already registered');
      const owned: { current?: OwnedTransaction } = {};
      sessions.set(key, owned);
      return {
        /** Return the observed attempt only after its first actual transactional command. */
        current(): OwnedTransaction {
          if (owned.current === undefined) throw new KernelError('INVALID', 'Mongo transaction has no observed command');
          return owned.current;
        },
        close(): void { sessions.delete(key); },
      };
    },
    /** Pending recognition covers events delivered before the commit promise settles. */
    pending(transaction: OwnedTransaction): boolean {
      const key = transactionKey({ session: transaction.session, number: Long.ZERO });
      const owned = sessions.get(key)?.current;
      return owned !== undefined && transactionKey(owned) === transactionKey(transaction);
    },
    close(): void {
      client.off('commandStarted', started);
      sessions.clear();
    },
  };
}
