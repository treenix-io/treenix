// Client-side mod auto-discovery.
// virtual:mod-clients loads all mods: internal (via package.json treenix.clients barrel),
// engine mods, and extra mod dirs — see vite-plugin-treenix.ts scanClients().
import 'virtual:mod-clients';

export { getModErrors } from '#mod-errors';
