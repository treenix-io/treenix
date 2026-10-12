import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { KernelError } from '@treenx/core/errors';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import { bindIo } from './native-io';
import schema from './schemas/examples.demo.generator.json' with { type: 'json' };

const input = z.object({
  count: z.number().int().nonnegative().default(10),
  delay: z.number().nonnegative().default(500),
});
const args = {
  type: 'object',
  properties: {
    count: { type: 'integer', minimum: 0, default: 10 },
    delay: { type: 'number', minimum: 0, default: 500 },
  },
};

/** Persist each scan piece with the existing reading owner before yielding it to the UI. */
export default function createNativeGenerator(): NativeModuleDeployment {
  const owner = '@treenx/mods/sensor-generator';
  return {
    io: bindIo,
    manifest: {
      id: owner,
      open: [],
      security: [],
      types: [
        {
          name: schema.$id,
          module: owner,
          security: 'ordinary',
          version: 0,
          schema: {
            ...schema,
            methods: {
              scan: {
                streaming: true,
                kind: 'write',
                io: true,
                arguments: [{ name: 'data', ...args }],
              },
            },
          },
          actions: {
            scan: {
              kind: 'write',
              io: true,
              args,
              async *handler(ctx, data) {
                const { count, delay } = input.parse(data);
                const io = ctx.io?.sensorGenerator;
                if (io === undefined)
                  throw new KernelError('UNAVAILABLE', 'Sensor scan IO is not bound');
                for (let seq = 0; seq < count; seq++) {
                  const ts = Date.now();
                  const node = {
                    $path: `${ctx.node.$path}/${ts}-${randomUUID()}`,
                    $type: 'examples.demo.sensor.reading',
                    ts,
                    seq,
                    value: +(20 + Math.sin(seq * 0.3) * 5 + Math.random() * 2).toFixed(1),
                  };
                  ctx.change.put(node);
                  yield node;
                  if (seq + 1 < count) await io.wait(delay);
                }
              },
            },
          },
        },
      ],
    },
  };
}
