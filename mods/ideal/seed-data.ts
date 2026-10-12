import type { NodeInput } from '@treenx/core/kernel/types';

/** Original ideal seed data shared by both deployment paths. */
export const idealSeed = [
  { $path: 'ideal', $type: 'ideal.board', autoApproveThreshold: 5 },
  { $path: 'ideal/simplify-views', $type: 'ideal.idea', title: 'Simplify view registration', votes: 3, status: 'approved' },
  { $path: 'ideal/auto-typenames', $type: 'ideal.idea', title: 'Auto-generate type names', votes: 1, status: 'new' },
  { $path: 'ideal/dark-mode', $type: 'ideal.idea', title: 'Dark mode support', votes: 7, status: 'new' },
] satisfies readonly NodeInput[];
