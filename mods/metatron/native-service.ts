import { KernelError } from '@treenx/core/errors';
import type { Session } from '@treenx/core/kernel/types';
import { uniqueMentionPaths } from '#metatron/mentions';

const SENSITIVE = /(password|secret|token|key|hash|credentials|apiKey|api_key)/i;

/** Redact the LLM export boundary while retaining the native reader's own permission projection. */
function summarize(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  if (Array.isArray(value)) return value.map(summarize);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => (key === '$type' || !key.startsWith('$')) && !SENSITIVE.test(key))
    .map(([key, field]) => [key, summarize(field)]));
  return value;
}

/** Resolve references through the actual service node session, never a creator's impersonated claims. */
export async function resolveNativeContext(session: Session, prompts: readonly string[]): Promise<string> {
  const paths = [...new Set(prompts.flatMap(uniqueMentionPaths))].slice(0, 5);
  if (paths.length === 0) return '';
  const sections: string[] = [];
  for (const path of paths) {
    try {
      const result = await session.read({ node: path });
      const copy = result.copies[0];
      if ('error' in copy) throw copy.error;
      sections.push(`### ${path}\n\`\`\`json\n${JSON.stringify(summarize(copy.node), null, 2)}\n\`\`\``);
    } catch (error) {
      if (!(error instanceof KernelError) || error.code !== 'NOT_FOUND') throw error;
      sections.push(`### ${path}\n(not found or access denied)`);
    }
  }
  return `\n\n## Referenced Nodes\n\n${sections.join('\n\n')}`;
}
