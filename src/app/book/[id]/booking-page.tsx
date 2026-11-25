"use client";

import { ArrowLeft, CalendarCheck, Clock, Globe, Mail, Video } from "lucide-react";
import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import { Button, Input, ToastProvider } from "@/components/ui";
import { lengthLabel, tryAgainIn } from "@/lib/booking";
import { dayKeyOf, formatDay } from "@/lib/time";
import type { BookingMade, BookingPageInfo } from "@/lib/types";
import { slotName, timeLabel, whenLabel, zoneName, type VisitorClock } from "../clock";
import { BookShell, Card, KeepLink, Message, useVisitorClock } from "../shell";

type Slot = { start: number; end: number };

/** One day of the time list, on the visitor's clock: its free times, or none because it's full. */
export type ListDay = { day: string; slots: Slot[]; full: boolean };

/**
 * The free times a day at a time, on the visitor's clock (`zone`), with the
 * full days in their places: each on the visitor's day of the first time it
 * would have offered (see BookingPageInfo.fullDays), unless that day has free
 * times. With no free time at all, no days.
 */
export function byDay(slots: Slot[], fullDays: number[], zone: string): ListDay[] {
  if (!slots.length) return [];
  const days = new Map<string, ListDay>();
  for (const slot of slots) {
    const day = dayKeyOf(slot.start, zone);
    const known = days.get(day);
    if (known) known.slots.push(slot);
    else days.set(day, { day, slots: [slot], full: false });
  }
  for (const first of fullDays) {
    const day = dayKeyOf(first, zone);
    if (!days.has(day)) days.set(day, { day, slots: [], full: true });
  }
  // Day keys (YYYY-MM-DD) sort as their dates do.
  return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** What the visitor types on the form. */
export type Guest = { name: string; email: string; note: string };

/** While the limit per address refuses this visitor's tries: until when, and the time now, which ticks. */
export type Wait = { until: number; now: number };

/** The visitor's way through the page: the time they picked, what they typed, and what Book answered. */
export type Flow = {
  picked: Slot | null;
  /** Whether the list is back after the form: its heading then takes the focus. */
  back: boolean;
  guest: Guest;
  sending: boolean;
  /** The message shown: on the form while a time is picked, else above the list. */
  problem: string | null;
  /** While it's set, Book waits for the limit per address. */
  wait: Wait | null;
  /** The booking just made. */
  made: BookingMade | null;
  /** Book answered that the link doesn't exist or is off. */
  gone: boolean;
  /** Bumped to read the free times again. */
  reload: number;
};

export const FLOW_START: Flow = {
  picked: null,
  back: false,
  guest: { name: "", email: "", note: "" },
  sending: false,
  problem: null,
  wait: null,
  made: null,
  gone: false,
  reload: 0,
};

/** What the visitor did, or what Book answered (Retry-After in seconds, 0 without one). */
export type FlowStep =
  | { type: "pick"; slot: Slot }
  | { type: "field"; field: keyof Guest; value: string }
  /** "Pick another time". */
  | { type: "back" }
  | { type: "send" }
  | { type: "answer"; status: number; body: unknown; retryAfter: number; now: number }
  /** Book got no answer. */
  | { type: "unreachable" }
  /** A second went by while Book waits. */
  | { type: "tick"; now: number };

/**
 * The flow after `step`. A message goes as soon as the visitor picks a time,
 * changes a field or presses "Pick another time". A time that was just taken
 * (409) sends them back to the list, read again, with its message above it.
 * The limit per address (429 with Retry-After) has Book wait until then,
 * counted down, rather than show a message that a field change would drop.
 */
export function nextFlow(flow: Flow, step: FlowStep): Flow {
  switch (step.type) {
    case "pick":
      return { ...flow, picked: step.slot, problem: null };
    case "field":
      return { ...flow, guest: { ...flow.guest, [step.field]: step.value }, problem: null };
    case "back":
      return { ...flow, picked: null, problem: null, back: true };
    case "send":
      return { ...flow, sending: true, problem: null };
    case "unreachable":
      return { ...flow, sending: false, problem: "Couldn't reach the server. Try again." };
    case "tick":
      if (!flow.wait) return flow;
      return { ...flow, wait: step.now >= flow.wait.until ? null : { until: flow.wait.until, now: step.now } };
    case "answer": {
      const done = { ...flow, sending: false };
      if (step.status >= 200 && step.status < 300) return { ...done, made: step.body as BookingMade };
      if (step.status === 404) return { ...done, gone: true };
      if (step.status === 429 && step.retryAfter > 0) {
        return { ...done, problem: null, wait: { until: step.now + step.retryAfter * 1000, now: step.now } };
      }
      const error = (step.body as { error?: unknown } | null)?.error;
      const problem = typeof error === "string" ? error : "Couldn't book that time. Try again.";
      // Someone else got it first: show what's still free.
      if (step.status === 409) return { ...done, problem, picked: null, back: true, reload: flow.reload + 1 };
      return { ...done, problem };
    }
  }
}

/** Whether Book can be pressed: a time is picked, a name and an email are given, and nothing is on its way or waiting. */
export function canBook(flow: Flow): boolean {
  return flow.picked !== null && !flow.sending && flow.wait === null && flow.guest.name.trim() !== "" && flow.guest.email.trim() !== "";
}

/**
 * Right after booking: the address bar holds the booking's cancel link in
 * place of the booking page's history entry, with no new entry. Back then
 * leaves for the page before the booking link, and a reload or a bookmark
 * opens the booking. Next keeps this page as it is meanwhile (see
 * window.history.replaceState in Next's linking guide). Only the link's path,
 * so it stays on this page's origin whatever APP_URL says.
 */
export function replaceAddressWithCancelLink(cancelUrl: string): void {
  try {
    window.history.replaceState(null, "", new URL(cancelUrl).pathname);
  } catch {
    // The confirmation still shows the link to copy.
  }
}

/** A booking link, as a visitor sees it: the host's name, what the meeting is, and the free times to pick from. */
export function BookingPage({ id }: { id: string }) {
  return (
    <ToastProvider>
      <Booking id={id} />
    </ToastProvider>
  );
}

function Booking({ id }: { id: string }) {
  const clock = useVisitorClock();
  /** The link as GET answered it, and when that was: the zone's offset is read then while there are no times. */
  const [page, setPage] = useState<{ info: BookingPageInfo; at: number } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "gone" | "error">("loading");
  const [flow, step] = useReducer(nextFlow, FLOW_START);
  const { picked, guest, problem, wait, made } = flow;

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const res = await fetch(`/api/book/${encodeURIComponent(id)}`, { cache: "no-store", signal: controller.signal });
        if (res.status === 404) {
          setState("gone");
          return;
        }
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        setPage({ info: (await res.json()) as BookingPageInfo, at: Date.now() });
        setState("ready");
      } catch {
        if (!controller.signal.aborted) setState("error");
      }
    };
    void load();
    return () => controller.abort();
  }, [id, flow.reload]);

  // Book waits as long as the limit per address says, counted down, and not a moment less.
  const waiting = wait !== null;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => step({ type: "tick", now: Date.now() }), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  const book = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // A waiting visitor's press, Enter in a field included, isn't sent: it would count again.
    if (!picked || !canBook(flow)) return;
    step({ type: "send" });
    try {
      const res = await fetch(`/api/book/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: picked.start,
          name: guest.name.trim(),
          email: guest.email.trim(),
          note: guest.note.trim() || null,
        }),
      });
      const body: unknown = await res.json().catch(() => ({}));
      step({ type: "answer", status: res.status, body, retryAfter: Number(res.headers.get("Retry-After")) || 0, now: Date.now() });
      if (res.ok) replaceAddressWithCancelLink((body as BookingMade).cancelUrl);
    } catch {
      step({ type: "unreachable" });
    }
  };

  if (state === "gone" || flow.gone) return <Message>This booking link doesn&apos;t exist or was turned off.</Message>;
  if (state === "error") return <Message>Couldn&apos;t load this booking link. Try again in a moment.</Message>;
  if (!page || !clock) return <Message status>Loading…</Message>;

  if (made) {
    return <Confirmation made={made} email={guest.email.trim()} meet={page.info.meet} clock={clock} />;
  }

  const { info, at } = page;
  return (
    <BookShell>
      <LinkHeader page={info} />
      {picked ? (
        <BookingForm
          slot={picked}
          clock={clock}
          guest={guest}
          problem={problem}
          wait={wait}
          sending={flow.sending}
          canBook={canBook(flow)}
          onField={(field, value) => step({ type: "field", field, value })}
          onBack={() => step({ type: "back" })}
          onSubmit={book}
        />
      ) : (
        <TimeList
          slots={info.slots}
          fullDays={info.fullDays ?? []}
          clock={clock}
          at={info.slots[0]?.start ?? at}
          problem={problem}
          focus={flow.back}
          onPick={(slot) => step({ type: "pick", slot })}
        />
      )}
    </BookShell>
  );
}

/** The top of the page: who, what, how long, whether it's a Google Meet call, and the link's description. */
export function LinkHeader({ page }: { page: Pick<BookingPageInfo, "hostName" | "title" | "durationMin" | "meet" | "description"> }) {
  return (
    <Card>
      <p className="font-body text-sm break-words text-fg-2">{page.hostName}</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight break-words text-fg">{page.title}</h1>
      <p className="mt-2 flex items-center gap-1.5 font-body text-sm text-fg-2">
        <Clock className="size-4 shrink-0" aria-hidden /> {lengthLabel(page.durationMin)}
      </p>
      {page.meet && (
        <p className="mt-1 flex items-center gap-1.5 font-body text-sm text-fg-2">
          <Video className="size-4 shrink-0" aria-hidden /> Google Meet video call
        </p>
      )}
      {page.description && <p className="mt-3 font-body text-sm break-words whitespace-pre-line text-fg">{page.description}</p>}
    </Card>
  );
}

/**
 * The free times to pick from, a day at a time, with the full days in their
 * places. `at` is when the zone's offset is read: the first time. `focus`
 * moves the focus to the heading as the list appears.
 */
export function TimeList({
  slots,
  fullDays,
  clock,
  at,
  problem,
  focus,
  onPick,
}: {
  slots: Slot[];
  fullDays: number[];
  clock: VisitorClock;
  at: number;
  problem: string | null;
  focus: boolean;
  onPick: (slot: Slot) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus]);
  const days = byDay(slots, fullDays, clock.zone);
  return (
    <Card>
      <h2 ref={heading} tabIndex={-1} className="text-base font-semibold text-fg focus-visible:outline-2 focus-visible:outline-accent">
        Pick a time
      </h2>
      <p className="mt-1 flex items-center gap-1.5 font-body text-xs text-fg-3">
        <Globe className="size-3.5 shrink-0" aria-hidden /> Times are in your time zone, {zoneName(clock.zone, at)}.
      </p>
      {problem && (
        <p role="alert" className="mt-3 rounded-xl bg-danger-container px-3 py-2 font-body text-sm text-fg">
          {problem}
        </p>
      )}
      {days.length === 0 ? (
        <p className="mt-4 font-body text-sm text-fg-2">No free times right now. Try again later.</p>
      ) : (
        <div className="mt-4 flex flex-col gap-5">
          {days.map(({ day, slots: free, full }) => (
            <div key={day}>
              <h3 className="text-sm font-semibold text-fg">{formatDay(day, "long")}</h3>
              {full ? (
                <p className="mt-1 font-body text-sm text-fg-3">Fully booked</p>
              ) : (
                <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {free.map((slot) => (
                    <button
                      key={slot.start}
                      type="button"
                      aria-label={slotName(slot.start, clock)}
                      onClick={() => onPick(slot)}
                      className="h-10 rounded-lg border border-grid-strong font-body text-sm font-medium text-fg hover:border-accent hover:bg-accent-container focus-visible:outline-2 focus-visible:outline-accent max-sm:h-11"
                    >
                      {timeLabel(slot.start, clock)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * The picked time and the visitor's details. The heading, the picked time,
 * takes the focus as the form appears. Book can be pressed only with
 * `canBook` (see canBook); while `wait` is on, the form says how long is left.
 */
export function BookingForm({
  slot,
  clock,
  guest,
  problem,
  wait,
  sending,
  canBook,
  onField,
  onBack,
  onSubmit,
}: {
  slot: Slot;
  clock: VisitorClock;
  guest: Guest;
  problem: string | null;
  wait: Wait | null;
  sending: boolean;
  canBook: boolean;
  onField: (field: keyof Guest, value: string) => void;
  onBack: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [slot.start]);
  return (
    <Card>
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 rounded-full font-body text-sm font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent max-sm:min-h-11"
      >
        <ArrowLeft className="size-4" aria-hidden /> Pick another time
      </button>
      <h2 ref={heading} tabIndex={-1} className="mt-3 text-base font-semibold text-fg focus-visible:outline-2 focus-visible:outline-accent">
        {whenLabel(slot, clock)}
      </h2>
      <p className="font-body text-xs text-fg-3">{zoneName(clock.zone, slot.start)}</p>
      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-fg">Your name</span>
          <Input required maxLength={100} autoComplete="name" value={guest.name} onChange={(e) => onField("name", e.target.value)} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-fg">Your email</span>
          <Input
            required
            type="email"
            maxLength={254}
            autoComplete="email"
            value={guest.email}
            onChange={(e) => onField("email", e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-fg">Note (optional)</span>
          <textarea
            maxLength={500}
            rows={3}
            value={guest.note}
            onChange={(e) => onField("note", e.target.value)}
            className="w-full rounded-lg border border-grid-strong bg-surface px-3 py-2 font-body text-sm text-fg placeholder:text-fg-3 focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-accent/30"
          />
        </label>
        {problem && (
          <p role="alert" className="font-body text-sm text-danger">
            {problem}
          </p>
        )}
        {wait && (
          <p role="status" className="font-body text-sm text-danger">
            {tryAgainIn(wait.until - wait.now)}
          </p>
        )}
        <div>
          <Button type="submit" variant="primary" disabled={!canBook} className="max-sm:h-11 max-sm:w-full">
            {sending ? "Booking…" : "Book"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * Right after booking: what was booked, with whom and when, and the cancel
 * link, which is now the page's address. Outside the demo (invited), also the
 * invitation on its way to `email`, and with `meet` (the link adds a Meet
 * link) that the Meet link comes with it. The heading takes the focus.
 */
export function Confirmation({ made, email, meet, clock }: { made: BookingMade; email: string; meet: boolean; clock: VisitorClock }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <BookShell>
      <Card>
        <CalendarCheck className="size-8 text-on-free" aria-hidden />
        <h1 ref={heading} tabIndex={-1} className="mt-3 text-2xl font-semibold tracking-tight text-fg focus-visible:outline-2 focus-visible:outline-accent">
          Booked
        </h1>
        <p className="mt-2 font-body text-sm break-words text-fg">
          {made.title} with {made.hostName}
        </p>
        <p className="mt-1 font-body text-sm text-fg-2">{whenLabel(made, clock)}</p>
        <p className="font-body text-xs text-fg-3">{zoneName(clock.zone, made.start)}</p>
        {made.invited && (
          <p className="mt-3 flex items-start gap-1.5 font-body text-sm text-fg">
            <Mail className="mt-0.5 size-4 shrink-0 text-fg-2" aria-hidden />
            <span className="min-w-0 break-words">An invitation is on its way to {email}.</span>
          </p>
        )}
        {made.invited && meet && (
          <p className="mt-2 flex items-start gap-1.5 font-body text-sm text-fg">
            <Video className="mt-0.5 size-4 shrink-0 text-fg-2" aria-hidden />
            <span className="min-w-0">Google Meet video call: the link comes with your invitation.</span>
          </p>
        )}
        <KeepLink url={made.cancelUrl} />
      </Card>
    </BookShell>
  );
}
