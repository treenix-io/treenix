// AgentSim — round-based multi-agent simulation (Layer 6)
// Handlers = MCP-style tools: each entity type exposes action:* handlers
// Agents discover nearby entities + their capabilities → rich context for AI
// speak(to?) with hear events, move, remember, interact(target, action)
// No ANTHROPIC_API_KEY → mock mode (random actions for demo)

import {
  createNode,
  getComponent,
  getContextsForType,
  getMeta,
  type NodeData,
  register,
  resolve,
} from '@treenity/core';
import '@treenity/core/contexts/service';
import { newComponent, setComponent } from '@treenity/core/comp';
import { OpError } from '@treenity/core/errors';
import { type ActionCtx, serverNodeHandle } from '@treenity/core/server/actions';
import {
  type AgentEvent,
  type EventEntry,
  SimAi,
  SimConfig,
  SimDescriptive,
  SimEvents,
  SimMemory,
  SimNearby,
  SimPosition,
  SimRound,
} from './types';

export type { EventEntry };

type Tool = { tool: string; [k: string]: unknown };

// ── Helpers ──

function dist(a: SimPosition, b: SimPosition) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function getNearby(agent: NodeData, all: NodeData[]): NodeData[] {
  const pos = getComponent(agent, SimPosition);
  if (!pos) return [];
  return all.filter((a) => {
    if (a.$path === agent.$path) return false;
    const ap = getComponent(a, SimPosition);
    return ap && dist(pos, ap) <= pos.radius;
  });
}

function eName(n: NodeData): string {
  return getComponent(n, SimDescriptive)?.name ?? n.$path.split('/').at(-1)!;
}

// Discover registered action:* handlers for a type → MCP-style tool list with meta
type ActionInfo = { name: string; description?: string; params?: string };

function getEntityActions(type: string): ActionInfo[] {
  return getContextsForType(type)
    .filter((c) => c.startsWith('action:'))
    .map((c) => {
      const name = c.slice(7);
      const meta = getMeta(type, c);
      return {
        name,
        description: meta?.description as string | undefined,
        params: meta?.params as string | undefined,
      };
    });
}

function formatActions(actions: ActionInfo[]): string {
  if (!actions.length) return '';
  return actions
    .map((a) => {
      let s = a.name;
      if (a.params) s += `(${a.params})`;
      if (a.description) s += ` — ${a.description}`;
      return s;
    })
    .join('; ');
}

// Build environment context string for AI — like collectEnvironment() in original
function collectEnvironment(agent: NodeData, allEntities: NodeData[]): string {
  const near = getNearby(agent, allEntities);
  if (!near.length) return 'Nobody and nothing nearby.';

  return near
    .map((n, i) => {
      const d = getComponent(n, SimDescriptive);
      const p = getComponent(n, SimPosition);
      const actions = getEntityActions(n.$type);
      const actionsStr = actions.length ? `\n   Actions: ${formatActions(actions)}` : '';
      return `${i + 1}. ${n.$type} "${d?.name ?? n.$path}" ${d?.icon ?? ''} at (${p?.x},${p?.y}): ${d?.description ?? ''}${actionsStr}`;
    })
    .join('\n');
}

// Get per-agent event history
function getAgentEvents(n: NodeData): AgentEvent[] {
  const ev = getComponent(n, SimEvents);
  return ev?.entries ?? [];
}

// Append event to agent's inbox (capped at 30)
function pushAgentEvent(n: NodeData, event: AgentEvent) {
  const ev = getComponent(n, SimEvents);
  const entries = [...(ev?.entries ?? []), event].slice(-30);
  setComponent(n, SimEvents, { entries });
}

// ── LLM tools — base + interact ──

const BASE_TOOLS = [
  {
    name: 'speak',
    description: 'Say something. If "to" is given, direct message to that entity. Otherwise, all nearby entities hear you.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'What to say' },
        to: { type: 'string', description: 'Name of specific entity to address (optional)' },
      },
      required: ['message'],
    },
  },
  {
    name: 'move',
    description: 'Move to a new position on the map.',
    input_schema: {
      type: 'object' as const,
      properties: {
        x: { type: 'number', description: 'Target X coordinate' },
        y: { type: 'number', description: 'Target Y coordinate' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'remember',
    description: 'Save a thought or observation to your memory.',
    input_schema: {
      type: 'object' as const,
      properties: { text: { type: 'string', description: 'What to remember' } },
      required: ['text'],
    },
  },
  {
    name: 'interact',
    description: 'Call an action on a nearby entity. Use this to interact with items, agents, or objects you can see.',
    input_schema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'Name of the entity to interact with' },
        action: { type: 'string', description: 'Action name to invoke (from the entity\'s available actions)' },
        data: { type: 'object', description: 'Parameters for the action' },
      },
      required: ['target', 'action'],
    },
  },
];

// ── LLM call ──

async function callLLM(
  agent: NodeData,
  allEntities: NodeData[],
  worldLog: EventEntry[],
  round: number,
  model: string,
): Promise<Tool[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return mockThink(agent, allEntities);

  const desc = getComponent(agent, SimDescriptive);
  const pos = getComponent(agent, SimPosition);
  const mem = getComponent(agent, SimMemory);
  const ai = getComponent(agent, SimAi);

  const myName = desc?.name ?? 'agent';

  // Per-agent events (directed + heard)
  const agentEvents = getAgentEvents(agent)
    .slice(-15)
    .map((e) => `[R${e.round}] ${e.from}→${e.to ?? 'all'} ${e.type}: ${JSON.stringify(e.data)}`)
    .join('\n');

  // Environment: nearby entities with capabilities
  const env = collectEnvironment(agent, allEntities);

  const memText = mem?.entries?.length ? mem.entries.slice(-10).join('\n') : '(empty)';

  // My own actions (what others can ask me to do)
  const myActions = getEntityActions(agent.$type);

  const system = `${ai?.systemPrompt ?? `You are ${myName}.`}

You are "${myName}" ${desc?.icon ?? ''} — ${desc?.description ?? ''}
Position: (${pos?.x}, ${pos?.y}), hearing radius: ${pos?.radius}.
Your available actions others can call on you: ${formatActions(myActions) || 'none'}

Environment (nearby entities and their capabilities):
${env}

Your memory:
${memText}

${agentEvents ? `Recent events involving you:\n${agentEvents}` : 'No recent events.'}

Round ${round}. Use tools to act. You can speak (optionally TO someone), move, remember, or interact with nearby entities by calling their actions. Be concise. Stay in character.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ai?.model ?? model,
      max_tokens: 400,
      system,
      messages: [{ role: 'user', content: "It's your turn. What do you do?" }],
      tools: BASE_TOOLS,
    }),
  });

  if (!res.ok) {
    console.error(`[sim] AI ${res.status}:`, await res.text());
    return [];
  }

  const body = (await res.json()) as {
    content: { type: string; name?: string; input?: Record<string, unknown> }[];
  };
  return body.content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ tool: b.name!, ...b.input }));
}

// ── Mock mode (no API key) ──

function mockThink(agent: NodeData, all: NodeData[]): Tool[] {
  const near = getNearby(agent, all);
  const r = Math.random();
  if (r < 0.35 && near.length > 0) {
    const target = near[Math.floor(Math.random() * near.length)];
    const msgs = ['Hello!', 'Nice day!', 'Interesting...', 'I wonder...', 'Look at that!'];
    // 50% directed, 50% broadcast
    const to = Math.random() < 0.5 ? eName(target) : undefined;
    return [{ tool: 'speak', message: msgs[Math.floor(Math.random() * msgs.length)], to }];
  }
  if (r < 0.6) {
    return [
      { tool: 'move', x: Math.floor(Math.random() * 600), y: Math.floor(Math.random() * 400) },
    ];
  }
  if (r < 0.8) {
    return [{ tool: 'remember', text: `Observation at ${new Date().toLocaleTimeString()}` }];
  }
  // interact with nearby item/agent
  if (near.length > 0) {
    const target = near[Math.floor(Math.random() * near.length)];
    const actions = getEntityActions(target.$type).filter((a) => a.name !== 'update');
    if (actions.length > 0) {
      return [{
        tool: 'interact',
        target: eName(target),
        action: actions[Math.floor(Math.random() * actions.length)].name,
        data: {},
      }];
    }
  }
  return [{ tool: 'remember', text: `Nothing interesting happening` }];
}

// ── Node-level actions (UI control) ──

/** @description Start the agent simulation loop */
register('sim.world', 'action:start', async (ctx: ActionCtx) => {
  const cfg = getComponent(ctx.node, SimConfig)!;
  setComponent(ctx.node, SimConfig, { ...cfg, running: true });
}, { description: 'Start the simulation' });

/** @description Stop the agent simulation loop */
register('sim.world', 'action:stop', async (ctx: ActionCtx) => {
  const cfg = getComponent(ctx.node, SimConfig)!;
  setComponent(ctx.node, SimConfig, { ...cfg, running: false });
}, { description: 'Stop the simulation' });

/** @description Update simulation settings (roundDelay, model, dimensions) */
register('sim.world', 'action:set-config', async (ctx: ActionCtx, params: any) => {
  const cfg = getComponent(ctx.node, SimConfig)!;
  const next = { ...cfg };
  if (params.roundDelay !== undefined) next.roundDelay = Number(params.roundDelay);
  if (params.model !== undefined) next.model = String(params.model);
  if (params.width !== undefined) next.width = Number(params.width);
  if (params.height !== undefined) next.height = Number(params.height);
  setComponent(ctx.node, SimConfig, next);
}, { description: 'Update simulation settings', params: 'roundDelay?, model?, width?, height?' });

/** @description Add an agent or item entity to the simulation world */
register('sim.world', 'action:add-entity', async (ctx: ActionCtx, params: any) => {
  const id = params.id || `e-${Date.now()}`;
  const type = params.type || 'sim.item';
  const path = `${ctx.node.$path}/${id}`;
  const components: Record<string, any> = {
    descriptive: newComponent(SimDescriptive, {
      name: params.name || id,
      icon: params.icon || '?',
      description: params.description || '',
    }),
    position: newComponent(SimPosition, {
      x: params.x ?? 300,
      y: params.y ?? 200,
      radius: params.radius ?? 100,
    }),
  };
  if (type === 'sim.agent') {
    components.ai = newComponent(SimAi, { systemPrompt: params.systemPrompt || `You are ${params.name}.` });
    components.memory = newComponent(SimMemory, { entries: [] });
    components.events = newComponent(SimEvents, { entries: [] });
  }
  await ctx.tree.set(createNode(path, type, {}, components));
}, { description: 'Add agent or item to the world', params: 'name, icon, type?, x?, y?, radius?, systemPrompt?, description?' });

// Agent actions (callable by other agents via interact, or by UI)
/** @description Move agent to a new position on the map */
register('sim.agent', 'action:move', async (ctx: ActionCtx, params: any) => {
  const pos = getComponent(ctx.node, SimPosition)!;
  const next = { ...pos };
  if (params.x !== undefined) next.x = Math.round(Number(params.x));
  if (params.y !== undefined) next.y = Math.round(Number(params.y));
  setComponent(ctx.node, SimPosition, next);
}, { description: 'Move to position', params: 'x, y' });

/** @description Update agent properties (systemPrompt, radius, name, icon, description) */
register('sim.agent', 'action:update', async (ctx: ActionCtx, params: any) => {
  if (params.systemPrompt !== undefined) {
    const ai = getComponent(ctx.node, SimAi)!;
    setComponent(ctx.node, SimAi, { ...ai, systemPrompt: String(params.systemPrompt) });
  }
  if (params.radius !== undefined) {
    const pos = getComponent(ctx.node, SimPosition)!;
    setComponent(ctx.node, SimPosition, { ...pos, radius: Number(params.radius) });
  }
  if (params.name !== undefined || params.icon !== undefined || params.description !== undefined) {
    const desc = getComponent(ctx.node, SimDescriptive)!;
    const next = { ...desc };
    if (params.name !== undefined) next.name = String(params.name);
    if (params.icon !== undefined) next.icon = String(params.icon);
    if (params.description !== undefined) next.description = String(params.description);
    setComponent(ctx.node, SimDescriptive, next);
  }
}, { description: 'Update agent properties', params: 'systemPrompt?, radius?, name?, icon?, description?' });

// Item actions — example extensible types
/** @description Examine the item and return its description */
register('sim.item', 'action:examine', async (ctx: ActionCtx) => {
  const desc = getComponent(ctx.node, SimDescriptive);
  return { description: desc?.description ?? 'Nothing special.' };
}, { description: 'Look at the item closely' });

/** @description Use or interact with the item */
register('sim.item', 'action:use', async (ctx: ActionCtx, params: any) => {
  const desc = getComponent(ctx.node, SimDescriptive);
  return { result: `You used ${desc?.name ?? 'item'}. ${params.how ?? ''}` };
}, { description: 'Interact with the item', params: 'how?' });

// ── World Service ──

register('sim.world', 'service', async (node, ctx) => {
  let stopped = false;
  const wp = node.$path;

  async function getAllEntities() {
    return (await ctx.tree.getChildren(wp)).items.filter(
      (n) => n.$type === 'sim.agent' || n.$type === 'sim.item',
    );
  }

  async function getAgents() {
    return (await ctx.tree.getChildren(wp)).items.filter((n) => n.$type === 'sim.agent');
  }

  async function runRound() {
    const world = await ctx.tree.get(wp);
    if (!world) return;
    const cfg = getComponent(world, SimConfig);
    if (!cfg?.running) return;

    const round = getComponent(world, SimRound)!;
    const num = round.current ?? 0;
    const allEntities = await getAllEntities();
    const agents = allEntities.filter((n) => n.$type === 'sim.agent');
    if (!agents.length) return;

    // Phase: thinking
    setComponent(world, SimRound, { ...round, phase: 'thinking' });
    await ctx.tree.set(world);

    const log = round.log ?? [];
    const model = cfg.model ?? 'claude-haiku-4-5-20251001';

    // All agents think in parallel — quorum
    const results = await Promise.allSettled(
      agents.map(async (a) => ({
        agent: a,
        tools: await callLLM(a, allEntities, log, num, model),
      })),
    );

    // Execute actions
    const newEntries: EventEntry[] = [];
    // Map name→path for interact resolution
    const nameToPath = new Map<string, string>();
    for (const e of allEntities) nameToPath.set(eName(e), e.$path);

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { agent, tools } = r.value;
      const agentName = eName(agent);
      const desc = getComponent(agent, SimDescriptive);

      for (const t of tools) {
        const ts = Date.now();
        switch (t.tool) {
          case 'speak': {
            const to = t.to as string | undefined;
            const nearAgents = getNearby(agent, agents);
            const hearers = nearAgents.map(eName);

            // Push event to directed target or all hearers
            for (const hearer of nearAgents) {
              const fresh = await ctx.tree.get(hearer.$path);
              if (!fresh) continue;
              const hName = eName(fresh);
              const eventType = to && to === hName ? 'speak' : 'hear';
              pushAgentEvent(fresh, {
                round: num,
                type: eventType,
                from: agentName,
                to: to || undefined,
                data: { message: t.message as string },
                ts,
              });
              await ctx.tree.set(fresh);
            }

            newEntries.push({
              round: num,
              agent: agentName,
              icon: desc?.icon ?? '',
              action: to ? `speak→${to}` : 'speak',
              data: { message: t.message as string },
              heardBy: hearers,
              ts,
            });
            break;
          }
          case 'move': {
            const fresh = await ctx.tree.get(agent.$path);
            if (!fresh) break;
            const pos = getComponent(fresh, SimPosition)!;
            setComponent(fresh, SimPosition, {
              ...pos,
              x: Math.max(0, Math.min(cfg.width, t.x as number)),
              y: Math.max(0, Math.min(cfg.height, t.y as number)),
            });
            await ctx.tree.set(fresh);
            newEntries.push({
              round: num,
              agent: agentName,
              icon: desc?.icon ?? '',
              action: 'move',
              data: { x: t.x as number, y: t.y as number },
              ts,
            });
            break;
          }
          case 'remember': {
            const fresh = await ctx.tree.get(agent.$path);
            if (!fresh) break;
            const mem = getComponent(fresh, SimMemory);
            setComponent(fresh, SimMemory, {
              entries: [...(mem?.entries ?? []), t.text as string].slice(-20),
            });
            await ctx.tree.set(fresh);
            break;
          }
          case 'interact': {
            const targetName = t.target as string;
            const action = t.action as string;
            const data = (t.data as Record<string, unknown>) ?? {};
            const targetPath = nameToPath.get(targetName);
            if (!targetPath) break;

            const targetNode = await ctx.tree.get(targetPath);
            if (!targetNode) break;

            // Check proximity
            const near = getNearby(agent, allEntities);
            if (!near.find((n) => n.$path === targetPath)) break;

            // Resolve and call target's action handler
            const handler = resolve(targetNode.$type, `action:${action}`);
            if (!handler) break;

            const actx: ActionCtx = {
              node: targetNode,
              tree: ctx.tree,
              signal: AbortSignal.timeout(5000),
              nc: serverNodeHandle(ctx.tree),
            };
            const result = await (handler as any)(actx, data);
            // Persist handler mutations (handlers don't call tree.set — executeAction/caller does)
            await ctx.tree.set(targetNode);

            // Push event to target agent's inbox
            if (targetNode.$type === 'sim.agent') {
              const freshTarget = await ctx.tree.get(targetPath);
              if (freshTarget) {
                pushAgentEvent(freshTarget, {
                  round: num,
                  type: `interact:${action}`,
                  from: agentName,
                  data: { ...data, result },
                  ts,
                });
                await ctx.tree.set(freshTarget);
              }
            }

            newEntries.push({
              round: num,
              agent: agentName,
              icon: desc?.icon ?? '',
              action: `${action}→${targetName}`,
              data: { ...data, result },
              ts,
            });
            break;
          }
        }
      }
    }

    // Recompute proximity links on all entities (engine-owned data)
    const freshEntities = await getAllEntities();
    for (const a of freshEntities) {
      const near = getNearby(a, freshEntities);
      setComponent(a, SimNearby, { agents: near.map(eName) });
      await ctx.tree.set(a);
    }

    // Advance round
    const worldFresh = await ctx.tree.get(wp);
    if (!worldFresh) return;
    setComponent(worldFresh, SimRound, {
      current: num + 1,
      phase: 'idle',
      log: [...log, ...newEntries].slice(-50),
    });
    await ctx.tree.set(worldFresh);
    console.log(`[sim] round ${num} done: ${newEntries.length} events`);
  }

  // Main loop
  (async () => {
    console.log(`[sim] started on ${wp}`);
    while (!stopped) {
      try {
        const w = await ctx.tree.get(wp);
        const cfg = w ? getComponent(w, SimConfig) : null;
        if (cfg?.running) await runRound();
        await new Promise((r) => setTimeout(r, cfg?.roundDelay ?? 5000));
      } catch (e) {
        if (e instanceof OpError && e.code === 'CONFLICT') {
          continue;
        }
        console.error('[sim] error:', e);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();

  return {
    stop: async () => {
      stopped = true;
    },
  };
});
