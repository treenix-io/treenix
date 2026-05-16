// SSE connection indicator — true when the stream has been disconnected
// for longer than the grace window. Resets on reconnect.

import { useEffect, useRef, useState } from 'react';
import { SSE_CONNECTED, SSE_DISCONNECTED } from '#tree/events';

const SSE_DOWN_GRACE_MS = 5_000;

export function useSseStatus(): boolean {
  const [down, setDown] = useState(false);
  const downTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const onConnect = () => {
      if (downTimer.current) {
        clearTimeout(downTimer.current);
        downTimer.current = undefined;
      }
      setDown(false);
    };
    const onDisconnect = () => {
      if (!downTimer.current) {
        downTimer.current = setTimeout(() => {
          downTimer.current = undefined;
          setDown(true);
        }, SSE_DOWN_GRACE_MS);
      }
    };
    window.addEventListener(SSE_CONNECTED, onConnect);
    window.addEventListener(SSE_DISCONNECTED, onDisconnect);
    return () => {
      window.removeEventListener(SSE_CONNECTED, onConnect);
      window.removeEventListener(SSE_DISCONNECTED, onDisconnect);
      if (downTimer.current) clearTimeout(downTimer.current);
    };
  }, []);

  return down;
}
