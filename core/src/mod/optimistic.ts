// Treenix Optimistic Updates — predict locally, reconcile with server
// Component class methods are the shared kernel: same code runs on client (optimistic)
// and server (authoritative). Server patches confirm or override.

import { getComponent, type NodeData } from '#core';

export interface PendingMutation {
  id: string;
  path: string;
  compType: string;
  action: string;
  predicted: NodeData;
  baseline: NodeData;
  method: (target: any, data: unknown) => void;
  data: unknown;
  createdAt: number;
}

export class OptimisticBuffer {
  private pending = new Map<string, PendingMutation[]>();
  private idCounter = 0;

  // Apply an action optimistically: clone node, run method, tree prediction
  apply(
    node: NodeData,
    compType: string,
    action: string,
    method: (target: any, data: unknown) => void,
    data: unknown,
  ): { predicted: NodeData; mutationId: string } {
    const baseline = structuredClone(node);
    const draft = structuredClone(node);

    // Find the component (or node itself) matching compType
    const target = getComponent(draft, compType);
    if (!target) throw new Error(`Component "${compType}" not found on node ${node.$path}`);

    method(target, data);

    const id = `opt_${++this.idCounter}_${Date.now()}`;
    const mutation: PendingMutation = {
      id,
      path: node.$path,
      compType,
      action,
      predicted: draft,
      baseline,
      method,
      data,
      createdAt: Date.now(),
    };

    if (!this.pending.has(node.$path)) this.pending.set(node.$path, []);
    this.pending.get(node.$path)!.push(mutation);

    return { predicted: draft, mutationId: id };
  }

  // Server confirmed a new state. Reconcile with pending mutations.
  // Returns the node to use and whether any rollback happened.
  confirm(path: string, serverNode: NodeData): { node: NodeData; rolledBack: boolean } {
    const mutations = this.pending.get(path);
    if (!mutations || mutations.length === 0) {
      return { node: serverNode, rolledBack: false };
    }

    // Find the first pending mutation that this server update might confirm
    const first = mutations[0];

    // Compare server result with our prediction
    if (nodesMatch(serverNode, first.predicted)) {
      // Prediction was correct — drop this mutation
      mutations.shift();
      if (mutations.length === 0) this.pending.delete(path);

      // If more pending mutations, rebase them on the confirmed state
      if (mutations.length > 0) {
        return { node: this.rebase(path, serverNode), rolledBack: false };
      }
      return { node: serverNode, rolledBack: false };
    }

    // Prediction was wrong — server wins, drop ALL pending for this path
    this.pending.delete(path);
    return { node: serverNode, rolledBack: true };
  }

  // Rebase remaining mutations on top of a new base state
  private rebase(path: string, base: NodeData): NodeData {
    const mutations = this.pending.get(path);
    if (!mutations || mutations.length === 0) return base;

    // Replay each pending mutation on top of the new base
    let current = base;
    const surviving: PendingMutation[] = [];

    for (const m of mutations) {
      try {
        const draft = structuredClone(current);
        const target = getComponent(draft, m.compType);
        if (!target) continue;

        m.method(target, m.data);
        m.baseline = current;
        m.predicted = draft;
        current = draft;
        surviving.push(m);
      } catch {
        // Mutation no longer valid on new base — drop it
      }
    }

    if (surviving.length === 0) this.pending.delete(path);
    else this.pending.set(path, surviving);

    return current;
  }

  // Confirm a specific mutation by ID
  confirmById(mutationId: string): boolean {
    for (const [path, mutations] of this.pending) {
      const idx = mutations.findIndex(m => m.id === mutationId);
      if (idx !== -1) {
        mutations.splice(idx, 1);
        if (mutations.length === 0) this.pending.delete(path);
        return true;
      }
    }
    return false;
  }

  // Rollback all pending mutations for a path
  rollback(path: string): NodeData | undefined {
    const mutations = this.pending.get(path);
    if (!mutations || mutations.length === 0) return undefined;
    const baseline = mutations[0].baseline;
    this.pending.delete(path);
    return baseline;
  }

  // Rollback a specific mutation by ID, return baseline
  rollbackById(mutationId: string): NodeData | undefined {
    for (const [path, mutations] of this.pending) {
      const idx = mutations.findIndex(m => m.id === mutationId);
      if (idx !== -1) {
        const baseline = mutations[idx].baseline;
        mutations.splice(idx, 1);
        if (mutations.length === 0) this.pending.delete(path);
        return baseline;
      }
    }
    return undefined;
  }

  // Get the optimistic view: base node with all pending mutations applied
  getOptimistic(path: string): NodeData | undefined {
    const mutations = this.pending.get(path);
    if (!mutations || mutations.length === 0) return undefined;
    return mutations[mutations.length - 1].predicted;
  }

  hasPending(path: string): boolean {
    const m = this.pending.get(path);
    return !!m && m.length > 0;
  }

  getPendingCount(path?: string): number {
    if (path) return this.pending.get(path)?.length ?? 0;
    let total = 0;
    for (const m of this.pending.values()) total += m.length;
    return total;
  }

  // Expire mutations older than maxAge ms
  expire(maxAge: number): string[] {
    const now = Date.now();
    const expired: string[] = [];

    for (const [path, mutations] of this.pending) {
      const before = mutations.length;
      const remaining = mutations.filter(m => now - m.createdAt < maxAge);
      if (remaining.length < before) {
        expired.push(...mutations.filter(m => now - m.createdAt >= maxAge).map(m => m.id));
      }
      if (remaining.length === 0) this.pending.delete(path);
      else this.pending.set(path, remaining);
    }

    return expired;
  }

  clear(): void {
    this.pending.clear();
  }
}

// ── Helpers ──


// Deep equality check for node data (ignoring $rev which server increments)
function nodesMatch(a: NodeData, b: NodeData): boolean {
  const aClean = withoutRev(a);
  const bClean = withoutRev(b);
  return JSON.stringify(aClean) === JSON.stringify(bClean);
}

function withoutRev(node: NodeData): Record<string, unknown> {
  const { $rev, ...rest } = node as any;
  return rest;
}
