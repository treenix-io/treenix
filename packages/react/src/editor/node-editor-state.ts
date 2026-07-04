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

// OCC token = the $rev already IN the text, captured when the buffer was seeded.
// Stamping the LIVE node's $rev here (pre-cnr.5 behavior) defeated OCC: stale
// textarea content sailed through with a fresh rev, silently overwriting any
// change made externally while the tab was open. Now such a save CONFLICTs and
// the caller surfaces it; repeat saves stay green because the returned text
// carries the bumped $rev and the caller re-seeds the buffer from it.
export async function saveNodeEditorJson(
  jsonText: string,
  setFn: (node: NodeData) => Promise<NodeData>,
): Promise<string> {
  const parsed = parseNodeEditorJson(jsonText);
  const fresh = await setFn(parsed);
  return getNodeEditorJsonText(fresh);
}
