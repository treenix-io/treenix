import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTwpHttpRoutes } from '@treenx/core/server/http-routes';
import { createTwpHttpServer } from '@treenx/core/server/http-twp';
import { nativeMcpManifest } from '#mcp/native-service';
import type { ModuleManifest } from '@treenx/core/kernel/types';
import { R, W, A } from '@treenx/core/kernel';
import { prepareCredential } from '@treenx/core/kernel/auth/credentials';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { openNativeRuntime } from '@treenx/core/kernel/runtime';
import { nativeSystemManifest } from '@treenx/core/system/native-actions';
import { createMcpSession } from '#mcp/mcp-session';
import { createNativeMcpServer } from '#mcp/native-tools';
import prefabModule from '#prefab/kernel';

const counter: ModuleManifest = {
  id: 'mcp-key',
  types: [
    {
      name: 'mcp.counter',
      module: 'mcp-key',
      security: 'ordinary',
      version: 0,
      schema: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
        additionalProperties: false,
      },
      actions: {
        increment: {
          kind: 'write',
          args: { type: 'object', additionalProperties: false },
          post: { '': { $inc: { value: 1 } } },
        },
      },
    },
  ],
  security: [],
  open: [],
};

/** Exercise tool operations against the actual credential/session and native registry owners. */
test('native MCP reads acts commits and reflects visible types', async () => {
  const temporary = new URL('../../../temp/', import.meta.url);
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL('native-mcp-data-', temporary)));
  const routes = createTwpHttpRoutes();
  let registeredResolve = () => {};
  const registered = new Promise<void>((resolve) => {
    registeredResolve = resolve;
  });
  const register = routes.register;
  routes.register = (path, handler) => {
    const retire = register(path, handler);
    registeredResolve();
    return retire;
  };
  const runtime = await openNativeRuntime({
    id: 'native-mcp',
    directory,
    credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'smoke-password' },
    modules: [
      nativeSystemManifest(),
      nativeMcpManifest(routes),
      (await prefabModule()).manifest,
      counter,
    ],
  });
  try {
    const session = await runtime.instance.openSession(runtime.instance.setupCredential);
    const tools = await createMcpSession(session);
    const server = createNativeMcpServer(tools);
    try {
      await tools.set_node({ node: { $path: '/sys/mcp/catalog', $type: 't.system' } });
      await tools.set_node({ node: { $path: '/mcp-data', $type: 't.dir' } });
      await tools.set_node({ node: { $path: '/mcp-counter', $type: 'mcp.counter', value: 0 } });
      await tools.set_node({
        node: {
          $path: '/mcp-prefab',
          $type: 't.prefab',
          mod: 'demo',
          name: 'sample',
          nodes: [
            { $path: '.', $type: 't.dir', label: 'template' },
            { $path: 'child', $type: 't.dir', label: 'child' },
          ],
        },
      });
      assert.equal((await tools.get_node({ path: '/mcp-data' })).copies.length, 1);
      assert.equal((await tools.list_children({ path: '/' })).list.length > 0, true);
      const catalog = await tools.catalog();
      assert.equal(Array.isArray(catalog.value), true);
      const description = await tools.describe_type({ type: 't.dir' });
      assert.equal(typeof description.value, 'object');
      const search = await tools.search_types({ query: 't.dir' });
      assert.equal(Array.isArray(search.value), true);
      await tools.execute({ path: '/sys/mcp/catalog', action: 'catalog', args: {} });
      await tools.set_node({
        node: {
          $path: '/mcp-service',
          $type: 'mcp.server',
          url: '/mcp',
          systemPath: '/sys/mcp/catalog',
        },
      });
      const service = (await tools.get_node({ path: '/mcp-service' })).copies[0];
      if ('error' in service) throw service.error;
      await tools.commit({
        expect: { nodes: [{ path: service.node.$path, rev: service.node.$rev }] },
        changes: [
          {
            op: 'patch',
            path: service.node.$path,
            ops: {
              $set: { $acl: [{ subject: { group: `n:${service.node.$id}` }, grant: R | W | A }] },
            },
          },
        ],
      });
      await tools.commit({ changes: [{ op: 'move', from: '/mcp-service', to: '/sys/autostart' }] });
      await registered;
      const http = createTwpHttpServer({
        instance: runtime.instance,
        routes,
        allowedOrigins: [],
        credentialTtlMs: 60_000,
      });
      http.server.listen(0, '127.0.0.1');
      await once(http.server, 'listening');
      const address = http.server.address();
      if (address === null || typeof address === 'string') throw Error('Missing HTTP address');
      const client = new Client({ name: 'native-mcp-test', version: '1.0.0' });
      const credential = runtime.instance.setupCredential;
      if (credential === undefined) throw Error('Missing credential');
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
            requestInit: { headers: { authorization: `Bearer ${credential.token}` } },
          }),
        );
        const opId = {
          epoch: runtime.instance.writer.intake.epoch,
          time: Date.now(),
          nonce: 'public-counter-once',
        };
        const request = {
          name: 'execute',
          arguments: { path: '/mcp-counter', action: 'increment', args: {}, opId },
        };
        assert.equal((await client.callTool(request)).isError, undefined);
        assert.equal((await client.callTool(request)).isError, undefined);
        const counted = (await tools.get_node({ path: '/mcp-counter' })).copies[0];
        if ('error' in counted) throw counted.error;
        assert.equal(counted.node.value, 1);
        const listed = await client.listTools();
        assert.equal(
          listed.tools.some((tool) => tool.name === 'get_node'),
          true,
        );
        assert.equal(
          listed.tools.some((tool) => tool.name === 'deploy_prefab'),
          true,
        );
        assert.equal(
          (
            await client.callTool({
              name: 'deploy_prefab',
              arguments: { source: '/mcp-prefab', target: '/mcp-data/copy' },
            })
          ).isError,
          undefined,
        );
        const copied = (await tools.get_node({ path: '/mcp-data/copy/child' })).copies[0];
        if ('error' in copied) throw copied.error;
        assert.equal(copied.node.label, 'child');
        assert.ok(copied.node.$prefab);
        assert.equal(
          (
            await client.callTool({
              name: 'execute',
              arguments: {
                path: '/mcp-prefab',
                action: 'pull',
                args: { target: '/mcp-data/copy' },
              },
            })
          ).isError,
          undefined,
        );
        const read = await client.callTool({ name: 'get_node', arguments: { path: '/mcp-data' } });
        assert.equal(read.isError, undefined);
        assert.equal(
          (
            await client.callTool({
              name: 'execute',
              arguments: { path: '/sys/mcp/catalog', action: 'catalog', args: {} },
            })
          ).isError,
          undefined,
        );
        assert.equal(
          (await client.callTool({ name: 'catalog', arguments: {} })).isError,
          undefined,
        );
        const committed = await client.callTool({
          name: 'set_node',
          arguments: { path: '/mcp-data/child', type: 't.dir', fields: {} },
        });
        assert.equal(committed.isError, undefined);
        assert.equal((await tools.get_node({ path: '/mcp-data/child' })).copies.length, 1);
        const account = (await tools.get_node({ path: '/admin' })).copies[0];
        if ('error' in account) throw account.error;
        const issued = prepareCredential(account.node.$id, {
          expiresAt: Date.now() + 60_000,
          scope: ['/mcp-data'],
        });
        await tools.set_node({ node: issued.node });
        const scoped = new Client({ name: 'scoped-mcp', version: '1.0.0' });
        try {
          await scoped.connect(
            new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
              requestInit: { headers: { authorization: `Bearer ${issued.credential.token}` } },
            }),
          );
          assert.equal(
            (await scoped.callTool({ name: 'get_node', arguments: { path: '/mcp-data' } })).isError,
            undefined,
          );
          const refused = await scoped.callTool({
            name: 'get_node',
            arguments: { path: '/admin' },
          });
          assert.equal(refused.isError, true);
          const content = refused.content;
          if (!Array.isArray(content) || content[0].type !== 'text')
            throw Error('Missing MCP error content');
          assert.equal(JSON.parse(content[0].text).code, 'NOT_FOUND');
        } finally {
          await scoped.close();
        }
      } finally {
        await client.close();
        await http.close();
      }
      await tools.remove_node({ path: '/mcp-data' });
      assert.equal((await tools.list_children({ path: '/mcp-data' })).list.length, 0);
    } finally {
      await server.close();
    }
  } finally {
    await runtime.close();
  }
});
