import type { NodeInput } from '@treenx/core/kernel/types';

export const cafeSeed = [
  { $path: 'cafe', $type: 'dir' },
  { $path: 'cafe/contact', $type: 'cafe.contact', recipient: 'owner@cafe.example' },
  { $path: 'cafe/pages', $type: 'dir' },
] satisfies NodeInput[];
