import { randomUUID } from 'node:crypto';
import { getComponent } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import { buildTypeDef } from '@treenx/core/kernel/typedef';
import { readAllChildren } from '@treenx/core/kernel/read-children';
import { runPeriodicAction } from '@treenx/core/kernel/periodic-service';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import type { WriteAction } from '@treenx/core/kernel/types';
import { SensorDemo, SensorReading } from './types';
import sensor from './schemas/examples.demo.sensor.json' with { type: 'json' };
import reading from './schemas/examples.demo.sensor.reading.json' with { type: 'json' };

const owner = '@treenx/mods/sensor-demo';
const tick: WriteAction = {
  kind: 'write',
  args: {},
  async handler(ctx) {
    const config = getComponent(ctx.node, SensorDemo);
    if (config === undefined) throw new KernelError('INVALID', 'Sensor component absent');
    const readings = await readAllChildren(ctx.read, {
      children: ctx.node.$path,
      where: { $type: 'examples.demo.sensor.reading' },
      sort: [['ts', 1]],
    });
    const seq =
      readings.length === 0
        ? 0
        : Math.max(
            ...readings.map((node) => {
              const reading = getComponent(node, SensorReading);
              if (reading === undefined)
                throw new KernelError('INVALID', 'Sensor reading component absent');
              return reading.seq;
            }),
          ) + 1;
    const ts = Date.now();
    const result = {
      $path: `${ctx.node.$path}/${ts}-${randomUUID()}`,
      $type: 'examples.demo.sensor.reading',
      ts,
      seq,
      value: +(config.baseValue + Math.sin(seq * 0.1) * 5 + Math.random() * 2).toFixed(1),
    };
    ctx.change.put(result);
    for (const old of readings.slice(0, Math.max(0, readings.length - 9)))
      ctx.change.remove(old.$path);
    return result;
  },
};

/** Publish the existing sensor types, base-setting action and node-owned live timer. */
export default function createNativeSensor(): NativeModuleDeployment {
  const sensorType = buildTypeDef(SensorDemo, {
    name: sensor.$id,
    module: owner,
    security: 'user-capability',
    schema: { ...sensor, type: 'object' },
  });
  return {
    manifest: {
      id: owner,
      open: [],
      types: [
        { ...sensorType, actions: { ...sensorType.actions, tick } },
        buildTypeDef(SensorReading, {
          name: reading.$id,
          module: owner,
          security: 'ordinary',
          schema: { ...reading, type: 'object' },
        }),
      ],
      security: [
        {
          type: sensor.$id,
          context: 'service',
          handler: (node, session) =>
            runPeriodicAction(session, {
              path: node.$path,
              action: 'tick',
              interval: () => 1000,
              enabled: () => true,
            }),
        },
      ],
    },
  };
}
