import { KernelError } from '@treenx/core/errors';
import { replayPredictions } from '#tree/replay-predictions';

interface Prediction<Node> {
  readonly apply: (candidate: Node) => unknown;
  pending: boolean;
}

interface Group<Node> {
  readonly base: Node;
  readonly operations: Map<string, Prediction<Node>>;
  draft?: Node;
}

/** Hold a captured-base presentation while its unfinished group settles; canonical updates stay independent. */
export function createPredictionGroups<Node extends { readonly $id: string }>(
  failed: (error: unknown) => void,
  asynchronous: () => void,
) {
  const groups = new Map<string, Group<Node>>();
  const listeners = new Set<(id: string) => void>();
  let version = 0;

  /** Notify only after the pending group owns its new immutable presentation. */
  function changed(id: string): void {
    version++;
    for (const listener of listeners) listener(id);
  }

  /** Add one prediction without inserting a fabricated copy or projection version into the canonical cache. */
  function push(base: Node, key: string, apply: (candidate: Node) => unknown) {
    let group = groups.get(base.$id);
    if (group === undefined) {
      group = { base, operations: new Map() };
      groups.set(base.$id, group);
    }
    if (group.operations.has(key))
      throw new KernelError('CONFLICT', 'Prediction key is already pending');

    const owned = group;
    const operation: Prediction<Node> = { apply, pending: true };
    owned.operations.set(key, operation);
    owned.draft = undefined;
    changed(base.$id);

    return {
      /** Remove refusals immediately; completed predictions remain until this unfinished display group releases. */
      settle(accepted: boolean): void {
        if (!operation.pending) return;
        operation.pending = false;
        if (!accepted) owned.operations.delete(key);
        if (![...owned.operations.values()].some((entry) => entry.pending)) groups.delete(base.$id);
        owned.draft = undefined;
        changed(base.$id);
      },
    };
  }

  return {
    push,
    get version() {
      return version;
    },
    /** Delay foreign canonical presentation while pending, then reveal the current canonical node unchanged. */
    project(node: Node): Node {
      const group = groups.get(node.$id);
      if (group === undefined) return node;
      if (group.draft === undefined)
        group.draft = replayPredictions(
          group.base,
          [...group.operations.values()],
          (candidate, operation) => operation.apply(candidate),
          (_operation, error) => failed(error),
          asynchronous,
        );
      return group.draft;
    },
    subscribe(listener: (id: string) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Release captured bodies when the authenticated source ends. */
    clear(): void {
      const ids = [...groups.keys()];
      groups.clear();
      for (const id of ids) changed(id);
      listeners.clear();
    },
  };
}
