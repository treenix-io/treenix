import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  workspaces: {
    // Root workspace — monorepo scripts, d3 deps used by mods
    '.': {
      entry: ['scripts/*.ts'],
      ignoreDependencies: [
        // d3 used by mods (mindmap, three) — hoisted to root
        'd3-hierarchy',
        'd3-selection',
        'd3-shape',
        'd3-transition',
        'd3-zoom',
        '@types/d3-selection',
        '@types/d3-transition',
        '@types/d3-zoom',
      ],
    },

    // Core — public server entry, native discovery, and worker boundaries.
    core: {
      entry: [
        'src/server/main.ts',
        'src/server/native-main.ts',
        'src/server/backup-cli.ts',
        'src/mods/servers.ts',
        'src/mods/*/kernel.ts',
        'src/kernel/source-worker.ts',
        'src/kernel/source-worker-bootstrap.ts',
        'src/mod/examples/*/kernel.ts',
        'src/mod/examples/*/view.tsx',
        'src/mod/examples/*/types.ts',
        'src/**/*.typecheck.ts',
        'src/schema/_import-fixtures/*.ts',
        'src/**/*.test.ts',
        'bin/*.mjs',
      ],
      project: ['src/**/*.ts', 'src/**/*.tsx'],
      ignoreDependencies: [
        // cross-package peers resolved at runtime
        '@treenx/react',
        'dayjs',
        'eventsource',
        'reflect-metadata',
      ],
    },

    // React package — frontend, admin UI, built-in mods
    'packages/react': {
      entry: [
        'src/index.ts',
        'src/app/main.tsx',
        'src/native/main.tsx',
        'src/app/Treenix.tsx',
        'src/mods/clients.ts',
        'src/mods/servers.ts',
        'vite-plugin.ts',
        'src/**/*.test.ts',
      ],
      project: ['src/**/*.ts', 'src/**/*.tsx'],
      ignoreDependencies: [
        '@tailwindcss/vite', // vite plugin, not a direct import
        '@treenx/react', // self-reference in package.json
      ],
    },

    // Mods — dynamically loaded by mod loader
    mods: {
      entry: [
        'clients.ts',
        '*/client.ts',
        '*/server.ts',
        '*/kernel.ts',
        '*/view.tsx',
        '*/seed.ts',
        '*/types.ts',
        '**/*.test.ts',
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
  ignore: ['core/src/lab/**', '**/components/ui/**', '**/components/lib/**'],

  ignoreWorkspaces: [],
};

export default config;
