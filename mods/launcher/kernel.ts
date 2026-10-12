import { z } from 'zod';
import { KernelError } from '@treenx/core/errors';
import type { NativeModuleDeployment } from '@treenx/core/kernel/manifest';
import type { WriteAction, ModuleManifest } from '@treenx/core/kernel/types';
import { nativeSeed } from '#prefab/seed';
import { appendLauncherItem, removeLauncherItem } from '#launcher/layout';
import { launcherSeed } from '#launcher/seed-data';
import schema from './schemas/launcher.json';

interface LauncherState {
  columns: number;
  layout: string;
}
const segment = z
  .string()
  .min(1)
  .regex(/^[^/]+$/)
  .refine((value) => value !== '.' && value !== '..');
const addInput = z.object({
  path: z.string().trim().min(1).startsWith('/'),
  id: segment.optional(),
});
const removeInput = z.object({ id: segment });
const layoutInput = z.object({ layout: z.string().min(1) });

const actions: Readonly<Record<string, WriteAction>> = {
  addApp: {
    kind: 'write',
    args: schema.methods.addApp.arguments[0],
    async handler(this: LauncherState, ctx, args) {
      const input = addInput.parse(args);
      const id = input.id ?? input.path.split('/').at(-1);
      if (id === undefined || id === '')
        throw new KernelError('INVALID', 'A root shortcut requires an id');
      segment.parse(id);

      ctx.change.put({ $path: `${ctx.node.$path}/${id}`, $type: 't.ref', $ref: input.path });
      this.layout = appendLauncherItem(this.layout, this.columns, id);
    },
  },
  removeApp: {
    kind: 'write',
    args: schema.methods.removeApp.arguments[0],
    async handler(this: LauncherState, ctx, args) {
      const { id } = removeInput.parse(args);
      ctx.change.remove(`${ctx.node.$path}/${id}`);
      this.layout = removeLauncherItem(this.layout, id);
    },
  },
  updateLayout: {
    kind: 'write',
    args: schema.methods.updateLayout.arguments[0],
    async handler(this: LauncherState, _ctx, args) {
      this.layout = layoutInput.parse(args).layout;
    },
  },
};

const manifest: ModuleManifest = {
  id: '@treenx/mods/launcher',
  security: [],
  open: [],
  types: [
    {
      name: 't.launcher',
      module: '@treenx/mods/launcher',
      security: 'ordinary',
      version: 0,
      schema: {
        ...schema,
        $id: 't.launcher',
        type: 'object',
        methods: Object.fromEntries(
          Object.entries(schema.methods).map(([name, method]) => [
            name,
            { ...method, kind: 'write' },
          ]),
        ),
      },
      actions,
    },
  ],
};

/** Publish the existing home screen with atomic shortcut and layout mutations. */
export default function createNativeLauncher(): NativeModuleDeployment {
  return { manifest, seeds: nativeSeed('launcher', launcherSeed) };
}
