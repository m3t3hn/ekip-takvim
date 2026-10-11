"use client";

import { commonFree, freeIn, hasData, noDataText } from "@/lib/availability";
import { colorStyle } from "@/lib/colors";
import { atLeast, total, type Interval } from "@/lib/intervals";
import { addDays, dayStart, formatHours, formatRange } from "@/lib/time";
import type { AvailabilityResponse, PersonAvailability } from "@/lib/types";
import { cn, firstName } from "./ui";

// Shared pieces for the big-cell week and month views: each day is a box
// with plain-text availability instead of hour bars.

export type PersonDay = {
  person: PersonAvailability;
  /** Free gaps inside the search hours that are at least the minimum length. */
  free: Interval[];
  freeMs: number;
  span: number;
  /** Jobs this person is at during the search hours. */
  labels: string[];
  /** Label of an all-day event (vacation, out of office), if any. */
  off: string | null;
  /** Why their free time isn't known; such people never show as free. */
  noData: { short: string; long: string } | null;
};

export type DaySummary = {
  day: string;
  covered: boolean;
  /** No search window at all, e.g. a weekend outside working hours. */
  closed: boolean;
  common: Interval[];
  people: PersonDay[];
};

export function summarizeDay(
  data: AvailabilityResponse | null,
  avail: PersonAvailability[],
  day: string,
  windows: Interval[],
  tz: string,
  minMs: number,
): DaySummary {
  const covered = !!data && day >= data.coverage.from && day <= data.coverage.to;
  const closed = windows.length === 0;
  if (!covered) return { day, covered, closed, common: [], people: [] };
  const span = total(windows);
  const from = dayStart(day, tz);
  const to = dayStart(addDays(day, 1), tz);
  const known = avail.filter(hasData);
  return {
    day,
    covered,
    closed,
    common: known.length >= 2 ? atLeast(commonFree(known, windows), minMs) : [],
    people: avail.map((p) => {
      const free = atLeast(freeIn(p, windows), minMs);
      const allDay = p.busy.find((b) => b.allDay && b.start < to && b.end > from);
      const labels = [
        ...new Set(
          p.busy
            .filter((b) => !b.allDay && windows.some(([s, e]) => b.start < e && b.end > s))
            .map((b) => b.label),
        ),
      ];
      return {
        person: p,
        free,
        freeMs: total(free),
        span,
        labels,
        off: allDay ? allDay.label : null,
        noData: noDataText(p),
      };
    }),
  };
}

export function statusOf(pd: PersonDay): { text: string; tone: "free" | "part" | "busy" | "unknown" } {
  if (pd.noData) return { text: pd.noData.short, tone: "unknown" };
  if (pd.off) return { text: "Off", tone: "busy" };
  if (pd.freeMs >= pd.span) return { text: "Free all day", tone: "free" };
  if (pd.freeMs === 0) return { text: "Busy", tone: "busy" };
  return { text: `${formatHours(pd.freeMs)} free`, tone: "part" };
}

const toneClass = {
  free: "text-on-free",
  part: "text-fg-2",
  busy: "text-fg-3",
  unknown: "text-warn",
};

export function DateBadge({
  day,
  today,
  size = "md",
  muted,
}: {
  day: string;
  today: string;
  size?: "sm" | "md" | "lg";
  muted?: boolean;
}) {
  const isToday = day === today;
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full",
        size === "lg" ? "size-11 text-2xl" : size === "md" ? "size-7 text-xs font-medium" : "size-6 text-xs font-medium",
        isToday ? "bg-accent text-on-accent" : muted ? "text-fg-3" : "text-fg",
      )}
    >
      {Number(day.slice(8))}
    </span>
  );
}

/** One person's day: colour dot, name, how much free time, and when. */
export function PersonLine({
  pd,
  tz,
  detail,
  onClick,
}: {
  pd: PersonDay;
  tz: string;
  detail: boolean;
  onClick: () => void;
}) {
  const { text, tone } = statusOf(pd);
  const name = firstName(pd.person.name);
  const freeText = pd.free.map(([s, e]) => formatRange(s, e, tz)).join(", ");
  return (
    <button
      type="button"
      onClick={onClick}
      title={
        pd.noData
          ? `${pd.person.name} ${pd.noData.long}, so their free time isn't known`
          : pd.off
          ? `${pd.person.name} — off (${pd.off})`
          : `${pd.person.name} — ${pd.free.length ? `free ${freeText}` : "no free time"}${pd.labels.length ? ` · at ${pd.labels.join(", ")}` : ""}`
      }
      className={cn(
        "block w-full rounded-md text-left font-body hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent",
        detail ? "px-2 py-1.5" : "px-1.5 py-px",
      )}
    >
      {/* Status wraps under the name when the box is narrow. */}
      <div className={cn("flex min-w-0 items-center gap-x-1.5", detail && "flex-wrap")}>
        <span className="flex min-w-0 max-w-full items-center gap-1.5">
          <span aria-hidden className="swatch size-2 shrink-0 rounded-full" style={colorStyle(pd.person.color)} />
          <span className={cn("min-w-0 truncate text-fg", detail ? "text-[13px] font-medium" : "text-xs")}>{name}</span>
        </span>
        <span
          className={cn(
            "shrink-0 whitespace-nowrap",
            detail ? "ml-auto pl-3.5 text-xs" : "ml-auto text-[11px]",
            toneClass[tone],
          )}
        >
          {text}
        </span>
      </div>
      {detail && (
        <div className="pl-3.5">
          {pd.noData ? (
            <div className="mt-0.5 truncate text-xs text-fg-3">{pd.noData.long}</div>
          ) : pd.off ? (
            <div className="mt-0.5 truncate text-xs text-fg-3">{pd.off}, all day</div>
          ) : (
            <>
              {pd.free.length > 0 && pd.freeMs < pd.span && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {pd.free.map(([s, e]) => (
                    <span key={s} className="rounded bg-free px-1.5 py-px text-[11px] font-medium text-on-free">
                      {formatRange(s, e, tz)}
                    </span>
                  ))}
                </div>
              )}
              {pd.labels.length > 0 && (
                <div className="mt-1 truncate text-[11px] text-fg-3">At {pd.labels.join(", ")}</div>
              )}
            </>
          )}
        </div>
      )}
    </button>
  );
}

export function CommonChips({
  common,
  tz,
  onPick,
}: {
  common: Interval[];
  tz: string;
  onPick: (slot: Interval) => void;
}) {
  if (common.length === 0) {
    return <div className="px-2 font-body text-xs text-fg-3">No shared time</div>;
  }
  return (
    <div className="flex flex-wrap gap-1 px-1.5">
      {common.map((slot) => (
        <button
          key={slot[0]}
          type="button"
          onClick={() => onPick(slot)}
          title="Everyone ticked is free — open on the day view"
          className="rounded-md bg-free-strong px-2 py-0.5 font-body text-xs font-medium text-surface hover:brightness-110 focus-visible:outline-2 focus-visible:outline-accent"
        >
          {formatRange(slot[0], slot[1], tz)}
        </button>
      ))}
    </div>
  );
}

export function weekdayNames(weekStartsOn: 0 | 1): string[] {
  return Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" })
      .format(Date.UTC(2026, 0, 4 + weekStartsOn + i))
      .toUpperCase(),
  );
}
