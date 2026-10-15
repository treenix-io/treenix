import { KernelError } from '@treenx/core/errors';
import type {
  ActionIoBinding,
  ChangeBuilder,
  NodeId,
  Reader,
  NestedActRequest,
} from '@treenx/core/kernel/types';

export interface AgentRequest {
  readonly key: NodeId;
  readonly provider?: 'claude' | 'chatgpt';
  readonly model: string;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly outputSchema?: Record<string, unknown>;
  readonly tools?: 'none';
  readonly sessionId?: string;
  readonly forkSession?: boolean;
}

export interface AgentPorts {
  readonly read: Reader;
  readonly act: (request: NestedActRequest) => Promise<unknown>;
  readonly change: ChangeBuilder;
}

export interface AgentResult {
  readonly output: string;
  readonly sessionId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export type AgentEvent =
  | { readonly type: 'chunk'; readonly text: string }
  | { readonly type: 'result'; readonly result: AgentResult };
export type AgentProvider = (
  request: AgentRequest,
  ports: AgentPorts,
  signal: AbortSignal,
) => AsyncGenerator<AgentEvent>;

export interface AgentIo {
  invoke(request: AgentRequest, ports: AgentPorts): AsyncGenerator<AgentEvent>;
  stop(key: NodeId): void;
}

declare module '@treenx/core/kernel/types' {
  interface Io {
    readonly agent?: AgentIo;
  }
}

/** Owns model cancellation per module instance and keeps every native tool inside its action frame. */
export function createAgentIo(provider: AgentProvider): ActionIoBinding {
  const running = new Map<NodeId, AbortController>();

  return (scope) => ({
    agent: {
      async *invoke(request, ports) {
        scope.assertActive();
        if (running.has(request.key))
          throw new KernelError('CONFLICT', 'Agent already has a running model call');
        const controller = new AbortController();
        running.set(request.key, controller);
        const signal = AbortSignal.any([scope.signal, controller.signal]);

        try {
          for await (const event of provider(request, ports, signal)) {
            signal.throwIfAborted();
            scope.assertActive();
            yield event;
          }
        } finally {
          running.delete(request.key);
          controller.abort();
        }
      },
      stop(key) {
        scope.assertActive();
        running.get(key)?.abort(new KernelError('CANCELLED', 'Agent stopped'));
      },
    },
  });
}
