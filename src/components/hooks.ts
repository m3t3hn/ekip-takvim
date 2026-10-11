"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AvailabilityResponse, StatusResponse } from "@/lib/types";

// One shared 30s clock. During hydration the server's timestamp is used so
// the first client render matches the HTML; the live time takes over after.
let clock = 0;
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | undefined;

function subscribeClock(cb: () => void) {
  clockListeners.add(cb);
  if (!clockTimer) {
    clock = Date.now();
    clockTimer = setInterval(() => {
      clock = Date.now();
      clockListeners.forEach((l) => l());
    }, 30_000);
  }
  return () => {
    clockListeners.delete(cb);
    if (clockListeners.size === 0) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}

export function useNow(serverNow: number): number {
  return useSyncExternalStore(
    subscribeClock,
    () => clock || serverNow,
    () => serverNow,
  );
}

type Loadable<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
};

function usePolling<T>(
  url: string | null,
  pollMs: number,
  refreshKey = 0,
): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const lastUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    const urlChanged = lastUrl.current !== url;
    lastUrl.current = url;

    const load = async () => {
      if (urlChanged) setLoading(true);
      try {
        const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
        setData(body as T);
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Request failed");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();

    const id = setInterval(load, pollMs);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      controller.abort();
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [url, pollMs, tick, refreshKey]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/** `start` and `days` are calendar days in `tz`, the viewer's zone. */
export function useAvailability(start: string, days: number, tz: string, refreshKey = 0) {
  const result = usePolling<AvailabilityResponse>(
    `/api/availability?start=${start}&days=${days}&tz=${encodeURIComponent(tz)}`,
    120_000,
    refreshKey,
  );
  // Keep showing the previous range while a new one loads, but only if it
  // covers the same request; otherwise callers would render the wrong days.
  const fresh =
    result.data && result.data.start === start && result.data.days === days && result.data.timezone === tz
      ? result.data
      : null;
  return { ...result, data: fresh };
}

export function useStatus(pollMs = 60_000) {
  return usePolling<StatusResponse>("/api/status", pollMs);
}

