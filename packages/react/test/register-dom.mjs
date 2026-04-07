// Provide minimal DOM globals for React + @testing-library/react.
// Must be loaded via --import BEFORE React is imported.
import { Window } from 'happy-dom';

const win = new Window({ url: 'http://localhost' });

for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'MutationObserver', 'customElements', 'localStorage', 'sessionStorage']) {
  globalThis[key] ??= win[key];
}
globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame ??= clearTimeout;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
