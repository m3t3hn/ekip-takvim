"use client";

import { CircleCheck, CircleHelp, CircleMinus, Copy, Send, X } from "lucide-react";
import { blocksDuring, isFree, hasData, noDataText } from "@/lib/availability";
import type { Interval } from "@/lib/intervals";
import { formatDay, formatHours, formatRange } from "@/lib/time";
import type { PersonAvailability, Zone } from "@/lib/types";
import { localRange } from "./timezone";
import { Avatar, Button, IconButton, cn, firstName } from "./ui";

/** The popover shown next to a selected time range, like an event preview. */
export function SelectionCard({
  day,
  range,
  people,
  tz,
  zones,
  onClose,
  onCopy,
  onInvite,
}: {
  day: string;
  range: Interval;
  people: PersonAvailability[];
  tz: string;
  zones: Zone[];
  onClose: () => void;
  onCopy: (text: string) => void;
  onInvite: () => void;
}) {
  // Without calendar data we can't say someone is free (or busy).
  const known = people.filter(hasData);
  const unknown = people.filter((p) => !hasData(p));
  const free = known.filter((p) => isFree(p, range));
  const busy = known.filter((p) => !isFree(p, range));
  const time = formatRange(range[0], range[1], tz);
  const text =
    `${formatDay(day)} ${time} — free: ${free.map((p) => firstName(p.name)).join(", ") || "nobody"}` +
    (busy.length ? `; busy: ${busy.map((p) => firstName(p.name)).join(", ")}` : "") +
    (unknown.length ? `; unknown: ${unknown.map((p) => firstName(p.name)).join(", ")}` : "");

  return (
    <div
      role="dialog"
      aria-label={`Who's free ${time}`}
      className="rounded-2xl bg-surface px-5 pt-2 pb-4 shadow-[var(--shadow-card)]"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      <div className="-mr-3 flex justify-end">
        <IconButton size="sm" aria-label="Copy as text" title="Copy as text" onClick={() => onCopy(text)}>
          <Copy className="size-4" />
        </IconButton>
        <IconButton size="sm" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <X className="size-[18px]" />
        </IconButton>
      </div>
      <div className="flex gap-3">
        <span
          aria-hidden
          className={cn(
            "mt-1.5 size-3.5 shrink-0 rounded",
            free.length === known.length && known.length > 0 ? "bg-free-strong" : "bg-accent",
          )}
        />
        <div className="min-w-0">
          <div className="text-[19px] leading-snug text-fg">
            {free.length === known.length && known.length > 0
              ? unknown.length
                ? "Everyone else is free"
                : "Everyone's free"
              : free.length === 0
                ? "Nobody's free"
                : `${free.length} of ${known.length} free`}
          </div>
          <div className="mt-0.5 font-body text-sm text-fg-2">
            {formatDay(day, "long")} · {time}
            <span className="text-fg-3"> ({formatHours(range[1] - range[0])})</span>
          </div>
        </div>
      </div>

      <ul className="mt-4 flex flex-col gap-2.5 font-body text-sm">
        {free.map((p) => (
          <li key={p.id} className="flex items-center gap-3">
            <Avatar name={p.name} color={p.color} size={24} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-fg">{p.name}</span>
              <LocalTime range={range} person={p} tz={tz} zones={zones} />
            </span>
            <CircleCheck className="size-4 shrink-0 text-free-strong" aria-label="Free" />
          </li>
        ))}
        {busy.map((p) => {
          const labels = [...new Set(blocksDuring(p, range).map((b) => b.title ?? b.label))];
          return (
            <li key={p.id} className="flex items-center gap-3">
              <Avatar name={p.name} color={p.color} size={24} className="opacity-60" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  <span className="text-fg-2">{p.name}</span>
                  <span className="text-fg-3"> · {labels.join(", ")}</span>
                </span>
                <LocalTime range={range} person={p} tz={tz} zones={zones} />
              </span>
              <CircleMinus className="size-4 shrink-0 text-fg-3" aria-label="Busy" />
            </li>
          );
        })}
        {unknown.map((p) => (
          <li key={p.id} className="flex items-center gap-3">
            <Avatar name={p.name} color={p.color} size={24} className="opacity-60" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">
                <span className="text-fg-2">{p.name}</span>
                <span className="text-warn" title={`${p.name} ${noDataText(p)!.long}`}>
                  {" "}
                  · {noDataText(p)!.short}
                </span>
              </span>
            </span>
            <CircleHelp className="size-4 shrink-0 text-warn" aria-label="Unknown" />
          </li>
        ))}
      </ul>

      <Button variant="primary" className="mt-4 w-full" onClick={onInvite}>
        <Send className="size-4" aria-hidden /> Invite to a meeting
      </Button>
    </div>
  );
}

/** The selected range on the person's own clock, when it differs from ours. */
function LocalTime({ range, person, tz, zones }: { range: Interval; person: PersonAvailability; tz: string; zones: Zone[] }) {
  const text = localRange(range, person.timezone, tz, zones);
  if (!text) return null;
  return (
    <span className="block text-xs text-fg-3 tabular-nums" title={`${person.name}'s local time (${person.timezone})`}>
      {text} for them
    </span>
  );
}
