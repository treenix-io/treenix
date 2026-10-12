// @treenx/react — root barrel for package consumers
// Mods should import from here: import { usePath, useActions, cn } from '@treenx/react'
// UI components stay at: @treenx/react/ui/button, etc.

export * from './context/index.tsx';
export * from './hooks';
export * from './navigate';
export { view } from './view';
export { useSave, useAutoSave, usePathSave, scopeOnChange } from '#tree/auto-save';
export type {
  SaveHandle,
  SaveOptions,
  PathSaveHandle,
  PathHandle,
  OnChange,
} from '#tree/auto-save';
export { cn } from '#lib/utils';
export { sanitizeHref } from '#lib/sanitize-href';
export { minimd } from '#lib/minimd';
export { stampNode, stampComponent } from '#symbols';
export { useDraft, type DraftHandle } from './draft';
export { useReactivePathEvents } from '#hooks/use-reactive-path-events';

export type { PresentationNode, PresentationComponent } from '#tree/presentation';

export { createLaneTreeSource } from '#tree/lane-source';
export { createLaneTreeClient } from '#tree/lane-tree-client';
export { createLaneEffects } from '#tree/lane-effects';
export { TreeSourceProvider } from '#tree/tree-source-context';
export type { ClientAction, TreeEffects, KernelEffects } from '#tree/effects';
export type { TreeSource } from '#tree/tree-source';
