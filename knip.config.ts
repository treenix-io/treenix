import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  workspaces: {
    // Root workspace — monorepo scripts, d3 deps used by mods
    '.': {
      entry: ['scripts/*.ts'],
      ignoreDependencies: [
        // d3 used by mods (mindmap, three) — hoisted to root
        'd3-hierarchy', 'd3-selection', 'd3-shape', 'd3-transition', 'd3-zoom',
      ],
    },

    // Core — server entry, tests, mod system
    'core': {
      entry: [
        'src/server/main.ts',
        'src/server/factory.ts',
        'src/mods/clients.ts',
        'src/mods/servers.ts',
        'src/mod/examples/*/service.ts',
        'src/mod/examples/*/view.tsx',
      ],
      project: ['src/**/*.ts', 'src/**/*.tsx'],
      ignoreDependencies: [
        // cross-package peers resolved at runtime
        '@treenx/react', 'dayjs', 'eventsource', 'reflect-metadata',
      ],
    },

    // React package — frontend, admin UI, built-in mods
    'packages/react': {
      entry: [
        'src/index.ts',
        'src/app/main.tsx',
        'src/app/Treenix.tsx',
        'src/mods/clients.ts',
        'src/mods/servers.ts',
        'vite-plugin.ts',
      ],
      project: ['src/**/*.ts', 'src/**/*.tsx'],
      ignoreDependencies: [
        '@tailwindcss/vite',  // vite plugin, not a direct import
        '@treenx/react',    // self-reference in package.json
      ],
    },

    // Mods — dynamically loaded by mod loader
    'mods': {
      entry: [
        'clients.ts',
        '*/client.ts',
        '*/server.ts',
        '*/service.ts',
        '*/view.tsx',
        '*/seed.ts',
        '*/types.ts',
      ],
      project: ['**/*.ts', '**/*.tsx'],
    },

    'packages/agent-client': {},
    'packages/create-treenix': {},
    'packages/treenix': {},
    'packages/fuse': {},
  },

  // # imports — knip doesn't resolve Node.js imports field
  paths: {
    '#*': ['./src/*'],
  },

  // shadcn UI components — used on demand, not all statically imported
  ignore: [
    '**/components/ui/**',
    '**/components/lib/**',
  ],

  ignoreWorkspaces: [],
};

export default config;
