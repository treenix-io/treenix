import { registerPrefab } from '@treenx/core/mod';

registerPrefab('ideal', 'seed', [
  { $path: 'ideal', $type: 'ideal.board', autoApproveThreshold: 5 },
  { $path: 'ideal/simplify-views', $type: 'ideal.idea', title: 'Simplify view registration', votes: 3, status: 'approved' },
  { $path: 'ideal/auto-typenames', $type: 'ideal.idea', title: 'Auto-generate type names', votes: 1, status: 'new' },
  { $path: 'ideal/dark-mode', $type: 'ideal.idea', title: 'Dark mode support', votes: 7, status: 'new' },
]);
