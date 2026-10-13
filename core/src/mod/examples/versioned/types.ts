// Example mod: schema migrations — the contract mod developers use to evolve
// stored data shapes without breaking existing deployments.
//
// History of example.versioned.doc:
//   v0: { text }            — original shape
//   v1: { body }            — field renamed
//   v2: { body, words }     — derived word count added
//
// The owning native manifest declares each ladder. The kernel upgrades reads
// in memory; the migrated shape is saved only with the next authorized write.
import { declareClientType } from '#comp/client-declaration';
import { declareOpenModule } from '#kernel/module-declaration';
import type { Migration } from '#kernel/types';

/**
 * Versioned document — demonstrates per-type schema migrations
 * @version 2
 */
export class VersionedDoc {
  body = '';
  words = 0;
}
const documentDeclaration = declareClientType('example.versioned.doc', VersionedDoc);

export const documentMigrations: readonly Migration[] = [
  { from: 0, to: 1, up: n => {
    const { text, ...fields } = n;
    return { ...fields, body: typeof text === 'string' ? text : '' };
  } },
  { from: 1, to: 2, up: n => {
    const body = String(n.body ?? '').trim();
    return { ...n, words: body ? body.split(/\s+/).length : 0 };
  } },
];

/**
 * Attachable note component with its own migration ladder (v1 renames txt → note)
 * @version 1
 */
export class VersionedNote {
  note = '';
}
const noteDeclaration = declareClientType('example.versioned.note', VersionedNote);

export const noteMigrations: readonly Migration[] = [
  { from: 0, to: 1, up: n => {
    const { txt, ...fields } = n;
    return { ...fields, note: typeof txt === 'string' ? txt : '' };
  } },
];

export const clientModules = [declareOpenModule('example.versioned/types', [], [documentDeclaration, noteDeclaration])];
