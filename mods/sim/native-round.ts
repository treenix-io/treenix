import { getComponent } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import { readAllChildren } from '@treenx/core/kernel/read-children';
import type { Node, WriteActionContext } from '@treenx/core/kernel/types';
import { entityName, nearby, part, patchPart, readNode } from './native-data';
import type { SimThinkRequest } from './native-io';
import {
  SimAi,
  SimConfig,
  SimDescriptive,
  SimEvents,
  SimMemory,
  SimNearby,
  SimPosition,
  SimRound,
  type AgentEvent,
  type EventEntry,
} from './types';

/** Append an inbox event without changing the authored component key. */
function inbox(ctx: WriteActionContext, node: Node, event: AgentEvent): void {
  patchPart(ctx, node, SimEvents, {
    entries: [...part(node, SimEvents).entries, event].slice(-30),
  });
}

/** Include actual native action metadata in the model's environment. */
async function thinkRequest(
  ctx: WriteActionContext,
  agent: Node,
  entities: Node[],
  world: Node,
): Promise<SimThinkRequest> {
  const ai = part(agent, SimAi),
    position = part(agent, SimPosition),
    config = part(world, SimConfig);
  const neighbours = nearby(agent, entities);
  const descriptions = await Promise.all(
    [agent, ...neighbours].map(async (entity) => ({
      name: entityName(entity),
      type: entity.$type,
      position: part(entity, SimPosition),
      description: getComponent(entity, SimDescriptive)?.description ?? '',
      actions: await ctx.act({
        path: `/sys/types/${entity.$type}`,
        action: 'describe_type',
        args: {},
      }),
    })),
  );
  return {
    name: entityName(agent),
    model: ai.model ?? config.model ?? 'claude-haiku-4-5-20251001',
    width: config.width,
    height: config.height,
    nearby: neighbours.map((entity) => ({ name: entityName(entity), type: entity.$type })),
    system: `${ai.systemPrompt}
You are ${entityName(agent)} at (${position.x}, ${position.y}), hearing radius ${position.radius}.
Your capabilities and nearby entities: ${JSON.stringify(descriptions)}
Your memory: ${JSON.stringify(part(agent, SimMemory).entries.slice(-10))}
Recent events: ${JSON.stringify(part(agent, SimEvents).entries.slice(-15))}
Round ${part(world, SimRound).current}. Use speak, move, remember, or interact with nearby entities. Be concise. Stay in character.`,
  };
}

/** Run one caller-projected round, committing each tool before executing the next. */
export async function* runRound(
  ctx: WriteActionContext,
): AsyncGenerator<unknown, unknown, undefined> {
  const worldPath = ctx.node.$path;
  const initialRound = part(ctx.node, SimRound),
    config = part(ctx.node, SimConfig);
  if (!config.running) return { running: false };
  if (initialRound.phase !== 'idle')
    throw new KernelError('CONFLICT', 'Simulation round already running');
  const io = ctx.io?.sim;
  if (io === undefined) throw new KernelError('UNAVAILABLE', 'Simulation model IO is not bound');

  patchPart(ctx, ctx.node, SimRound, { phase: 'thinking' });
  yield { phase: 'thinking', round: initialRound.current };
  const entities = await readAllChildren(ctx.read, { children: worldPath });
  const agents = entities.filter((entity) => entity.$type === 'sim.agent');
  const world = await readNode(ctx.read, worldPath);
  const thoughts = await Promise.all(
    agents.map(async (agent) => ({
      path: agent.$path,
      tools: await io.think(await thinkRequest(ctx, agent, entities, world)),
    })),
  );

  // Release the thinking snapshot before tools or nested actions change its inputs.
  yield { phase: 'acting', round: initialRound.current };
  let interaction = 0;
  for (const thought of thoughts) {
    for (const tool of thought.tools) {
      const currentWorld = await readNode(ctx.read, worldPath);
      const currentConfig = part(currentWorld, SimConfig),
        round = part(currentWorld, SimRound);
      if (!currentConfig.running) throw new KernelError('CANCELLED', 'Simulation stopped');
      const agent = await readNode(ctx.read, thought.path),
        name = entityName(agent);
      const ts = Date.now();
      let entry: EventEntry | undefined;
      const logEntry = (action: string, data: Record<string, unknown>): EventEntry => ({
        round: round.current,
        agent: name,
        icon: getComponent(agent, SimDescriptive)?.icon ?? '',
        action,
        data,
        ts,
      });

      switch (tool.tool) {
        case 'speak': {
          const hearers = nearby(
            agent,
            await readAllChildren(ctx.read, { children: worldPath, where: { $type: 'sim.agent' } }),
          );
          for (const hearer of hearers)
            inbox(ctx, hearer, {
              round: round.current,
              from: name,
              ...(tool.to === undefined ? {} : { to: tool.to }),
              ts,
              type: tool.to === entityName(hearer) ? 'speak' : 'hear',
              data: { message: tool.message },
            });
          entry = {
            ...logEntry(tool.to === undefined ? 'speak' : `speak→${tool.to}`, {
              message: tool.message,
            }),
            heardBy: hearers.map(entityName),
          };
          break;
        }
        case 'move': {
          const position = {
            x: Math.max(0, Math.min(currentConfig.width, tool.x)),
            y: Math.max(0, Math.min(currentConfig.height, tool.y)),
          };
          patchPart(ctx, agent, SimPosition, position);
          entry = logEntry('move', position);
          break;
        }
        case 'remember':
          patchPart(ctx, agent, SimMemory, {
            entries: [...part(agent, SimMemory).entries, tool.text].slice(-20),
          });
          break;
        case 'interact': {
          const target = nearby(
            agent,
            await readAllChildren(ctx.read, { children: worldPath }),
          ).find((entity) => entityName(entity) === tool.target);
          if (target === undefined)
            throw new KernelError('INVALID', 'Simulation target is not nearby');

          // Nested actions commit independently; release prior read preconditions first.
          yield { agent: name, action: 'interact', target: tool.target };
          const result = await ctx.act({
            key: `interact:${interaction++}`,
            path: target.$path,
            action: tool.action,
            args: tool.data ?? {},
          });
          const freshTarget = await readNode(ctx.read, target.$path);
          if (freshTarget.$type === 'sim.agent')
            inbox(ctx, freshTarget, {
              round: round.current,
              type: 'interact',
              from: name,
              ts,
              data: { action: tool.action, result },
            });
          entry = logEntry(`interact→${tool.target}.${tool.action}`, { ...tool.data, result });
          break;
        }
      }
      if (entry !== undefined) {
        const freshWorld = await readNode(ctx.read, worldPath),
          freshRound = part(freshWorld, SimRound);
        patchPart(ctx, freshWorld, SimRound, { log: [...freshRound.log, entry].slice(-50) });
      }
      yield { agent: name, action: tool.tool };
    }
  }

  const finalWorld = await readNode(ctx.read, worldPath),
    finalRound = part(finalWorld, SimRound);
  if (!part(finalWorld, SimConfig).running)
    throw new KernelError('CANCELLED', 'Simulation stopped');
  const finalEntities = await readAllChildren(ctx.read, { children: worldPath });
  for (const agent of finalEntities.filter((entity) => entity.$type === 'sim.agent')) {
    const names = nearby(agent, finalEntities).map(entityName);
    if (getComponent(agent, SimNearby) === undefined) {
      ctx.change.patch(agent.$path, {
        $set: { '#nearby': { $type: 'sim.nearby', agents: names } },
      });
    } else patchPart(ctx, agent, SimNearby, { agents: names });
  }
  patchPart(ctx, finalWorld, SimRound, { current: finalRound.current + 1, phase: 'idle' });
  return { round: finalRound.current + 1 };
}
