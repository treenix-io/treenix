import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { it } from 'node:test';
import type { Frame } from '#kernel/types';
import { writeSse } from '#server/http-twp';

it(
  'idle event streams send comments and stop their heartbeat on completion or cancellation',
  { timeout: 3000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    for (const cancel of [false, true]) {
      const controller = new AbortController();
      let release = () => {};
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      async function* frames(): AsyncGenerator<Frame> {
        await ready;
        yield { t: 'done', req: 'after-idle' };
      }
      let acceptResponse = (_response: ServerResponse) => {};
      const accepted = new Promise<ServerResponse>((resolve) => {
        acceptResponse = resolve;
      });
      const server = createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.flushHeaders();
        acceptResponse(response);
        void writeSse(response, frames(), controller.signal).then(
          () => response.end(),
          (error: unknown) => {
            if (!controller.signal.aborted || error !== controller.signal.reason) {
              console.error(error);
              response.destroy();
            } else response.end();
          },
        );
      });
      t.after(async () => {
        controller.abort();
        release();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address !== null && typeof address === 'object');
      const response = await fetch(`http://127.0.0.1:${address.port}/`);
      assert.ok(response.body);
      const reader = response.body.getReader();
      const outgoing = await accepted;
      const socket = outgoing.socket;
      assert.ok(socket);
      t.mock.timers.tick(15_000);
      const heartbeat = await reader.read();
      assert.equal(heartbeat.done, false);
      const comment = new TextDecoder().decode(heartbeat.value);
      assert.ok(comment.startsWith(':') && comment.endsWith('\n\n'));
      assert.equal(comment.includes('data:'), false);

      if (cancel) {
        controller.abort(new Error('Reader disconnected'));
        const before = socket.bytesWritten;
        t.mock.timers.tick(150_000);
        assert.equal(socket.bytesWritten, before);
      }
      release();
      let events = '';
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        events += new TextDecoder().decode(next.value);
      }
      assert.equal(events, cancel ? '' : 'data: {"t":"done","req":"after-idle"}\n\n');
      const before = socket.bytesWritten;
      t.mock.timers.tick(150_000);
      assert.equal(socket.bytesWritten, before);
      reader.releaseLock();
    }
  },
);
