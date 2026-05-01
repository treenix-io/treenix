// Show a sonner toast for each mod that failed to load. Fires once on mount.

import { useEffect } from 'react';
import { toast } from 'sonner';
import { getModErrors } from '#tree/load-client';

export function useModErrors() {
  useEffect(() => {
    const errors = getModErrors();
    if (!errors.size) return;
    for (const [name, msg] of errors) {
      toast.warning(`Mod "${name}" skipped`, { description: msg, duration: 10_000 });
    }
  }, []);
}
