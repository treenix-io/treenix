import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';
// AgentSim shared types — used by both service (backend) and view (frontend)
// Classes per CLAUDE.md: "Exception: for entity definition could be used"

/** Agent 2D map position and interaction radius */
export class SimPosition {
  x = 0;
  y = 0;
  radius = 200;
}

/** Agent identity — name, icon, description */
export class SimDescriptive {
  name = '';
  icon = '';
  /** @format textarea */
  description = '';
}

/** Agent memory — accumulated observations */
export class SimMemory {
  entries: string[] = [];
}

/** Simulation world config — dimensions, round timing */
export class SimConfig {
  width = 600;
  height = 400;
  roundDelay = 5000;
  running = false;
  model?: string;
}

/** Current simulation round — phase and event log */
export class SimRound {
  current = 0;
  phase = 'idle';
  log: EventEntry[] = [];
}

/** Agent event inbox — received events per round */
export class SimEvents {
  entries: AgentEvent[] = [];
}

/** Agent AI config — system prompt and model override */
export class SimAi {
  /** @format textarea */
  systemPrompt = '';
  model?: string;
}

/** Proximity cache — nearby agents within radius */
export class SimNearby {
  agents: string[] = [];
}

// Per-agent event inbox
export type AgentEvent = {
  round: number;
  type: string;
  from: string;
  to?: string;
  data: Record<string, unknown>;
  ts: number;
};

// World-level event log entry (for UI display)
export type EventEntry = {
  round: number;
  agent: string;
  icon: string;
  action: string;
  data: Record<string, unknown>;
  heardBy?: string[];
  ts: number;
};

const declaredSimPosition = declareClientType('sim.position', SimPosition);
const declaredSimDescriptive = declareClientType('sim.descriptive', SimDescriptive);
const declaredSimMemory = declareClientType('sim.memory', SimMemory);
const declaredSimConfig = declareClientType('sim.config', SimConfig);
const declaredSimRound = declareClientType('sim.round', SimRound);
const declaredSimEvents = declareClientType('sim.events', SimEvents);
const declaredSimAi = declareClientType('sim.ai', SimAi);
const declaredSimNearby = declareClientType('sim.nearby', SimNearby);

/** Simulation world entity — aggregates config, round, events. Actions registered separately. */
export class SimWorld {}
/** Agent entity — aggregates position, descriptive, memory, ai, nearby, events. */
export class SimAgent {}
/** Interactable item entity in the world. */
export class SimItem {}

const declaredSimWorld = declareClientType('sim.world', SimWorld);
const declaredSimAgent = declareClientType('sim.agent', SimAgent);
const declaredSimItem = declareClientType('sim.item', SimItem);

export const clientModules = [
  declareOpenModule(
    '@treenx/mods/sim/types',
    [],
    [
      declaredSimPosition,
      declaredSimDescriptive,
      declaredSimMemory,
      declaredSimConfig,
      declaredSimRound,
      declaredSimEvents,
      declaredSimAi,
      declaredSimNearby,
      declaredSimWorld,
      declaredSimAgent,
      declaredSimItem,
    ],
  ),
];
