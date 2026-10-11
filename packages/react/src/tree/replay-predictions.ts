/** Replay synchronous predictions atomically; failed or asynchronous candidates never become visible. */
export function replayPredictions<Node extends object, Operation>(
  confirmed: Node,
  operations: readonly Operation[],
  apply: (candidate: Node, operation: Operation) => unknown,
  failed: (operation: Operation, error: unknown) => void,
  asynchronous: (operation: Operation) => void,
): Node {
  let draft = structuredClone(confirmed);

  for (const operation of operations) {
    const candidate = structuredClone(draft);
    try {
      const result = apply(candidate, operation);
      if (result !== null && (typeof result === 'object' || typeof result === 'function')
          && 'then' in result && typeof result.then === 'function') {
        Promise.resolve(result).catch(error => failed(operation, error));
        asynchronous(operation);
        continue;
      }

      draft = candidate;
    } catch (error) {
      failed(operation, error);
    }
  }

  return draft;
}
