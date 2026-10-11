// Fixed-top banner shown while the SSE stream is disconnected.

import { useTreeEffects } from "#tree/effects";
import { useSseStatus } from "#hooks/use-sse-status";

function LegacyConnectionBanner() {
  const down = useSseStatus();

  if (!down) return null;
  return (
    <div className="fixed top-0 inset-x-0 z-50 bg-yellow-500 text-black text-center text-sm py-1">
      Reconnecting to server…
    </div>
  );
}

/** Native lane failures are presented by their owning source subscribers. */
export function ConnectionBanner() {
  const effects = useTreeEffects();
  return effects.lane ? null : <LegacyConnectionBanner />;
}
