"use client";

import { useMemo } from "react";
import type { Interval } from "@/lib/intervals";
import { MINUTE, addDays, dayKeyOf, formatDay, startOfWeek } from "@/lib/time";
import type { PersonAvailability } from "@/lib/types";
import { CommonChips, DateBadge, PersonLine, summarizeDay, weekdayNames } from "./cells";
import { EmptyPeople } from "./day-view";
import { useAvailability } from "./hooks";
import { cn } from "./ui";
import type { ViewProps } from "./view-props";

/** Seven big day boxes; each lists who's free when, as text. */
export function WeekView({
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
  const weekStart = startOfWeek(state.date, settings.weekStartsOn);
  const { data, error } = useAvailability(weekStart, 7, tz, refreshKey);
  const today = dayKeyOf(now, tz);
  const names = weekdayNames(settings.weekStartsOn);

  const avail = useMemo(() => {
    const byId = new Map(data?.people.map((p) => [p.id, p]) ?? []);
    return people.map((p) => byId.get(p.id)).filter((p): p is PersonAvailability => !!p);
  }, [data, people]);

  if (people.length === 0) return <EmptyPeople />;

  const openDay = (day: string) => update({ view: "day", date: day });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error && !data && <p className="border-b border-grid px-5 py-2 font-body text-sm text-danger">{error}</p>}
      {/* Seven columns when there's room; otherwise one row per day. */}
      <div className="scrollbar-thin @container min-h-0 flex-1 overflow-y-auto">
        <div className="grid min-h-full grid-cols-1 @min-[56rem]:grid-cols-7">
          {Array.from({ length: 7 }, (_, i) => {
            const day = addDays(weekStart, i);
            const s = summarizeDay(data, avail, day, windowsFor(day), tz, state.min * MINUTE);
            const past = day < today;
            return (
              <section
                key={day}
                aria-label={formatDay(day, "long")}
                className="grid min-w-0 grid-cols-[72px_minmax(0,1fr)] border-b border-grid @min-[56rem]:flex @min-[56rem]:flex-col @min-[56rem]:border-b-0 @min-[56rem]:border-l @min-[56rem]:first:border-l-0"
              >
                <button
                  type="button"
                  onClick={() => openDay(day)}
                  title={`Open ${formatDay(day, "long")}`}
                  className="group flex flex-col items-center gap-0.5 self-start px-2 pt-3 pb-2 focus-visible:outline-2 focus-visible:outline-accent @min-[56rem]:sticky @min-[56rem]:top-0 @min-[56rem]:z-10 @min-[56rem]:self-stretch @min-[56rem]:border-b @min-[56rem]:border-grid @min-[56rem]:bg-surface"
                >
                  <span
                    className={cn(
                      "text-[11px] font-medium tracking-wide",
                      day === today ? "text-accent" : "text-fg-2",
                    )}
                  >
                    {names[i]}
                  </span>
                  <span className="rounded-full group-hover:bg-hover">
                    <DateBadge day={day} today={today} size="lg" muted={past} />
                  </span>
                </button>

                <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5 p-1.5", past && "opacity-60")}>
                  {!data ? (
                    <Loading />
                  ) : !s.covered ? (
                    <p className="px-2 py-3 font-body text-xs text-fg-3">No calendar data this far out.</p>
                  ) : s.closed ? (
                    <p className="px-2 py-3 font-body text-xs text-fg-3">
                      {state.offHours ? "Outside the search hours." : "Not a working day. Turn on “Show off-hours” to include it."}
                    </p>
                  ) : (
                    <>
                      {avail.length >= 2 && (
                        <div className="mb-1 border-b border-grid pb-2 @max-[56rem]:flex @max-[56rem]:items-center @max-[56rem]:gap-1">
                          <div className="px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-wide whitespace-nowrap text-on-free uppercase @max-[56rem]:pb-1">
                            Everyone free
                          </div>
                          <CommonChips common={s.common} tz={tz} onPick={(slot) => openSlot(day, slot)} />
                        </div>
                      )}
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-0.5 @min-[56rem]:flex @min-[56rem]:flex-col">
                        {s.people.map((pd) => (
                          <PersonLine key={pd.person.id} pd={pd} tz={tz} detail onClick={() => openDay(day)} />
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-2 p-1">
      {[0, 1, 2].map((i) => (
        <div key={i} className="shimmer h-9 rounded-md bg-surface-2" />
      ))}
    </div>
  );
}
