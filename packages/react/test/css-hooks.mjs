// Stub .css imports in Node.js test runner — returns empty module
export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  return next(url, context);
}
