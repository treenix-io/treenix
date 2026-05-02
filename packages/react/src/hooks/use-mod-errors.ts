// Show a sonner toast for each mod that failed to load. Fires once on mount.
//
// Imports getModErrors directly from '#mod-errors' — NOT via '#tree/load-client'
// (which side-effect imports virtual:mod-clients). Mods themselves call this
// hook (editor-shell), so going through load-client would create a cycle:
// virtual:mod-clients → editor-shell → use-mod-errors → load-client →
// virtual:mod-clients (hangs at init).

import { useEffect } from 'react';
import { toast } from 'sonner';
import { getModErrors } from '#mod-errors';

export function useModErrors() {
  useEffect(() => {
    const errors = getModErrors();
    if (!errors.size) return;
    for (const [name, msg] of errors) {
      toast.warning(`Mod "${name}" skipped`, { description: msg, duration: 10_000 });
    }
  }, []);
}
