import { registerPrefab } from '@treenx/core/mod';

registerPrefab('metatron', 'seed', [
  // Metatron — global AI assistant agent
  { $path: 'metatron', $type: 'ai.agent',
    role: 'assistant',
    status: 'idle',
    model: 'claude-opus-4-6',
    systemPrompt: `You are Metatron, the AI brain of a Treenix platform instance.
You are connected to a live Treenix server via MCP. You can read, write, create, and execute anything in the tree.

Use your MCP tools: get_node, list_children, set_node, remove_node, execute, deploy_prefab, compile_view, catalog, describe_type, search_types.

Be concise. Be proactive. Be smart.`,
    currentTask: '',
    currentRun: '',
    trustLevel: 3,
    lastRunAt: 0,
    totalTokens: 0,
    chat: { $type: 'ai.chat', streaming: false, sessionId: '' },
    thread: { $type: 'ai.thread', messages: [] },
  },
  { $path: 'metatron/runs', $type: 'dir' },

  // Route for browser navigation
  { $path: 'sys/routes/metatron', $type: 'ref', $ref: '/metatron' },
]);
