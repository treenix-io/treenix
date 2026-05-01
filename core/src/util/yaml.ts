// Mini YAML parser — covers the subset used by markdown frontmatter and config files.
// Supports: scalars (null, bool, number, string), quoted strings, flow arrays [a, b],
// block arrays (- item), top-level mappings, and one level of nested mapping by indent.
// Does NOT support: anchors/aliases, tags, multi-doc, folded/literal strings, complex keys.
//
// Goal: zero deps, ~100 lines, parses real-world frontmatter losslessly.

export type YamlValue = null | boolean | number | string | YamlValue[] | { [k: string]: YamlValue };

export function parseYaml(input: string): YamlValue {
  const lines = input.split('\n').map(stripComment);
  // Drop trailing blank lines so we don't trip the EOF check inside parseBlock.
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const ctx = { lines, i: 0 };
  if (!ctx.lines.length) return {};
  return parseBlock(ctx, 0);
}

function stripComment(line: string): string {
  // Strip `# ...` comments outside quoted strings. Cheap pass: scan once.
  let inSingle = false, inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && (inSingle || inDouble)) { i++; continue; }
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '#' && !inSingle && !inDouble) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}

type Ctx = { lines: string[]; i: number };

// Parse a block (mapping or array) at the given indent. Returns when a line
// is encountered with smaller indent (or EOF).
function parseBlock(ctx: Ctx, indent: number): YamlValue {
  // Skip leading blank lines
  while (ctx.i < ctx.lines.length && !ctx.lines[ctx.i].trim()) ctx.i++;
  if (ctx.i >= ctx.lines.length) return {};

  const first = ctx.lines[ctx.i];
  const firstIndent = indentOf(first);
  if (firstIndent < indent) return {};

  // Block array: lines starting with "- "
  if (first.slice(firstIndent).startsWith('- ') || first.slice(firstIndent) === '-') {
    return parseBlockArray(ctx, firstIndent);
  }

  // Otherwise: mapping
  return parseMapping(ctx, firstIndent);
}

function parseMapping(ctx: Ctx, indent: number): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {};
  while (ctx.i < ctx.lines.length) {
    const line = ctx.lines[ctx.i];
    if (!line.trim()) { ctx.i++; continue; }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) throw new Error(`yaml: unexpected indent at line ${ctx.i + 1}`);

    const rest = line.slice(ind);
    const colon = findKeyColon(rest);
    if (colon < 0) throw new Error(`yaml: expected "key: value" at line ${ctx.i + 1}: ${rest}`);
    const key = unquote(rest.slice(0, colon).trim());
    const after = rest.slice(colon + 1).trim();
    ctx.i++;

    if (after) {
      out[key] = parseScalar(after);
      continue;
    }
    // Empty value → look at next non-blank line for nested block
    const peek = peekNext(ctx);
    if (peek === null || peek.indent <= indent) {
      out[key] = null;
      continue;
    }
    out[key] = parseBlock(ctx, peek.indent);
  }
  return out;
}

function parseBlockArray(ctx: Ctx, indent: number): YamlValue[] {
  const out: YamlValue[] = [];
  while (ctx.i < ctx.lines.length) {
    const line = ctx.lines[ctx.i];
    if (!line.trim()) { ctx.i++; continue; }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) throw new Error(`yaml: unexpected indent in list at line ${ctx.i + 1}`);
    const rest = line.slice(ind);
    if (!rest.startsWith('-')) break;
    const after = rest === '-' ? '' : rest.slice(2); // skip "- "
    ctx.i++;
    out.push(after.trim() ? parseScalar(after.trim()) : (peekNext(ctx)?.indent ?? -1) > indent ? parseBlock(ctx, indent + 2) : null);
  }
  return out;
}

function peekNext(ctx: Ctx): { indent: number } | null {
  for (let j = ctx.i; j < ctx.lines.length; j++) {
    if (ctx.lines[j].trim()) return { indent: indentOf(ctx.lines[j]) };
  }
  return null;
}

// Find the colon that separates key from value, ignoring colons inside quotes.
function findKeyColon(s: string): number {
  let inSingle = false, inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && (inSingle || inDouble)) { i++; continue; }
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === ':' && !inSingle && !inDouble) {
      // Only count `:` followed by space/end as separator (so URLs survive in values).
      if (i === s.length - 1 || s[i + 1] === ' ') return i;
    }
  }
  return -1;
}

function unquote(s: string): string {
  if (s.length >= 2) {
    const a = s[0], b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      return s.slice(1, -1).replace(/\\(.)/g, '$1');
    }
  }
  return s;
}

function parseScalar(s: string): YamlValue {
  if (!s) return null;
  // Quoted string
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return unquote(s);
  }
  // Flow array: [a, b, c]
  if (s.startsWith('[') && s.endsWith(']')) {
    const body = s.slice(1, -1).trim();
    if (!body) return [];
    return splitFlow(body).map(parseScalar);
  }
  // Null
  if (s === 'null' || s === '~' || s === 'Null' || s === 'NULL') return null;
  // Bool
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  // Number
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s)) return Number(s);
  // Plain string
  return s;
}

// ── Emitter ──
//
// Symmetric subset to the parser: scalars, primitive flow arrays, block mappings (recursive).
// Does NOT emit: flow objects, arrays-of-mappings, anchors. The parser can't roundtrip those
// either, so the emitter refuses them rather than producing silently lossy output.

export function yamlScalar(s: string): string {
  if (s === '') return '""';
  // Quote if: leading/trailing whitespace, contains special chars that would break parseScalar
  // or findKeyColon, looks like a reserved scalar (true/false/null), looks like a number,
  // or starts with `-` (would be ambiguous with a list item in some contexts).
  const needsQuote =
    /^[\s]|[\s]$/.test(s) ||
    /[:#\[\]{}"'`,&*!|>%@]/.test(s) ||
    /^(true|false|null|~|True|False|TRUE|FALSE|Null|NULL|yes|no|on|off|Yes|No|On|Off|YES|NO|ON|OFF)$/.test(s) ||
    /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s) ||
    /^-/.test(s);
  if (!needsQuote) return s;
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

// Keys have the same safety rules as scalars in this subset.
export const yamlKey = yamlScalar;

// Accepts `unknown` because callers pass user/runtime data (Tiptap attrs, frontmatter extras)
// that the type system can't statically narrow to YamlValue. Unsupported shapes throw.
export function emitYaml(value: unknown, indent: number = 0): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return yamlScalar(value);
  if (Array.isArray(value)) {
    if (value.some((v) => v !== null && typeof v === 'object')) {
      throw new Error('emitYaml: arrays of objects/nested arrays are not roundtrippable in this YAML subset');
    }
    return '[' + value.map((v) => emitYaml(v)).join(', ') + ']';
  }
  if (typeof value === 'object') return emitMapping(value as Record<string, unknown>, indent);
  throw new Error(`emitYaml: unsupported value type ${typeof value}`);
}

function emitMapping(obj: Record<string, unknown>, indent: number): string {
  const pad = ' '.repeat(indent);
  const entries = Object.entries(obj);
  if (!entries.length) return `${pad}{}`;
  const lines: string[] = [];
  for (const [k, v] of entries) {
    const key = yamlKey(k);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      lines.push(`${pad}${key}:`);
      lines.push(emitMapping(v as Record<string, unknown>, indent + 2));
    } else {
      lines.push(`${pad}${key}: ${emitYaml(v)}`);
    }
  }
  return lines.join('\n');
}

function splitFlow(body: string): string[] {
  // Split top-level commas, respecting quotes.
  const out: string[] = [];
  let depth = 0, inSingle = false, inDouble = false, start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && (inSingle || inDouble)) { i++; continue; }
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (!inSingle && !inDouble) {
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) {
        out.push(body.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  out.push(body.slice(start).trim());
  return out.filter((s) => s !== '');
}
