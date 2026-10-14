import { createHash } from 'node:crypto';
import { z } from 'zod/v3';
import { KernelError } from '@treenx/core/errors';
import { createLaneCache } from '@treenx/core/client/lane-cache';
import { stableJson } from '@treenx/core/util/stable-json';
import type {
  Actor,
  Gate,
  ModuleManifest,
  Operation,
  ServiceHandler,
  WriteActionContext,
} from '@treenx/core/kernel/types';

/** Bind approvals to the actual actor and complete operation, including mutation arguments. */
export function approvalKey(principal: string, operation: unknown): string {
  return createHash('sha256')
    .update(stableJson({ principal, operation: JSON.parse(JSON.stringify(operation)) }))
    .digest('hex');
}

/** Own bounded approval projection and refuse until an explicit administrator-approved proof arrives. */
export function createNativeGuardian(root = '/guardian/approvals', guardianPath = '/guardian') {
  const cache = createLaneCache();
  let active = false;
  let ready = false;
  let principal: string | undefined;
  const listeners = new Set<() => void>();

  const gate: Gate = async (operation, actor) => {
    if (actor.principal === principal && (operation.kind === 'read' || operation.kind === 'sub')) {
      const selector = operation.selector;
      const path =
        'node' in selector ? selector.node : 'children' in selector ? selector.children : undefined;
      if (path === root || path?.startsWith(`${root}/`)) return 'pass';
    }
    if (!actor.claims.includes('agent')) return 'pass';
    if (operation.kind === 'read' || operation.kind === 'sub' || operation.kind === 'download')
      return 'pass';
    if (
      operation.kind === 'act' &&
      operation.path === guardianPath &&
      operation.action === 'request_approval'
    )
      return 'pass';
    if (!active || !ready) return { refuse: 'REFUSED' };
    const key = approvalKey(actor.principal, operation);
    const copy = cache.at(`${root}/${key}`);
    if (copy === undefined) return { refuse: 'REFUSED' };
    if ('error' in copy) throw copy.error;
    if (
      copy.node.$type !== 'ai.approval' ||
      copy.node.principal !== actor.principal ||
      approvalKey(actor.principal, copy.node.operation) !== key
    )
      return { refuse: 'REFUSED' };
    return copy.node.status === 'approved' &&
      typeof copy.node.expiresAt === 'number' &&
      copy.node.expiresAt > Date.now()
      ? 'pass'
      : { refuse: 'REFUSED' };
  };

  const service: ServiceHandler = async (_node, session) => {
    if (active) throw new KernelError('CONFLICT', 'Guardian already has an owner');
    active = true;
    principal = session.actor.principal;
    const sub = session.sub({ children: root, window: { limit: 256 }, sort: [['createdAt', -1]] });
    const done = (async () => {
      try {
        for await (const frame of session.lane) {
          cache.apply(frame);
          if (frame.t === 'snap' && frame.sub === sub) ready = true;
          if ((frame.t === 'end' || frame.t === 'reset') && frame.sub === sub) ready = false;
          if (frame.t === 'end' && frame.sub === sub) throw frame.error;
          if (frame.t === 'fail') throw frame.error;
          for (const listener of listeners) listener();
        }
      } catch (error) {
        if (
          !(error instanceof KernelError) ||
          (error.code !== 'CANCELLED' && error.code !== 'UNAUTHENTICATED')
        )
          throw error;
      } finally {
        active = false;
        ready = false;
        principal = undefined;
        cache.clear();
      }
    })();
    return {
      done,
      async stop() {
        active = false;
        ready = false;
        session.unsub(sub);
        await done;
      },
    };
  };

  const request = z.object({ operation: z.unknown() }).strict();
  const manifest: ModuleManifest = {
    id: 'treenix.guardian',
    open: [],
    security: [{ type: 'ai.guardian', context: 'service', handler: service }],
    types: [
      {
        name: 'ai.guardian',
        module: 'treenix.guardian',
        security: 'user-capability',
        version: 1,
        schema: { type: 'object', additionalProperties: false },
        actionsOnly: true,
        actions: {
          request_approval: {
            kind: 'setuid',
            args: {
              type: 'object',
              required: ['operation'],
              additionalProperties: false,
              properties: { operation: { type: 'object' } },
            },
            async handler(context, args) {
              const input = request.parse(args);
              const key = approvalKey(context.caller.principal, input.operation);
              const path = `${root}/${key}`;
              context.change.put({
                $path: path,
                $type: 'ai.approval',
                principal: context.caller.principal,
                operation: input.operation,
                status: 'pending',
                createdAt: Date.now(),
                expiresAt: Date.now() + 300_000,
              });
              return { path };
            },
          },
        },
      },
      {
        name: 'ai.approval',
        module: 'treenix.guardian',
        security: 'ordinary',
        version: 1,
        schema: {
          type: 'object',
          required: ['principal', 'operation', 'status', 'createdAt', 'expiresAt'],
          additionalProperties: false,
          properties: {
            principal: { type: 'string' },
            operation: { type: 'object' },
            status: { enum: ['pending', 'approved', 'denied'] },
            createdAt: { type: 'number' },
            expiresAt: { type: 'number' },
            agentPath: { type: 'string' },
            agentRole: { type: 'string' },
            tool: { type: 'string' },
            input: { type: 'string' },
            inputTruncated: { type: 'boolean' },
            branchRef: { type: 'string' },
            reason: { type: 'string' },
            resolvedAt: { type: 'number' },
            remember: { enum: ['', 'agent', 'global'] },
          },
        },
        actions: Object.fromEntries(
          ['approve', 'deny'].map((action) => [
            action,
            {
              kind: 'write' as const,
              args: { type: 'object', additionalProperties: false },
              async handler(context: WriteActionContext) {
                await context.requireAdmin();
                context.change.patch(context.node.$path, {
                  $set: { status: action === 'approve' ? 'approved' : 'denied' },
                });
              },
            },
          ]),
        ),
      },
    ],
  };
  return {
    gate,
    manifest,
    service,
    /** Observe delivered proofs without waiting inside the gate or a Writer decision. */
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async verdict(operation: Operation, actor: Actor) {
      return gate(operation, actor);
    },
  };
}
