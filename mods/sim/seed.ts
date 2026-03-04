import { type NodeData } from '@treenity/core/core';
import { registerPrefab } from '@treenity/core/mod';

registerPrefab('sim', 'seed', [
  { $path: 'sim', $type: 'dir' },

  { $path: 'sim/world', $type: 'sim.world',
    config: { $type: 'sim.config', width: 600, height: 400, roundDelay: 5000, running: false, model: 'claude-haiku-4-5-20251001' },
    round: { $type: 'sim.round', current: 0, phase: 'idle', log: [] },
  },

  // Agents
  { $path: 'sim/world/alice', $type: 'sim.agent',
    descriptive: { $type: 'sim.descriptive', name: 'Alice', icon: '\u{1F52C}', description: 'Curious researcher who asks deep questions' },
    ai: { $type: 'sim.ai', systemPrompt: 'You are Alice, a curious researcher. You love asking questions and exploring ideas. You are friendly but intellectually rigorous.' },
    position: { $type: 'sim.position', x: 150, y: 200, radius: 200 },
    memory: { $type: 'sim.memory', entries: [] },
    events: { $type: 'sim.events', entries: [] },
  },
  { $path: 'sim/world/bob', $type: 'sim.agent',
    descriptive: { $type: 'sim.descriptive', name: 'Bob', icon: '\u{1F6E0}', description: 'Practical engineer who builds things' },
    ai: { $type: 'sim.ai', systemPrompt: 'You are Bob, a practical engineer. You focus on building and solving concrete problems. Straightforward and hands-on.' },
    position: { $type: 'sim.position', x: 450, y: 200, radius: 200 },
    memory: { $type: 'sim.memory', entries: [] },
    events: { $type: 'sim.events', entries: [] },
  },
  { $path: 'sim/world/eve', $type: 'sim.agent',
    descriptive: { $type: 'sim.descriptive', name: 'Eve', icon: '\u{1F3A8}', description: 'Creative artist who sees beauty everywhere' },
    ai: { $type: 'sim.ai', systemPrompt: 'You are Eve, a creative artist. You express yourself through metaphors and see connections others miss. Passionate and emotional.' },
    position: { $type: 'sim.position', x: 300, y: 100, radius: 200 },
    memory: { $type: 'sim.memory', entries: [] },
    events: { $type: 'sim.events', entries: [] },
  },
  { $path: 'sim/world/guide', $type: 'sim.agent',
    descriptive: { $type: 'sim.descriptive', name: 'Guide', icon: '\u{1F4D6}', description: 'System narrator who explains how the simulation works' },
    ai: { $type: 'sim.ai', systemPrompt: `You are Guide, the narrator of this simulation. You explain what is happening to observers.
You know the system: agents live in a 2D world, each has a hearing radius. They act in rounds — everyone thinks in parallel (quorum), then actions execute: speak (heard by nearby agents), move (change position), remember (save to memory).
Describe the dynamics you observe: who moved where, who spoke, who heard whom. Be concise and insightful, like a nature documentary narrator.` },
    position: { $type: 'sim.position', x: 300, y: 350, radius: 350 },
    memory: { $type: 'sim.memory', entries: [] },
    events: { $type: 'sim.events', entries: [] },
  },

  // Items
  { $path: 'sim/world/workbench', $type: 'sim.item',
    descriptive: { $type: 'sim.descriptive', name: 'Workbench', icon: '\u{1F527}', description: 'A sturdy workbench with tools. Agents can examine or use it.' },
    position: { $type: 'sim.position', x: 500, y: 350, radius: 80 },
  },
  { $path: 'sim/world/crystal', $type: 'sim.item',
    descriptive: { $type: 'sim.descriptive', name: 'Crystal', icon: '\u{1F48E}', description: 'A mysterious glowing crystal. It hums softly when touched.' },
    position: { $type: 'sim.position', x: 100, y: 350, radius: 60 },
  },

  { $path: '/sys/autostart/sim', $type: 'ref', $ref: '/sim/world' },
] as NodeData[]);
