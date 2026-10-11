"use client";

import { CalendarSearch, Send } from "lucide-react";
import { useMemo } from "react";
import { almostSlots, daysInRange, findSlots, hasData, leftOutNote, type DayFilter } from "@/lib/availability";
import type { Interval } from "@/lib/intervals";
import { MINUTE, addDays, dayKeyOf, formatDay, formatHours, formatRange } from "@/lib/time";
import type { PersonAvailability } from "@/lib/types";
import { EmptyPeople } from "./day-view";
import { useAvailability } from "./hooks";
import { Avatar, Button, Select, cn, firstName, useCopy } from "./ui";
import type { ViewProps } from "./view-props";

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];
const AHEAD = [3, 7, 14, 30];

const duration = (min: number) => (min < 60 ? `${min} min` : formatHours(min * MINUTE));

/** Agenda-style list of gaps where everyone ticked is free. */
export function ScheduleView({
  tz,
  windowsFor,
  state,
  update,
  people,
  refreshKey,
  now,
  openSlot,
  onInvite,
}: ViewProps & { openSlot: (day: string, range: Interval) => void }) {
  const today = dayKeyOf(now, tz);
  const start = state.date < today ? today : state.date;
  const { data, error, loading } = useAvailability(start, state.ahead, tz, refreshKey);
  const copy = useCopy();

  const avail = useMemo(() => {
    const byId = new Map(data?.people.map((p) => [p.id, p]) ?? []);
    return people.map((p) => byId.get(p.id)).filter((p): p is PersonAvailability => !!p);
  }, [data, people]);

  // Someone whose calendars can't be read would look free all the time.
  const known = avail.filter(hasData);
  const leftOut = data ? leftOutNote(avail) : null;
  const minMs = state.duration * MINUTE;
  const days = daysInRange(start, state.ahead, state.dayFilter);
  const results = data && known.length ? findSlots(known, days, windowsFor, minMs, now) : [];
  const count = results.reduce((n, d) => n + d.slots.length, 0);
  const almost = data && count < 4 ? almostSlots(known, days, windowsFor, minMs, now).slice(0, 10) : [];
  const names = known.map((p) => firstName(p.name)).join(", ");
  const shown = data ? known : people;

  if (people.length === 0) return <EmptyPeople />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-3 border-b border-grid px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex -space-x-2">
            {shown.slice(0, 5).map((p) => (
              <Avatar key={p.id} name={p.name} color={p.color} size={28} className="ring-2 ring-surface" />
            ))}
          </div>
          <div className="font-body text-sm text-fg-2">
            {shown.length === 1 ? "Free time for " : "Times when "}
            <span className="font-medium text-fg">{shown.map((p) => firstName(p.name)).join(", ")}</span>
            {shown.length === 1 ? "" : shown.length === 2 ? " are both free" : " are all free"}
            {leftOut && <div className="text-xs text-warn">{leftOut}</div>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <Select aria-label="Length" value={state.duration} onChange={(e) => update({ duration: Number(e.target.value) })}>
            {DURATIONS.map((m) => (
              <option key={m} value={m}>{`${duration(m)} or longer`}</option>
            ))}
          </Select>
          <Select aria-label="Within" value={state.ahead} onChange={(e) => update({ ahead: Number(e.target.value) })}>
            {AHEAD.map((d) => (
              <option key={d} value={d}>{`Next ${d} days`}</option>
            ))}
          </Select>
          <Select
            aria-label="Days"
            value={state.dayFilter}
            onChange={(e) => update({ dayFilter: e.target.value as DayFilter })}
          >
            <option value="all">Any day</option>
            <option value="weekdays">Weekdays</option>
            <option value="weekends">Weekends</option>
          </Select>
          {count > 0 && (
            <Button
              variant="text"
              onClick={() =>
                copy(
                  [
                    `When ${names} are free (${duration(state.duration)}+):`,
                    ...results.map(
                      (r) => `${formatDay(r.day)}: ${r.slots.map(([s, e]) => formatRange(s, e, tz)).join(", ")}`,
                    ),
                  ].join("\n"),
                )
              }
            >
              Copy all
            </Button>
          )}
        </div>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {error && !data ? (
          <Message title="Couldn't load calendars" body={error} />
        ) : loading && !data ? (
          <div className="flex flex-col gap-3 p-6">
            {[0, 1, 2, 3].map((i) => <div key={i} className="shimmer h-12 rounded-xl bg-surface-2" />)}
          </div>
        ) : count === 0 ? (
          <Message
            title="Nothing fits everyone"
            body={`No ${duration(state.duration)} gap in the next ${state.ahead} days between ${String(state.hours.start).padStart(2, "0")}:00 and ${String(state.hours.end).padStart(2, "0")}:00${state.offHours ? "" : " within working hours"}. Try a shorter length, wider search hours, fewer people${state.offHours ? "" : ", or “Show off-hours” in the sidebar"}.`}
          />
        ) : (
          <ol>
            {results.map(({ day, slots }) => (
              <li key={day} className="grid grid-cols-[92px_minmax(0,1fr)] border-b border-grid px-2 py-2 sm:grid-cols-[140px_minmax(0,1fr)] sm:px-4">
                <DateBlock day={day} today={today} />
                <ul className="flex flex-col">
                  {slots.map((slot) => (
                    <li key={slot[0]}>
                      <SlotRow
                        slot={slot}
                        tz={tz}
                        note={`${formatHours(slot[1] - slot[0])} free`}
                        onClick={() => openSlot(day, slot)}
                        onInvite={() => onInvite(day, slot)}
                      />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}

        {almost.length > 0 && (
          <section className="px-2 pt-6 pb-8 sm:px-4">
            <h2 className="px-3 text-sm font-medium text-fg">Almost works</h2>
            <p className="mb-2 px-3 font-body text-xs text-fg-3">Everyone but one person is free.</p>
            <ul>
              {almost.map(({ day, slot, missing }) => (
                <li key={`${day}-${slot[0]}-${missing.id}`}>
                  <SlotRow
                    slot={slot}
                    tz={tz}
                    prefix={formatDay(day)}
                    note={`without ${firstName(missing.name)}`}
                    hollow
                    onClick={() => openSlot(day, slot)}
                    onInvite={() => onInvite(day, slot)}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function DateBlock({ day, today }: { day: string; today: string }) {
  const isToday = day === today;
  const [y, m, d] = day.split("-").map(Number);
  const sub = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "short", weekday: "short" })
    .format(Date.UTC(y, m - 1, d))
    .toUpperCase();
  return (
    <div className="flex items-start gap-2 pt-1 pl-1">
      <span
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-full text-xl",
          isToday ? "bg-accent text-on-accent" : "text-fg-2",
        )}
      >
        {d}
      </span>
      <span className={cn("pt-2.5 text-[11px] font-medium tracking-wide", isToday ? "text-accent" : "text-fg-2")}>
        {day === addDays(today, 1) ? "TOMORROW" : sub.replace(" ", ", ")}
      </span>
    </div>
  );
}

function SlotRow({
  slot,
  tz,
  note,
  prefix,
  hollow,
  onClick,
  onInvite,
}: {
  slot: Interval;
  tz: string;
  note: string;
  prefix?: string;
  hollow?: boolean;
  onClick: () => void;
  onInvite: () => void;
}) {
  return (
    <div className="group flex items-center gap-1 rounded-full hover:bg-hover">
      <button
        type="button"
        onClick={onClick}
        title="Open on the day view"
        className="flex min-h-11 min-w-0 flex-1 items-center gap-4 rounded-full px-3 text-left font-body text-sm focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span
          aria-hidden
          className={cn("size-2.5 shrink-0 rounded-full", hollow ? "border-2 border-fg-3" : "bg-free-strong")}
        />
        {prefix && <span className="w-24 shrink-0 text-fg-2">{prefix}</span>}
        <span className="w-32 shrink-0 font-medium text-fg">{formatRange(slot[0], slot[1], tz)}</span>
        <span className="truncate text-fg-2">{note}</span>
      </button>
      <Button
        variant="text"
        className="mr-1 h-8 shrink-0 px-3 opacity-70 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={onInvite}
        aria-label={`Invite to ${formatRange(slot[0], slot[1], tz)}`}
      >
        <Send className="size-3.5" aria-hidden /> Invite
      </Button>
    </div>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center">
      <CalendarSearch className="mb-3 size-8 text-fg-3" aria-hidden />
      <p className="text-base font-medium text-fg">{title}</p>
      <p className="mt-1 font-body text-sm text-fg-2">{body}</p>
    </div>
  );
}
