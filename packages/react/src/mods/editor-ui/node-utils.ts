import type { PresentationNode } from '#tree/presentation';
import { getComponents as getComps, type ComponentData } from '@treenx/core';
import type { NativeTypeDescription } from '@treenx/core/kernel/type-description';
import type { ClientRegistry } from '#context/client-registry';

export function getComponents(node: PresentationNode): [string, ComponentData][] {
  return getComps(node).slice(1);
}

export function getPlainFields(node: PresentationNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('$')) continue;
    if (typeof v === 'object' && v !== null && '$type' in v) continue;
    out[k] = v;
  }
  return out;
}

const INTERNAL_CONTEXTS = new Set(['schema', 'mount', 'class']);

export function getViewContexts(
  registry: ClientRegistry,
  type: string,
  node?: PresentationNode,
): string[] {
  const ctxs = registry
    .contexts(type)
    .filter((c) => !INTERNAL_CONTEXTS.has(c) && !c.startsWith('action:'));
  // Also collect view contexts from component types present on the node
  if (node) {
    for (const [, comp] of getComponents(node)) {
      for (const c of registry.contexts(comp.$type)) {
        if (!INTERNAL_CONTEXTS.has(c) && !c.startsWith('action:') && !ctxs.includes(c)) {
          ctxs.push(c);
        }
      }
    }
  }
  return ctxs;
}

export function getActions(description: NativeTypeDescription | undefined): string[] {
  return description === undefined
    ? []
    : Object.keys(description.actions).filter((name) => !name.startsWith('_'));
}

export function pickDefaultContext(_type: string): string {
  return 'react:layout';
}
