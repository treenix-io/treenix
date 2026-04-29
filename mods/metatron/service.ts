// resolveContext — resolve @/path mentions in prompts into a context section.
// Uses ACL-wrapped tree scoped to the task creator's permissions.
// withAcl.get() returns undefined for denied paths — no existence leakage.

import { buildClaims, withAcl } from '@treenx/core/server/auth';
import { uniqueMentionPaths } from './mentions';

const SENSITIVE_RE = /(password|secret|token|key|hash|credentials|apiKey|api_key)/i;

export async function resolveContext(
  store: import('@treenx/core/tree').Tree,
  prompts: string[],
  createdBy: string | null,
): Promise<string> {
  const allPaths = new Set<string>();
  for (const p of prompts) {
    for (const path of uniqueMentionPaths(p)) allPaths.add(path);
  }

  if (!allPaths.size) return '';

  // ACL-scoped tree for the task creator
  const claims = createdBy ? await buildClaims(store, createdBy) : ['public'];
  const userTree = withAcl(store, createdBy, claims);

  const MAX_MENTIONS = 5;
  const paths = [...allPaths].slice(0, MAX_MENTIONS);
  const sections: string[] = [];

  for (const path of paths) {
    try {
      const node = await userTree.get(path);
      if (!node) {
        sections.push(`### ${path}\n(not found or access denied)`);
        continue;
      }
      // Include type + top-level fields, strip system and sensitive fields
      const summary: Record<string, unknown> = { $type: node.$type };
      // use getComponents for this loop
      for (const [k, v] of Object.entries(node)) {
        if (k.startsWith('$')) continue;
        if (SENSITIVE_RE.test(k)) continue;
        if (typeof v === 'object' && v && '$type' in v) {
          // Named component — filter its keys too
          const comp: Record<string, unknown> = { $type: (v as any).$type };
          for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) {
            if (ck.startsWith('$') || SENSITIVE_RE.test(ck)) continue;
            comp[ck] = typeof cv === 'string' && cv.length > 500 ? cv.slice(0, 500) + '...' : cv;
          }
          summary[k] = comp;
          continue;
        }
        if (typeof v === 'string' && v.length > 500) {
          summary[k] = v.slice(0, 500) + '...';
        } else {
          summary[k] = v;
        }
      }
      sections.push(`### ${path}\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``);
    } catch {
      sections.push(`### ${path}\n(error reading node)`);
    }
  }

  return '\n\n## Referenced Nodes\n\n' + sections.join('\n\n');
}
