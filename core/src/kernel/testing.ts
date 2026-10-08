import { randomUUID } from 'node:crypto'
import { KernelError } from '#errors'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import { createInstance } from '#kernel/instance'
import { ambientModule, publishModules } from '#kernel/manifest'
import { previewModules } from '#kernel/module-install'
import { copyManifest, createRegistry } from '#kernel/registry'
import { drainSession } from '#kernel/session-delivery'
import { createMemoryStore } from '#kernel/store/memory'
import type { Position, PositionCounter, StreamCursor, TestActor, TestInstance, TestInstanceConfig } from '#kernel/types'

export { runStoreContract, scanBudget, position, storedNode, storeCommit } from '#kernel/store/contract'
export type { StoreContractOptions } from '#kernel/store/contract'

export interface NativeTestInstance<ActorName extends string = string>
  extends TestInstance<ActorName> {
  readonly initialCursor: StreamCursor;
  /** Close actor lanes and drain their pending deliveries. */
  close(): Promise<void>;
}

/** Owns a monotonic counter only for this ephemeral Store's lifetime; deployment counters stay durable. */
function testCounter(instance: string): PositionCounter {
  let saved: Position | undefined;
  let issuedEpoch = 0;
  return {
    /** Restore the position held by this in-memory test counter. */
    async load() {
      return saved === undefined ? undefined : { ...saved };
    },
    /** Save an accepted position for this test instance and writer. */
    async save(position, writerEpoch) {
      if (position.instance !== instance || writerEpoch !== 1)
        throw new KernelError('INVALID', 'Test counter identity differs');
      saved = { ...position };
    },
    /** Allocate a test epoch above the supplied durable floor. */
    async freshEpoch(floor) {
      issuedEpoch = Math.max(issuedEpoch, floor) + 1;
      return issuedEpoch;
    },
  };
}

/** Installs native modules and seeds as an admin, then opens actors through the production Session factory. */
export function createTestInstance<ActorName extends string>(
  input: TestInstanceConfig<ActorName>,
): Promise<NativeTestInstance<ActorName>>;
export async function createTestInstance(input: TestInstanceConfig): Promise<NativeTestInstance> {
  const ambient = ambientModule();
  publishModules(createRegistry(), [ambient]);
  const modules = [...input.modules, ambient].map(copyManifest);
  previewModules(modules);
  const seed = structuredClone(input.seed);
  const actorInputs = Object.entries(input.actors).map(
    ([name, actor]) =>
      [
        name,
        actor.kind === 'node'
          ? { kind: 'node' as const, node: actor.node }
          : {
              kind: 'credential' as const,
              origin: actor.origin,
              credential:
                actor.credential === undefined ? undefined : { token: actor.credential.token },
            },
      ] as const,
  );
  const id = `test:${randomUUID()}`;
  const root = createMemoryStore({ domain: id });
  const instance = await createInstance({
    id,
    root: { kind: 'store', store: root },
    provisioning: {
      writerEpoch: 1,
      counter: testCounter(id),
      domains: [{ store: root, epoch: randomUUID(), persistent: false }],
      credentialTtlMs: 60_000,
      bootstrap: { kind: 'fresh', admin: { path: '/auth/users/test-admin', name: 'test-admin', password: randomUUID() } },
    },
    blobs: createMemoryBlobStore(),
    modules,
  });
  const initialCursor = instance.bootstrapCursor;
  const deliveries: Promise<void>[] = [];
  const actors: Record<string, TestActor> = {};
  let closing: Promise<void> | undefined;

  /** Releases lanes before awaiting their pumps; setup failures use the same cleanup. */
  function close(): Promise<void> {
    if (closing !== undefined) return closing;
    closing = instance.close().then(() => Promise.all(deliveries)).then(() => undefined);
    return closing;
  }

  try {
    const credential = instance.setupCredential;
    if (credential === undefined)
      throw new KernelError('INVALID', 'Test bootstrap did not issue an admin credential');
    const admin = await instance.openSession(credential);
    const adminDelivery = drainSession(admin);
    try {
      const capacity = Math.floor(instance.limits().changeSet);
      if (seed.length > 0 && capacity < 1)
        throw new KernelError('BUDGET', 'Seed installation exceeds the commit limit');
      for (let offset = 0; offset < seed.length; offset += capacity) {
        await admin.commit({
          opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
          changes: seed.slice(offset, offset + capacity).map((node) => ({ op: 'put', node })),
        }).outcome;
      }
    } finally {
      admin.close();
      await adminDelivery;
    }
    for (const [name, input] of actorInputs) {
      const session =
        input.kind === 'node'
          ? await instance.openNodeSession(input.node)
          : await instance.openSession(input.credential, input.origin);
      deliveries.push(drainSession(session));
      actors[name] = session;
    }
    return { instance, actors: Object.freeze(actors), initialCursor, close };
  } catch (error) {
    await close();
    throw error;
  }
}
