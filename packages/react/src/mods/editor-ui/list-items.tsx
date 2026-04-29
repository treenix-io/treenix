// Universal list item components for react:list context
// Self-contained: include card styling, click navigation, chevron

import { useNavigate } from '#navigate';
import type { NodeData } from '@treenx/core';
import { register } from '@treenx/core';

const TYPE_ICONS: Record<string, string> = {
  root: '/',
  folder: 'D',
  page: 'P',
  bot: 'B',
  'type-registry': 'T',
  'mount-point': 'M',
  type: 'S',
  user: 'U',
  shop: 'S',
  config: 'C',
};

function typeIcon(type: string): string {
  return TYPE_ICONS[type] ?? type.charAt(0).toUpperCase();
}

export function pathName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1) || '/';
}

// ── Dir list item ──

function DirListItem({ value }: { value: NodeData }) {
  const navigate = useNavigate();
  const meta = value.metadata as { $type: string; title?: string; description?: string } | undefined;
  return (
    <div className="child-card" onClick={() => navigate(value.$path)}>
      <span className="child-icon">&#128193;</span>
      <div className="child-info">
        <span className="child-name">{meta?.title ?? pathName(value.$path)}</span>
        <span className="child-type">{meta?.description ?? 'dir'}</span>
      </div>
      <span className="child-chevron">&#8250;</span>
    </div>
  );
}
register('dir', 'react:list', DirListItem as any);

// ── Default list item — fallback for any type ──

function DefaultListItem({ value }: { value: NodeData }) {
  const navigate = useNavigate();
  const path = (value as any).$ref ?? value.$path;
  return (
    <div className="child-card" onClick={() => navigate(path)}>
      <span className="child-icon">{typeIcon(value.$type)}</span>
      <div className="child-info">
        <span className="child-name">{pathName(value.$path)}</span>
        <span className="child-type">{value.$type}</span>
      </div>
      <span className="child-chevron">&#8250;</span>
    </div>
  );
}
register('default', 'react:list', DefaultListItem as any);
