// Client-side mod auto-discovery.
// Internal mods (packages/react/src/mods/*) — vite glob.
// External mods (mods/*, core/src/mods/*) — vite-plugin-mods virtual module.
import.meta.glob('./mods/*/client.ts', { eager: true });
import 'virtual:mod-clients';
