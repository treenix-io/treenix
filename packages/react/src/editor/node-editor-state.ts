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

// $rev synced from `latest` (live React state) — JSON textarea doesn't auto-refresh.
export async function saveNodeEditorJson(
  jsonText: string,
  setFn: (node: NodeData) => Promise<NodeData>,
  latest?: NodeData,
): Promise<string> {
  const parsed = parseNodeEditorJson(jsonText);
  if (latest?.$rev !== undefined) (parsed as Record<string, unknown>).$rev = latest.$rev;
  const fresh = await setFn(parsed);
  return getNodeEditorJsonText(fresh);
}
