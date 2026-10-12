import { createReadStream, realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

const mime: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
};

/** Serve a deployment's built frontend; API admission remains with the native HTTP owner. */
export function createStaticHandler(directory: string) {
  const root = realpathSync(directory);

  return async (
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<boolean> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;

    let file = resolve(root, '.' + decodeURIComponent(pathname));
    if (file !== root && !file.startsWith(root + sep)) return false;

    try {
      if (!(await stat(file)).isFile()) file = resolve(root, 'index.html');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      if (extname(pathname) !== '') return false;
      file = resolve(root, 'index.html');
    }

    file = await realpath(file);
    if (file !== root && !file.startsWith(root + sep)) return false;

    response.writeHead(200, {
      'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
      'Cache-Control':
        extname(file) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    if (request.method === 'HEAD') response.end();
    else await pipeline(createReadStream(file), response);
    return true;
  };
}
