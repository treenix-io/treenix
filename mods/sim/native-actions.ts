import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getComponent } from '@treenx/core';
import type { ActionDef, WriteAction } from '@treenx/core/kernel/types';
import { patchPart } from './native-data';
import { SimAi, SimConfig, SimDescriptive, SimPosition, SimRound } from './types';
import { runRound } from './native-round';

const configInput = z.object({
  roundDelay: z.number().positive().optional(),
  model: z.string().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});
const moveInput = z.object({ x: z.number().finite(), y: z.number().finite() });
const updateInput = z.object({
  systemPrompt: z.string().optional(),
  radius: z.number().nonnegative().optional(),
  name: z.string().optional(),
  icon: z.string().optional(),
  description: z.string().optional(),
});
const entityInput = z.object({
  id: z
    .string()
    .regex(/^[^/]+$/)
    .optional(),
  type: z.string().default('sim.item'),
  name: z.string().optional(),
  icon: z.string().default('?'),
  description: z.string().default(''),
  x: z.number().finite().default(300),
  y: z.number().finite().default(200),
  radius: z.number().nonnegative().default(100),
  systemPrompt: z.string().optional(),
});

/** Keep start and stop as ordinary world mutations under the caller's permissions. */
function toggle(running: boolean): WriteAction {
  return {
    kind: 'write',
    args: {},
    async handler(ctx) {
      patchPart(ctx, ctx.node, SimConfig, { running });
      if (!running) patchPart(ctx, ctx.node, SimRound, { phase: 'idle' });
    },
  };
}

export const worldActions: Record<string, ActionDef> = {
  start: toggle(true),
  stop: toggle(false),
  'set-config': {
    kind: 'write',
    args: { type: 'object' },
    async handler(ctx, data) {
      patchPart(ctx, ctx.node, SimConfig, configInput.parse(data));
    },
  },
  'add-entity': {
    kind: 'write',
    args: { type: 'object' },
    async handler(ctx, data) {
      const input = entityInput.parse(data),
        id = input.id ?? `e-${randomUUID()}`,
        name = input.name ?? id;
      const node = {
        $path: `${ctx.node.$path}/${id}`,
        $type: input.type,
        '#descriptive': {
          $type: 'sim.descriptive',
          name,
          icon: input.icon,
          description: input.description,
        },
        '#position': { $type: 'sim.position', x: input.x, y: input.y, radius: input.radius },
        ...(input.type === 'sim.agent'
          ? {
              '#ai': { $type: 'sim.ai', systemPrompt: input.systemPrompt ?? `You are ${name}.` },
              '#memory': { $type: 'sim.memory', entries: [] },
              '#events': { $type: 'sim.events', entries: [] },
            }
          : {}),
      };
      ctx.change.put(node);
      return { path: node.$path };
    },
  },
  round: { kind: 'write', io: true, args: { type: 'object' }, handler: runRound },
};

export const agentActions: Record<string, ActionDef> = {
  move: {
    kind: 'write',
    args: { type: 'object' },
    async handler(ctx, data) {
      const input = moveInput.parse(data);
      patchPart(ctx, ctx.node, SimPosition, { x: Math.round(input.x), y: Math.round(input.y) });
    },
  },
  update: {
    kind: 'write',
    args: { type: 'object' },
    async handler(ctx, data) {
      const { systemPrompt, radius, ...description } = updateInput.parse(data);
      if (systemPrompt !== undefined) patchPart(ctx, ctx.node, SimAi, { systemPrompt });
      if (radius !== undefined) patchPart(ctx, ctx.node, SimPosition, { radius });
      if (Object.keys(description).length !== 0)
        patchPart(ctx, ctx.node, SimDescriptive, description);
    },
  },
};

export const itemActions: Record<string, ActionDef> = {
  examine: {
    kind: 'read',
    args: {},
    async handler(ctx) {
      return {
        description: getComponent(ctx.node, SimDescriptive)?.description ?? 'Nothing special.',
      };
    },
  },
  use: {
    kind: 'write',
    args: { type: 'object' },
    async handler(ctx, data) {
      const { how } = z.object({ how: z.string().default('') }).parse(data);
      return {
        result: `You used ${getComponent(ctx.node, SimDescriptive)?.name ?? 'item'}. ${how}`,
      };
    },
  },
};
