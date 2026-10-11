import { randomUUID } from 'node:crypto';
import { z } from 'zod/v3';
import { KernelError } from '@treenx/core/errors';
import { prepareCredential } from '@treenx/core/kernel/auth/credentials';
import type { ModuleManifest } from '@treenx/core/kernel/types';

const createInput = z.object({ name: z.string().min(1), groups: z.array(z.string()).default(['agent']), scope: z.array(z.string().startsWith('/')).min(1) }).strict();
const accountInput = z.object({ id: z.string().uuid(), name: z.string().min(1), groups: z.array(z.string()) }).strict();
const revokeInput = z.object({ id: z.string().uuid() }).strict();

/** Install one native definition per token type, with explicit administrator account provisioning. */
export function nativeApiTokenManifest(): ModuleManifest {
  return { id: 'treenix.api-token', security: [], open: [], types: [
    { name: 't.api.tokens', module: 'treenix.api-token', security: 'ordinary', version: 1, actionsOnly: true,
      schema: { type: 'object', additionalProperties: false }, actions: {
        provision_account: { kind: 'write', args: { type: 'object', required: ['id', 'name', 'groups'], additionalProperties: false,
          properties: { id: { type: 'string' }, name: { type: 'string' }, groups: { type: 'array', items: { type: 'string' } } } },
          async handler(context, args) {
            await context.requireAdmin();
            const input = accountInput.parse(args);
            context.change.put({ $path: `/auth/users/api-${input.id}`, $type: 't.user', name: input.name, status: 'active', '#groups': { $type: 't.groups', list: input.groups } });
          },
        },
        create: { kind: 'write', args: { type: 'object', required: ['name', 'scope'], additionalProperties: false,
          properties: { name: { type: 'string' }, groups: { type: 'array', items: { type: 'string' } }, scope: { type: 'array', items: { type: 'string' }, minItems: 1 } } },
          async handler(context, args) {
            await context.requireAdmin();
            const input = createInput.parse(args);
            const id = randomUUID();
            const accountPath = `/auth/users/api-${id}`;
            await context.act({ path: context.node.$path, action: 'provision_account', args: { id, name: input.name, groups: input.groups }, key: 'account' });
            const account = (await context.read.read({ node: accountPath })).copies[0];
            if ('error' in account) throw account.error;
            const prepared = prepareCredential(account.node.$id, { expiresAt: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000, scope: input.scope });
            context.change.put(prepared.node);
            const path = `${context.node.$path}/${id}`;
            context.change.put({ $path: path, $type: 't.api.token', name: input.name, accountPath, principal: `u:${account.node.$id}`, sessionRef: prepared.node.$path, preview: prepared.credential.token.slice(0, 8), createdAt: Date.now() });
            return { id, token: prepared.credential.token, userId: `u:${account.node.$id}` };
          },
        },
        revoke: { kind: 'write', args: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string' } } },
          async handler(context, args) {
            await context.requireAdmin();
            const { id } = revokeInput.parse(args);
            const path = `${context.node.$path}/${id}`;
            const copy = (await context.read.read({ node: path })).copies[0];
            if ('error' in copy) throw copy.error;
            const reference = copy.node.sessionRef;
            if (typeof reference !== 'string') throw new KernelError('INVALID', 'Token descriptor has no session');
            context.change.remove(reference);
            context.change.remove(path);
            return { revoked: true };
          },
        },
      },
    },
    { name: 't.api.token', module: 'treenix.api-token', security: 'ordinary', version: 1, actionsOnly: true, actions: {},
      schema: { type: 'object', required: ['name', 'accountPath', 'principal', 'sessionRef', 'preview', 'createdAt'], additionalProperties: false,
        properties: { name: { type: 'string' }, accountPath: { type: 'string' }, principal: { type: 'string' }, sessionRef: { type: 'string' }, preview: { type: 'string' }, createdAt: { type: 'number' } } },
    },
  ] };
}
