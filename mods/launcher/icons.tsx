// Launcher icons — react:icon context with iOS-style SVG icons

import { register } from '@treenx/core';
import type { RenderProps } from '@treenx/react';
import type { FC, ReactNode } from 'react';

// ── Icon shell — rounded rect with gradient + glow ──

function IconShell({ children, g1, g2, glow }: {
  children: ReactNode; g1: string; g2: string; glow?: string;
}) {
  const id = `g-${g1.replace('#', '')}`;
  return (
    <svg viewBox="0 0 120 120" className="h-full w-full" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0.5" y2="1">
          <stop offset="0%" stopColor={g1} />
          <stop offset="100%" stopColor={g2} />
        </linearGradient>
        {/* Highlight sheen */}
        <linearGradient id={`${id}-sheen`} x1="0.5" y1="0" x2="0.5" y2="0.5">
          <stop offset="0%" stopColor="white" stopOpacity="0.3" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Background */}
      <rect x="4" y="4" width="112" height="112" rx="26" fill={`url(#${id})`} />
      {/* Top sheen */}
      <rect x="4" y="4" width="112" height="56" rx="26" fill={`url(#${id}-sheen)`} />
      {/* Subtle inner border */}
      <rect x="4" y="4" width="112" height="112" rx="26" fill="none"
        stroke="white" strokeOpacity="0.15" strokeWidth="1" />
      {/* Icon content */}
      <g fill="white" fillOpacity="0.95">
        {children}
      </g>
    </svg>
  );
}

// ── Board (Kanban) ──
const BoardIcon: FC<RenderProps> = () => (
  <IconShell g1="#6366f1" g2="#4338ca">
    {/* 4 cards in 2 columns */}
    <rect x="28" y="32" width="26" height="20" rx="4" />
    <rect x="28" y="58" width="26" height="30" rx="4" />
    <rect x="66" y="32" width="26" height="30" rx="4" />
    <rect x="66" y="68" width="26" height="20" rx="4" />
    {/* Column divider */}
    <rect x="59" y="30" width="2" height="62" rx="1" fillOpacity="0.3" />
  </IconShell>
);

// ── Todo (Checklist) ──
const TodoIcon: FC<RenderProps> = () => (
  <IconShell g1="#22c55e" g2="#15803d">
    {/* 3 checkbox rows */}
    <rect x="30" y="34" width="14" height="14" rx="4" fillOpacity="0.4" />
    <path d="M34 41 l3 3 l6-6" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    <rect x="52" y="37" width="36" height="6" rx="3" fillOpacity="0.6" />

    <rect x="30" y="54" width="14" height="14" rx="4" fillOpacity="0.4" />
    <path d="M34 61 l3 3 l6-6" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    <rect x="52" y="57" width="28" height="6" rx="3" fillOpacity="0.6" />

    <rect x="30" y="74" width="14" height="14" rx="4" fillOpacity="0.25" />
    <rect x="52" y="77" width="32" height="6" rx="3" fillOpacity="0.35" />
  </IconShell>
);

// ── Contact (Mail) ──
const ContactIcon: FC<RenderProps> = () => (
  <IconShell g1="#f59e0b" g2="#d97706">
    {/* Envelope body */}
    <rect x="24" y="38" width="72" height="48" rx="8" fillOpacity="0.4" />
    {/* Envelope flap — V shape */}
    <path d="M24 42 l36 26 l36-26" fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" strokeOpacity="0.9" />
    {/* Bottom fold */}
    <path d="M24 86 l24-18 M96 86 l-24-18" fill="none" stroke="white" strokeWidth="2" strokeOpacity="0.3" strokeLinecap="round" />
  </IconShell>
);

// ── Docs (Files) ──
const DocsIcon: FC<RenderProps> = () => (
  <IconShell g1="#64748b" g2="#334155">
    {/* Back page */}
    <rect x="38" y="28" width="48" height="62" rx="6" fillOpacity="0.35" />
    {/* Front page */}
    <rect x="30" y="34" width="48" height="62" rx="6" fillOpacity="0.7" />
    {/* Folded corner */}
    <path d="M62 34 l16 0 l0 0 l-16 16 z" fillOpacity="0.3" />
    {/* Text lines */}
    <rect x="38" y="58" width="30" height="4" rx="2" fillOpacity="0.5" />
    <rect x="38" y="68" width="24" height="4" rx="2" fillOpacity="0.4" />
    <rect x="38" y="78" width="28" height="4" rx="2" fillOpacity="0.35" />
  </IconShell>
);

// ── System (Gear) ──
const SystemIcon: FC<RenderProps> = () => (
  <IconShell g1="#475569" g2="#1e293b">
    {/* Gear — outer ring with teeth */}
    <path d="
      M60 28 l5 0 l2 8 l7 3 l7-5 l4 4 l-5 7 l3 7 l8 2 l0 5 l-8 2 l-3 7 l5 7 l-4 4 l-7-5 l-7 3 l-2 8 l-5 0 l-2-8 l-7-3 l-7 5 l-4-4 l5-7 l-3-7 l-8-2 l0-5 l8-2 l3-7 l-5-7 l4-4 l7 5 l7-3 z
    " fillOpacity="0.8" fillRule="evenodd" />
    {/* Inner circle (hole) */}
    <circle cx="60" cy="60" r="14" fill="#334155" />
    <circle cx="60" cy="60" r="14" fill="white" fillOpacity="0.15" />
  </IconShell>
);

// ── Whisper (Audio Waves) ──
const WhisperIcon: FC<RenderProps> = () => (
  <IconShell g1="#8b5cf6" g2="#6d28d9">
    {/* Sound waveform bars */}
    <rect x="30" y="50" width="6" height="20" rx="3" fillOpacity="0.6" />
    <rect x="42" y="38" width="6" height="44" rx="3" fillOpacity="0.8" />
    <rect x="54" y="30" width="6" height="60" rx="3" />
    <rect x="66" y="42" width="6" height="36" rx="3" fillOpacity="0.8" />
    <rect x="78" y="34" width="6" height="52" rx="3" fillOpacity="0.9" />
    <rect x="90" y="48" width="6" height="24" rx="3" fillOpacity="0.5" />
    {/* Subtle glow circle */}
    <circle cx="60" cy="60" r="38" fill="white" fillOpacity="0.05" />
  </IconShell>
);

// ── Sim (Network/Agents) ──
const SimIcon: FC<RenderProps> = () => (
  <IconShell g1="#06b6d4" g2="#0e7490">
    {/* 3 connected nodes */}
    <circle cx="60" cy="38" r="10" fillOpacity="0.9" />
    <circle cx="38" cy="78" r="10" fillOpacity="0.7" />
    <circle cx="82" cy="78" r="10" fillOpacity="0.7" />
    {/* Connecting lines */}
    <line x1="54" y1="46" x2="42" y2="70" stroke="white" strokeWidth="3" strokeOpacity="0.5" strokeLinecap="round" />
    <line x1="66" y1="46" x2="78" y2="70" stroke="white" strokeWidth="3" strokeOpacity="0.5" strokeLinecap="round" />
    <line x1="48" y1="78" x2="72" y2="78" stroke="white" strokeWidth="3" strokeOpacity="0.5" strokeLinecap="round" />
    {/* Center pulse */}
    <circle cx="60" cy="60" r="6" fillOpacity="0.4" />
  </IconShell>
);

// ── LLM (Brain/AI) ──
const LlmIcon: FC<RenderProps> = () => (
  <IconShell g1="#a855f7" g2="#c026d3">
    {/* Brain left half */}
    <path d="M58 36 C48 36, 32 40, 32 56 C32 68, 40 78, 50 82 C52 82, 56 80, 58 76"
      fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" strokeOpacity="0.85" />
    {/* Brain right half */}
    <path d="M62 36 C72 36, 88 40, 88 56 C88 68, 80 78, 70 82 C68 82, 64 80, 62 76"
      fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" strokeOpacity="0.85" />
    {/* Center line */}
    <line x1="60" y1="34" x2="60" y2="84" stroke="white" strokeWidth="2" strokeOpacity="0.4" />
    {/* Neural connection dots */}
    <circle cx="44" cy="52" r="3" fillOpacity="0.7" />
    <circle cx="76" cy="52" r="3" fillOpacity="0.7" />
    <circle cx="48" cy="68" r="3" fillOpacity="0.5" />
    <circle cx="72" cy="68" r="3" fillOpacity="0.5" />
    {/* Sparkle top */}
    <path d="M60 28 l0-4 M56 30 l-2-3 M64 30 l2-3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeOpacity="0.6" />
  </IconShell>
);

// ── Sensor (Thermometer + gauge) ──
const SensorIcon: FC<RenderProps> = () => (
  <IconShell g1="#10b981" g2="#047857">
    {/* Thermometer body */}
    <rect x="50" y="28" width="12" height="46" rx="6" fillOpacity="0.4" />
    {/* Mercury */}
    <rect x="53" y="42" width="6" height="32" rx="3" />
    {/* Bulb */}
    <circle cx="56" cy="80" r="12" fillOpacity="0.9" />
    <circle cx="56" cy="80" r="7" fill="#047857" />
    <circle cx="56" cy="80" r="7" fill="white" fillOpacity="0.8" />
    {/* Tick marks */}
    <rect x="64" y="34" width="10" height="2" rx="1" fillOpacity="0.4" />
    <rect x="64" y="42" width="14" height="2" rx="1" fillOpacity="0.5" />
    <rect x="64" y="50" width="10" height="2" rx="1" fillOpacity="0.4" />
    <rect x="64" y="58" width="14" height="2" rx="1" fillOpacity="0.5" />
  </IconShell>
);

// ── Folder ──
const FolderIcon: FC<RenderProps> = () => (
  <IconShell g1="#3b82f6" g2="#1d4ed8">
    {/* Folder tab */}
    <path d="M28 40 l0-6 a4 4 0 0 1 4-4 l18 0 l6 8 l36 0 a4 4 0 0 1 4 4 l0 0 z" fillOpacity="0.5" />
    {/* Folder body */}
    <rect x="28" y="40" width="64" height="48" rx="6" fillOpacity="0.8" />
    {/* Subtle front face highlight */}
    <rect x="28" y="52" width="64" height="36" rx="6" fillOpacity="0.15" />
  </IconShell>
);

// ── Default fallback — hue from type hash ──

const HUES = [0, 25, 45, 60, 90, 140, 170, 200, 220, 260, 290, 320];

function hashHue(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return HUES[Math.abs(h) % HUES.length];
}

const DefaultIcon: FC<RenderProps> = ({ value }) => {
  const hue = hashHue(value.$type);
  const parts = value.$type.split('.');
  const letter = (parts.at(-1) || value.$type)[0]?.toUpperCase() || '?';
  const g1 = `hsl(${hue}, 65%, 55%)`;
  const g2 = `hsl(${hue}, 70%, 35%)`;

  return (
    <IconShell g1={g1} g2={g2}>
      <text x="60" y="68" textAnchor="middle" fontSize="40" fontWeight="700" fontFamily="system-ui"
        fill="white" fillOpacity="0.9">
        {letter}
      </text>
    </IconShell>
  );
};

// ── Register all ──

register('default', 'react:icon', DefaultIcon);
register('dir', 'react:icon', FolderIcon);
register('board.kanban', 'react:icon', BoardIcon);
register('board.task', 'react:icon', BoardIcon);
register('todo.list', 'react:icon', TodoIcon);
register('cafe.contact', 'react:icon', ContactIcon);
register('mount-point', 'react:icon', DocsIcon);
register('treenix.system', 'react:icon', SystemIcon);
register('whisper.service', 'react:icon', WhisperIcon);
register('examples.demo.sensor', 'react:icon', SensorIcon);
register('t.llm', 'react:icon', LlmIcon);
