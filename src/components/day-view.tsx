"use client";

import { TriangleAlert, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { commonFree, freeIn, hasData, leftOutNote, noDataText } from "@/lib/availability";
import { atLeast, total, type Interval } from "@/lib/intervals";
import { MINUTE, formatDay, formatHours, formatRange, formatTime, zoneLabel } from "@/lib/time";
import type { PersonAvailability } from "@/lib/types";
import { EventDialog } from "./event-dialog";
import { useAvailability } from "./hooks";
import { SelectionCard } from "./selection-card";
import { TimeGrid, type GridColumn } from "./time-grid";
import { Avatar, cn, firstName, useCopy } from "./ui";
import type { ViewProps } from "./view-props";

/** One day, people side by side — each person is a column. */
export function DayView({
  settings,
  tz,
  zones,
  windowsFor,
  selectableFor,
  state,
  people,
  refreshKey,
  now,
  selection,
  setSelection,
  onInvite,
}: ViewProps) {
  const { data, error } = useAvailability(state.date, 1, tz, refreshKey);
  const copy = useCopy();
  const [openEvent, setOpenEvent] = useState<string | null>(null);
  const wins = useMemo(() => windowsFor(state.date), [windowsFor, state.date]);
  const selectable = useMemo(() => selectableFor(state.date), [selectableFor, state.date]);

  const avail = useMemo(() => {
    const byId = new Map(data?.people.map((p) => [p.id, p]) ?? []);
    return people.map((p) => byId.get(p.id)).filter((p): p is PersonAvailability => !!p);
  }, [data, people]);

  // Only people whose calendars we can read count towards "everyone free".
  const known = useMemo(() => avail.filter(hasData), [avail]);
  const bands = useMemo(
    () => (known.length >= 2 ? atLeast(commonFree(known, wins), state.min * MINUTE) : []),
    [known, wins, state.min],
  );

  if (people.length === 0) return <EmptyPeople />;

  const span = total(wins);
  const columns: GridColumn[] = people.map((person) => {
    const p = avail.find((a) => a.id === person.id);
    const free = p ? total(freeIn(p, wins)) : 0;
    const loading = !p || p.pending;
    const unknown = p ? noDataText(p) : null;
    return {
      key: person.id,
      day: state.date,
      pending: loading,
      noData: !!unknown,
      bands,
      selectable,
      events: (p?.busy ?? [])
        .filter((b) => !b.allDay)
        .map((b, i) => ({
          key: `${b.start}-${b.calendar}-${i}`,
          start: b.start,
          end: b.end,
          color: person.color,
          // The title when this viewer may see it, else the calendar's label.
          title: b.title ?? b.label,
          tentative: b.tentative,
          ref: b.ref,
          tooltip: `${person.name} · ${b.title ? `${b.title} (${b.label})` : b.label}${b.tentative ? " (tentative)" : ""} · ${formatRange(b.start, b.end, tz)}${b.ref ? " — click for details" : ""}`,
        })),
      allDay: (p?.busy ?? [])
        .filter((b) => b.allDay)
        .map((b, i) => ({
          key: `${b.start}-${i}`,
          color: person.color,
          title: `${b.title ?? b.label} · all day`,
          ref: b.ref,
          tooltip: `${person.name} · ${b.title ? `${b.title} (${b.label})` : b.label} · all day`,
        })),
      header: (
        <div className="flex flex-col items-center gap-1 px-2 pt-3 pb-1 text-center">
          <Avatar name={person.name} color={person.color} size={36} />
          <div className="flex max-w-full items-center gap-1">
            <span className="truncate text-sm font-medium text-fg">{person.name}</span>
            {p?.stale && (
              <span title="A calendar for this person couldn't be refreshed — see Status.">
                <TriangleAlert className="size-3.5 shrink-0 text-warn" aria-label="Calendar problem" />
              </span>
            )}
          </div>
          <span
            className="font-body text-[11px] text-fg-3"
            title={`${person.name}'s local time (${person.timezone})`}
          >
            {formatTime(now, person.timezone)} {zoneLabel(person.timezone, zones)}
          </span>
          <span
            title={unknown && !loading ? `${person.name} ${unknown.long}, so their free time isn't known` : undefined}
            className={cn(
              "font-body text-xs",
              loading || span === 0
                ? "text-fg-3"
                : unknown
                  ? "text-warn"
                  : free === 0
                    ? "text-danger"
                    : free >= span / 2
                      ? "text-on-free"
                      : "text-fg-2",
            )}
          >
            {loading
              ? "Loading…"
              : unknown
                ? unknown.short
                : span === 0
                  ? "Off hours"
                  : free === 0
                    ? "No free time"
                    : `${formatHours(free)} free`}
          </span>
        </div>
      ),
    };
  });

  return (
    <>
      <CommonSummary
        label="Everyone free"
        count={known.length}
        leftOut={data ? leftOutNote(avail) : null}
        bands={bands}
        tz={tz}
        min={state.min}
        error={error && !data ? error : null}
        notice={
          data && (state.date < data.coverage.from || state.date > data.coverage.to)
            ? `No calendar data for this date. Calendars are loaded from ${formatDay(data.coverage.from)} to ${formatDay(data.coverage.to)}.`
            : wins.length === 0
              ? state.offHours
                ? "The search hours in the sidebar are empty."
                : "Outside working hours. Turn on “Show off-hours” in the sidebar to look at this day anyway."
              : null
        }
        onCopy={() =>
          copy(
            `${formatDay(state.date)} — everyone free (${known.map((p) => firstName(p.name)).join(", ")}): ` +
              (bands.length ? bands.map(([s, e]) => formatRange(s, e, tz)).join(", ") : "no shared time"),
          )
        }
        onPick={(range) => setSelection({ day: state.date, range, column: null })}
      />
      <TimeGrid
        columns={columns}
        tz={tz}
        zones={zones}
        hours={state.hours}
        now={now}
        minColumnWidth={140}
        selection={selection}
        onSelect={setSelection}
        selectAcross
        bandLabel="first"
        clickLength={state.min * MINUTE}
        scrollKey={`day-${state.date}`}
        onOpenEvent={setOpenEvent}
        card={
          selection && (
            <SelectionCard
              day={selection.day}
              range={selection.range}
              people={avail}
              tz={tz}
              zones={zones}
              onClose={() => setSelection(null)}
              onCopy={copy}
              onInvite={() => onInvite(selection.day, selection.range)}
            />
          )
        }
      />
      {openEvent && (
        <EventDialog
          eventRef={openEvent}
          tz={tz}
          zones={zones}
          people={people}
          viewerEmail={settings.viewer?.email ?? null}
          onClose={() => setOpenEvent(null)}
        />
      )}
    </>
  );
}

/** Strip above the grid listing shared free slots as chips. */
export function CommonSummary({
  label,
  count,
  leftOut = null,
  bands,
  tz,
  min,
  error,
  notice,
  onCopy,
  onPick,
}: {
  label: string;
  /** People whose free time is known (only they count). */
  count: number;
  /** Who isn't counted and why, e.g. "Not counted: Can (needs to sign in again)." */
  leftOut?: string | null;
  bands: Interval[];
  tz: string;
  min: number;
  error: string | null;
  notice: string | null;
  onCopy: () => void;
  onPick: (range: Interval) => void;
}) {
  return (
    <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-grid px-4 py-2 font-body text-sm sm:px-5">
      {error ? (
        <span className="text-danger">{error}</span>
      ) : notice ? (
        <span className="text-fg-2">{notice}</span>
      ) : count < 2 ? (
        <span className="text-fg-3">
          {leftOut ? `${leftOut} Everyone free needs two or more people with calendar data.` : "Tick two or more people in the sidebar to see when everyone's free."}
        </span>
      ) : (
        <>
          <span className="font-sans font-medium text-fg">{label}</span>
          {bands.length === 0 ? (
            <span className="text-fg-3">
              No shared gap of {min < 60 ? `${min} min` : formatHours(min * MINUTE)} or more in the search hours.
            </span>
          ) : (
            bands.map(([s, e]) => (
              <button
                key={s}
                type="button"
                onClick={() => onPick([s, e])}
                className="inline-flex h-7 items-center gap-1.5 rounded-full bg-free px-3 text-[13px] font-medium text-on-free hover:brightness-95 focus-visible:outline-2 focus-visible:outline-accent dark:hover:brightness-125"
              >
                {formatRange(s, e, tz)}
                <span className="font-normal opacity-80">{formatHours(e - s)}</span>
              </button>
            ))
          )}
          {leftOut && <span className="text-xs text-warn">{leftOut}</span>}
          <span className="ml-auto flex items-center gap-3">
            <span className="hidden text-xs text-fg-3 xl:inline">Drag on the grid to check any time</span>
            {bands.length > 0 && (
              <button type="button" onClick={onCopy} className="text-[13px] font-medium text-accent hover:underline">
                Copy
              </button>
            )}
          </span>
        </>
      )}
    </div>
  );
}

export function EmptyPeople() {
  return (
    <div className="m-auto flex max-w-sm flex-col items-center px-6 text-center">
      <Users className="mb-3 size-8 text-fg-3" aria-hidden />
      <p className="text-base font-medium text-fg">No one is ticked</p>
      <p className="mt-1 font-body text-sm text-fg-2">Tick people in the sidebar to see their calendars here.</p>
    </div>
  );
}
