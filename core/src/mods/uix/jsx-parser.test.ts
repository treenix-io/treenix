import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileJSX } from './jsx-parser';

// Helper: normalize whitespace for comparison
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('jsx-parser', () => {
  // ── Basic ──

  it('1. simple element', () => {
    const r = compileJSX('<div>hello</div>');
    assert.equal(norm(r), norm('h("div", null, "hello")'));
  });

  it('2. self-closing', () => {
    const r = compileJSX('<br />');
    assert.equal(norm(r), norm('h("br", null)'));
  });

  it('3. nested elements', () => {
    const r = compileJSX('<div><span>x</span></div>');
    assert.equal(norm(r), norm('h("div", null, h("span", null, "x"))'));
  });

  it('4. multiple children', () => {
    const r = compileJSX('<div><a /><b /><c /></div>');
    const expected = 'h("div", null, h("a", null), h("b", null), h("c", null))';
    assert.equal(norm(r), norm(expected));
  });

  // ── Attributes ──

  it('5. string attr (double quotes)', () => {
    const r = compileJSX('<div className="foo"></div>');
    assert.equal(norm(r), norm('h("div", {"className": "foo"})'));
  });

  it('6. single-quoted attr', () => {
    const r = compileJSX("<div id='bar'></div>");
    assert.equal(norm(r), norm("h(\"div\", {\"id\": 'bar'})"));
  });

  it('7. expression attr', () => {
    const r = compileJSX('<input onChange={(e) => set(e.target.value)} />');
    assert.ok(r.includes('"onChange": (e) => set(e.target.value)'), `Got: ${r}`);
  });

  it('8. boolean attr', () => {
    const r = compileJSX('<input disabled />');
    assert.ok(r.includes('"disabled": true'), `Got: ${r}`);
  });

  it('9. spread props', () => {
    const r = compileJSX('<div {...props} />');
    assert.ok(r.includes('...props'), `Got: ${r}`);
  });

  it('10. double-brace (object attr)', () => {
    const r = compileJSX('<div style={{color: "red"}} />');
    assert.ok(r.includes('"style": {color: "red"}'), `Got: ${r}`);
  });

  it('11. template literal attr', () => {
    const r = compileJSX('<div className={`text-${size}`} />');
    assert.ok(r.includes('`text-${size}`'), `Got: ${r}`);
  });

  // ── JS Edge Cases ──

  it('12. comparison in expression — must NOT close tag', () => {
    const r = compileJSX('<button onClick={() => x > 5}>click</button>');
    assert.ok(r.includes('"onClick": () => x > 5'), `Got: ${r}`);
    assert.ok(r.includes('"click"'), `Got: ${r}`);
  });

  it('13. ternary with JSX', () => {
    const r = compileJSX('{flag ? <A /> : <B />}');
    assert.ok(r.includes('h(A, null)'), `Got: ${r}`);
    assert.ok(r.includes('h(B, null)'), `Got: ${r}`);
  });

  it('14. arrow function with > in expression child', () => {
    const r = compileJSX('<div>{items.filter(x => x > 0)}</div>');
    assert.ok(r.includes('items.filter(x => x > 0)'), `Got: ${r}`);
  });

  it('15. string containing tags in attr', () => {
    const r = compileJSX('<div title="<hello>">text</div>');
    assert.ok(r.includes('"title": "<hello>"'), `Got: ${r}`);
    assert.ok(r.includes('"text"'), `Got: ${r}`);
  });

  it('16. template literal with tags in attr', () => {
    const r = compileJSX('<div data-x={`<${tag}>`} />');
    assert.ok(r.includes('`<${tag}>`'), `Got: ${r}`);
  });

  // ── Fragments ──

  it('17. fragment', () => {
    const r = compileJSX('<><div /><span /></>');
    assert.ok(r.includes('h(Fragment, null'), `Got: ${r}`);
    assert.ok(r.includes('h("div", null)'), `Got: ${r}`);
    assert.ok(r.includes('h("span", null)'), `Got: ${r}`);
  });

  it('18. React.Fragment with key', () => {
    const r = compileJSX('<React.Fragment key="x"><div /></React.Fragment>');
    assert.ok(r.includes('h(React.Fragment, {"key": "x"}'), `Got: ${r}`);
  });

  // ── Components ──

  it('19. uppercase = component ref', () => {
    const r = compileJSX('<MyComponent foo="bar" />');
    assert.ok(r.includes('h(MyComponent,'), `Got: ${r}`);
  });

  it('20. lowercase = HTML string', () => {
    const r = compileJSX('<div></div>');
    assert.ok(r.includes('h("div",'), `Got: ${r}`);
  });

  it('21. dotted component', () => {
    const r = compileJSX('<Ns.Component />');
    assert.ok(r.includes('h(Ns.Component,'), `Got: ${r}`);
  });

  // ── Full File ──

  it('22. function + return + JSX', () => {
    const r = compileJSX('function Foo() { return <div>hi</div>; }');
    assert.ok(r.includes('function Foo()'), `Got: ${r}`);
    assert.ok(r.includes('return h("div", null, "hi")'), `Got: ${r}`);
  });

  it('23. arrow component', () => {
    const r = compileJSX('const Foo = () => <div>hi</div>');
    assert.ok(r.includes('const Foo = () =>'), `Got: ${r}`);
    assert.ok(r.includes('h("div", null, "hi")'), `Got: ${r}`);
  });

  it('24. multi-statement body with hooks', () => {
    const code = `const [x, setX] = useState(0);
return <span>{x}</span>`;
    const r = compileJSX(code);
    assert.ok(r.includes('const [x, setX] = useState(0)'), `Got: ${r}`);
    assert.ok(r.includes('h("span", null, x)'), `Got: ${r}`);
  });

  it('25. nested function with JSX (map callback)', () => {
    const code = '<ul>{items.map(item => <li key={item.id}>{item.name}</li>)}</ul>';
    const r = compileJSX(code);
    assert.ok(r.includes('h("ul"'), `Got: ${r}`);
    assert.ok(r.includes('h("li"'), `Got: ${r}`);
    assert.ok(r.includes('"key": item.id'), `Got: ${r}`);
    assert.ok(r.includes('item.name'), `Got: ${r}`);
  });

  it('26. conditional rendering', () => {
    const code = 'if (loading) return <div>Loading</div>;\nreturn <div>Done</div>;';
    const r = compileJSX(code);
    assert.ok(r.includes('h("div", null, "Loading")'), `Got: ${r}`);
    assert.ok(r.includes('h("div", null, "Done")'), `Got: ${r}`);
  });

  // ── Text Nodes ──

  it('27. mixed text + expressions', () => {
    const r = compileJSX('<p>Hello {name}, you have {count} items</p>');
    assert.ok(r.includes('"Hello"'), `Got: ${r}`);
    assert.ok(r.includes('name'), `Got: ${r}`);
    assert.ok(r.includes('count'), `Got: ${r}`);
  });

  it('28. whitespace-only between tags collapses', () => {
    const r = compileJSX('<div>   <span />   </div>');
    // Should not have empty text children
    assert.ok(!r.includes('""'), `Should not have empty strings. Got: ${r}`);
  });

  it('29. multiline text', () => {
    const r = compileJSX(`<p>
  Hello
  World
</p>`);
    assert.ok(r.includes('h("p"'), `Got: ${r}`);
    assert.ok(r.includes('Hello'), `Got: ${r}`);
  });

  // ── TS Stripping ──

  it('30. type annotations on params', () => {
    const r = compileJSX('function Foo({ value }: { value: any }) { return <div /> }');
    assert.ok(r.includes('function Foo({ value })'), `Got: ${r}`);
    assert.ok(!r.includes(': { value: any }'), `TS not stripped. Got: ${r}`);
  });

  it('31. as cast', () => {
    const r = compileJSX('const x = data as string;');
    assert.ok(r.includes('const x = data'), `Got: ${r}`);
    assert.ok(!r.includes('as string'), `TS not stripped. Got: ${r}`);
  });

  it('31b. as cast after object literal', () => {
    const r = compileJSX('const x = { a: 1 } as Record<string, number>;');
    assert.ok(r.includes('const x = { a: 1 }'), `Got: ${r}`);
    assert.ok(!r.includes('as Record'), `TS not stripped. Got: ${r}`);
  });

  it('32. interface block stripped', () => {
    const r = compileJSX('interface Props { name: string; age: number; }\nconst x = 1;');
    assert.ok(!r.includes('interface'), `interface not stripped. Got: ${r}`);
    assert.ok(r.includes('const x = 1'), `Code lost. Got: ${r}`);
  });

  it('33. type alias stripped', () => {
    const r = compileJSX('type MyType = { name: string };\nconst x = 1;');
    assert.ok(!r.includes('type MyType'), `type not stripped. Got: ${r}`);
    assert.ok(r.includes('const x = 1'), `Code lost. Got: ${r}`);
  });

  it('34. return type annotation', () => {
    const r = compileJSX('function Foo(): JSX.Element { return <div /> }');
    assert.ok(!r.includes(': JSX.Element'), `TS not stripped. Got: ${r}`);
    assert.ok(r.includes('function Foo()'), `Got: ${r}`);
  });

  // ── $ identifiers ──

  it('36. $type in expression not stripped as TS type keyword', () => {
    const r = compileJSX('const x = children.filter(function(c) { return c.$type === "foo"; });');
    assert.ok(r.includes('c.$type'), `$type was stripped. Got: ${r}`);
    assert.ok(r.includes('=== "foo"'), `comparison lost. Got: ${r}`);
  });

  it('37. $path preserved in JSX attr expression', () => {
    const r = compileJSX('{items.map(function(item) { return <Render key={item.$path} value={item} />; })}');
    assert.ok(r.includes('item.$path'), `$path was stripped. Got: ${r}`);
    assert.ok(r.includes('h(Render,'), `Render not compiled. Got: ${r}`);
  });

  it('38. JSX inside function(){} callback (depth > 1)', () => {
    const r = compileJSX('{items.map(function(item) { return <div key={item.id}>{item.name}</div>; })}');
    assert.ok(r.includes('h("div"'), `JSX inside callback not transformed. Got: ${r}`);
    assert.ok(r.includes('"key": item.id'), `key attr lost. Got: ${r}`);
    assert.ok(r.includes('item.name'), `child expr lost. Got: ${r}`);
  });

  // ── uix.add pattern ──

  it('35. uix.add inline', () => {
    const r = compileJSX('uix.add(() => <div>test</div>)');
    assert.ok(r.includes('uix.add('), `Got: ${r}`);
    assert.ok(r.includes('h("div", null, "test")'), `Got: ${r}`);
  });
});

// ── Stress / Benchmark ──

describe('jsx-parser perf', () => {
  const SMALL = `
function Card({ value }: { value: any }) {
  return <div className="p-4 rounded shadow">
    <h2>{value.title}</h2>
    <p>{value.description}</p>
  </div>;
}
export default Card;`;

  const MEDIUM = `
import { useState, useEffect } from 'react';

interface ItemProps {
  value: { title: string; items: any[]; $path: string };
}

function Dashboard({ value }: ItemProps) {
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<'asc' | 'desc'>('asc');
  const children = useChildren(value.$path);

  const filtered = children.filter(c =>
    (c as any).title?.toLowerCase().includes(filter.toLowerCase())
  );

  const sorted = filtered.sort((a, b) => {
    const cmp = ((a as any).title || '').localeCompare((b as any).title || '');
    return sort === 'asc' ? cmp : -cmp;
  });

  return <div className="space-y-4">
    <div className="flex gap-2">
      <input
        className="border rounded px-3 py-1"
        placeholder="Filter..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <button onClick={() => setSort(s => s === 'asc' ? 'desc' : 'asc')}>
        Sort {sort === 'asc' ? '↓' : '↑'}
      </button>
    </div>
    <div className="grid grid-cols-3 gap-4">
      {sorted.map(item => (
        <div key={(item as any).$path} className="p-3 border rounded">
          <Render value={item} />
        </div>
      ))}
    </div>
    {sorted.length === 0 && <p className="text-gray-400">No items</p>}
  </div>;
}

export default Dashboard;`;

  // Large: repeat a block pattern to simulate ~200 lines of AI-generated code
  const BLOCK = `
    <div className="card p-4 mb-2 border rounded-lg shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">{item.title}</h3>
        <span className="text-sm text-gray-500">{item.date}</span>
      </div>
      <p className="mt-2 text-gray-600">{item.body}</p>
      <div className="mt-3 flex gap-2">
        <button onClick={() => onEdit(item.id)} className="px-3 py-1 bg-blue-500 text-white rounded">Edit</button>
        <button onClick={() => onDelete(item.id)} className="px-3 py-1 bg-red-500 text-white rounded">Delete</button>
      </div>
    </div>`;

  const LARGE = `
import { useState, useMemo, useCallback } from 'react';

type Item = { id: string; title: string; body: string; date: string };

interface ListProps {
  value: { items: Item[]; $path: string };
}

function BigList({ value }: ListProps) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 20;

  const onEdit = useCallback((id: string) => console.log('edit', id), []);
  const onDelete = useCallback((id: string) => console.log('delete', id), []);

  const items = useMemo(() =>
    value.items
      .filter(item => item.title.toLowerCase().includes(search.toLowerCase()))
      .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [value.items, search, page]
  );

  return <div className="space-y-4">
    <input value={search} onChange={(e) => setSearch(e.target.value)}
      className="w-full border rounded px-4 py-2" placeholder="Search..." />
    <div className="space-y-2">
      {items.map(item => (${BLOCK}
      ))}
    </div>
    <div className="flex gap-2 justify-center">
      <button disabled={page === 0} onClick={() => setPage(p => p - 1)}
        className="px-4 py-2 border rounded disabled:opacity-50">Prev</button>
      <span className="px-4 py-2">Page {page + 1}</span>
      <button onClick={() => setPage(p => p + 1)}
        className="px-4 py-2 border rounded">Next</button>
    </div>
  </div>;
}

export default BigList;`;

  function bench(label: string, code: string, iterations: number) {
    // Warmup
    for (let i = 0; i < 10; i++) compileJSX(code);

    const start = performance.now();
    for (let i = 0; i < iterations; i++) compileJSX(code);
    const elapsed = performance.now() - start;

    const perOp = elapsed / iterations;
    const lines = code.split('\n').length;
    const chars = code.length;
    return { label, lines, chars, iterations, totalMs: elapsed.toFixed(1), perOpUs: (perOp * 1000).toFixed(0) };
  }

  it('small component (~8 lines)', () => {
    const r = bench('SMALL', SMALL, 10000);
    console.log(`  ${r.label}: ${r.lines} lines, ${r.chars} chars → ${r.perOpUs} µs/op (${r.iterations} iters, ${r.totalMs} ms)`);
    // Must compile in under 500 µs
    assert.ok(Number(r.perOpUs) < 500, `Too slow: ${r.perOpUs} µs`);
  });

  it('medium component (~50 lines, TS types, ternary, map)', () => {
    const r = bench('MEDIUM', MEDIUM, 5000);
    console.log(`  ${r.label}: ${r.lines} lines, ${r.chars} chars → ${r.perOpUs} µs/op (${r.iterations} iters, ${r.totalMs} ms)`);
    assert.ok(Number(r.perOpUs) < 2000, `Too slow: ${r.perOpUs} µs`);
  });

  it('large component (~70 lines, nested JSX, callbacks)', () => {
    const r = bench('LARGE', LARGE, 2000);
    console.log(`  ${r.label}: ${r.lines} lines, ${r.chars} chars → ${r.perOpUs} µs/op (${r.iterations} iters, ${r.totalMs} ms)`);
    assert.ok(Number(r.perOpUs) < 5000, `Too slow: ${r.perOpUs} µs`);
  });

  it('correctness: large component output is valid', () => {
    const r = compileJSX(LARGE);
    // TS types stripped
    assert.ok(!r.includes('interface ListProps'), `interface not stripped`);
    assert.ok(!r.includes('type Item ='), `type not stripped`);
    // JSX compiled
    assert.ok(r.includes('h("div"'), `No createElement. Got: ${r.slice(0, 200)}`);
    assert.ok(r.includes('h("button"'), `No button. Got: ${r.slice(0, 200)}`);
    // JS logic preserved
    assert.ok(r.includes('useState'), `useState lost`);
    assert.ok(r.includes('useMemo'), `useMemo lost`);
    assert.ok(r.includes('useCallback'), `useCallback lost`);
    assert.ok(r.includes('.filter('), `filter lost`);
    assert.ok(r.includes('.slice('), `slice lost`);
  });

  // ── Full pipeline: compileJSX + new Function ──

  // Minimal prepareCode (mirrors compile.ts logic)
  function prepareCode(code: string): { body: string; exportName: string | null } {
    const lines = code.split('\n');
    const body: string[] = [];
    let exportName: string | null = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('import ')) continue;
      if (trimmed.startsWith('export default ')) {
        const rest = trimmed.slice('export default '.length).trim();
        const declMatch = rest.match(/^(function|class)\s+(\w+)/);
        if (declMatch) { exportName = declMatch[2]; body.push(line.replace('export default ', '')); }
        else { exportName = rest.replace(/;$/, '').trim(); }
        continue;
      }
      if (trimmed.startsWith('export ')) { body.push(line.replace('export ', '')); continue; }
      body.push(line);
    }
    return { body: body.join('\n'), exportName };
  }

  // Stub scope — real React not needed for benchmarking compilation
  const SCOPE_KEYS = [
    'React', 'h', 'Fragment',
    'useState', 'useEffect', 'useMemo', 'useCallback', 'useRef',
    'Render', 'RenderContext', 'RenderField', 'usePath', 'useChildren', 'uix',
  ];
  const noop = () => {};
  const SCOPE_VALS = [
    { createElement: noop, Fragment: 'Fragment' }, // React stub
    noop, // h
    'Fragment', // Fragment
    noop, noop, noop, noop, noop, // hooks
    noop, noop, noop, noop, noop, // Render, RenderContext, RenderField, usePath, useChildren
    { add: noop }, // uix
  ];

  function fullPipeline(code: string): Function {
    const { body, exportName } = prepareCode(code);
    const jsCode = compileJSX(body);
    const fnBody = exportName ? `${jsCode}\nreturn ${exportName};` : `${jsCode}\nreturn null;`;
    const fn = new Function(...SCOPE_KEYS, fnBody);
    fn(...SCOPE_VALS); // execute to verify it doesn't throw
    return fn;
  }

  function benchFull(label: string, code: string, iterations: number) {
    // Warmup
    for (let i = 0; i < 10; i++) fullPipeline(code);

    const start = performance.now();
    for (let i = 0; i < iterations; i++) fullPipeline(code);
    const elapsed = performance.now() - start;

    const perOp = elapsed / iterations;
    const lines = code.split('\n').length;
    const chars = code.length;
    return { label, lines, chars, iterations, totalMs: elapsed.toFixed(1), perOpUs: (perOp * 1000).toFixed(0) };
  }

  it('full pipeline small (compileJSX + new Function)', () => {
    const r = benchFull('SMALL+fn', SMALL, 5000);
    console.log(`  ${r.label}: ${r.lines} lines, ${r.chars} chars → ${r.perOpUs} µs/op (${r.iterations} iters, ${r.totalMs} ms)`);
    assert.ok(Number(r.perOpUs) < 2000, `Too slow: ${r.perOpUs} µs`);
  });

  it('full pipeline medium (compileJSX + new Function)', () => {
    const r = benchFull('MEDIUM+fn', MEDIUM, 2000);
    console.log(`  ${r.label}: ${r.lines} lines, ${r.chars} chars → ${r.perOpUs} µs/op (${r.iterations} iters, ${r.totalMs} ms)`);
    assert.ok(Number(r.perOpUs) < 5000, `Too slow: ${r.perOpUs} µs`);
  });

  it('full pipeline large (compileJSX + new Function)', () => {
    const r = benchFull('LARGE+fn', LARGE, 1000);
    console.log(`  ${r.label}: ${r.lines} lines, ${r.chars} chars → ${r.perOpUs} µs/op (${r.iterations} iters, ${r.totalMs} ms)`);
    assert.ok(Number(r.perOpUs) < 10000, `Too slow: ${r.perOpUs} µs`);
  });

  // ── Correctness: all fixtures produce valid callable Functions ──

  it('new Function: small returns a function component', () => {
    const result = fullPipeline(SMALL);
    const component = result(...SCOPE_VALS);
    assert.equal(typeof component, 'function', 'Should return a function component');
  });

  it('new Function: medium returns a function component', () => {
    const result = fullPipeline(MEDIUM);
    const component = result(...SCOPE_VALS);
    assert.equal(typeof component, 'function', 'Should return a function component');
  });

  it('new Function: large returns a function component', () => {
    const result = fullPipeline(LARGE);
    const component = result(...SCOPE_VALS);
    assert.equal(typeof component, 'function', 'Should return a function component');
  });

  it('new Function: uix.add inline captures component', () => {
    const code = 'uix.add(({ value }) => h("div", null, value.title));';
    const { body, exportName } = prepareCode(code);
    const jsCode = compileJSX(body);
    const fnBody = exportName ? `${jsCode}\nreturn ${exportName};` : `${jsCode}\nreturn null;`;
    let captured: Function | null = null;
    const scopeVals = [
      ...SCOPE_VALS.slice(0, -1),
      { add: (c: Function) => { captured = c; } },
    ];
    const fn = new Function(...SCOPE_KEYS, fnBody);
    fn(...scopeVals);
    assert.ok(captured, 'uix.add should capture the component');
    assert.equal(typeof captured, 'function');
  });

  it('new Function: arrow export default', () => {
    const code = `const Greeting = ({ value }) => h("span", null, value.name);\nexport default Greeting;`;
    const result = fullPipeline(code);
    const component = result(...SCOPE_VALS);
    assert.equal(typeof component, 'function');
  });

  it('new Function: export default function declaration', () => {
    const code = `export default function MyView({ value }) {\n  return h("div", null, value.title);\n}`;
    const result = fullPipeline(code);
    const component = result(...SCOPE_VALS);
    assert.equal(typeof component, 'function');
    assert.equal(component.name, 'MyView');
  });
});
