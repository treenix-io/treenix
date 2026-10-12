import { assertValidType, safeJsonParse } from '#core/json';
import { isRecord } from '#util/is-record';
import { KernelError } from '#errors';
import type { NodeData } from '#core';
import { extname } from 'node:path';

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
  '.json': 'application/json', '.xml': 'application/xml', '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.csv': 'text/csv', '.txt': 'text/plain', '.md': 'text/markdown',
  '.html': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript',
  '.py': 'text/x-python', '.sh': 'text/x-shellscript',
  '.env': 'application/x-env',
};

export const rawFsMimeTypes = [...new Set(Object.values(MIME)), 'application/octet-stream'];

export function getMime(filename: string): string {
  return MIME[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}


/** Pure text codecs receive bytes only after their physical owner charges the read. */
export type RawFsCodecNode = Pick<NodeData, '$path' | '$type'> & Readonly<Record<string, unknown>>;

export interface RawFsTextCodec {
  readonly type: string;
  /** Fields stored in the authored file; other components retain their own metadata. */
  readonly fields: readonly string[];
  decode(text: string, path: string, outerPath: string): RawFsCodecNode | Promise<RawFsCodecNode>;
  encode(node: RawFsCodecNode, outerPath: string): string | Promise<string>;
}
export type RawFsCodecs = Readonly<Record<string, RawFsTextCodec>>;

/** Parse JSON at the file boundary while preserving every authored field. */
export function decodeJsonBody(text: string, defaultType = 'application/json'): Record<string, unknown> & Pick<NodeData, '$type'> {
  const body: unknown = safeJsonParse(text);
  if (!isRecord(body)) throw new KernelError('INVALID', 'JSON file requires an object');
  const type = body.$type ?? defaultType;
  assertValidType(type);
  return { ...body, $type: type };
}
