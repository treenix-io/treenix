// Markdown frontmatter — split a `.md` source into its YAML head and body.
// Format (Jekyll/Hugo/Next.js convention):
//   ---
//   key: value
//   ---
//   # body markdown
//
// "Front matter" comes from book printing — material that appears before the main text
// (title page, copyright, toc). SSGs adopted the term for header metadata.

import { parseYaml, type YamlValue } from '@treenx/core/util/yaml';

const KNOWN_KEYS = ['title', 'description', 'tags', 'section', 'order'] as const;
type KnownKey = typeof KNOWN_KEYS[number];

export type DocFrontmatterData = {
  title?: string;
  description?: string;
  tags?: string[];
  section?: string;
  order?: number;
  extra?: Record<string, unknown>;
};

export type FrontmatterSplit = {
  /** Typed frontmatter component data, or null if no frontmatter block present. */
  frontmatter: DocFrontmatterData | null;
  /** Markdown body with the frontmatter block removed. */
  body: string;
};

const FENCE = /^---\s*\r?\n/;

export function splitFrontmatter(raw: string): FrontmatterSplit {
  // Must start with a `---` fence (allow leading BOM only).
  const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!FENCE.test(stripped)) return { frontmatter: null, body: raw };

  const afterOpen = stripped.replace(FENCE, '');
  // Find the closing fence — `---` on its own line. Consume an optional blank line
  // after the fence so `---\n\nbody` and `---\nbody` both yield `body` (no leading \n).
  const close = afterOpen.match(/(^|\r?\n)---[ \t]*(?:\r?\n\r?\n|\r?\n|$)/);
  if (!close || close.index === undefined) return { frontmatter: null, body: raw };

  const yamlSrc = afterOpen.slice(0, close.index);
  const body = afterOpen.slice(close.index + close[0].length);

  let parsed: YamlValue;
  try {
    parsed = parseYaml(yamlSrc);
  } catch {
    // Malformed YAML: treat as no frontmatter rather than crashing on the whole file.
    return { frontmatter: null, body: raw };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { frontmatter: null, body };
  }

  return { frontmatter: distributeFrontmatter(parsed as Record<string, YamlValue>), body };
}

function distributeFrontmatter(obj: Record<string, YamlValue>): DocFrontmatterData {
  const out: DocFrontmatterData = {};
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if ((KNOWN_KEYS as readonly string[]).includes(k)) {
      assignKnown(out, k as KnownKey, v);
    } else {
      extra[k] = v;
    }
  }
  if (Object.keys(extra).length) out.extra = extra;
  return out;
}

function assignKnown(out: DocFrontmatterData, key: KnownKey, v: YamlValue): void {
  switch (key) {
    case 'title':
    case 'description':
    case 'section':
      if (typeof v === 'string') out[key] = v;
      else if (v != null) out[key] = String(v);
      return;
    case 'order':
      if (typeof v === 'number') out.order = v;
      else if (typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v)) out.order = Number(v);
      return;
    case 'tags':
      if (Array.isArray(v)) out.tags = v.map((t) => (typeof t === 'string' ? t : String(t)));
      else if (typeof v === 'string') out.tags = [v];
      return;
  }
}

// Build a `---\nyaml\n---\n` block from frontmatter data, or '' if empty.
export function serializeFrontmatter(fm: DocFrontmatterData | null | undefined): string {
  if (!fm) return '';
  const lines: string[] = [];
  if (fm.title !== undefined) lines.push(`title: ${yamlScalar(fm.title)}`);
  if (fm.description !== undefined) lines.push(`description: ${yamlScalar(fm.description)}`);
  if (fm.section !== undefined) lines.push(`section: ${yamlScalar(fm.section)}`);
  if (fm.order !== undefined) lines.push(`order: ${fm.order}`);
  if (fm.tags?.length) lines.push(`tags: [${fm.tags.map(yamlScalar).join(', ')}]`);
  if (fm.extra) {
    for (const [k, v] of Object.entries(fm.extra)) {
      lines.push(`${k}: ${yamlAny(v)}`);
    }
  }
  if (!lines.length) return '';
  return `---\n${lines.join('\n')}\n---\n\n`;
}

function yamlScalar(s: string): string {
  // Quote if contains chars that would break parseScalar/findKeyColon
  if (/^[\s]|[\s]$|[:#\[\]"']|^(true|false|null|~)$|^-?\d+(\.\d+)?$/i.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

function yamlAny(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return yamlScalar(v);
  if (Array.isArray(v)) return `[${v.map(yamlAny).join(', ')}]`;
  // Nested objects — punt to JSON-as-string; rare in frontmatter.
  return JSON.stringify(v);
}
