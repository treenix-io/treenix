import { type NodeData } from '@treenity/core';
import { registerPrefab } from '@treenity/core/mod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

registerPrefab('metatron', 'seed', [
  { $path: 'metatron', $type: 'metatron.config',
    model: 'claude-opus-4-6', systemPrompt: '', sessionId: '', lastRun: 0 },

  { $path: 'metatron/tasks', $type: 'dir' },

  // Query mounts — virtual folders filtered by task status
  { $path: 'metatron/inbox', $type: 'mount-point',
    mount: { $type: 't.mount.query', source: '/metatron/tasks', match: { $type: 'metatron.task', status: { $in: ['pending', 'running'] } } } },
  { $path: 'metatron/done', $type: 'mount-point',
    mount: { $type: 't.mount.query', source: '/metatron/tasks', match: { $type: 'metatron.task', status: 'done' } } },

  // Skills — modular prompt fragments
  { $path: 'metatron/skills', $type: 'dir' },
  { $path: 'metatron/skills/tree-admin', $type: 'metatron.skill',
    name: 'Tree Admin',
    prompt: 'You are a Treenity tree administrator. You can create, read, update, and delete nodes using MCP tools. Use catalog and describe_type to discover available types before creating nodes.',
    enabled: true, category: 'core', updatedAt: 0 },
  { $path: 'metatron/skills/self-learning', $type: 'metatron.skill',
    name: 'Self-Learning',
    prompt: 'After completing a task successfully, reflect on what you learned. If you discovered a reusable principle, pattern, or gotcha — save it as a skill at /metatron/skills/. Check existing skills first (list_children), update rather than duplicate. Skills should be concise (1-3 sentences) and actionable.',
    enabled: true, category: 'meta', updatedAt: 0 },

  // Memory — persistent facts/preferences
  { $path: 'metatron/memory', $type: 'dir' },

  // Workspaces — multi-task columns
  { $path: 'metatron/workspaces', $type: 'dir' },

  { $path: '/sys/autostart/metatron', $type: 'ref', $ref: '/metatron' },
] as NodeData[], (nodes) => {
  // Load metatron prompt from docs
  let systemPrompt = '';
  try {
    systemPrompt = readFileSync(join(process.cwd(), 'docs/metatron-prompt.md'), 'utf8');
  } catch {
    console.warn('[seed] docs/metatron-prompt.md not found, metatron systemPrompt will be empty');
  }

  return nodes.map(n =>
    n.$path === 'metatron' ? { ...n, systemPrompt } : n,
  );
});
