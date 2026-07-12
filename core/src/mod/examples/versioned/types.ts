// Example mod: schema migrations — the contract mod developers use to evolve
// stored data shapes without breaking existing deployments.
//
// History of example.versioned.doc:
//   v0: { text }            — original shape
//   v1: { body }            — field renamed
//   v2: { body, words }     — derived word count added
//
// Steps are registered next to the type via the ordinary context registry and
// run on read by the storage policy's migration step (tree/policy.ts): a stored
// v0 node arrives to callers as v2 (in memory); the migrated shape converges on
// disk when the node is next written (core-anz4.9 — reads never write back).
import { registerType } from '#comp';
import { register } from '#core';

/** Versioned document — demonstrates per-type schema migrations */
export class VersionedDoc {
  body = '';
  words = 0;
}
registerType('example.versioned.doc', VersionedDoc);

register('example.versioned.doc', 'migrate', () => ({
  1: (n: Record<string, unknown>) => {
    n.body = typeof n.text === 'string' ? n.text : '';
    delete n.text;
  },
  2: (n: Record<string, unknown>) => {
    const body = String(n.body ?? '').trim();
    n.words = body ? body.split(/\s+/).length : 0;
  },
}));

/** Attachable note component with its own migration ladder (v1 renames txt → note) */
export class VersionedNote {
  note = '';
}
registerType('example.versioned.note', VersionedNote);

register('example.versioned.note', 'migrate', () => ({
  1: (n: Record<string, unknown>) => {
    n.note = typeof n.txt === 'string' ? n.txt : '';
    delete n.txt;
  },
}));
