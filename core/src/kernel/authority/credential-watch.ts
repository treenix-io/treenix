import { isDeepStrictEqual } from 'node:util';
import { ancestorPaths } from '#core/path';
import type { AuthEvent } from '#kernel/auth-factory';
import { typeReadVersion } from '#kernel/preconditions';
import { readerRightsInput, type ReaderSource } from '#kernel/reader';
import type { Registry, ScanRange } from '#kernel/types';

interface CredentialWatchOptions {
  readonly path: string;
  readonly registry: Registry;
  readonly source: () => ReaderSource;
  readonly observe: (listener: (event: AuthEvent) => void) => () => void;
  readonly topology: (listener: (intersects: (range: ScanRange) => boolean) => void) => () => void;
}

/** Uses the Reader's accepted rights projections without reading credential bodies. */
export function observeCredential(
  options: CredentialWatchOptions,
  changed: () => void,
): () => void {
  const paths = new Set(ancestorPaths(options.path));
  let ids = new Set<string | undefined>();
  function snapshot() {
    const source = options.source(),
      target = source.resolve(options.path);
    const chain = target.chain(options.path);
    ids = new Set(chain.map((node) => node.id));
    const types = new Set(chain.flatMap((node) => node.types));
    return {
      credentialId: chain.find((node) => node.path === options.path)?.id,
      target: { id: target.id, domain: target.store.domain },
      rights: [...paths].map((path) =>
        readerRightsInput(
          chain.find((node) => node.path === path),
          options.registry,
        ),
      ),
      types: [...types].sort().map((name) => typeReadVersion(options.registry, name)),
    };
  }
  let current = snapshot();
  function refresh(force: boolean): void {
    const next = snapshot();
    const different = !isDeepStrictEqual(current, next);
    current = next;
    if (force || different) changed();
  }
  const unobserve = options.observe((event) => {
    if (event.t === 'registry') {
      refresh(false);
      return;
    }
    if (event.t === 'faults') {
      if (event.changes.some((change) => paths.has(change.path))) refresh(true);
      return;
    }
    if (
      !event.changes.some(
        (change) => ids.has(change.id) || (change.node !== null && paths.has(change.node.$path)),
      )
    )
      return;
    refresh(
      event.changes.some(
        (change) =>
          change.node?.$path === options.path ||
          (change.node === null && change.id === current.credentialId),
      ),
    );
  });
  const untarget = options.topology((intersects) => {
    if (intersects({ node: options.path })) refresh(true);
  });
  return () => {
    unobserve();
    untarget();
  };
}
