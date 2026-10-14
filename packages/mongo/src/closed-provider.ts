import { isDeepStrictEqual } from 'node:util';
import { KernelError } from '@treenx/core/errors';
import type { OpenedStoreMountTarget, Session } from '@treenx/core/kernel/types';
import {
  openMongoTransactionOwner,
  type MongoOwnerOptions,
  type MongoTransactionOwner,
} from '#owner';
import type { MongoHandleOptions } from '#store';

export interface MongoClosedBinding extends Omit<MongoOwnerOptions, 'uri'> {
  readonly connection: string;
}

interface ConnectionImage {
  readonly id: string;
  readonly rev: string;
  readonly ver: string;
  readonly uri: string;
}

interface Generation {
  readonly image: ConnectionImage;
  readonly binding: MongoClosedBinding;
  readonly owner: Promise<MongoTransactionOwner>;
  refs: number;
  invalid: boolean;
}

/** Reads the closed connection through each declaring node's admitted Session. */
async function connectionImage(session: Session, path: string): Promise<ConnectionImage> {
  const result = await session.read({ node: path });
  const copy = result.copies.find((copy) =>
    'node' in copy ? copy.node.$path === path : copy.path === path,
  );
  if (copy === undefined) throw new KernelError('NOT_FOUND', 'Mongo connection is unavailable');
  if (!('node' in copy)) throw copy.error;
  const node = copy.node;
  if (node.$type !== 't.mongo.connection' || typeof node.uri !== 'string' || node.uri.length === 0)
    throw new KernelError('INVALID', 'Malformed closed Mongo connection');
  return { id: node.$id, rev: node.$rev, ver: copy.ver, uri: node.uri };
}

/** Shares physical transaction ownership while each sibling proves its own credential admission. */
export function createMongoClosedProvider() {
  const generations = new Map<string, Generation>();

  async function open(
    cluster: string,
    binding: MongoClosedBinding,
    session: Session,
    options: MongoHandleOptions,
  ): Promise<OpenedStoreMountTarget> {
    let declaringSession = session;
    const image = await connectionImage(declaringSession, binding.connection);
    let generation = generations.get(cluster);
    if (
      generation !== undefined &&
      (generation.binding.connection !== binding.connection ||
        generation.binding.instance !== binding.instance ||
        generation.binding.domain !== binding.domain ||
        generation.binding.journalDb !== binding.journalDb ||
        generation.binding.journalCollection !== binding.journalCollection ||
        generation.binding.journalReadBsonBytes !== binding.journalReadBsonBytes ||
        generation.binding.journalUpgradeMs !== binding.journalUpgradeMs)
    )
      throw new KernelError('CONFLICT', 'Mongo cluster ownership binding changed');
    if (
      generation === undefined ||
      generation.invalid ||
      generation.image.id !== image.id ||
      generation.image.rev !== image.rev ||
      generation.image.ver !== image.ver
    ) {
      if (generation !== undefined) generation.invalid = true;
      generation = {
        image,
        binding: { ...binding },
        refs: 0,
        invalid: false,
        owner: openMongoTransactionOwner({ ...binding, uri: image.uri }),
      };
      generations.set(cluster, generation);
    }
    const captured = generation;
    captured.refs++;
    let released = false;
    let stopObservation: (() => void) | undefined;
    let store: Awaited<ReturnType<MongoTransactionOwner['openCollection']>> | undefined;

    function validate(): void {
      if (released || captured.invalid)
        throw new KernelError('UNAUTHENTICATED', 'Mongo connection generation retired');
    }

    async function check(): Promise<void> {
      validate();
      const current = await connectionImage(declaringSession, binding.connection);
      if (current.id !== image.id || current.rev !== image.rev || current.ver !== image.ver)
        throw new KernelError('UNAUTHENTICATED', 'Mongo connection generation changed');
      if (released || captured.invalid)
        throw new KernelError('UNAUTHENTICATED', 'Mongo connection generation retired');
    }

    async function close(): Promise<void> {
      if (released) return;
      released = true;
      stopObservation?.();
      try {
        await store?.close();
      } finally {
        captured.refs--;
        if (captured.refs === 0) {
          if (generations.get(cluster) === captured) generations.delete(cluster);
          await (await captured.owner).close();
        }
      }
    }

    try {
      const owner = await captured.owner;
      await check();
      store = await owner.openCollection(options);
      await check();
      return {
        kind: 'store',
        store,
        resources: owner.resources,
        close,
        credentialDependency: {
          path: binding.connection,
          check,
          validate,
          rebind(next) {
            validate();
            if (!isDeepStrictEqual(next.actor, declaringSession.actor))
              throw new KernelError('CONFLICT', 'Prepared Mongo executor admission changed');
            declaringSession = next;
          },
          invalidate() {
            captured.invalid = true;
          },
          ownObservation(stop) {
            if (released) {
              stop();
              return;
            }
            stopObservation?.();
            stopObservation = stop;
          },
        },
      };
    } catch (error) {
      await close();
      throw error;
    }
  }

  return { open };
}
