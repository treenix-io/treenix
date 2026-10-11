import { resolve } from 'node:path';
import { KernelError } from '#errors';
import { isRecord } from '#util/is-record';

export interface NativeRootStorage {
  readonly directory: string;
  readonly baseDirectory?: string;
  readonly seedFilter?: readonly string[];
}

/** Resolve the existing root mount without importing the retiring mount registry. */
export function nativeRootStorage(value: unknown, cwd: string): NativeRootStorage {
  if (!isRecord(value) || value.$path !== '/' || value.$type !== 'root')
    throw new KernelError('INVALID', 'Native boot requires a root configuration');
  if (value.seeds !== undefined && (!Array.isArray(value.seeds)
    || !value.seeds.every((name: unknown): name is string => typeof name === 'string')))
    throw new KernelError('INVALID', 'Root seeds must be module names');
  const seedFilter = value.seeds;

  const mount = value['#mount'];
  if (!isRecord(mount)) throw new KernelError('INVALID', 'Root mount is missing');

  /** Root paths retain the legacy launcher contract: relative to the server working directory. */
  function directory(component: unknown): string {
    if (!isRecord(component) || component.$type !== 't.mount.fs'
      || typeof component.root !== 'string' || component.root.length === 0)
      throw new KernelError('INVALID', 'Native root storage requires filesystem layers');

    return resolve(cwd, component.root);
  }

  if (mount.$type === 't.mount.fs') return { directory: directory(mount), seedFilter };

  if (mount.$type !== 't.mount.overlay' || !Array.isArray(mount.layers)
    || mount.layers.length !== 2 || !mount.layers.every((name: unknown) => typeof name === 'string'))
    throw new KernelError('INVALID', 'Native root overlay requires a base and a writable layer');

  const baseDirectory = directory(value[`#${mount.layers[0]}`]);
  const writable = directory(value[`#${mount.layers[1]}`]);
  if (baseDirectory === writable)
    throw new KernelError('INVALID', 'Root overlay layers must have distinct directories');

  return { directory: writable, baseDirectory, seedFilter };
}
