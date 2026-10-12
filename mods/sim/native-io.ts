import { z } from 'zod';
import { KernelError } from '@treenx/core/errors';
import type { ActionIoBinding } from '@treenx/core/kernel/types';
import { BASE_TOOLS } from './tool-definitions';

const toolSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('speak'), message: z.string(), to: z.string().optional() }),
  z.object({ tool: z.literal('move'), x: z.number().finite(), y: z.number().finite() }),
  z.object({ tool: z.literal('remember'), text: z.string() }),
  z.object({
    tool: z.literal('interact'),
    target: z.string(),
    action: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
]);
export type SimTool = z.infer<typeof toolSchema>;
export interface SimThinkRequest {
  readonly system: string;
  readonly model: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly nearby: readonly { name: string; type: string }[];
}
export type SimProvider = (request: SimThinkRequest, signal: AbortSignal) => Promise<SimTool[]>;

declare module '@treenx/core/kernel/types' {
  interface Io {
    readonly sim?: { think(request: SimThinkRequest): Promise<SimTool[]> };
  }
}
declare module '@treenx/core/kernel/manifest' {
  interface NativeModuleHost {
    readonly sim?: { readonly provider: SimProvider };
  }
}

/** Preserve the explicit keyless demonstration mode without hiding provider failures. */
function mockThink(request: SimThinkRequest): SimTool[] {
  const choice = Math.random(),
    target = request.nearby[Math.floor(Math.random() * request.nearby.length)];
  if (choice < 0.35)
    return [
      {
        tool: 'speak',
        message: `${request.name} observes the world.`,
        ...(target === undefined ? {} : { to: target.name }),
      },
    ];
  if (choice < 0.6)
    return [
      {
        tool: 'move',
        x: Math.floor(Math.random() * request.width),
        y: Math.floor(Math.random() * request.height),
      },
    ];
  if (choice >= 0.8 && target?.type === 'sim.item')
    return [{ tool: 'interact', target: target.name, action: 'examine' }];
  return [{ tool: 'remember', text: `Observation at ${new Date().toLocaleTimeString()}` }];
}

/** Validate tool calls at the external model boundary; malformed responses fail the action. */
async function configuredProvider(
  request: SimThinkRequest,
  signal: AbortSignal,
): Promise<SimTool[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return mockThink(request);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: request.model,
      max_tokens: 400,
      system: request.system,
      messages: [{ role: 'user', content: "It's your turn. What do you do?" }],
      tools: BASE_TOOLS,
    }),
    signal,
  });
  if (!response.ok)
    throw new KernelError('UNAVAILABLE', `Simulation model HTTP ${response.status}`);
  const body = z
    .object({
      content: z.array(
        z.object({
          type: z.string(),
          name: z.string().optional(),
          input: z.record(z.string(), z.unknown()).optional(),
        }),
      ),
    })
    .parse(await response.json());
  const tools: SimTool[] = [];
  for (const block of body.content) {
    if (block.type === 'tool_use')
      tools.push(toolSchema.parse({ ...block.input, tool: block.name }));
  }
  return tools;
}

/** Bind every model call to the owning native action's lifetime. */
export function createSimIo(provider: SimProvider = configuredProvider): ActionIoBinding {
  return (scope) => ({
    sim: {
      async think(request) {
        scope.assertActive();
        const tools = await provider(request, scope.signal);
        scope.assertActive();
        return tools;
      },
    },
  });
}
