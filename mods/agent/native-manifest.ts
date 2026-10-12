import type { TypeDef } from '@treenx/core/kernel/types';
import type { TypeSchema } from '@treenx/core/schema/types';
import { agentActions } from '#agent/native-actions';
import agent from './schemas/ai.agent.json';
import assignment from './schemas/ai.assignment.json';
import pool from './schemas/ai.pool.json';
import thread from './schemas/ai.thread.json';
import plan from './schemas/ai.plan.json';
import policy from './schemas/ai.policy.json';
import approvals from './schemas/ai.approvals.json';
import chat from './schemas/ai.chat.json';
import log from './schemas/ai.log.json';
import status from './schemas/ai.run-status.json';
import cost from './schemas/ai.cost.json';
import run from './schemas/ai.run.json';

const schemas: readonly TypeSchema[] = [
  { ...agent, type: 'object' },
  { ...assignment, type: 'object' },
  { ...pool, type: 'object' },
  { ...thread, type: 'object' },
  { ...plan, type: 'object' },
  { ...policy, type: 'object' },
  { ...approvals, type: 'object' },
  { ...chat, type: 'object' },
  { ...log, type: 'object' },
  { ...status, type: 'object' },
  { ...cost, type: 'object' },
  { ...run, type: 'object' },
];

/** Publishes actual native actions with existing data layouts; Guardian retains approval ownership. */
export function nativeAgentTypes(owner: string): TypeDef[] {
  return schemas.map((schema) => {
    const actions = agentActions(schema.$id!);
    return {
      name: schema.$id!,
      module: owner,
      security: 'ordinary',
      version: 0,
      schema: {
        ...schema,
        methods: Object.fromEntries(
          Object.entries(actions).map(([name, action]) => [
            name,
            {
              ...schema.methods![name],
              kind: action.kind,
              ...(name === 'send'
                ? { streaming: true, arguments: [{ name: 'data', ...action.args }] }
                : {}),
            },
          ]),
        ),
      },
      actions,
    };
  });
}
