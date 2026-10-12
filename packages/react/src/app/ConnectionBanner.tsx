// Fixed-top banner shown while the native lane reconnects.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTreeSource } from '#tree/tree-source-context';

const connected = () => 'connected' as const;
const noSubscription = () => () => {};

/** Preserve the existing banner while observing only the selected lane's transport owner. */
export function ConnectionBanner() {
  const connection = useTreeSource().connection;
  const state = useSyncExternalStore(
    connection?.subscribe ?? noSubscription,
    connection?.getSnapshot ?? connected,
    connected,
  );
  const [down, setDown] = useState(false);

  useEffect(() => {
    if (state === 'connected') {
      setDown(false);
      return;
    }
    const timer = setTimeout(() => setDown(true), 5000);
    return () => clearTimeout(timer);
  }, [state]);

  if (!down) return null;
  return (
    <div className="fixed top-0 inset-x-0 z-50 bg-yellow-500 text-black text-center text-sm py-1">
      {state === 'disconnected'
        ? 'Connection to server lost. Reload to reconnect.'
        : 'Reconnecting to server…'}
    </div>
  );
}
