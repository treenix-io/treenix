import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, relative, resolve } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { openTwpHttp } from '#client/http-twp'
import { createTwpClient } from '#client/twp'
import type { Credential } from '#kernel/types'
import { isRecord } from '#util/is-record'

const children: ChildProcess[] = []

/** Keep configuration and storage evidence in independent test directories. */
async function scratch(): Promise<string> {
  const parent = resolve('../../temp/native-cli-mount-config')
  await mkdir(parent, { recursive: true })
  return mkdtemp(join(parent, 'dataset-'))
}

/** Launch the actual CLI with bounded owned process lifetime and structured error observation. */
function run(configPath: string) {
  const child = fork(fileURLToPath(new URL('./native-main-process-fixture.ts', import.meta.url)), [configPath], {
    execArgv: ['--conditions=development', '--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    signal: AbortSignal.timeout(10_000),
    env: { ...process.env, NODE_OPTIONS: '', VSCODE_INSPECTOR_OPTIONS: '' },
  })
  children.push(child)
  let stderr = ''
  assert.ok(child.stderr)
  child.stderr.on('data', data => { stderr += data.toString() })
  const exited = once(child, 'exit')
  return { child, exited, stderr: () => stderr }
}

/** Make early process termination fail at its source rather than hanging for a message. */
async function report(running: ReturnType<typeof run>): Promise<Record<string, unknown>> {
  const message = await Promise.race([
    once(running.child, 'message'),
    running.exited.then(([code]) => { throw new Error(`CLI exited before reporting: ${code}: ${running.stderr()}`) }),
  ])
  const value: unknown = message[0]
  assert.ok(isRecord(value))
  return value
}

/** Resolve only a genuine listen report, preserving startup errors as failures. */
async function start(configPath: string) {
  const running = run(configPath)
  const message = await report(running)
  assert.equal(message.type, 'info', running.stderr())
  assert.ok(Array.isArray(message.values) && isRecord(message.values[1]))
  assert.equal(typeof message.values[1].port, 'number')
  const address = `http://127.0.0.1:${message.values[1].port}`

  return {
    address,
    async close(): Promise<void> {
      assert.equal(running.child.kill('SIGTERM'), true)
      assert.deepEqual(await running.exited, [0, null], running.stderr())
      assert.equal(running.stderr(), '')
    },
  }
}

/** Authenticate through the real native credential endpoint. */
async function login(address: string): Promise<Credential> {
  const response = await fetch(`${address}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: '/admin', password: 'cli-password' }),
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(response.status, 200)
  const value: unknown = await response.json()
  assert.ok(isRecord(value) && typeof value.token === 'string')
  return { token: value.token }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    }
  }
})

describe('native CLI mount directory configuration', { timeout: 45_000 }, () => {
  it('rejects malformed optional capabilities as INVALID before acquiring root storage', async () => {
    for (const mountDirectories of [null, [], 'data', { data: 1 }, { data: '' }, { data: null }]) {
      const directory = await scratch()
      const configPath = join(directory, 'config.json')
      await writeFile(configPath, JSON.stringify({ id: 'cli-invalid', directory: './root', credentialTtlMs: 60_000,
        allowedOrigins: [], port: 0, firstAdmin: { path: '/admin', name: 'admin', password: 'cli-password' }, mountDirectories }))
      const running = run(configPath)
      const error = await report(running)

      assert.equal(error.type, 'error')
      assert.equal(error.code, 'INVALID')
      assert.deepEqual(await running.exited, [1, null])
      assert.deepEqual(await readdir(directory), ['config.json'])
    }
  })

  it('binds a relative host directory through a genuine declaring-node mount after CLI restart', async () => {
    const directory = await scratch()
    const configuration = join(directory, 'configuration')
    const hostData = join(directory, 'host-data')
    await mkdir(configuration)
    await mkdir(hostData)
    await writeFile(join(hostData, 'doc.json'), JSON.stringify({ $type: 't.dir', marker: 'physical-data' }))
    const configPath = join(configuration, 'config.json')
    await writeFile(configPath, JSON.stringify({ id: 'cli-mounted', directory: '../root', credentialTtlMs: 60_000,
      allowedOrigins: [], port: 0, firstAdmin: { path: '/admin', name: 'admin', password: 'cli-password' },
      mountDirectories: { data: '../host-data' } }))

    const first = await start(configPath)
    const connection = await openTwpHttp({ url: first.address, credential: await login(first.address) })
    const errors: unknown[] = []
    const client = createTwpClient(connection, { close: connection.close, onError: error => errors.push(error) })
    await client.ready
    try {
      const accepted = await client.commit({ changes: [{ op: 'put', node: { $path: '/data', $type: 't.dir',
        '#mount': { $type: 't.mount.fs', pattern: '', directory: 'data', external: 'none' },
        '#groups': { $type: 't.groups', list: ['admins'] } } }] }).outcome
      assert.ok(accepted.pos)
      assert.equal(errors.length, 0)
    } finally {
      client.close()
      await first.close()
    }

    const second = await start(configPath)
    const reopenedConnection = await openTwpHttp({ url: second.address, credential: await login(second.address) })
    const reopened = createTwpClient(reopenedConnection, { close: reopenedConnection.close, onError: error => errors.push(error) })
    await reopened.ready
    try {
      const result = await reopened.read({ node: '/data/doc' })
      assert.equal(result.copies.length, 1)
      const copy = result.copies[0]
      assert.ok('node' in copy)
      assert.equal(copy.node.$id, 'p:/data/doc')
      assert.equal(copy.node.marker, 'physical-data')
      assert.equal(errors.length, 0)
      assert.deepEqual(JSON.parse(await readFile(join(hostData, 'doc.json'), 'utf8')), { $type: 't.dir', marker: 'physical-data' })
      assert.ok((await readdir(hostData)).includes('.treenix'))
    } finally {
      reopened.close()
      await second.close()
    }
  })
})

describe('native CLI action I/O configuration', { timeout: 45_000 }, () => {
  it('rejects malformed deployment entries before acquiring persistent resources', async () => {
    for (const io of [null, [], 'provider', { entry: 1 }, { entry: '' }]) {
      const directory = await scratch();
      const configPath = join(directory, 'config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          id: 'cli-io-invalid',
          directory: './root',
          credentialTtlMs: 60_000,
          allowedOrigins: [],
          modules: [],
          port: 0,
          io,
        }),
      );
      const running = run(configPath);
      const error = await report(running);
      assert.equal(error.type, 'error');
      assert.equal(error.code, 'INVALID');
      assert.deepEqual(await running.exited, [1, null]);
      assert.deepEqual(await readdir(directory), ['config.json']);
    }
  });

  it('requires a callable named binding before acquiring persistent resources', async () => {
    for (const source of ['export const other = 1', 'export const bindIo = 1']) {
      const directory = await scratch();
      await writeFile(join(directory, 'provider.mjs'), source);
      const configPath = join(directory, 'config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          id: 'cli-io-export',
          directory: './root',
          credentialTtlMs: 60_000,
          allowedOrigins: [],
          modules: [],
          port: 0,
          io: { entry: './provider.mjs' },
        }),
      );
      const running = run(configPath);
      const error = await report(running);
      assert.equal(error.type, 'error');
      assert.equal(error.code, 'INVALID');
      assert.deepEqual(await running.exited, [1, null]);
      assert.deepEqual((await readdir(directory)).sort(), ['config.json', 'provider.mjs']);
    }
  });

  it('resolves a relative entry and invokes its real provider through the stock CLI', async (t) => {
    const received: string[] = [];
    const provider = createServer(async (request, response) => {
      let input = '';
      for await (const data of request) input += data.toString();
      received.push(input);
      response.end(`external:${input}`);
    });
    await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
    t.after(
      () =>
        new Promise<void>((done, reject) =>
          provider.close((error) => (error === undefined ? done() : reject(error))),
        ),
    );
    const address = provider.address();
    assert.ok(address !== null && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const directory = await scratch();
    const configuration = join(directory, 'configuration');
    await mkdir(configuration);
    const entry = relative(
      configuration,
      fileURLToPath(new URL('./native-main-io-fixture.ts', import.meta.url)),
    );
    const configPath = join(configuration, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        id: 'cli-io-live',
        directory: '../root',
        credentialTtlMs: 60_000,
        allowedOrigins: [],
        port: 0,
        firstAdmin: { path: '/admin', name: 'admin', password: 'cli-password' },
        modules: [{ id: 'cli-io-fixture', entry }],
        io: { entry },
      }),
    );
    const running = await start(configPath);
    const connection = await openTwpHttp({
      url: running.address,
      credential: await login(running.address),
    });
    const errors: unknown[] = [];
    const client = createTwpClient(connection, {
      close: connection.close,
      onError: (error) => errors.push(error),
    });
    await client.ready;
    try {
      await client.commit({ changes: [{ op: 'put', node: { $path: '/worker', $type: 'cli.io' } }] })
        .outcome;
      const outcome = await client.act({
        path: '/worker',
        action: 'exchange',
        args: { endpoint, input: 'owned-request' },
      }).outcome;
      assert.equal(outcome.value, 'external:owned-request');
      assert.ok(outcome.pos);
      assert.deepEqual(received, ['owned-request']);
      assert.deepEqual(errors, []);
    } finally {
      client.close();
      await running.close();
    }
  });
});
