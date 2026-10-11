import 'reflect-metadata';
import '#tree/load-client';
import '../root.css';

/** Select the native hydration owner before loading the retiring legacy transport. */
export async function boot(element: HTMLElement | string = '#root') {
  const root = typeof element === 'string' ? document.querySelector<HTMLElement>(element) : element;
  if (root === null) throw new Error('Application root is missing');
  const script = document.getElementById('treenix-initial');
  const value: unknown = script?.textContent ? JSON.parse(script.textContent) : undefined;
  if (typeof value === 'object' && value !== null && 'reads' in value) {
    const { bootNative, decodeNativeHydration } = await import('#app/native-boot');
    return bootNative(root, decodeNativeHydration(value));
  }
  const legacy = await import('#app/legacy-boot');
  legacy.boot(root);
}

if (typeof document !== 'undefined' && document.getElementById('root') !== null)
  void boot().catch(error => console.error('[treenix] boot failed', error));
