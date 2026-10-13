import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createClientRegistry, declareClientModule, declareView } from '#context/client-registry';

const type = 'test.price';
const plain = () => null;
const edit = () => null;
const compact = () => null;
const combined = () => null;

describe('context selectors', () => {
  const separate = [
    declareView(type, 'react:cell +edit', edit),
    declareView(type, 'react:cell +compact', compact),
  ];

  for (const reversed of [false, true]) {
    it(`uses request order for equal variants, registration order reversed: ${reversed}`, () => {
      const entries = reversed ? [...separate].reverse() : separate;
      const registry = createClientRegistry(entries.map((entry, i) => declareClientModule(String(i), [entry])));
      assert.equal(registry.resolve(type, 'react:cell +compact +edit')?.handler, edit);
      assert.equal(registry.resolve(type, 'react:cell +edit +compact')?.handler, compact);
      assert.equal(registry.resolve(type, 'react:cell !edit +compact')?.handler, edit);
      assert.throws(() => registry.resolve(type, 'react:cell !edit !compact'), { code: 'MISSING_REQUIRED_VARIANT' });
    });
  }

  it('prefers the combined variant and preserves the handler and preset', () => {
    const meta = { props: { label: 'combined' } };
    const registry = createClientRegistry([declareClientModule('views', [
      ...separate, declareView(type, 'react:cell +edit +compact', combined, meta),
    ])]);
    for (const context of ['react:cell +edit +compact', 'react:cell +compact +edit', 'react:cell !edit !compact']) {
      const selected = registry.resolve(type, context);
      assert.equal(selected?.handler, combined);
      assert.equal(selected?.meta, meta);
    }
  });

  it('ranks modifier count before exact type, then exact type before modifier order', () => {
    const registry = createClientRegistry([declareClientModule('views', [
      declareView(type, 'react:cell', plain),
      declareView(type, 'react:cell +edit', edit),
      declareView('default', 'react:cell +compact', compact),
      declareView('default', 'react:cell +edit +compact', combined),
    ])]);
    assert.equal(registry.resolve(type, 'react:cell +compact')?.handler, compact);
    assert.equal(registry.resolve(type, 'react:cell +edit +compact')?.handler, combined);
    registry.publish(declareClientModule('views', [
      declareView(type, 'react:cell +edit', edit),
      declareView('default', 'react:cell +compact', compact),
    ]));
    assert.equal(registry.resolve(type, 'react:cell +edit +compact')?.handler, edit);
  });

  it('ignores shared modifiers when breaking ties and supports mod-defined names', () => {
    const registry = createClientRegistry([declareClientModule('views', [
      declareView(type, 'react +acme.review +compact', compact),
      declareView(type, 'react +acme.review +edit', edit),
    ])]);
    assert.equal(registry.resolve(type, 'react +compact +edit !acme.review')?.handler, edit);
    assert.equal(registry.resolve(type, 'react +edit +compact !acme.review')?.handler, compact);
    assert.equal(registry.resolve(type, 'react +edit'), null);
  });

  it('keeps base specificity ahead of modifier count and retains requirements during fallback', () => {
    const registry = createClientRegistry([declareClientModule('views', [
      declareView(type, 'react:table:cell', plain),
      declareView('default', 'react:table +edit', edit),
      declareView(type, 'react +edit +compact', combined),
    ])]);
    assert.equal(registry.resolve(type, 'react:table:cell +edit +compact')?.handler, plain);
    assert.equal(registry.resolve(type, 'react:table:cell !edit +compact')?.handler, edit);
    assert.equal(registry.resolve(type, 'react:table:cell !edit !compact')?.handler, combined);
    assert.throws(() => registry.resolve(type, 'site !edit'), { code: 'MISSING_REQUIRED_VARIANT' });
  });

  it('preserves base-only exact, default, suffix fallback, and missing lookup behavior', () => {
    const registry = createClientRegistry([declareClientModule('views', [
      declareView(type, 'react', plain),
      declareView(type, 'react:cell', edit),
      declareView('default', 'react:cell', compact),
    ])]);
    assert.equal(registry.resolve(type, 'react:cell')?.handler, edit);
    assert.equal(registry.resolve('unknown', 'react:cell')?.handler, compact);
    assert.equal(registry.resolve(type, 'react:table:cell')?.handler, plain);
    assert.equal(registry.resolve(type, 'site'), null);
    assert.equal(registry.exact(type, 'react:table'), null);
  });

  it('normalizes registration sets for lookup and discovery', () => {
    const registry = createClientRegistry([declareClientModule('views', [
      declareView(type, ' react:cell  +edit +compact +edit ', combined),
    ])]);
    assert.equal(registry.exact(type, 'react:cell +compact +edit')?.handler, combined);
    assert.equal(registry.exact(type, 'react:cell +edit +compact')?.handler, combined);
    assert.deepEqual(registry.typesForContext('react:cell +edit +compact'), [type]);
    assert.deepEqual(registry.contexts(type), ['react:cell +compact +edit']);
  });

  it('rejects canonical duplicates without changing a published registry', () => {
    const entry = declareView(type, 'react:cell +edit +compact', combined);
    const duplicate = declareView(type, 'react:cell +compact +edit', plain);
    const registry = createClientRegistry([declareClientModule('views', [entry])]);
    const revision = registry.getSnapshot();
    assert.throws(() => registry.publish(declareClientModule('other', [duplicate])), { code: 'DUPLICATE_VIEW' });
    assert.equal(registry.getSnapshot(), revision);
    assert.equal(registry.resolve(type, 'react:cell +edit +compact')?.handler, combined);
    assert.throws(() => createClientRegistry([declareClientModule('views', [entry, duplicate])]), { code: 'DUPLICATE_VIEW' });
  });

  it('rejects malformed requests and registrations', () => {
    const registry = createClientRegistry();
    for (const context of ['react::cell', 'react:', 'react +', 'react +edit+compact', 'react *', 'react [edit]', 'react cell']) {
      assert.throws(() => registry.resolve(type, context), SyntaxError);
      assert.throws(() => createClientRegistry([declareClientModule('bad', [declareView(type, context, plain)])]), SyntaxError);
    }
    for (const context of ['', ':cell', '+edit', 'react !edit', 'react -edit +edit']) {
      assert.throws(() => createClientRegistry([declareClientModule('bad', [declareView(type, context, plain)])]), SyntaxError);
    }
  });

  it('checks lazy declarations against the active and required modifiers', () => {
    const requested: string[] = [];
    const registry = createClientRegistry([declareClientModule('lazy', [], (loadedType, context) => {
      requested.push(context);
      return context === 'react' ? declareView(loadedType, context, plain) : undefined;
    })]);
    assert.equal(registry.resolve(type, 'react:cell +edit')?.handler, plain);
    assert.deepEqual(requested, ['react:cell', 'react']);
    assert.throws(() => registry.resolve(type, 'react:cell !edit'), { code: 'MISSING_REQUIRED_VARIANT' });
    const count = requested.length;
    assert.equal(registry.resolve(type, 'react', false), null);
    assert.equal(requested.length, count);
  });

  it('ranks lazy variants independently of module order and rejects duplicate lazy declarations', () => {
    const modules = separate.map((entry, i) => declareClientModule(String(i), [], () => entry));
    for (const entries of [modules, [...modules].reverse()]) {
      const registry = createClientRegistry(entries);
      assert.equal(registry.resolve(type, 'react:cell +compact +edit')?.handler, edit);
      assert.equal(registry.resolve(type, 'react:cell +edit +compact')?.handler, compact);
    }
    const registry = createClientRegistry([...modules, declareClientModule('duplicate', [], () => separate[0])]);
    assert.throws(() => registry.resolve(type, 'react:cell +edit'), { code: 'DUPLICATE_VIEW' });
  });
});
