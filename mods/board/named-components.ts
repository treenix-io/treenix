import { type ComponentData, getComponents, type NodeData } from '@treenx/core';

export function getNamedComponents(node: NodeData): [string, ComponentData][] {
  return getComponents(node).slice(1);
}
