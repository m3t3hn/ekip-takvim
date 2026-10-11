"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { formatRange, formatTime, isTimeZone, offsetLabel, zoneLabel } from "@/lib/time";
import type { Zone } from "@/lib/types";
import { cn } from "./ui";

// The viewer's zone: every time on screen is shown in it. It's the browser's
// own zone unless the viewer picked another one (kept in localStorage). A
// cookie mirrors it so the server renders the same zone on the next visit.

const KEY = "tz";
const listeners = new Set<() => void>();

export function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function readOverride(): string | null {
  try {
    const v = localStorage.getItem(KEY);
    return isTimeZone(v) ? v : null;
  } catch {
    return null;
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

export type ViewerZone = {
  /** Zone times are shown in. */
  zone: string;
  /** The browser's zone: where the viewer actually is. */
  own: string;
  /** Show times in another zone; null goes back to the viewer's own. */
  setZone: (zone: string | null) => void;
};

export function useViewerZone(serverZone: string): ViewerZone {
  const zone = useSyncExternalStore(subscribe, () => readOverride() ?? browserZone(), () => serverZone);
  const own = useSyncExternalStore(subscribe, browserZone, () => serverZone);

  useEffect(() => {
    document.cookie = `${KEY}=${encodeURIComponent(zone)}; path=/; max-age=31536000; samesite=lax`;
  }, [zone]);

  const setZone = useCallback((next: string | null) => {
    try {
      if (next === null || next === browserZone()) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {}
    listeners.forEach((l) => l());
  }, []);

  return useMemo(() => ({ zone, own, setZone }), [zone, own, setZone]);
}

/** The configured zones, plus the viewer's own when it isn't one of them. */
export function zonesFor(configured: Zone[], viewer: ViewerZone): Zone[] {
  const out = [...configured];
  for (const z of [viewer.own, viewer.zone]) {
    if (!out.some((c) => c.zone === z)) out.push({ label: zoneLabel(z, configured), zone: z });
  }
  return out;
}

/** Clocks for each zone; the one times are shown in stands out. Click to switch. */
export function ZoneClocks({ zones, viewer, now }: { zones: Zone[]; viewer: ViewerZone; now: number }) {
  return (
    <section aria-label="Time zones" className="mx-1">
      <h2 className="px-2 text-sm font-semibold text-fg">Time zones</h2>
      <div role="group" className="mt-1.5 flex flex-col gap-0.5">
        {zones.map((z) => {
          const active = z.zone === viewer.zone;
          const own = z.zone === viewer.own;
          return (
            <button
              key={z.zone}
              type="button"
              aria-pressed={active}
              onClick={() => viewer.setZone(z.zone)}
              title={
                `${z.zone} (${offsetLabel(z.zone, now)})` +
                (own ? " · your time zone" : "") +
                (active ? " · times are shown in this zone" : " · click to show times in this zone")
              }
              className={cn(
                "flex h-8 items-center gap-2 rounded-full px-3 text-left font-body text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-accent",
                active ? "bg-accent-container text-on-accent-container" : "text-fg-2 hover:bg-hover",
              )}
            >
              <span className={cn("min-w-0 truncate", active && "font-semibold")}>{z.label}</span>
              {own && (
                <span className="rounded-full bg-accent px-1.5 text-[10px] leading-4 font-semibold tracking-wide text-on-accent uppercase">
                  You
                </span>
              )}
              <span className="ml-auto text-[11px] text-fg-3">{offsetLabel(z.zone, now)}</span>
              <span className={cn("w-11 text-right tabular-nums", active ? "font-semibold" : "text-fg")}>
                {formatTime(now, z.zone)}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 px-2 font-body text-xs text-fg-3">
        Times are shown in {zones.find((z) => z.zone === viewer.zone)?.label ?? viewer.zone} time.
        {viewer.zone !== viewer.own ? (
          <>
            {" "}
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => viewer.setZone(null)}>
              Use mine
            </button>
          </>
        ) : (
          " Pick another to see the calendar on its clock."
        )}
      </p>
    </section>
  );
}

/** "08:00–09:00 UK" when a range reads differently in someone's zone, else null. */
export function localRange(range: [number, number], personZone: string, viewerZone: string, zones: Zone[]): string | null {
  if (formatRange(range[0], range[1], personZone) === formatRange(range[0], range[1], viewerZone)) return null;
  return `${formatRange(range[0], range[1], personZone)} ${zoneLabel(personZone, zones)}`;
}
