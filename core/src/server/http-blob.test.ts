import assert from 'node:assert/strict';
import { once } from 'node:events';
import { it } from 'node:test';
import { createMemoryBlobStore } from '#kernel/blob-store-memory';
import { createInstanceFoundation } from '#kernel/instance';
import { createMemoryStore } from '#kernel/store/memory';
import type { BlobStore, Position, Operation } from '#kernel/types';
import { createTwpHttpServer } from '#server/http-twp';
import { openTwpHttp } from '#client/http-twp';
import { KernelError } from '#errors';

it('serves HTML as an authenticated attachment through the actual lane transfers', async (t) => {
  const root = createMemoryStore({ domain: 'http-blob' }),
    seen: Operation[] = [];
  let saved: Position | undefined,
    puts = 0,
    refuseUpload = false;
  const memory = createMemoryBlobStore();
  const blobs: BlobStore = {
    ...memory,
    async put(id, parts, type) {
      puts++;
      return memory.put(id, parts, type);
    },
  };
  const instance = await createInstanceFoundation({
    id: 'http-blob',
    root,
    blobs,
    writerEpoch: 1,
    counter: {
      async load() {
        return saved;
      },
      async save(pos) {
        saved = pos;
      },
      async freshEpoch(floor) {
        return floor + 1;
      },
    },
    domains: [{ store: root, epoch: 'http-blob', persistent: true }],
    firstAdmin: { path: '/admin', name: 'admin', password: 'http-blob-password' },
    initialCredential: { ttlMs: 60_000 },
    gates: [
      async (operation) => {
        seen.push(operation);
        return refuseUpload && operation.kind === 'upload' ? { refuse: 'REFUSED' } : 'pass';
      },
    ],
  });
  assert.ok(instance.setupCredential);
  const http = createTwpHttpServer({ instance, credentialTtlMs: 60_000, allowedOrigins: [] });
  http.server.listen(0, '127.0.0.1');
  await once(http.server, 'listening');
  const address = http.server.address();
  assert.ok(address !== null && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const connection = await openTwpHttp({ url, credential: instance.setupCredential });
  t.after(async () => {
    connection.close();
    await http.close();
    await instance.close();
    root.close();
  });
  const text = '<script>alert(1)</script>';
  async function* parts() {
    yield new TextEncoder().encode(text);
  }
  const ref = await connection.upload(parts(), 'text/html');
  assert.equal(ref.type, 'text/html');
  assert.equal(ref.size, Buffer.byteLength(text));
  const admin = instance.commands(await instance.auth.openCredential(instance.setupCredential));
  t.after(() => admin.close());
  await admin.commit({
    opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: 'file' },
    changes: [{ op: 'put', node: { $path: '/file', $type: 't.dir', body: ref } }],
  });
  const headers = {
    Authorization: `Bearer ${instance.setupCredential.token}`,
    'TWP-Lane': connection.lane,
    'TWP-Path': '/file',
    'TWP-Field': 'body',
  };
  const response = await fetch(`${url}/twp/blob`, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-disposition'), 'attachment');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await response.text(), text);
  const denied = await fetch(`${url}/twp/blob`, {
    headers: { ...headers, Authorization: 'Bearer wrong' },
  });
  assert.equal(denied.status, 401);
  const originDenied = await fetch(`${url}/twp/blob`, {
    method: 'POST',
    body: text,
    headers: {
      ...headers,
      Origin: 'https://untrusted.invalid',
      'Content-Type': 'text/html',
    },
  });
  assert.equal(originDenied.status, 403);
  const uploadDenied = await fetch(`${url}/twp/blob`, {
    method: 'POST',
    body: text,
    headers: {
      ...headers,
      Authorization: 'Bearer wrong',
      'Content-Type': 'text/html',
    },
  });
  assert.equal(uploadDenied.status, 401);
  assert.equal(puts, 1);
  refuseUpload = true;
  await assert.rejects(
    connection.upload(parts(), 'text/html'),
    (error) => error instanceof KernelError && error.code === 'REFUSED',
  );
  assert.equal(puts, 1);
  refuseUpload = false;
  assert.ok(seen.some((operation) => operation.kind === 'upload'));
  assert.ok(seen.some((operation) => operation.kind === 'download'));
  const collected: Uint8Array[] = [];
  for await (const part of connection.download('/file', 'body')) collected.push(part);
  assert.equal(Buffer.concat(collected).toString(), text);
  await admin.commit({
    opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: 'blob-quota' },
    changes: [{ op: 'put', node: { $path: '/sys/limits', $type: 't.limits', blobBytes: 2 } }],
  });
  async function* tooLarge() {
    yield new Uint8Array([1, 2, 3]);
  }
  await assert.rejects(
    connection.upload(tooLarge(), 'application/octet-stream'),
    (error) => error instanceof KernelError && error.code === 'BUDGET',
  );
  async function* small() {
    yield new Uint8Array([1, 2]);
  }
  assert.equal((await connection.upload(small(), 'application/octet-stream')).size, 2);
});
