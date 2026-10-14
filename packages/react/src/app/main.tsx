import 'reflect-metadata';
import '#tree/load-client';
import '../root.css';
import { bootNative, decodeNativeHydration } from '#app/native-boot';

/** Open the editor with native hydration and an admitted lane. */
export async function boot(element: HTMLElement | string = '#root') {
  const root = typeof element === 'string' ? document.querySelector<HTMLElement>(element) : element;
  if (root === null) throw new Error('Application root is missing');

  const script = document.getElementById('treenix-initial');
  const initial =
    script === null ? { reads: [] } : decodeNativeHydration(JSON.parse(script.textContent ?? ''));
  return bootNative(root, initial);
}

if (typeof document !== 'undefined' && document.getElementById('root') !== null)
  void boot().catch((error) => console.error('[treenix] boot failed', error));
