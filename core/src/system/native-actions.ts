import { KernelError } from '#errors';
import type { ModuleManifest, ReadActionContext } from '#kernel/types';

/** Resolve visible ownership nodes through the existing caller-scoped reflection action. */
export function nativeSystemManifest(): ModuleManifest {
  async function catalog(context: ReadActionContext, query?: string, name?: string) {
    const result = await context.read.read({ children: '/sys/types', ...(name === undefined ? {} : { where: { name } }) });
    const descriptions: unknown[] = [];
    for (const copy of result.copies) {
      if ('error' in copy) throw copy.error;
      if (!result.list.includes(copy.node.$id)) continue;
      const typeName = copy.node.name;
      if (typeof typeName !== 'string') throw new KernelError('INVALID', 'Type ownership has no name');
      const description = await context.act({ path: copy.node.$path, action: 'describe_type', args: {} });
      if (query !== undefined && !JSON.stringify(description).toLowerCase().includes(query.toLowerCase())) continue;
      descriptions.push(description);
    }
    if (name !== undefined && descriptions.length !== 1) throw new KernelError('NOT_FOUND', 'Type ownership is not visible');
    return name === undefined ? descriptions : descriptions[0];
  }

  return {
    id: 'treenix.system', security: [], open: [], types: [{
      name: 't.system', module: 'treenix.system', security: 'ordinary', version: 1,
      schema: { type: 'object', additionalProperties: false },
      actions: {
        deploy_prefab: {
          kind: 'write',
          args: {
            type: 'object',
            required: ['source', 'target'],
            additionalProperties: false,
            properties: {
              source: { type: 'string' },
              target: { type: 'string' },
              allowAbsolute: { type: 'boolean' },
            },
          },
          /** Keep the system entry point on the prefab owner's bounded native deployment. */
          async handler(context, input) {
            if (
              input === null ||
              typeof input !== 'object' ||
              !('source' in input) ||
              typeof input.source !== 'string' ||
              !('target' in input) ||
              typeof input.target !== 'string'
            )
              throw new KernelError('INVALID', 'Prefab source and target are required');
            const allowAbsolute = 'allowAbsolute' in input ? input.allowAbsolute : undefined;
            if (allowAbsolute !== undefined && typeof allowAbsolute !== 'boolean')
              throw new KernelError('INVALID', 'Absolute-path permission must be boolean');

            return context.act({
              path: input.source,
              action: 'deploy',
              key: 'deploy',
              args: {
                target: input.target,
                ...(allowAbsolute === undefined ? {} : { allowAbsolute }),
              },
            });
          },
        },
        catalog: { kind: 'read', args: { type: 'object', additionalProperties: false }, handler: context => catalog(context) },
        describe_type: { kind: 'read', args: { type: 'object', required: ['type'], additionalProperties: false, properties: { type: { type: 'string' } } }, handler: (context, input) => {
          if (typeof input !== 'object' || input === null || !('type' in input) || typeof input.type !== 'string') throw new KernelError('INVALID', 'Type name is required');
          return catalog(context, undefined, input.type);
        } },
        search_types: { kind: 'read', args: { type: 'object', required: ['query'], additionalProperties: false, properties: { query: { type: 'string' } } }, handler: (context, input) => {
          if (typeof input !== 'object' || input === null || !('query' in input) || typeof input.query !== 'string') throw new KernelError('INVALID', 'Search query is required');
          return catalog(context, input.query);
        } },
      },
    }],
  };
}
