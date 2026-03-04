// Launcher icons — react:icon context for type icons on the home screen

import { register } from '@treenity/core/core';
import type { RenderProps } from '@treenity/react/context';
import {
  Bot,
  ChefHat,
  ClipboardList,
  Coffee,
  FileText,
  Folder,
  Globe,
  LayoutDashboard,
  ListTodo,
  Orbit,
  Rocket,
  Thermometer,
} from 'lucide-react';
import type { FC } from 'react';

// ── Deterministic color from type name ──

const PALETTE = [
  'bg-red-500', 'bg-orange-500', 'bg-amber-500', 'bg-yellow-500',
  'bg-lime-500', 'bg-green-500', 'bg-emerald-500', 'bg-teal-500',
  'bg-cyan-500', 'bg-sky-500', 'bg-blue-500', 'bg-indigo-500',
  'bg-violet-500', 'bg-purple-500', 'bg-fuchsia-500', 'bg-pink-500',
  'bg-rose-500',
];

function hashIndex(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h) % PALETTE.length;
}

function typeLabel(type: string): string {
  const parts = type.split('.');
  return (parts[parts.length - 1] || type)[0]?.toUpperCase() || '?';
}

// ── Default fallback — colored rounded square with first letter ──

const DefaultIcon: FC<RenderProps> = ({ value }) => {
  const bg = PALETTE[hashIndex(value.$type)];
  const letter = typeLabel(value.$type);
  return (
    <div className={`flex h-full w-full items-center justify-center rounded-2xl text-white font-bold text-2xl select-none ${bg}`}>
      {letter}
    </div>
  );
};

register('default', 'react:icon', DefaultIcon);

// ── Icon wrapper — standardized colored bg + lucide icon ──

function makeIcon(Icon: FC<{ className?: string }>, bg: string): FC<RenderProps> {
  return () => (
    <div className={`flex h-full w-full items-center justify-center rounded-2xl ${bg}`}>
      <Icon className="h-7 w-7 text-white" />
    </div>
  );
}

// ── Per-type icons ──

register('dir', 'react:icon', makeIcon(Folder, 'bg-blue-500'));
register('board.kanban', 'react:icon', makeIcon(LayoutDashboard, 'bg-indigo-500'));
register('board.task', 'react:icon', makeIcon(ClipboardList, 'bg-blue-600'));
register('landing.page', 'react:icon', makeIcon(Rocket, 'bg-gradient-to-br from-pink-500 to-orange-400'));
register('brahman.bot', 'react:icon', makeIcon(Bot, 'bg-violet-600'));
register('examples.demo.sensor', 'react:icon', makeIcon(Thermometer, 'bg-emerald-500'));
register('cafe.menu', 'react:icon', makeIcon(ChefHat, 'bg-amber-500'));
register('cafe.cafe', 'react:icon', makeIcon(Coffee, 'bg-amber-600'));
register('todo.list', 'react:icon', makeIcon(ListTodo, 'bg-green-500'));
register('mabu.page', 'react:icon', makeIcon(Globe, 'bg-cyan-500'));
register('t.mount-point', 'react:icon', makeIcon(FileText, 'bg-slate-500'));
register('changelog.feed', 'react:icon', makeIcon(FileText, 'bg-rose-500'));
register('metatron.config', 'react:icon', makeIcon(Bot, 'bg-purple-600'));
register('treenity.system', 'react:icon', makeIcon(Orbit, 'bg-slate-600'));
