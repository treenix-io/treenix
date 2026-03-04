// UIX View Verification — server-safe compile check (no React dependency)
// Used by MCP to let LLMs verify that created views compile correctly

import { compileJSX } from './jsx-parser';

// Mirrors prepareCode from compile.ts but kept here to avoid React imports
function prepareCode(code: string): { body: string; exportName: string | null } {
  const lines = code.split('\n');
  const body: string[] = [];
  let exportName: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('import ')) continue;

    if (trimmed.startsWith('export default ')) {
      const rest = trimmed.slice('export default '.length).trim();
      const declMatch = rest.match(/^(function|class)\s+(\w+)/);
      if (declMatch) {
        exportName = declMatch[2];
        body.push(line.replace('export default ', ''));
      } else {
        exportName = rest.replace(/;$/, '').trim();
      }
      continue;
    }

    if (trimmed.startsWith('export ')) {
      body.push(line.replace('export ', ''));
      continue;
    }

    body.push(line);
  }

  return { body: body.join('\n'), exportName };
}

// Scope parameter names that will be available at runtime
const SCOPE_KEYS = [
  'React', 'h', 'Fragment',
  'useState', 'useEffect', 'useMemo', 'useCallback', 'useRef',
  'Render', 'RenderContext', 'RenderField',
  'usePath', 'useChildren',
  'uix',
];

export function verifyViewSource(source: string): { ok: true } | { ok: false; error: string } {
  try {
    const { body, exportName } = prepareCode(source);
    const jsCode = compileJSX(body);

    const fnBody = exportName
      ? `${jsCode}\nreturn ${exportName};`
      : `${jsCode}\nreturn null;`;

    // Syntax check only — new Function parses but we don't execute
    new Function(...SCOPE_KEYS, fnBody);

    if (!exportName) {
      return { ok: false, error: 'No export default found. Use `export default function ViewName(...)` or `export default ViewName`.' };
    }

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
