"use client";

import { CalendarSearch, ChevronDown, ChevronLeft, ChevronRight, Search, TriangleAlert } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { Hours } from "@/lib/availability";
import { MINUTE, addDays, formatHours, formatTime, hourLabel, startOfWeek, zoneLabel } from "@/lib/time";
import type { Person, Zone } from "@/lib/types";
import { ColorCheckbox, IconButton, Select, cn } from "./ui";

export function Sidebar({
  people,
  checked,
  onChecked,
  stale,
  date,
  today,
  weekStartsOn,
  onPickDate,
  hours,
  onHours,
  min,
  onMin,
  offHours,
  onOffHours,
  workingHoursText,
  now,
  zones,
  clocks,
  onFind,
  footer,
}: {
  people: Person[];
  checked: string[];
  onChecked: (ids: string[]) => void;
  stale: Set<string>;
  date: string;
  today: string;
  weekStartsOn: 0 | 1;
  onPickDate: (day: string) => void;
  hours: Hours;
  onHours: (h: Hours) => void;
  min: number;
  onMin: (m: number) => void;
  offHours: boolean;
  onOffHours: (on: boolean) => void;
  /** e.g. "10:00–18:00 Türkiye time, Mon–Fri (08:00–16:00 your time)". */
  workingHoursText: string;
  now: number;
  zones: Zone[];
  /** Clocks for the configured zones. */
  clocks: ReactNode;
  onFind: () => void;
  footer: ReactNode;
}) {
  return (
    <div className="scrollbar-thin flex h-full flex-col gap-5 overflow-y-auto px-3 pt-2 pb-4 [&>*]:shrink-0">
      <button
        type="button"
        onClick={onFind}
        className="mx-1 flex h-11 items-center justify-center gap-2 rounded-xl bg-accent text-sm font-semibold text-on-accent transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <CalendarSearch className="size-[18px]" aria-hidden />
        Find a time
      </button>

      {clocks}

      <MiniCalendar date={date} today={today} weekStartsOn={weekStartsOn} onPick={onPickDate} />

      <PeopleList people={people} checked={checked} onChecked={onChecked} stale={stale} now={now} zones={zones} />

      <section className="mx-1 rounded-xl bg-surface-2 px-3 py-3">
        <h2 className="text-sm font-semibold text-fg">Look for free time</h2>
        <button
          type="button"
          role="switch"
          aria-checked={offHours}
          onClick={() => onOffHours(!offHours)}
          title="Shortcut: O"
          className="mt-2.5 flex w-full items-center gap-3 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span className="min-w-0 flex-1 font-body text-[13px] text-fg">Show off-hours</span>
          <span
            aria-hidden
            className={cn(
              "relative h-5 w-9 shrink-0 rounded-full transition-colors",
              offHours ? "bg-accent" : "bg-grid-strong",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 size-4 rounded-full bg-surface shadow transition-[left]",
                offHours ? "left-[18px]" : "left-0.5",
              )}
            />
          </span>
        </button>
        <p className="mt-1 font-body text-xs text-fg-3">
          {offHours ? "Any time can be picked. " : "Only working hours can be picked. "}
          Working hours: {workingHoursText}.
        </p>
        <div className="mt-2.5 font-body text-xs text-fg-2">Between</div>
        <div className="mt-1 flex items-center gap-1.5">
          <Select
            aria-label="From"
            className="h-8 min-w-0 flex-1 bg-surface pl-3 text-[13px]"
            value={hours.start}
            onChange={(e) => {
              const start = Number(e.target.value);
              onHours({ start, end: Math.max(hours.end, start + 1) });
            }}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{hourLabel(h)}</option>
            ))}
          </Select>
          <span className="text-fg-3">–</span>
          <Select
            aria-label="To"
            className="h-8 min-w-0 flex-1 bg-surface pl-3 text-[13px]"
            value={hours.end}
            onChange={(e) => {
              const end = Number(e.target.value);
              onHours({ start: Math.min(hours.start, end - 1), end });
            }}
          >
            {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
              <option key={h} value={h}>{hourLabel(h)}</option>
            ))}
          </Select>
        </div>
        <label className="mt-2.5 block font-body text-xs text-fg-2">
          Gaps of at least
          <Select
            className="mt-1 h-8 w-full bg-surface pl-3 text-[13px]"
            value={min}
            onChange={(e) => onMin(Number(e.target.value))}
          >
            {[15, 30, 60, 90, 120, 180].map((m) => (
              <option key={m} value={m}>{m < 60 ? `${m} min` : formatHours(m * MINUTE)}</option>
            ))}
          </Select>
        </label>
        <p className="mt-2.5 font-body text-xs text-fg-3">The day view shows only these hours. Shorter gaps and times outside them aren&apos;t counted as free.</p>
      </section>

      <div className="mt-auto px-3">{footer}</div>
    </div>
  );
}

function MiniCalendar({
  date,
  today,
  weekStartsOn,
  onPick,
}: {
  date: string;
  today: string;
  weekStartsOn: 0 | 1;
  onPick: (day: string) => void;
}) {
  const [month, setMonth] = useState(date.slice(0, 7));
  const [lastDate, setLastDate] = useState(date);
  // Follow the main view when it moves to another month.
  if (date !== lastDate) {
    setLastDate(date);
    if (date.slice(0, 7) !== month) setMonth(date.slice(0, 7));
  }

  const first = `${month}-01`;
  const gridStart = startOfWeek(first, weekStartsOn);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const [y, m] = month.split("-").map(Number);
  const title = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    Date.UTC(y, m - 1, 1),
  );
  const weekdayLetters = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat("en-GB", { weekday: "narrow", timeZone: "UTC" }).format(
      Date.UTC(2026, 0, 4 + weekStartsOn + i),
    ),
  );
  const shift = (n: number) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth(d.toISOString().slice(0, 7));
  };

  return (
    <section className="px-2 font-body" aria-label="Mini calendar">
      <div className="flex items-center justify-between pl-2">
        <span className="font-sans text-sm font-medium text-fg">{title}</span>
        <div className="flex">
          <IconButton size="sm" aria-label="Previous month" onClick={() => shift(-1)}>
            <ChevronLeft className="size-4" />
          </IconButton>
          <IconButton size="sm" aria-label="Next month" onClick={() => shift(1)}>
            <ChevronRight className="size-4" />
          </IconButton>
        </div>
      </div>
      <div className="mt-1 grid grid-cols-7 text-center">
        {weekdayLetters.map((l, i) => (
          <span key={i} className="py-1 text-[11px] font-medium text-fg-3">{l}</span>
        ))}
        {cells.map((d) => {
          const inMonth = d.slice(0, 7) === month;
          const isToday = d === today;
          const isSelected = d === date;
          return (
            <button
              key={d}
              type="button"
              onClick={() => onPick(d)}
              aria-label={d}
              aria-current={isSelected ? "date" : undefined}
              className={cn(
                "mx-auto grid size-7 place-items-center rounded-full text-[11px] transition-colors",
                "focus-visible:outline-2 focus-visible:outline-accent",
                isToday
                  ? "bg-accent font-medium text-on-accent"
                  : isSelected
                    ? "bg-accent-container font-medium text-on-accent-container"
                    : inMonth
                      ? "text-fg hover:bg-hover"
                      : "text-fg-3 hover:bg-hover",
              )}
            >
              {Number(d.slice(8))}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function PeopleList({
  people,
  checked,
  onChecked,
  stale,
  now,
  zones,
}: {
  people: Person[];
  checked: string[];
  onChecked: (ids: string[]) => void;
  stale: Set<string>;
  now: number;
  zones: Zone[];
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const set = new Set(checked);

  const groups = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("tr");
    const match = people.filter((p) => !q || p.name.toLocaleLowerCase("tr").includes(q));
    const map = new Map<string, Person[]>();
    for (const p of match) {
      const key = p.team ?? "People";
      map.set(key, [...(map.get(key) ?? []), p]);
    }
    return [...map.entries()];
  }, [people, query]);

  const toggle = (id: string, on: boolean) =>
    onChecked(on ? [...checked, id] : checked.filter((x) => x !== id));

  return (
    <section className="flex flex-col gap-1">
      <div className="relative mx-1 mb-1">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search for people"
          className="h-10 w-full rounded-lg bg-surface-2 pr-3 pl-10 font-body text-sm text-fg placeholder:text-fg-3 focus:outline-2 focus:outline-accent"
        />
      </div>

      {groups.map(([team, members]) => {
        const isCollapsed = collapsed.has(team);
        const allOn = members.every((p) => set.has(p.id));
        return (
          <div key={team}>
            <div className="flex items-center">
              <button
                type="button"
                className="flex h-9 flex-1 items-center justify-between rounded-full pr-2 pl-3 text-sm font-medium text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
                aria-expanded={!isCollapsed}
                onClick={() => {
                  const next = new Set(collapsed);
                  if (isCollapsed) next.delete(team);
                  else next.add(team);
                  setCollapsed(next);
                }}
              >
                {team}
                <ChevronDown className={cn("size-4 text-fg-3 transition-transform", isCollapsed && "-rotate-90")} aria-hidden />
              </button>
              <button
                type="button"
                className="h-9 rounded-full px-2.5 font-body text-xs text-fg-3 hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
                onClick={() => {
                  const ids = members.map((p) => p.id);
                  onChecked(allOn ? checked.filter((id) => !ids.includes(id)) : [...new Set([...checked, ...ids])]);
                }}
              >
                {allOn ? "None" : "All"}
              </button>
            </div>
            {!isCollapsed &&
              members.map((p) => (
                <ColorCheckbox
                  key={p.id}
                  checked={set.has(p.id)}
                  color={p.color}
                  label={p.name}
                  onChange={(on) => toggle(p.id, on)}
                >
                  <span className="min-w-0 flex-1 truncate font-body">{p.name}</span>
                  {stale.has(p.id) && (
                    <span title="A calendar for this person couldn't be refreshed — see Status.">
                      <TriangleAlert className="size-3.5 text-warn" aria-label="Calendar problem" />
                    </span>
                  )}
                  <span
                    className="shrink-0 font-body text-[11px] whitespace-nowrap text-fg-3 tabular-nums"
                    title={`${p.name}'s local time (${p.timezone})`}
                  >
                    {formatTime(now, p.timezone)} {zoneLabel(p.timezone, zones)}
                  </span>
                </ColorCheckbox>
              ))}
          </div>
        );
      })}
      {groups.length === 0 && (
        <p className="px-3 py-2 font-body text-sm text-fg-3">No one matches “{query}”.</p>
      )}
    </section>
  );
}
