import type { NativeModuleDeployment } from '#kernel/manifest';
import { documentMigrations, noteMigrations } from './types';
import document from './schemas/example.versioned.doc.json';
import note from './schemas/example.versioned.note.json';

/** Publish the example's existing data schemas and migration ladders under one native owner. */
export default function versionedModule(): NativeModuleDeployment {
  const owner = 'example.versioned';
  return {
    manifest: {
      id: owner,
      security: [
        { type: document.$id, context: 'migrate', handler: documentMigrations },
        { type: note.$id, context: 'migrate', handler: noteMigrations },
      ],
      open: [],
      types: [
        {
          name: document.$id,
          module: owner,
          security: 'ordinary',
          version: 2,
          schema: { ...document, type: 'object' },
          actions: {},
        },
        {
          name: note.$id,
          module: owner,
          security: 'ordinary',
          version: 1,
          schema: { ...note, type: 'object' },
          actions: {},
        },
      ],
    },
  };
}
