"use client";

import { CircleAlert, CircleCheck, Copy, Download, ExternalLink, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { blocksDuring, hasData, isFree, noDataText } from "@/lib/availability";
import type { Interval } from "@/lib/intervals";
import { buildIcs, googleCalendarUrl, outlookUrl, type InviteDraft } from "@/lib/invite";
import { MINUTE, dayKeyOf, formatDay, formatHours, formatRange, formatTime, offsetLabel, zoneLabel } from "@/lib/time";
import type { Person, PersonAvailability, Zone } from "@/lib/types";
import { useAvailability } from "./hooks";
import { Avatar, Button, ColorCheckbox, IconButton, Input, Select, cn, firstName, useCopy } from "./ui";

const STEP = 15 * MINUTE;
const LENGTHS = [15, 30, 45, 60, 90, 120, 150, 180, 240, 300, 360];

/** Prepare an invite for a free slot and hand it to the organiser's calendar. */
export function InviteDialog({
  day,
  range,
  defaultMinutes,
  people,
  tz,
  zones,
  organiser,
  now,
  onClose,
}: {
  day: string;
  range: Interval;
  defaultMinutes: number;
  people: Person[];
  /** The viewer's zone, which the start and length pickers use. */
  tz: string;
  zones: Zone[];
  /** The signed-in person's address: Google opens in that account, and they aren't added as a guest. */
  organiser: string | null;
  now: number;
  onClose: () => void;
}) {
  const { data } = useAvailability(day, 1, tz);
  const copy = useCopy();
  const closeRef = useRef<HTMLButtonElement>(null);

  const avail = useMemo(() => {
    const byId = new Map(data?.people.map((p) => [p.id, p]) ?? []);
    return people.map((p) => byId.get(p.id)).filter((p): p is PersonAvailability => !!p);
  }, [data, people]);

  // Don't offer times that have already gone.
  const first = Math.max(range[0], Math.ceil(now / STEP) * STEP);
  const earliest = first < range[1] - STEP ? first : range[0];
  const [start, setStart] = useState(earliest);
  const [minutes, setMinutes] = useState(() =>
    Math.max(15, Math.min(defaultMinutes, Math.round((range[1] - earliest) / MINUTE))),
  );
  const end = start + minutes * MINUTE;

  const [title, setTitle] = useState("Team meeting");
  const [note, setNote] = useState("");
  const [location, setLocation] = useState("");
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // Until someone changes it, invite whoever we know is free then.
  const included = picked ?? new Set(avail.filter((p) => hasData(p) && isFree(p, [start, end])).map((p) => p.id));


  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const starts: number[] = [];
  for (let t = range[0]; t <= range[1] - STEP; t += STEP) starts.push(t);
  const room = Math.round((range[1] - start) / MINUTE);
  const lengths = [...new Set([...LENGTHS.filter((m) => m <= room), room])].sort((a, b) => a - b);

  const guests = avail.filter((p) => included.has(p.id) && p.email !== organiser);
  const draft = (): InviteDraft | null => {
    if (!title.trim()) {
      setProblem("Give the meeting a title.");
      return null;
    }
    if (guests.length === 0) {
      setProblem("Tick at least one person to invite.");
      return null;
    }
    setProblem(null);
    return {
      title: title.trim(),
      start,
      end,
      note: note.trim(),
      location: location.trim(),
      attendees: guests.map((p) => ({ name: p.name, email: p.email })),
    };
  };

  const emailList = () => guests.map((p) => p.email).join(", ");

  const openTab = (url: string) => window.open(url, "_blank", "noopener,noreferrer");

  const download = (d: InviteDraft) => {
    const blob = new Blob([buildIcs(d, crypto.randomUUID())], { type: "text/calendar;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `${d.title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "invite"}.ics`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  };

  const busyNow = guests
    .map((p) => ({ p, blocks: blocksDuring(p, [start, end]) }))
    .filter((x) => x.blocks.length > 0);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-3 sm:p-6" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-title"
        className="pop relative flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-surface shadow-[var(--shadow-card)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-grid px-5 pt-4 pb-3">
          <div className="min-w-0 flex-1">
            <h2 id="invite-title" className="text-lg font-semibold tracking-tight text-fg">
              Invite to a meeting
            </h2>
            <p className="font-body text-sm text-fg-2">
              {formatDay(day, "long")} · free {formatTime(range[0], tz)}–{formatTime(range[1], tz)}{" "}
              <span className="text-fg-3">
                ({zoneLabel(tz, zones)} time, {offsetLabel(tz, range[0])})
              </span>
            </p>
          </div>
          <IconButton ref={closeRef} size="sm" aria-label="Close" onClick={onClose} className="-mr-2">
            <X className="size-[18px]" />
          </IconButton>
        </div>

        <div className="scrollbar-thin flex flex-col gap-5 overflow-y-auto px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-fg">Title</span>
            <Input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-fg">
                Starts <span className="font-normal text-fg-3">({zoneLabel(tz, zones)} time)</span>
              </span>
              <Select
                className="w-full"
                value={start}
                onChange={(e) => {
                  const s = Number(e.target.value);
                  setStart(s);
                  setMinutes((m) => Math.min(m, Math.round((range[1] - s) / MINUTE)));
                }}
              >
                {starts.map((t) => (
                  <option key={t} value={t} disabled={t + STEP < now}>
                    {formatTime(t, tz)}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-fg">Length</span>
              <Select className="w-full" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                {lengths.map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? `${m} min` : formatHours(m * MINUTE)} · until {formatTime(start + m * MINUTE, tz)}
                  </option>
                ))}
              </Select>
            </label>
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-sm font-semibold text-fg">Who</span>
              <span className="font-body text-xs text-fg-3">Invites go to each person&apos;s company address</span>
            </div>
            {!data ? (
              <div className="shimmer h-24 rounded-xl bg-surface-2" />
            ) : (
              <ul className="divide-y divide-grid rounded-xl border border-grid">
                {avail.map((p) => {
                  const on = included.has(p.id);
                  const unknown = noDataText(p);
                  const free = !unknown && isFree(p, [start, end]);
                  const busyAt = [...new Set(blocksDuring(p, [start, end]).map((b) => b.title ?? b.label))];
                  return (
                    <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
                      <ColorCheckbox
                        checked={on}
                        color={p.color}
                        label={`Invite ${p.name}`}
                        onChange={(v) => {
                          const next = new Set(included);
                          if (v) next.add(p.id);
                          else next.delete(p.id);
                          setPicked(next);
                        }}
                      >
                        <Avatar name={p.name} color={p.color} size={22} />
                        <span className="min-w-0 truncate font-body text-sm text-fg">{p.name}</span>
                      </ColorCheckbox>
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-px font-body text-xs text-fg-2 tabular-nums"
                        title={`Meeting time on ${p.name}'s clock (${p.timezone}, ${offsetLabel(p.timezone, start)})`}
                      >
                        {formatRange(start, end, p.timezone)}
                        <span className="text-fg-3">{zoneLabel(p.timezone, zones)}</span>
                        {formatDay(dayKeyOf(start, p.timezone)) !== formatDay(dayKeyOf(start, tz)) && (
                          <span className="text-warn">{formatDay(dayKeyOf(start, p.timezone))}</span>
                        )}
                      </span>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 font-body text-xs",
                          free ? "text-on-free" : "text-warn",
                        )}
                      >
                        {free ? <CircleCheck className="size-3.5" aria-hidden /> : <CircleAlert className="size-3.5" aria-hidden />}
                        {free ? "free" : unknown ? unknown.short.toLowerCase() : `busy · ${busyAt.join(", ")}`}
                      </span>
                      <span className="ml-auto truncate font-body text-xs text-fg-3">
                        {p.email === organiser ? "you (organiser)" : p.email}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {busyNow.length > 0 && (
              <p className="mt-2 font-body text-xs text-warn">
                {busyNow.map((x) => firstName(x.p.name)).join(", ")} {busyNow.length === 1 ? "is" : "are"} busy then.
              </p>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-fg">
                Where <span className="font-normal text-fg-3">(optional)</span>
              </span>
              <Input placeholder="Meeting link or place" value={location} onChange={(e) => setLocation(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-fg">
                Note <span className="font-normal text-fg-3">(optional)</span>
              </span>
              <Input placeholder="What it's about" value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
          </div>

          {problem && (
            <p role="alert" className="flex gap-2 rounded-xl bg-danger-container px-3 py-2 font-body text-sm text-danger">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              {problem}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-grid bg-surface-2/60 px-5 py-4">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              onClick={() => {
                const d = draft();
                if (d) openTab(googleCalendarUrl(d, organiser ?? undefined));
              }}
            >
              <ExternalLink className="size-4" aria-hidden /> Google Calendar
            </Button>
            <Button
              onClick={() => {
                const d = draft();
                if (!d) return;
                void copy(emailList(), "Emails copied — paste them into the invite's attendees");
                openTab(outlookUrl(d, "work"));
              }}
            >
              <ExternalLink className="size-4" aria-hidden /> Outlook
            </Button>
            <Button
              onClick={() => {
                const d = draft();
                if (d) download(d);
              }}
            >
              <Download className="size-4" aria-hidden /> .ics file
            </Button>
            <Button
              variant="text"
              onClick={() => {
                if (draft()) void copy(emailList(), "Emails copied");
              }}
            >
              <Copy className="size-4" aria-hidden /> Copy emails
            </Button>
          </div>
          <p className="font-body text-xs text-fg-3">
            Your own calendar sends the invitations, so replies come back to you. Google adds everyone as guests;
            Outlook opens without them, so their emails are copied for you to paste.{" "}
            <button
              type="button"
              className="font-medium text-accent hover:underline"
              onClick={() => {
                const d = draft();
                if (!d) return;
                void copy(emailList(), "Emails copied — paste them into the invite's attendees");
                openTab(outlookUrl(d, "personal"));
              }}
            >
              Personal Outlook.com
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
