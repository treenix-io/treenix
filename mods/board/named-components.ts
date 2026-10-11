import type { PresentationNode } from '@treenx/react';
import { type ComponentData, getComponents, type NodeData } from '@treenx/core';

export function getNamedComponents(node: PresentationNode): [string, ComponentData][] {
  return getComponents(node).slice(1);
}
