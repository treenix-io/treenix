import type { NodeData } from '@treenity/core';

export type NodeEditorTab = 'properties' | 'json';

export function getNodeEditorJsonText(node: NodeData, tab: NodeEditorTab): string {
  return tab === 'json' ? JSON.stringify(node, null, 2) : '';
}

export function parseNodeEditorJson(text: string): NodeData {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON must be a node object');
  }

  const node = parsed as Partial<NodeData>;

  if (typeof node.$path !== 'string' || !node.$path) {
    throw new Error('JSON node must include "$path"');
  }

  if (typeof node.$type !== 'string' || !node.$type) {
    throw new Error('JSON node must include "$type"');
  }

  return node as NodeData;
}
