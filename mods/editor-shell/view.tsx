// Placeholder. Step 7 replaces this with the migrated Editor body.
//
// Until then, this view is dormant — the route /sys/routes/t exists in the
// tree but Router.tsx (Phase 2 step 9) hasn't switched to the resolver yet,
// so /t/* still hits the legacy Router branch.

import { view } from '@treenx/react';
import { EditorShell } from './types';

const EditorShellView = () => (
  <div className="p-4 text-sm italic text-[--text-3]">
    editor-shell placeholder — Editor body migration pending
  </div>
);

view(EditorShell, EditorShellView);
