// AgentSim shared types — used by both service (backend) and view (frontend)
// Classes per CLAUDE.md: "Exception: for entity definition could be used"

import { registerType } from '@treenx/core/comp';

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

registerType('sim.position', SimPosition);
registerType('sim.descriptive', SimDescriptive);
registerType('sim.memory', SimMemory);
registerType('sim.config', SimConfig);
registerType('sim.round', SimRound);
registerType('sim.events', SimEvents);
registerType('sim.ai', SimAi);
registerType('sim.nearby', SimNearby);
