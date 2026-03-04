// UIX JSX Parser — state machine, zero deps
// Transforms JSX → jsx() calls + strips basic TypeScript
// Output uses `h()` (hyperscript convention) — caller must provide `h: React.createElement` in scope
// Handles: nested tags, expressions with <>, strings, template literals,
// fragments, spread props, components vs HTML, TS annotations
//
// Optimized: shared output buffer (no intermediate strings),
// charCode comparisons (no regex in hot paths), pass-through regions

export function compileJSX(src: string): string {
  return stripTS(transformJSX(src));
}

// ── Char helpers (no regex in hot paths) ──

function isWS(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

function isAlpha(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isWord(c: number): boolean {
  return isAlpha(c) || (c >= 48 && c <= 57) || c === 95 || c === 36; // _ or $
}

function isTagChar(c: number): boolean {
  return isAlpha(c) || (c >= 48 && c <= 57) || c === 46 || c === 95;
}

function isAttrChar(c: number): boolean {
  return isAlpha(c) || (c >= 48 && c <= 57) || c === 95 || c === 45;
}

function advWS(src: string, i: number): number {
  while (i < src.length && isWS(src.charCodeAt(i))) i++;
  return i;
}

// ── Phase 1: JSX → React.createElement ──
// Shared output buffer — all emit* functions push directly, return new position

function transformJSX(src: string): string {
  const out: string[] = [];
  let i = 0;
  let ps = 0; // pass-through start

  while (i < src.length) {
    const c = src.charCodeAt(i);

    if (c === 34 || c === 39 || c === 96) { i = skipString(src, i); continue; }

    if (c === 47) { // /
      const c2 = src.charCodeAt(i + 1);
      if (c2 === 47) { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
      if (c2 === 42) { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 2; continue; }
    }

    if (c === 60 && looksLikeJSX(src, i)) {
      if (i > ps) out.push(src.slice(ps, i));
      i = emitElement(src, i, out);
      ps = i;
      continue;
    }

    i++;
  }

  if (ps === 0) return src;
  if (i > ps) out.push(src.slice(ps, i));
  return out.join('');
}

function looksLikeJSX(src: string, i: number): boolean {
  const c = src.charCodeAt(i + 1);
  if (!(isAlpha(c) || c === 62 || c === 47)) return false;
  // Word char before < means TS generic (Record<string>), not JSX
  if (i > 0 && isWord(src.charCodeAt(i - 1))) return false;
  return true;
}

// Emit jsx(...) for one element, return position after
function emitElement(src: string, start: number, out: string[]): number {
  let i = start + 1;

  // Fragment <>
  if (src.charCodeAt(i) === 62) {
    out.push('h(Fragment, null');
    return emitChildren(src, i + 1, out);
  }

  // Stray </
  if (src.charCodeAt(i) === 47) { out.push(src[i]); return i + 1; }

  // Tag name
  const ts = i;
  while (i < src.length && isTagChar(src.charCodeAt(i))) i++;
  const tag = src.slice(ts, i);
  const isComp = (src.charCodeAt(ts) >= 65 && src.charCodeAt(ts) <= 90) || tag.indexOf('.') !== -1;

  out.push('h(');
  if (isComp) out.push(tag);
  else { out.push('"'); out.push(tag); out.push('"'); }
  out.push(', ');

  i = emitProps(src, advWS(src, i), out);
  i = advWS(src, i);

  // Self-closing />
  if (src.charCodeAt(i) === 47 && src.charCodeAt(i + 1) === 62) {
    out.push(')');
    return i + 2;
  }

  // Opening > → children
  if (src.charCodeAt(i) === 62) {
    return emitChildren(src, i + 1, out);
  }

  out.push(')');
  return i;
}

// Emit props as `{...}` or `null`, return position after props (before > or />)
function emitProps(src: string, start: number, out: string[]): number {
  let i = start;
  const c0 = src.charCodeAt(i);
  if (c0 === 62 || (c0 === 47 && src.charCodeAt(i + 1) === 62)) {
    out.push('null');
    return i;
  }

  out.push('{');
  let first = true;

  while (i < src.length) {
    i = advWS(src, i);
    const c = src.charCodeAt(i);
    if (c === 62 || (c === 47 && src.charCodeAt(i + 1) === 62)) break;

    if (!first) out.push(', ');
    first = false;

    // Spread {...expr}
    if (c === 123) {
      const end = scanBrace(src, i);
      out.push(src.slice(i + 1, end - 1).trim());
      i = end;
      continue;
    }

    // Attr name
    const ns = i;
    while (i < src.length && isAttrChar(src.charCodeAt(i))) i++;
    if (i === ns) { first = true; i++; continue; } // skip unexpected char
    const ne = i;

    i = advWS(src, i);

    // Boolean attr (no =)
    if (src.charCodeAt(i) !== 61) {
      out.push('"'); out.push(src.slice(ns, ne)); out.push('": true');
      continue;
    }

    i = advWS(src, i + 1);

    out.push('"'); out.push(src.slice(ns, ne)); out.push('": ');

    const vc = src.charCodeAt(i);
    if (vc === 34 || vc === 39) {
      const end = skipString(src, i);
      out.push(src.slice(i, end));
      i = end;
    } else if (vc === 123) {
      const end = scanBrace(src, i);
      out.push(src.slice(i + 1, end - 1));
      i = end;
    } else {
      out.push('"');
      const vs = i;
      while (i < src.length) { const x = src.charCodeAt(i); if (isWS(x) || x === 62 || x === 47) break; i++; }
      out.push(src.slice(vs, i));
      out.push('"');
    }
  }

  out.push('}');
  return i;
}

// Emit children (`, child1, child2`) and closing `)`, return position after </tag>
function emitChildren(src: string, start: number, out: string[]): number {
  let i = start;
  let txS = i; // text start
  let hasTx = false;

  while (i < src.length) {
    const c = src.charCodeAt(i);

    // Close tag </
    if (c === 60 && src.charCodeAt(i + 1) === 47) {
      flushText(src, txS, i, hasTx, out);
      i += 2;
      while (i < src.length && src.charCodeAt(i) !== 62) i++;
      i++;
      out.push(')');
      return i;
    }

    // Child element
    if (c === 60 && looksLikeJSX(src, i)) {
      flushText(src, txS, i, hasTx, out);
      hasTx = false;
      out.push(', ');
      i = emitElement(src, i, out);
      txS = i;
      continue;
    }

    // Expression {stuff}
    if (c === 123) {
      flushText(src, txS, i, hasTx, out);
      hasTx = false;
      out.push(', ');
      i = emitChildExpr(src, i, out);
      txS = i;
      continue;
    }

    if (!hasTx) { txS = i; hasTx = true; }
    i++;
  }

  flushText(src, txS, i, hasTx, out);
  out.push(')');
  return i;
}

function flushText(src: string, start: number, end: number, has: boolean, out: string[]): void {
  if (!has) return;
  // Fast path: all whitespace?
  let allWS = true;
  for (let k = start; k < end; k++) { if (!isWS(src.charCodeAt(k))) { allWS = false; break; } }
  if (allWS) return;
  const t = src.slice(start, end).replace(/\s+/g, ' ').trim();
  if (t) { out.push(', "'); out.push(t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')); out.push('"'); }
}

// Emit expression content from {expr} in children context (may contain nested JSX)
function emitChildExpr(src: string, start: number, out: string[]): number {
  let i = advWS(src, start + 1); // skip { + leading WS
  let depth = 1;
  let ps = i;

  while (i < src.length && depth > 0) {
    const c = src.charCodeAt(i);

    if (c === 34 || c === 39 || c === 96) { i = skipString(src, i); continue; }

    if (c === 60 && looksLikeJSX(src, i)) {
      if (i > ps) out.push(src.slice(ps, i));
      i = emitElement(src, i, out);
      ps = i;
      continue;
    }

    if (c === 123) depth++;
    if (c === 125) {
      depth--;
      if (depth === 0) {
        // Trim trailing WS before }
        let te = i;
        while (te > ps && isWS(src.charCodeAt(te - 1))) te--;
        if (te > ps) out.push(src.slice(ps, te));
        i++;
        break;
      }
    }

    i++;
  }

  return i;
}

// Scan balanced braces, return position after closing }
function scanBrace(src: string, start: number): number {
  let i = start;
  let depth = 0;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c === 34 || c === 39 || c === 96) { i = skipString(src, i); continue; }
    if (c === 123) depth++;
    if (c === 125) { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return i;
}

// Skip a string literal including escapes and template ${} nesting
function skipString(src: string, start: number): number {
  const q = src.charCodeAt(start);
  let i = start + 1;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c === 92) { i += 2; continue; }
    if (q === 96 && c === 36 && src.charCodeAt(i + 1) === 123) {
      i += 2;
      let d = 1;
      while (i < src.length && d > 0) {
        const tc = src.charCodeAt(i);
        if (tc === 92) { i += 2; continue; }
        if (tc === 123) d++;
        if (tc === 125) d--;
        if (d > 0) i++;
      }
      i++;
      continue;
    }
    if (c === q) return i + 1;
    i++;
  }
  return i;
}

// ── Phase 2: Basic TypeScript stripping ──

function stripTS(code: string): string {
  const out: string[] = [];
  let i = 0;
  let ps = 0;

  while (i < code.length) {
    const c = code.charCodeAt(i);

    if (c === 34 || c === 39 || c === 96) { i = skipString(code, i); continue; }

    if (c === 47) {
      const c2 = code.charCodeAt(i + 1);
      if (c2 === 47) { const nl = code.indexOf('\n', i); i = nl === -1 ? code.length : nl; continue; }
      if (c2 === 42) { const e = code.indexOf('*/', i + 2); i = e === -1 ? code.length : e + 2; continue; }
    }

    if (c === 105 && matchWord(code, i, 'interface')) {
      if (i > ps) out.push(code.slice(ps, i));
      i = skipBraceBlock(code, i + 9);
      ps = i;
      continue;
    }

    if (c === 116 && matchWord(code, i, 'type') && i + 4 < code.length && isWS(code.charCodeAt(i + 4))) {
      const eq = code.indexOf('=', i + 5);
      const semi = code.indexOf(';', i + 5);
      if (eq !== -1 && (semi === -1 || eq < semi)) {
        if (i > ps) out.push(code.slice(ps, i));
        let k = advWS(code, eq + 1);
        if (code.charCodeAt(k) === 123) {
          k = skipBraceBlock(code, k);
          k = advWS(code, k);
          if (code.charCodeAt(k) === 59) k++;
        } else {
          const nl = code.indexOf('\n', k);
          k = semi !== -1 ? semi + 1 : (nl !== -1 ? nl : code.length);
        }
        i = k;
        ps = i;
        continue;
      }
    }

    if (c === 58 && i > 0 && isAnnotationContext(code, i)) {
      if (i > ps) out.push(code.slice(ps, i));
      i = skipAnnotation(code, i + 1);
      ps = i;
      continue;
    }

    if (c === 97 && matchWord(code, i, 'as')) {
      let j = i - 1;
      while (j >= 0 && isWS(code.charCodeAt(j))) j--;
      if (j >= 0 && isAsContext(code.charCodeAt(j))) {
        if (i > ps) out.push(code.slice(ps, i));
        i = skipAnnotation(code, i + 2);
        ps = i;
        continue;
      }
    }

    i++;
  }

  if (ps === 0) return code;
  if (i > ps) out.push(code.slice(ps, i));
  return out.join('');
}

function isAsContext(c: number): boolean {
  return isWord(c) || c === 41 || c === 93 || c === 125 || c === 34; // \w ) ] } "
}

function matchWord(src: string, i: number, word: string): boolean {
  if (i > 0 && isWord(src.charCodeAt(i - 1))) return false;
  const end = i + word.length;
  if (end > src.length) return false;
  for (let k = 0; k < word.length; k++) {
    if (src.charCodeAt(i + k) !== word.charCodeAt(k)) return false;
  }
  return end >= src.length || !isWord(src.charCodeAt(end));
}

function isAnnotationContext(code: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && isWS(code.charCodeAt(j))) j--;
  if (j < 0) return false;

  const ch = code.charCodeAt(j);

  if (ch === 41) { // )
    let pd = 0;
    for (let k = j; k >= 0; k--) {
      const kc = code.charCodeAt(k);
      if (kc === 41) pd++;
      if (kc === 40) { if (pd > 0) pd--; else break; }
      if (pd === 0 && kc === 63) return false;
      if (pd === 0 && kc === 59) break;
    }
    return true;
  }

  if (ch === 125) { // }
    let pd = 0;
    for (let k = j; k >= 0; k--) {
      const kc = code.charCodeAt(k);
      if (kc === 41) pd++;
      if (kc === 40) { if (pd > 0) pd--; else return true; }
      if (kc === 59) break;
    }
    return false;
  }

  if (isWord(ch)) {
    let k = j;
    while (k >= 0 && isWord(code.charCodeAt(k))) k--;
    while (k >= 0 && isWS(code.charCodeAt(k))) k--;
    if (k < 0) return false;
    const kc = code.charCodeAt(k);
    if (kc === 123 || kc === 44) return false;
    if (kc === 40) return true;
    const before = code.slice(Math.max(0, k - 5), k + 1).trim();
    if (/\b(const|let|var)$/.test(before)) return true;
    return false;
  }

  return false;
}

function skipAnnotation(code: string, start: number): number {
  let i = advWS(code, start);
  if (code.charCodeAt(i) === 123) return skipBraceBlock(code, i);

  let depth = 0;
  while (i < code.length) {
    const c = code.charCodeAt(i);
    if (c === 40 || c === 60 || c === 91) { depth++; i++; continue; }
    if (c === 41 || c === 62 || c === 93) { if (depth === 0) break; depth--; i++; continue; }
    if (depth === 0 && (c === 44 || c === 61 || c === 123 || c === 59)) break;
    if (c === 34 || c === 39 || c === 96) { i = skipString(code, i); continue; }
    i++;
  }
  return i;
}

function skipBraceBlock(code: string, start: number): number {
  let i = start;
  while (i < code.length && code.charCodeAt(i) !== 123) i++;
  if (i >= code.length) return i;
  i++;
  let depth = 1;
  while (i < code.length && depth > 0) {
    const c = code.charCodeAt(i);
    if (c === 123) depth++;
    else if (c === 125) depth--;
    else if (c === 34 || c === 39 || c === 96) { i = skipString(code, i); continue; }
    i++;
  }
  return i;
}
