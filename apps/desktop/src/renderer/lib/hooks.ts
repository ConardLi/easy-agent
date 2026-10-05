import { useEffect, useState } from "react";

/** Current time, refreshed every `interval` ms while `active`. */
export function useNow(active = true, interval = 200): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [active, interval]);
  return now;
}
