// $map expression parser
// Syntax: selector.field | pipe1(args) | pipe2(args)
// Source path lives in $ref, not here — parser handles $map content only
//
// Access modes:
//   .field         = drill into current pipe value
//   #field         = lookup from source node ($ref path) — like URI fragment
//   #/path.field   = lookup from external node — absolute path after #

export type RefArg = { $ref: string; fields: string[] };
export type PipeArg = number | string | RefArg;

export type MapExpr = { steps: PipeStep[] };

export type PipeStep =
  | { type: 'pipe'; name: string; args: PipeArg[] }
  | { type: 'field'; name: string };

export function isRefArg(arg: PipeArg): arg is RefArg {
  return typeof arg === 'object' && arg !== null && '$ref' in arg;
}

const PIPE_RE = /^([a-zA-Z_]\w*)\(([^)]*)\)(.*)$/;

function parseArg(s: string): PipeArg {
  const t = s.trim();

  // # = node ref: #field (self), #/path.field (external)
  if (t.startsWith('#')) {
    const rest = t.slice(1);
    if (rest.startsWith('/')) {
      // External: #/path.field
      const dotIdx = rest.indexOf('.');
      if (dotIdx === -1) return { $ref: rest, fields: [] };
      return { $ref: rest.slice(0, dotIdx), fields: rest.slice(dotIdx + 1).split('.') };
    }
    // Self: #field or #comp.field
    return { $ref: '.', fields: rest.length ? rest.split('.') : [] };
  }

  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}

function parseSegment(raw: string): PipeStep[] {
  const s = raw.trim();
  if (!s) return [];

  // #field — self-ref field access (like URI fragment)
  if (s.startsWith('#') && !s.startsWith('#/')) {
    const rest = s.slice(1);
    return rest.split('.').map(name => ({ type: 'field' as const, name }));
  }

  // Pure field chain: .foo.bar — drill into pipe value
  if (s.startsWith('.')) {
    return parseFieldChain(s);
  }

  // pipe(args) optionally followed by .field chain
  const m = PIPE_RE.exec(s);
  if (m) {
    const steps: PipeStep[] = [{
      type: 'pipe',
      name: m[1],
      args: m[2] ? m[2].split(',').map(parseArg) : [],
    }];
    if (m[3]) steps.push(...parseFieldChain(m[3]));
    return steps;
  }

  // Bare name (round, abs): pipe with no args, optionally followed by .field
  const bare = /^([a-zA-Z_]\w*)(.*)$/.exec(s);
  if (bare) {
    const steps: PipeStep[] = [{ type: 'pipe', name: bare[1], args: [] }];
    if (bare[2]) steps.push(...parseFieldChain(bare[2]));
    return steps;
  }

  return [];
}

function parseFieldChain(s: string): PipeStep[] {
  const steps: PipeStep[] = [];
  let rest = s;
  while (rest) {
    const m = /^\.([a-zA-Z_$]\w*)(.*)$/.exec(rest);
    if (!m) break;
    steps.push({ type: 'field', name: m[1] });
    rest = m[2];
  }
  return steps;
}

export function parseMapExpr(expr: string): MapExpr {
  const parts = expr.split('|').map(s => s.trim());
  const steps: PipeStep[] = [];

  for (const part of parts) {
    steps.push(...parseSegment(part));
  }

  return { steps };
}
