// Reusable type preview — Storybook-like: context switcher + live render + schema form editor

import { Button } from '#components/ui/button';
import { Render, RenderContext } from '#context';
import { stampNode } from '#symbols';
import { type ComponentData, getContextsForType, type NodeData } from '@treenx/core';
import { useMemo, useState } from 'react';

// ── Mock data generator (by JSON Schema field type) ──

const STRING_HINTS: [RegExp, string][] = [
  [/title|heading|name/i, 'Amazing Feature Title'],
  [/desc|subtitle|summary|text|content|body/i, 'A short description of this amazing feature that showcases its value.'],
  [/button|label|cta/i, 'Get Started'],
  [/url|link|href/i, 'https://example.com'],
  [/image|photo|avatar|picture|src/i, 'https://picsum.photos/seed/demo/400/200'],
  [/email/i, 'user@example.com'],
  [/phone|tel/i, '+1-555-0123'],
  [/address/i, '42 Oak Street, San Francisco'],
  [/color/i, '#4c88ff'],
  [/date/i, '2026-01-15'],
  [/status|state/i, 'active'],
  [/tag|category/i, 'featured'],
];

function mockValue(schema: Record<string, unknown>, fieldName = ''): unknown {
  const type = schema.type as string | undefined;
  if (schema.default !== undefined && schema.default !== '' && schema.default !== 0) return schema.default;
  if (schema.enum) return (schema.enum as unknown[])[0];

  switch (type) {
    case 'string': {
      const fmt = schema.format as string | undefined;
      if (fmt === 'date' || fmt === 'date-time') return '2026-01-15';
      if (fmt === 'email') return 'user@example.com';
      if (fmt === 'uri' || fmt === 'url') return 'https://example.com';
      if (fmt === 'color') return '#4c88ff';
      if (fmt === 'image') return 'https://picsum.photos/seed/demo/400/200';
      if (fmt === 'textarea') return 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';
      for (const [re, val] of STRING_HINTS) if (re.test(fieldName)) return val;
      return schema.title ? `Sample ${schema.title}` : 'Sample text';
    }
    case 'number':
    case 'integer': {
      const min = (schema.minimum as number) ?? 0;
      const max = (schema.maximum as number) ?? 100;
      return Math.round((min + max) / 2) || 42;
    }
    case 'boolean':
      return true;
    case 'array': {
      const items = schema.items as Record<string, unknown> | undefined;
      if (!items) return ['alpha', 'beta', 'gamma'];
      return [mockValue(items, fieldName), mockValue(items, fieldName), mockValue(items, fieldName)];
    }
    case 'object': {
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      return mockObject(props);
    }
    default:
      return 'sample';
  }
}

export function mockObject(properties: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(properties)) result[k] = mockValue(v, k);
  return result;
}

// ── Preview component ──

export function TypePreview({ typeName, properties }: {
  typeName: string;
  properties: Record<string, Record<string, unknown>>;
}) {
  const contexts = getContextsForType(typeName);
  const reactContexts = contexts.filter(c => c.startsWith('react'));

  const initial = useMemo(() => {
    const n = {
      $path: `/preview/${typeName.replace(/\./g, '/')}`,
      $type: typeName,
      ...mockObject(properties),
    } as NodeData;
    stampNode(n);
    return n;
  }, [typeName]);

  const [previewCtx, setPreviewCtx] = useState<string | null>(null);
  const [node, setNode] = useState<NodeData>(initial);

  if (reactContexts.length === 0) return null;

  const handleFormChange = (partial: Record<string, unknown>) => {
    setNode(prev => {
      const next = { ...prev, ...partial, $path: initial.$path, $type: initial.$type } as NodeData;
      stampNode(next);
      return next;
    });
  };

  return (
    <div>
      <div className="flex gap-1.5 mb-2">
        {reactContexts.map(c => (
          <Button
            key={c}
            variant={previewCtx === c ? 'default' : 'outline'}
            size="sm"
            className="h-auto rounded-full px-2.5 py-0.5 text-xs font-mono"
            onClick={() => setPreviewCtx(prev => prev === c ? null : c)}
          >
            {c}
          </Button>
        ))}
      </div>

      {previewCtx && (
        <div className="flex flex-col gap-3">
          <div className="border border-border rounded-lg p-3 bg-background/50">
            <RenderContext name={previewCtx}>
              <Render value={node} onChange={handleFormChange} />
            </RenderContext>
          </div>

          <details className="group">
            <summary className="text-xs text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors">
              Edit data
            </summary>
            <div className="mt-2 border border-border rounded-lg p-3 bg-muted/30">
              <RenderContext name="react:form">
                <Render value={node} onChange={handleFormChange} />
              </RenderContext>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
