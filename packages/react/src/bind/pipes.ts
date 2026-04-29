// Pipe registry — Angular-style transforms for $map expressions

import type { NodeData } from '@treenx/core';

export type PipeFn = (input: unknown, ...args: unknown[]) => unknown;

const registry = new Map<string, PipeFn>();

export function registerPipe(name: string, fn: PipeFn): void {
  registry.set(name, fn);
}

export function getPipe(name: string): PipeFn | undefined {
  return registry.get(name);
}

// ── Collection pipes ──

registerPipe('last', (input) => {
  const arr = input as NodeData[];
  return arr.length ? arr[arr.length - 1] : undefined;
});

registerPipe('first', (input) => {
  const arr = input as NodeData[];
  return arr.length ? arr[0] : undefined;
});

registerPipe('count', (input) => (input as unknown[]).length);

registerPipe('map', (input, field) => {
  return (input as Record<string, unknown>[]).map(item => item[field as string]);
});

registerPipe('sum', (input) => {
  return (input as number[]).reduce((a, b) => a + b, 0);
});

registerPipe('avg', (input) => {
  const arr = input as number[];
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
});

registerPipe('max', (input) => Math.max(...(input as number[])));

registerPipe('min', (input) => Math.min(...(input as number[])));

// ── Scalar pipes ──

registerPipe('div', (input, n) => (input as number) / (n as number));

registerPipe('mul', (input, n) => (input as number) * (n as number));

registerPipe('add', (input, n) => (input as number) + (n as number));

registerPipe('sub', (input, n) => (input as number) - (n as number));

registerPipe('clamp', (input, min, max) =>
  Math.min(Math.max(input as number, min as number), max as number));

registerPipe('round', (input) => Math.round(input as number));

registerPipe('abs', (input) => Math.abs(input as number));

registerPipe('floor', (input) => Math.floor(input as number));

registerPipe('ceil', (input) => Math.ceil(input as number));

// ── Reactivity control ──

registerPipe('once', (input) => input);
