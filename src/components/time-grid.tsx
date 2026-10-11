"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { assignLanes, type Hours } from "@/lib/availability";
import { colorStyle } from "@/lib/colors";
import { subtract, type Interval } from "@/lib/intervals";
import { HOUR, MINUTE, dayKeyOf, dayStart, formatRange, formatTime, zonedTime } from "@/lib/time";
import type { Zone } from "@/lib/types";
import { cn } from "./ui";

/** Hours stretch to fill the height; below this they scroll instead. */
const MIN_HOUR_PX = 40;
/** One column of hour labels per zone; phones only show the viewer's. */
const ZONE_PX = 44;
const SNAP = 15 * MINUTE;

export type GridEvent = {
  key: string;
  start: number;
  end: number;
  color: string;
  title: string;
  tentative?: boolean;
  tooltip: string;
  /** Set when the viewer may open the event's details. */
  ref?: string;
};

export type GridAllDay = { key: string; color: string; title: string; tooltip: string; ref?: string };

export type GridColumn = {
  key: string;
  day: string;
  header: ReactNode;
  events: GridEvent[];
  allDay: GridAllDay[];
  /** Common free slots, drawn as green bands. */
  bands: Interval[];
  /** Parts of the day that can be selected; the rest is hatched. null = all. */
  selectable?: Interval[] | null;
  pending?: boolean;
  /** We don't know when this person is free; the column is hatched, never white. */
  noData?: boolean;
};

export type GridSelection = {
  day: string;
  range: Interval;
  /** null = the selection spans every column (people side by side). */
  column: string | null;
};

export function TimeGrid({
  columns,
  tz,
  zones,
  hours,
  now,
  minColumnWidth,
  selection,
  onSelect,
  selectAcross,
  bandLabel,
  card,
  clickLength,
  scrollKey,
  onOpenEvent,
}: {
  columns: GridColumn[];
  tz: string;
  /** Zones whose hours are listed in the gutter; `tz` among them. */
  zones: Zone[];
  hours: Hours;
  now: number;
  minColumnWidth: number;
  selection: GridSelection | null;
  onSelect: (s: GridSelection | null) => void;
  selectAcross: boolean;
  bandLabel: "first" | "all";
  card: ReactNode;
  clickLength: number;
  scrollKey: string;
  /** Open an event's details; events with a ref become clickable. */
  onOpenEvent?: (ref: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const span = hours.end - hours.start;
  const [hourPx, setHourPx] = useState(48);

  // Spread the display hours over the whole visible height.
  useLayoutEffect(() => {
    const sc = scroller.current;
    const head = header.current;
    if (!sc || !head) return;
    const fit = () => setHourPx(Math.max(MIN_HOUR_PX, Math.floor((sc.clientHeight - head.offsetHeight) / span)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(sc);
    ro.observe(head);
    return () => ro.disconnect();
  }, [span]);
  const today = dayKeyOf(now, tz);
  const template = `var(--gutter) repeat(${columns.length}, minmax(${minColumnWidth}px, 1fr))`;
  // The viewer's zone sits next to the grid; the others to its left.
  const gutterZones = [...zones.filter((z) => z.zone !== tz), ...zones.filter((z) => z.zone === tz)];
  const labelDay = columns[0]?.day;
  const hasAllDay = columns.some((c) => c.allDay.length > 0);

  // The grid only covers the display hours; open at their start.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [scrollKey]);

  const drag = useRef<{
    column: string;
    day: string;
    anchor: number;
    /** The selectable stretch the drag started in; it can't leave it. Null: nothing selectable here. */
    limit: Interval | null;
    /**
     * What was pressed. Read on pointer down: once the column captures the
     * pointer, later events report the column as their target, not this.
     */
    pressed: { ref?: string; band?: Interval } | null;
    y: number;
    moved: boolean;
  } | null>(null);

  const timeAt = (el: HTMLElement, clientY: number, day: string) => {
    const rect = el.getBoundingClientRect();
    const base = dayStart(day, tz);
    const raw = hours.start * HOUR + ((clientY - rect.top) / hourPx) * HOUR;
    const snapped = Math.round(raw / SNAP) * SNAP;
    return base + Math.min(Math.max(snapped, hours.start * HOUR), hours.end * HOUR);
  };

  const handlers = (col: GridColumn) => ({
    onPointerDown(e: PointerEvent<HTMLDivElement>) {
      if (e.button !== 0) return;
      const anchor = timeAt(e.currentTarget, e.clientY, col.day);
      const base = dayStart(col.day, tz);
      const shown: Interval = [base + hours.start * HOUR, base + hours.end * HOUR];
      const found = col.selectable
        ? col.selectable.find(([s, end]) => anchor >= s && anchor <= end)
        : shown;
      const limit = found ? ([Math.max(found[0], shown[0]), Math.min(found[1], shown[1])] as Interval) : null;
      const target = e.target as HTMLElement;
      const event = target.closest<HTMLElement>("[data-event]");
      const band = target.closest<HTMLElement>("[data-band-start]");
      const pressed = event
        ? { ref: event.dataset.ref }
        : band
          ? { band: [Number(band.dataset.bandStart), Number(band.dataset.bandEnd)] as Interval }
          : null;
      // Outside working hours nothing can be picked, but an event there can still be opened.
      if (!limit && !pressed?.ref) return;
      drag.current = {
        column: col.key,
        day: col.day,
        anchor,
        limit,
        pressed,
        y: e.clientY,
        moved: false,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove(e: PointerEvent<HTMLDivElement>) {
      const d = drag.current;
      if (!d) return;
      if (!d.moved && Math.abs(e.clientY - d.y) < 4) return;
      d.moved = true;
      if (!d.limit) return;
      const t = Math.min(Math.max(timeAt(e.currentTarget, e.clientY, d.day), d.limit[0]), d.limit[1]);
      const range: Interval =
        t === d.anchor ? [d.anchor, d.anchor + SNAP] : [Math.min(t, d.anchor), Math.max(t, d.anchor)];
      onSelect({ day: d.day, range, column: selectAcross ? null : d.column });
    },
    onPointerUp() {
      const d = drag.current;
      drag.current = null;
      if (!d || d.moved) return;
      if (d.pressed?.band) {
        onSelect({ day: d.day, range: d.pressed.band, column: selectAcross ? null : d.column });
        return;
      }
      if (d.pressed) {
        // An event: open it if the viewer may; otherwise a click on it does nothing.
        if (d.pressed.ref && onOpenEvent) onOpenEvent(d.pressed.ref);
        return;
      }
      if (!d.limit) return;
      // A plain click picks a slot starting at the half hour you clicked.
      const base = dayStart(d.day, tz);
      const start = Math.max(base + Math.floor((d.anchor - base) / (30 * MINUTE)) * 30 * MINUTE, d.limit[0]);
      const end = Math.min(start + clickLength, d.limit[1]);
      if (end - start < SNAP) return;
      onSelect({
        day: d.day,
        range: [start, end],
        column: selectAcross ? null : d.column,
      });
    },
    onPointerCancel() {
      drag.current = null;
    },
  });

  const selIndex = selection
    ? selection.column === null
      ? -1
      : columns.findIndex((c) => c.key === selection.column)
    : -2;
  const selVisible =
    selection && columns.some((c) => c.day === selection.day) && (selection.column === null || selIndex >= 0);
  const selTop = selection && selVisible
    ? Math.max(0, (selection.range[0] - dayStart(selection.day, tz)) / HOUR - hours.start) * hourPx
    : 0;

  // Keep the popover inside the visible part of the grid, like a calendar
  // event preview, instead of letting it hang off the bottom.
  useLayoutEffect(() => {
    const el = cardRef.current;
    const sc = scroller.current;
    if (!el || !sc || window.matchMedia("(max-width: 639px)").matches) return;
    const headerH = header.current?.offsetHeight ?? 0;
    const lo = sc.scrollTop + 8;
    const hi = sc.scrollTop + sc.clientHeight - headerH - el.offsetHeight - 8;
    el.style.top = `${Math.max(lo, Math.min(selTop, hi))}px`;
  });

  return (
    <div
      ref={scroller}
      className="time-grid scrollbar-thin relative min-h-0 flex-1 overflow-auto overscroll-contain"
      style={{
        ["--hour" as string]: `${hourPx}px`,
        ["--gutter-one" as string]: `${ZONE_PX + 8}px`,
        ["--gutter-all" as string]: `${gutterZones.length * ZONE_PX + 8}px`,
      }}
    >
      <div className="relative" style={{ minWidth: `calc(var(--gutter) + ${columns.length * minColumnWidth}px)` }}>
        {/* Sticky header: column titles and all-day row */}
        <div ref={header} className="sticky top-0 z-30 bg-surface">
          <div className="grid" style={{ gridTemplateColumns: template }}>
            <div className="sticky left-0 z-10 flex items-end bg-surface pb-1 pl-1">
              {gutterZones.map((z) => (
                <span
                  key={z.zone}
                  title={z.zone === tz ? `Times are in ${z.label} time` : `${z.label} time`}
                  className={cn(
                    "truncate pr-2 text-right font-body text-[10px] leading-tight",
                    z.zone === tz ? "font-semibold text-accent" : "text-fg-3 max-sm:hidden",
                  )}
                  style={{ width: ZONE_PX }}
                >
                  {z.label}
                </span>
              ))}
            </div>
            {columns.map((c) => (
              <div key={c.key} className="min-w-0">{c.header}</div>
            ))}
          </div>
          {hasAllDay && (
            <div className="grid" style={{ gridTemplateColumns: template }}>
              <div className="sticky left-0 z-10 bg-surface" />
              {columns.map((c) => (
                <div key={c.key} className="flex min-w-0 flex-col gap-0.5 border-l border-grid px-1 pb-1">
                  {c.allDay.map((a) => (
                    <div
                      key={a.key}
                      title={a.tooltip}
                      role={a.ref && onOpenEvent ? "button" : undefined}
                      tabIndex={a.ref && onOpenEvent ? 0 : undefined}
                      onClick={a.ref && onOpenEvent ? () => onOpenEvent(a.ref!) : undefined}
                      onKeyDown={(e) => {
                        if (a.ref && onOpenEvent && (e.key === "Enter" || e.key === " ")) onOpenEvent(a.ref);
                      }}
                      className={cn(
                        "event truncate rounded px-2 py-px font-body text-xs font-medium",
                        a.ref && onOpenEvent && "cursor-pointer hover:brightness-95",
                      )}
                      style={colorStyle(a.color)}
                    >
                      {a.title}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          <div className="grid border-b border-grid" style={{ gridTemplateColumns: template }}>
            <div className="sticky left-0 z-10 h-2 bg-surface" />
            {columns.map((c) => (
              <div key={c.key} className="h-2 border-l border-grid" />
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="relative grid" style={{ gridTemplateColumns: template, height: span * hourPx }}>
          <div className="sticky left-0 z-20 bg-surface">
            {labelDay &&
              Array.from({ length: hours.end - hours.start - 1 }, (_, i) => hours.start + i + 1).map((h) => {
                const at = zonedTime(labelDay, h, tz);
                return gutterZones.map((z, zi) => (
                  <span
                    key={`${h}-${z.zone}`}
                    className={cn(
                      "absolute pr-2 text-right font-body text-[10px] tabular-nums select-none",
                      z.zone === tz ? "font-medium text-fg-2" : "text-fg-3/80 max-sm:hidden",
                    )}
                    style={{
                      top: (h - hours.start) * hourPx - 7,
                      width: ZONE_PX,
                      // On phones only the viewer's column shows, at the left edge.
                      left: z.zone === tz ? `calc(var(--gutter) - ${ZONE_PX + 4}px)` : 4 + zi * ZONE_PX,
                    }}
                  >
                    {formatTime(at, z.zone)}
                  </span>
                ));
              })}
          </div>

          {columns.map((c, ci) => (
            <Column
              key={c.key}
              column={c}
              tz={tz}
              hourPx={hourPx}
              hours={hours}
              now={now}
              isToday={c.day === today}
              showDot={ci === columns.findIndex((x) => x.day === today)}
              showBandLabel={bandLabel === "all" || ci === 0}
              selection={
                selection &&
                selection.day === c.day &&
                (selection.column === null || selection.column === c.key)
                  ? {
                      range: selection.range,
                      edgeLeft: selection.column !== null || ci === 0 || columns[ci - 1].day !== c.day,
                      edgeRight:
                        selection.column !== null || ci === columns.length - 1 || columns[ci + 1].day !== c.day,
                    }
                  : null
              }
              {...handlers(c)}
            />
          ))}

          {selVisible && card && (
            <div
              ref={cardRef}
              className={cn(
                "z-40 w-[320px] max-w-[calc(100vw-24px)]",
                "max-sm:fixed max-sm:inset-x-3 max-sm:bottom-3 max-sm:w-auto",
                "sm:absolute",
              )}
              style={
                {
                  ...(selIndex === -1
                    ? { right: 16 }
                    : selIndex < columns.length / 2
                      ? { left: `calc(var(--gutter) + (100% - var(--gutter)) * ${(selIndex + 1) / columns.length} + 8px)` }
                      : { right: `calc((100% - var(--gutter)) * ${(columns.length - selIndex) / columns.length} + 8px)` }),
                } as CSSProperties
              }
            >
              {card}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Column({
  column,
  tz,
  hourPx,
  hours,
  now,
  isToday,
  showDot,
  showBandLabel,
  selection,
  ...handlers
}: {
  column: GridColumn;
  tz: string;
  hourPx: number;
  hours: Hours;
  now: number;
  isToday: boolean;
  showDot: boolean;
  showBandLabel: boolean;
  selection: { range: Interval; edgeLeft: boolean; edgeRight: boolean } | null;
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: () => void;
}) {
  // The column covers the display hours only; times outside them are cut off.
  const midnight = dayStart(column.day, tz);
  const base = midnight + hours.start * HOUR;
  const end = midnight + hours.end * HOUR;
  const y = (t: number) => (Math.min(Math.max(t - base, 0), end - base) / HOUR) * hourPx;
  // Off-hours: the shown hours outside working hours.
  const blocked = column.selectable ? subtract([base, end], column.selectable) : [];

  const laid = useMemo(() => {
    const events = column.events
      .map((e) => ({ ...e, top: y(e.start), bottom: y(e.end) }))
      .filter((e) => e.bottom > e.top)
      .sort((a, b) => a.top - b.top || b.bottom - a.bottom);
    const { lanes, count } = assignLanes(events.map((e) => ({ start: e.top, end: e.bottom })));
    return events.map((e, i) => ({ ...e, lane: lanes[i], lanes: count }));
    // y depends only on base, end and hourPx, which derive from column.day, tz, hours and the height
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [column.events, column.day, tz, hours.start, hours.end, hourPx]);

  return (
    <div
      {...handlers}
      className="grid-hours relative cursor-default touch-pan-y border-l border-grid select-none"
    >

      {blocked.map(([s, e]) => (
        <div
          key={`blocked-${s}`}
          title="Outside working hours — turn on “Show off-hours” to pick these times"
          className="offwork absolute inset-x-0 cursor-not-allowed"
          style={{ top: y(s), height: y(e) - y(s) }}
        />
      ))}

      {column.bands.map(([s, e]) => {
        const top = y(s);
        const height = y(e) - top;
        return (
          <div
            key={`band-${s}`}
            data-band-start={s}
            data-band-end={e}
            title={`Everyone free ${formatRange(s, e, tz)} — click to select`}
            className="absolute inset-x-0 cursor-pointer border-y border-free-border/60 bg-free hover:brightness-[0.97]"
            style={{ top, height }}
          >
            {showBandLabel && height >= 22 && (
              <div className="truncate px-2 pt-0.5 font-body text-[11px] font-medium text-on-free">
                {height >= 36 ? "Everyone free" : formatRange(s, e, tz)}
                {height >= 36 && <div className="font-normal opacity-90">{formatRange(s, e, tz)}</div>}
              </div>
            )}
          </div>
        );
      })}

      {column.noData && !column.pending && <div aria-hidden className="nodata pointer-events-none absolute inset-0" />}
      {column.pending && <div className="shimmer pointer-events-none absolute inset-1 rounded-md bg-surface-2" />}

      {laid.map((e) => {
        const height = Math.max(e.bottom - e.top - 2, 16);
        const tall = height >= 36;
        return (
          <div
            key={e.key}
            data-event
            data-ref={e.ref}
            title={e.tooltip}
            className={cn(
              e.ref && "cursor-pointer hover:brightness-95",
              e.tentative ? "event-tentative" : "event",
              // The block is its own size container: text only shows when the
              // lane is wide enough, otherwise colour and tooltip carry it.
              "@container absolute overflow-hidden rounded-[5px] font-body leading-tight ring-1 ring-surface",
              tall ? "py-1" : "flex items-center",
            )}
            style={{
              ...colorStyle(e.color),
              top: e.top + 1,
              height,
              left: `calc((100% - 8px) * ${e.lane / e.lanes})`,
              width: `calc((100% - 8px) / ${e.lanes} - 1px)`,
            }}
          >
            {tall ? (
              <div className="px-1.5 @max-[52px]:hidden">
                <div className="truncate text-xs font-medium">{e.title}</div>
                <div className="truncate text-[11px] opacity-90">{formatRange(e.start, e.end, tz)}</div>
              </div>
            ) : (
              <div className="truncate px-1.5 text-[11px] @max-[52px]:hidden">
                <span className="font-medium">{e.title}</span>, {formatRange(e.start, e.end, tz).split("–")[0]}
              </div>
            )}
          </div>
        );
      })}

      {selection && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute z-10 border-y-2 border-accent bg-accent/15",
            selection.edgeLeft ? "left-0 rounded-l-md border-l-2" : "-left-px",
            selection.edgeRight ? "right-0 rounded-r-md border-r-2" : "right-0",
          )}
          style={{ top: y(selection.range[0]), height: Math.max(y(selection.range[1]) - y(selection.range[0]), 4) }}
        />
      )}

      {isToday && now >= base && now < end && (
        <div className="pointer-events-none absolute inset-x-0 z-20" style={{ top: y(now) }}>
          <div className="h-0.5 bg-now" />
          {showDot && <div className="absolute -top-[5px] -left-1.5 size-3 rounded-full bg-now" />}
        </div>
      )}
    </div>
  );
}
