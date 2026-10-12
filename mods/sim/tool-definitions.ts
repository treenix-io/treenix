export const BASE_TOOLS = [
  {
    name: 'speak',
    description:
      'Say something. If "to" is given, direct message to that entity. Otherwise, all nearby entities hear you.',
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
    description:
      'Call an action on a nearby entity. Use this to interact with items, agents, or objects you can see.',
    input_schema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'Name of the entity to interact with' },
        action: {
          type: 'string',
          description: "Action name to invoke (from the entity's available actions)",
        },
        data: { type: 'object', description: 'Parameters for the action' },
      },
      required: ['target', 'action'],
    },
  },
];
