import { type ComponentData, getComponents, type NodeData } from '@treenity/core';

export function getNamedComponents(node: NodeData): [string, ComponentData][] {
  return getComponents(node).slice(1);
}
