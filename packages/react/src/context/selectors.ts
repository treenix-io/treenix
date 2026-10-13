export interface ContextSelector {
  readonly base: string;
  readonly modifiers: ReadonlyMap<string, boolean>;
}

const basePattern = /^[\w.][\w.-]*(?::[\w.][\w.-]*)*$/;
const modifierPattern = /^[+!-][\w.][\w.-]*$/;

/** Merge a scope without changing its parent's modifier order or requirements. */
export function parseContext(expression: string, inherited?: ContextSelector): ContextSelector {
  const source = expression.trim();
  if (!source && inherited) return inherited;

  const tokens = source.split(/\s+/);
  let base = inherited?.base;
  if (tokens[0] && !/^[+!-]/.test(tokens[0])) {
    const token = tokens.shift()!;
    base = token.startsWith(':')
      ? inherited && inherited.base.split(':', 1)[0] + token
      : token;
  }
  if (!base || !basePattern.test(base)) throw new SyntaxError(`Invalid context base: ${expression}`);

  const modifiers = new Map(inherited?.modifiers);
  for (const token of tokens) {
    if (!modifierPattern.test(token)) throw new SyntaxError(`Invalid context modifier: ${token}`);
    const name = token.slice(1);
    modifiers.delete(name);
    if (token[0] !== '-') modifiers.set(name, token[0] === '!');
  }
  return { base, modifiers };
}

/** Registrations declare support; only requests can require or remove it. */
export function parseRegistration(expression: string): ContextSelector {
  if (/(^|\s)[!-]/.test(expression)) throw new SyntaxError(`Invalid context registration: ${expression}`);
  return parseContext(expression);
}

export function formatContext(context: ContextSelector): string {
  let result = context.base;
  for (const [name, required] of context.modifiers) result += ` ${required ? '!' : '+'}${name}`;
  return result;
}

export function registrationContext(context: ContextSelector): string {
  return context.base + [...context.modifiers.keys()].sort().map(name => ` +${name}`).join('');
}

/** Required ⊆ supported ⊆ active. Names have no built-in meaning. */
export function matchesContext(candidate: ContextSelector, request: ContextSelector): boolean {
  for (const name of candidate.modifiers.keys()) if (!request.modifiers.has(name)) return false;
  for (const [name, required] of request.modifiers)
    if (required && !candidate.modifiers.has(name)) return false;
  return true;
}

export function prefersContext(candidate: ContextSelector, current: ContextSelector, request: ContextSelector): boolean {
  if (candidate.modifiers.size !== current.modifiers.size) return candidate.modifiers.size > current.modifiers.size;
  let preferred = false;
  // Later differences override earlier ones; shared modifiers do not break ties.
  for (const name of request.modifiers.keys()) {
    if (candidate.modifiers.has(name) !== current.modifiers.has(name)) preferred = candidate.modifiers.has(name);
  }
  return preferred;
}
