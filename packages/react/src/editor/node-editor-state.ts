import type { NodeData } from '@treenx/core';

export function getNodeEditorJsonText(node: NodeData): string {
  return JSON.stringify(node, null, 2);
}

export function parseNodeEditorJson(text: string): NodeData {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON: ${reason}`);
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

// After save, returned $rev is bumped by the server. We must re-derive the editor
// text from the fresh node, otherwise a second save reuses the stale OCC token
// and the server rejects with CONFLICT (Expected $rev N+1, got N).
export async function saveNodeEditorJson(
  jsonText: string,
  setFn: (node: NodeData) => Promise<NodeData>,
): Promise<string> {
  const parsed = parseNodeEditorJson(jsonText);
  const fresh = await setFn(parsed);
  return getNodeEditorJsonText(fresh);
}
