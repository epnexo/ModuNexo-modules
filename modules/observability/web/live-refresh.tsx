"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** The router's refresh; a no-op where no router is mounted (a bare render in a test), which never happens inside the app. */
function useRefresh(): () => void {
  try { return useRouter().refresh; } catch { return () => {}; }
}

/**
 * Keeps a page current: while "Live" is on and the tab is visible it asks the server for fresh data every
 * `intervalSeconds` without a page reload, and says how long ago it last did. The switch pauses it.
 */
export default function LiveRefresh({ intervalSeconds = 30 }: { intervalSeconds?: number }) {
  const refresh = useRefresh();
  const [live, setLive] = useState(true);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setElapsed((seconds) => {
        if (seconds + 1 < intervalSeconds) return seconds + 1;
        refresh();
        return 0;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [live, intervalSeconds, refresh]);

  return (
    <span className="obs-live" data-live={live}>
      <button type="button" className="btn btn-sm" aria-pressed={live} title={`Refreshes every ${intervalSeconds} s`} onClick={() => { setLive((on) => !on); setElapsed(0); }}>
        <span className="obs-pulse" aria-hidden="true" />
        {live ? "Live" : "Paused"}
      </button>
      <span className="obs-foot" aria-live="off">{live ? (elapsed < 2 ? "updated just now" : `updated ${elapsed} s ago`) : "refresh is off"}</span>
    </span>
  );
}
