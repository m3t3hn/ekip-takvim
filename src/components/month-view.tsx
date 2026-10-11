"use client";

import { useMemo } from "react";
import { colorStyle } from "@/lib/colors";
import { total, type Interval } from "@/lib/intervals";
import { MINUTE, addDays, dayKeyOf, diffDays, formatDay, formatHours, startOfWeek } from "@/lib/time";
import type { PersonAvailability } from "@/lib/types";
import { DateBadge, PersonLine, summarizeDay, weekdayNames } from "./cells";
import { EmptyPeople } from "./day-view";
import { useAvailability } from "./hooks";
import { cn } from "./ui";
import type { ViewProps } from "./view-props";

/** Month grid of day boxes: who's free how much, and the shared time. */
export function MonthView({
  settings,
  tz,
  windowsFor,
  state,
  update,
  people,
  refreshKey,
  now,
  openSlot,
}: ViewProps & { openSlot: (day: string, slot: Interval) => void }) {
  const month = state.date.slice(0, 7);
  const first = `${month}-01`;
  const gridStart = startOfWeek(first, settings.weekStartsOn);
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const weeks = Math.ceil((diffDays(gridStart, first) + daysInMonth) / 7);
  const { data, error } = useAvailability(gridStart, weeks * 7, tz, refreshKey);
  const today = dayKeyOf(now, tz);
  const names = weekdayNames(settings.weekStartsOn);
  const maxLines = weeks > 5 ? 4 : 5;

  const avail = useMemo(() => {
    const byId = new Map(data?.people.map((p) => [p.id, p]) ?? []);
    return people.map((p) => byId.get(p.id)).filter((p): p is PersonAvailability => !!p);
  }, [data, people]);

  if (people.length === 0) return <EmptyPeople />;

  const openDay = (day: string) => update({ view: "day", date: day });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error && !data && <p className="border-b border-grid px-5 py-2 font-body text-sm text-danger">{error}</p>}
      <div className="grid shrink-0 grid-cols-7 border-b border-grid">
        {names.map((n) => (
          <div key={n} className="py-2 text-center text-[11px] font-medium tracking-wide text-fg-2">
            {n}
          </div>
        ))}
      </div>
      <div className="scrollbar-thin @container min-h-0 flex-1 overflow-y-auto">
        <div
          className="grid h-full grid-cols-7"
          style={{ gridTemplateRows: `repeat(${weeks}, minmax(${weeks > 5 ? 136 : 152}px, 1fr))` }}
        >
          {Array.from({ length: weeks * 7 }, (_, i) => {
            const day = addDays(gridStart, i);
            const inMonth = day.slice(0, 7) === month;
            const s = summarizeDay(data, avail, day, windowsFor(day), tz, state.min * MINUTE);
            const shared = total(s.common);
            // Leave room for the "N more" line itself when not everyone fits.
          const shown = s.people.length > maxLines ? maxLines - 1 : maxLines;
          const hidden = s.people.length - shown;
            return (
              <div
                key={day}
                className={cn(
                  "flex min-w-0 flex-col border-b border-l border-grid pb-1",
                  i % 7 === 0 && "border-l-0",
                  (!inMonth || s.closed) && "bg-offhours",
                )}
              >
                <button
                  type="button"
                  onClick={() => openDay(day)}
                  title={`Open ${formatDay(day, "long")}`}
                  className="mx-auto mt-1 flex shrink-0 items-center gap-1 rounded-full px-1 hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {day.endsWith("-01") && (
                    <span className="pl-1 text-xs font-medium text-fg-2">
                      {new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(Date.UTC(y, Number(day.slice(5, 7)) - 1, 1))}
                    </span>
                  )}
                  <DateBadge day={day} today={today} size="sm" muted={!inMonth} />
                </button>

                <div className={cn("flex min-h-0 flex-1 flex-col gap-px overflow-hidden px-1", !inMonth && "opacity-60")}>
                  {!data ? (
                    <div className="shimmer mx-1 mt-1 h-4 rounded bg-surface-2" />
                  ) : !s.covered ? null : s.closed ? (
                    <div className="px-1.5 pt-1 font-body text-[11px] text-fg-3">Off</div>
                  ) : (
                    <>
                      {avail.length >= 2 && shared > 0 && (
                        <button
                          type="button"
                          onClick={() => openSlot(day, s.common[0])}
                          title="Everyone ticked is free — open the first shared slot"
                          className="mb-0.5 shrink-0 truncate rounded bg-free-strong px-1.5 py-px text-left font-body text-[11px] font-medium text-surface hover:brightness-110 focus-visible:outline-2 focus-visible:outline-accent"
                        >
                          {formatHours(shared)}
                          <span className="@max-[48rem]:hidden"> together</span>
                        </button>
                      )}

                      {/* Narrow grids: one dot per person, filled when they have free time. */}
                      <div className="flex flex-wrap justify-center gap-1 pt-0.5 @min-[48rem]:hidden">
                        {s.people.map((pd) => (
                          <span
                            key={pd.person.id}
                            className={cn(
                              "size-2 rounded-full",
                              pd.noData
                                ? "border border-dashed border-warn"
                                : pd.freeMs > 0 && !pd.off
                                  ? "swatch"
                                  : "border border-[var(--pc)] opacity-50",
                            )}
                            style={colorStyle(pd.person.color)}
                          />
                        ))}
                      </div>

                      <div className="@max-[48rem]:hidden">
                        {s.people.slice(0, shown).map((pd) => (
                          <PersonLine key={pd.person.id} pd={pd} tz={tz} detail={false} onClick={() => openDay(day)} />
                        ))}
                        {hidden > 0 && (
                          <button
                            type="button"
                            onClick={() => openDay(day)}
                            className="block w-full rounded-md px-1.5 text-left font-body text-[11px] font-medium text-fg-2 hover:bg-hover"
                          >
                            {hidden} more
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
