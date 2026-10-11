import { KernelError } from '@treenx/core/errors';
import { componentEntries } from '@treenx/core/kernel/migrate';
import { A, R, W, type Session, type ComponentName, type ModuleManifest, type MountHandler, type Node, type OpenedStoreMountTarget } from '@treenx/core/kernel/types';
import type { MongoTransactionOwner } from '#owner';
import type { MongoHandleOptions } from '#store';
import type { IndexDescription } from 'mongodb';
import { createMongoClosedProvider, type MongoClosedBinding } from '#closed-provider';

/** Authored index declarations cross the schema boundary as unknown values. */
function declaredIndexes(value: unknown): readonly IndexDescription[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new KernelError('INVALID', 'Mongo indexes must be an array');
  const items: readonly unknown[] = value;
  return items.map(item => {
    if (item === null || typeof item !== 'object' || !('key' in item) || item.key === null || typeof item.key !== 'object')
      throw new KernelError('INVALID', 'Malformed Mongo index');
    const key: Record<string, 1 | -1> = {};
    for (const [field, direction] of Object.entries(item.key)) {
      if (direction !== 1 && direction !== -1) throw new KernelError('INVALID', 'Invalid Mongo index direction');
      key[field] = direction;
    }
    if (!('unique' in item)) return { key };
    const unique = item.unique;
    if (typeof unique !== 'boolean') throw new KernelError('INVALID', 'Invalid Mongo index uniqueness');
    return { key, unique };
  });
}

/** Target retirement releases its collection handle while sibling mounts keep their shared capability. */
export async function openMongoMountTarget(owner: MongoTransactionOwner,
  options: MongoHandleOptions): Promise<OpenedStoreMountTarget> {
  const store = await owner.openCollection(options);
  return { kind: 'store', store, resources: owner.resources, close: () => store.close() };
}

/** Host bindings supply authority; declarations select a collection without carrying credentials. */
export function createMongoManifest(bindings: Readonly<Record<string, MongoTransactionOwner | MongoClosedBinding>>): ModuleManifest {
  const closed = createMongoClosedProvider();

  /** Acquire one exact physical collection before its declaring Session is accepted. */
  async function prepare(node: Node, name: ComponentName, session?: Session): Promise<OpenedStoreMountTarget> {
    const component = componentEntries(node).find(([component]) => component === name);
    if (component === undefined || component[1].$type !== 't.mount.mongo')
      throw new KernelError('INVALID', 'Mongo mount declaration is missing');
    const { cluster, db, collection } = component[1];
    if (typeof cluster !== 'string' || typeof db !== 'string' || typeof collection !== 'string')
      throw new KernelError('INVALID', 'Malformed Mongo mount binding');
    if (!Object.hasOwn(bindings, cluster)) throw new KernelError('UNAVAILABLE', 'Mongo cluster capability is unavailable');
    const external = component[1].external;
    if (external !== undefined && external !== 'trusted') throw new KernelError('INVALID', 'Invalid Mongo external authority');
    const binding = bindings[cluster];
    const options: MongoHandleOptions = { db, collection, logicalBase: node.$path,
      indexes: declaredIndexes(component[1].indexes), ...(external === undefined ? {} : { external }) };
    if ('connection' in binding) {
      if (session === undefined) throw new KernelError('UNAVAILABLE', 'Closed Mongo connection requires its declaring Session');
      return closed.open(cluster, binding, session, options);
    }
    return openMongoMountTarget(binding, options);
  }

  return {
    id: 'mongo', open: [],
    types: [{ name: 't.mongo.connection', module: 'mongo', security: 'privileged-capability', version: 0, actions: {},
      schema: { type: 'object', additionalProperties: false, required: ['uri'], properties: { uri: { type: 'string', minLength: 1 } } } }, { name: 't.mount.mongo', module: 'mongo', security: 'privileged-capability', version: 0, actions: {},
      schema: { type: 'object', additionalProperties: false, required: ['pattern', 'cluster', 'db', 'collection'],
        properties: { pattern: { type: 'string' }, cluster: { type: 'string', minLength: 1 },
          db: { type: 'string', minLength: 1 }, collection: { type: 'string', minLength: 1 },
          external: { enum: ['trusted'] },
          indexes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key'],
            properties: { key: { type: 'object', minProperties: 1, additionalProperties: { enum: [1, -1] } },
              unique: { type: 'boolean' } } } } } } }],
    security: [{ type: 't.mongo.connection', context: 'acl',
      handler: input => input.admin ? R | W | A : input.actor.principal.startsWith('n:') ? input.principalGrant & R : 0 },
      { type: 't.mount.mongo', context: 'mount', handler: Object.assign(async (...[node, session, name]: Parameters<MountHandler>) => {
      if (session.actor.principal !== `n:${node.$id}`)
        throw new KernelError('FORBIDDEN', 'Mongo mount requires its declaring node session');
      return prepare(node, name, session);
    }, { prepare }) }],
  };
}
