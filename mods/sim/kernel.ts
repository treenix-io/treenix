import { registerType } from '@treenx/core/comp';
import { R, W, type ActionDef, type TypeDef } from '@treenx/core/kernel/types';
import type { NativeModuleDeployment, NativeModuleHost } from '@treenx/core/kernel/manifest';
import type { TypeSchema } from '@treenx/core/schema/types';
import { nativeSeed } from '@treenx/core/mod/native-prefab';
import { runPeriodicAction } from '@treenx/core/kernel/periodic-service';
import { worldActions, agentActions, itemActions } from './native-actions';
import { createSimIo } from './native-io';
import { part } from './native-data';
import { SimConfig } from './types';
import { simSeed } from './seed-data';
import schema0 from './schemas/sim.agent.json' with { type: 'json' };
import schema1 from './schemas/sim.ai.json' with { type: 'json' };
import schema2 from './schemas/sim.config.json' with { type: 'json' };
import schema3 from './schemas/sim.descriptive.json' with { type: 'json' };
import schema4 from './schemas/sim.events.json' with { type: 'json' };
import schema5 from './schemas/sim.item.json' with { type: 'json' };
import schema6 from './schemas/sim.memory.json' with { type: 'json' };
import schema7 from './schemas/sim.nearby.json' with { type: 'json' };
import schema8 from './schemas/sim.position.json' with { type: 'json' };
import schema9 from './schemas/sim.round.json' with { type: 'json' };
import schema10 from './schemas/sim.world.json' with { type: 'json' };

const owner = '@treenx/mods/sim';
/** Immutable service configuration keeps maintenance ownership off the public world. */
class SimService {
  worldPath = '/sim/world';
}
registerType('sim.service', SimService);
const schemas: readonly TypeSchema[] = [
  { ...schema0, type: 'object' },
  { ...schema1, type: 'object' },
  { ...schema2, type: 'object' },
  { ...schema3, type: 'object' },
  { ...schema4, type: 'object' },
  { ...schema5, type: 'object' },
  { ...schema6, type: 'object' },
  { ...schema7, type: 'object' },
  { ...schema8, type: 'object' },
  { ...schema9, type: 'object' },
  { ...schema10, type: 'object' },
];

/** Publish the existing simulation types and UI actions with a separate round service. */
export default function createNativeSim(host: NativeModuleHost = {}): NativeModuleDeployment {
  const actionsByType: Record<string, Record<string, ActionDef>> = {
    'sim.world': worldActions,
    'sim.agent': agentActions,
    'sim.item': itemActions,
  };
  const types: TypeDef[] = schemas.map((schema) => {
    const actions = actionsByType[schema.$id!] ?? {};
    return {
      name: schema.$id!,
      module: owner,
      security: 'ordinary',
      version: 0,
      schema: {
        ...schema,
        methods: Object.fromEntries(
          Object.entries(actions).map(([name, action]) => [
            name,
            {
              ...schema.methods?.[name],
              kind: action.kind,
              arguments: [{ name: 'data', ...action.args }],
              ...(name === 'round' ? { streaming: true, io: true } : {}),
            },
          ]),
        ),
      },
      actions,
    };
  });
  types.push({
    name: 'sim.service',
    module: owner,
    security: 'user-capability',
    version: 0,
    actionsOnly: true,
    schema: {
      type: 'object',
      properties: { worldPath: { type: 'string' } },
      required: ['worldPath'],
    },
    actions: {},
  });
  return {
    io: createSimIo(host.sim?.provider),
    manifest: {
      id: owner,
      types,
      open: [],
      security: [
        {
          type: 'sim.service',
          context: 'service',
          handler: (node, session) => {
            const { worldPath } = part(node, SimService);
            return runPeriodicAction(session, {
              path: worldPath,
              action: 'round',
              immediate: true,
              enabled: (world) => part(world, SimConfig).running,
              interval: (world) => part(world, SimConfig).roundDelay,
            });
          },
        },
      ],
    },
    seeds: nativeSeed(
      'sim',
      [
        ...simSeed.map((node) =>
          node.$path === '/sys/autostart/sim' ? { ...node, $ref: '/sim/service' } : node,
        ),
        { $path: 'sim/service', $type: 'sim.service', worldPath: '/sim/world' },
      ],
      [{ $path: '/sys/autostart', $type: 't.autostart' }],
      [
        { executor: 'sim/service', target: 'sim/world', grant: R | W },
        { executor: 'sim/service', target: 'sim/service', grant: R },
        { executor: 'sim/service', target: '/sys/types', grant: R },
        { executor: '/sys/autostart', target: '/sys/autostart', grant: R },
        { executor: '/sys/autostart', target: 'sim/service', grant: R },
      ],
    ),
  };
}
