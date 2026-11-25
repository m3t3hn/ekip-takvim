"use client";

import { CircleAlert, CircleCheck, Copy, ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { BUFFERS, DURATIONS, MAX_PER_DAY, NOTICES, lengthLabel } from "@/lib/booking";
import { dayKeyOf, formatDay, formatRange } from "@/lib/time";
import type { AllowAccessResult, BookingLinkFields, MyBookingLink, MyBookingLinks } from "@/lib/types";
import { Button, Input, Select, ToastProvider, cn, useCopy } from "./ui";

/** Booking links one person can have (as the server says). */
const MAX_LINKS = 10;
/** Monday first, as the days are listed. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** The box Allow access needs ticked on Google's screen (calendar.events), in Google's words. */
const EVENTS_BOX = "View and edit events on all your calendars";
/** A link that looks like Button's "text" variant, as that renders. */
const TEXT_LINK =
  "inline-flex h-9 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium whitespace-nowrap text-accent transition-colors select-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** "10:00"; the end of the day is "24:00". */
function clock(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** "Mon–Fri", "Mon, Wed, Fri", "Every day". */
function daysLabel(days: number[]): string {
  const on = WEEK.filter((d) => days.includes(d));
  if (on.length === 7) return "Every day";
  const runs: number[][] = [];
  for (const d of on) {
    const last = runs[runs.length - 1];
    if (last && WEEK.indexOf(d) === WEEK.indexOf(last[last.length - 1]) + 1) last.push(d);
    else runs.push([d]);
  }
  return runs
    .flatMap((run) => (run.length >= 3 ? [`${DAY_NAMES[run[0]]}–${DAY_NAMES[run[run.length - 1]]}`] : run.map((d) => DAY_NAMES[d])))
    .join(", ");
}

function noticeLabel(min: number): string {
  if (min === 0) return "None";
  if (min < 1440) return min === 60 ? "1 hour" : `${min / 60} hours`;
  return min === 1440 ? "1 day" : `${min / 1440} days`;
}

const QUARTERS = Array.from({ length: 97 }, (_, i) => i * 15);

/** A link row's summary: "30 min · Mon–Fri · 09:00–17:00 · Meet", and whether it's off. */
export function linkSummary(link: MyBookingLink): string {
  return [
    lengthLabel(link.durationMin),
    daysLabel(link.days),
    `${clock(link.startMin)}–${clock(link.endMin)}`,
    ...(link.meet ? ["Meet"] : []),
    ...(link.active ? [] : ["Off: visitors can't book it"]),
  ].join(" · ");
}

/** The note Allow access comes back with (see the sign-in callback), shown once. */
const ACCESS_NOTES: Record<AllowAccessResult, { done: boolean; text: ReactNode }> = {
  granted: { done: true, text: "Done: your booking links can take bookings." },
  missing: {
    done: false,
    text: (
      <>
        Google didn&apos;t give the permission. Press Allow access again and tick <q>{EVENTS_BOX}</q>.
      </>
    ),
  },
  cancelled: { done: false, text: "Access wasn't allowed. Nothing changed." },
  // Sign-in's own failures, as the calendar page words them.
  expired: { done: false, text: "That sign-in took too long or came from another tab. Try again." },
  domain: { done: false, text: "Only company Google accounts can sign in." },
  failed: { done: false, text: "Google sign-in didn't work. Try again." },
  unavailable: { done: false, text: "Google sign-in isn't set up on this server." },
};

/** The note for ?access=…; none for anything else, or when whether they have access now says otherwise. */
function accessNote(access: string | null, allowed: boolean) {
  const result = (Object.keys(ACCESS_NOTES) as AllowAccessResult[]).find((r) => r === access);
  if (!result || (result === "granted" && !allowed) || (result === "missing" && allowed)) return null;
  return ACCESS_NOTES[result];
}

const noSubscribe = () => () => {};

/** This page's own origin, in the browser; null while it's rendered on the server. */
function useOrigin(): string | null {
  return useSyncExternalStore(noSubscribe, () => window.location.origin, () => null);
}

type Props = {
  initial: MyBookingLinks;
  zone: string;
  /** The company's working hours, in minutes, for a new link. */
  hours: { startMin: number; endMin: number };
  /** The most days ahead a link can offer (the config's horizon_days). */
  horizonDays: number;
  /** What a link's address starts with: APP_URL without a trailing slash, or null for this page's own address. */
  base: string | null;
  /** How Allow access went, when it just sent them back here (?access=…): its note is shown once. */
  access?: string | null;
};

/**
 * My settings' booking links: links anyone can open to book a time with the
 * signed-in person, and the bookings made on them. Days and hours are on
 * their clock (`zone`). The section is #booking, so /settings#booking opens there.
 */
export function BookingLinks(props: Props) {
  return (
    <ToastProvider>
      <BookingLinksSection {...props} />
    </ToastProvider>
  );
}

type Editing = { id: string | null; fields: BookingLinkFields; aheadText: string };

/** The section itself, inside BookingLinks' toasts. */
export function BookingLinksSection({ initial, zone, hours, horizonDays, base, access = null }: Props) {
  const copy = useCopy();
  const origin = useOrigin();
  const [data, setData] = useState(initial);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  /** The link just made, for the line that says it's ready. */
  const [readyId, setReadyId] = useState<string | null>(null);
  const [note, setNote] = useState(() => accessNote(access, initial.bookingAccess));
  const section = useRef<HTMLElement>(null);
  const readyLine = useRef<HTMLDivElement>(null);
  const readyCopy = useRef<HTMLButtonElement>(null);

  /** A link's address: what its row shows, Copy link copies and Open opens. */
  const address = (link: MyBookingLink) => `${base ?? origin ?? ""}${link.path}`;
  const ready = data.links.find((l) => l.id === readyId) ?? null;

  useEffect(() => {
    const url = new URL(window.location.href);
    let gone = false;
    if (url.searchParams.has("access")) {
      // Allow access's note is shown once: without ?access=, a reload doesn't bring it back.
      // Only once this commit's effects are done: Next's router patches replaceState in its own
      // effect, which runs after this one (a parent's effects run after its children's). The
      // patched one keeps the router's state in the entry, which Back needs, and gives the
      // router the new address, so it doesn't write ?access= back.
      url.searchParams.delete("access");
      queueMicrotask(() => {
        if (!gone) window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      });
    }
    // /settings#booking, in case the browser's own jump came before the page was laid out.
    if (url.hash === "#booking") section.current?.scrollIntoView({ block: "start" });
    return () => {
      gone = true;
    };
  }, []);

  useEffect(() => {
    // The form is gone: carry on from the new link's line.
    if (readyId) readyCopy.current?.focus();
  }, [readyId]);

  const fresh = (): BookingLinkFields => ({
    title: "",
    description: "",
    durationMin: 30,
    days: [1, 2, 3, 4, 5],
    startMin: hours.startMin,
    endMin: hours.endMin,
    bufferMin: 0,
    noticeMin: 240,
    aheadDays: Math.min(14, horizonDays),
    maxPerDay: null,
    meet: false,
  });

  /** Send a change; the answer is the whole list again, or null when it didn't work. */
  const send = async (key: string, url: string, method: string, body?: unknown): Promise<MyBookingLinks | null> => {
    setBusy(key);
    setProblem(null);
    try {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const answer = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(answer.error ?? "Couldn't save that. Try again.");
      setData(answer);
      return answer;
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Couldn't save that. Try again.");
      return null;
    } finally {
      setBusy(null);
    }
  };

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing) return;
    const fields = { ...editing.fields, title: editing.fields.title.trim(), aheadDays: Number(editing.aheadText) };
    const before = new Set(data.links.map((l) => l.id));
    const answer = editing.id
      ? await send("save", `/api/me/booking-links/${encodeURIComponent(editing.id)}`, "PUT", fields)
      : await send("save", "/api/me/booking-links", "POST", fields);
    if (!answer) return;
    // A new link: where the form was, say it's ready.
    if (!editing.id) setReadyId(answer.links.find((l) => !before.has(l.id))?.id ?? null);
    setEditing(null);
  };

  /** A field changed: a message about the form is out of date. */
  const change = (next: Editing) => {
    setEditing(next);
    setProblem(null);
  };

  /** Close the form, and any message on it. */
  const close = () => {
    setEditing(null);
    setProblem(null);
  };

  const edit = (link: MyBookingLink) => {
    setProblem(null);
    setEditing({ id: link.id, fields: link, aheadText: String(link.aheadDays) });
  };

  /** The ready line and Allow access's note stay until the host does something else in the section. */
  const onClickCapture = (event: React.MouseEvent<HTMLElement>) => {
    const control = (event.target as Element).closest("a, button, input, select, textarea");
    if (control && !readyLine.current?.contains(control)) {
      setReadyId(null);
      setNote(null);
    }
  };

  return (
    <section id="booking" ref={section} onClickCapture={onClickCapture} className="scroll-mt-6 rounded-2xl bg-surface p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-fg">Booking links</h2>
          <p className="mt-1 font-body text-xs text-fg-2">
            Send a booking link to anyone: they pick one of your free times and book it with their name and email, without
            signing in. They see your name and the free times the link offers, nothing else. Days and hours are on your
            clock ({zone.replace(/_/g, " ")}).
          </p>
        </div>
        {!(editing && !editing.id) && (
          <Button
            variant="tonal"
            disabled={busy !== null || data.links.length >= MAX_LINKS}
            title={data.links.length >= MAX_LINKS ? `You can have up to ${MAX_LINKS} booking links` : undefined}
            onClick={() => {
              setProblem(null);
              setEditing({ id: null, fields: fresh(), aheadText: String(fresh().aheadDays) });
            }}
          >
            <Plus className="size-4" aria-hidden /> New booking link
          </Button>
        )}
      </div>

      {note && (
        <div
          role="status"
          className={cn(
            "mt-4 flex gap-3 rounded-xl px-4 py-3 font-body text-sm",
            note.done ? "bg-accent-container text-on-accent-container" : "bg-danger-container text-fg",
          )}
        >
          {note.done ? (
            <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
          ) : (
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
          )}
          <p className="min-w-0">{note.text}</p>
        </div>
      )}

      {!data.bookingAccess && (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl bg-accent-container px-4 py-3">
          <p className="min-w-0 flex-1 basis-64 font-body text-sm text-on-accent-container">
            Booking links add each booked meeting to your Google Calendar and invite the visitor; nothing else in your
            calendar changes. Until you allow that, your links offer no times. On Google&apos;s screen, tick{" "}
            <q>{EVENTS_BOX}</q>.
          </p>
          <a
            href="/auth/google?booking=1"
            className="inline-flex h-9 shrink-0 items-center rounded-full bg-accent px-4 text-sm font-medium whitespace-nowrap text-on-accent hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Allow access
          </a>
        </div>
      )}

      {problem && !editing && (
        <p role="alert" className="mt-3 font-body text-xs text-danger">
          {problem}
        </p>
      )}

      {editing && !editing.id ? (
        <LinkForm
          editing={editing}
          horizonDays={horizonDays}
          busy={busy === "save"}
          problem={problem}
          onChange={change}
          onSubmit={save}
          onCancel={close}
        />
      ) : (
        ready && (
          <LinkReady
            ref={readyLine}
            copyRef={readyCopy}
            link={ready}
            address={address(ready)}
            onCopy={() => copy(address(ready), "Link copied")}
          />
        )
      )}

      <ul className="mt-4 divide-y divide-grid rounded-xl border border-grid">
        {data.links.length === 0 && (
          <li className="px-4 py-6 text-center font-body text-sm text-fg-3">No booking links yet.</li>
        )}
        {data.links.map((link) =>
          editing?.id === link.id ? (
            <li key={link.id} className="p-3">
              <LinkForm
                editing={editing}
                horizonDays={horizonDays}
                busy={busy === "save"}
                problem={problem}
                onChange={change}
                onSubmit={save}
                onCancel={close}
              />
            </li>
          ) : (
            <li key={link.id} className="px-4 py-3">
              <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                <div className="min-w-0 flex-1 basis-56">
                  <div className={cn("truncate font-body text-sm font-medium", link.active ? "text-fg" : "text-fg-3")}>{link.title}</div>
                  <div className="mt-0.5 font-body text-xs text-fg-2">{linkSummary(link)}</div>
                  <div className="mt-0.5 font-body text-xs break-all text-fg-3 select-all">{address(link)}</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={link.active}
                  aria-label={`${link.title}: ${link.active ? "on" : "off"}`}
                  disabled={busy !== null}
                  onClick={() => send(`switch:${link.id}`, `/api/me/booking-links/${encodeURIComponent(link.id)}`, "PUT", { active: !link.active })}
                  className="flex items-center gap-2 rounded-lg font-body text-xs text-fg-2 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
                >
                  <span
                    aria-hidden
                    className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", link.active ? "bg-accent" : "bg-grid-strong")}
                  >
                    <span
                      className={cn(
                        "absolute top-0.5 size-4 rounded-full bg-surface shadow transition-[left]",
                        link.active ? "left-[18px]" : "left-0.5",
                      )}
                    />
                  </span>
                  {link.active ? "On" : "Off"}
                </button>
              </div>
              {confirmDelete === link.id ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    variant="danger"
                    disabled={busy !== null}
                    onClick={async () => {
                      await send(`delete:${link.id}`, `/api/me/booking-links/${encodeURIComponent(link.id)}`, "DELETE");
                      setConfirmDelete(null);
                    }}
                  >
                    {busy === `delete:${link.id}` ? "Deleting…" : "Yes, delete"}
                  </Button>
                  <Button onClick={() => setConfirmDelete(null)} disabled={busy !== null}>
                    Keep it
                  </Button>
                </div>
              ) : (
                <div className="mt-1 -ml-4 flex flex-wrap items-center gap-1">
                  <Button
                    variant="text"
                    aria-label={`Copy link to ${link.title}`}
                    onClick={() =>
                      copy(address(link), link.active ? "Link copied" : "Link copied. It's off: turn it on before you send it.")
                    }
                  >
                    <Copy className="size-4" aria-hidden /> Copy link
                  </Button>
                  {link.active && (
                    <a
                      href={address(link)}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open ${link.title}`}
                      className={TEXT_LINK}
                    >
                      <ExternalLink className="size-4" aria-hidden /> Open
                    </a>
                  )}
                  <Button variant="text" onClick={() => edit(link)} disabled={busy !== null || editing !== null} aria-label={`Edit ${link.title}`}>
                    <Pencil className="size-4" aria-hidden /> Edit
                  </Button>
                  <Button
                    variant="text"
                    onClick={() => setConfirmDelete(link.id)}
                    disabled={busy !== null}
                    aria-label={`Delete ${link.title}`}
                  >
                    <Trash2 className="size-4" aria-hidden /> Delete
                  </Button>
                </div>
              )}
            </li>
          ),
        )}
      </ul>
      {confirmDelete && (
        <p className="mt-2 font-body text-xs text-fg-2">
          Deleting a link stops its page working. The bookings made on it stay, and you can still cancel them below.
        </p>
      )}

      <h3 className="mt-6 text-sm font-semibold text-fg">Upcoming bookings</h3>
      <ul className="mt-2 divide-y divide-grid rounded-xl border border-grid">
        {data.upcoming.length === 0 && (
          <li className="px-4 py-6 text-center font-body text-sm text-fg-3">No bookings yet.</li>
        )}
        {data.upcoming.map((b) => (
          <li key={b.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
            <div className="min-w-0 flex-1 basis-56 font-body text-sm">
              <div className="font-medium text-fg">
                {formatDay(dayKeyOf(b.start, zone))}, {formatRange(b.start, b.end, zone)}
                <span className="font-normal text-fg-2"> · {b.title}</span>
              </div>
              <div className="mt-0.5 truncate text-xs text-fg-2">
                {b.guestName} · <a href={`mailto:${b.guestEmail}`} className="text-accent hover:underline">{b.guestEmail}</a>
              </div>
              {b.note && <p className="mt-1 text-xs whitespace-pre-line text-fg-2">“{b.note}”</p>}
            </div>
            {confirmCancel === b.id ? (
              <span className="flex items-center gap-2">
                <Button
                  variant="danger"
                  disabled={busy !== null}
                  onClick={async () => {
                    await send(`cancel:${b.id}`, `/api/me/bookings/${encodeURIComponent(b.id)}/cancel`, "POST");
                    setConfirmCancel(null);
                  }}
                >
                  {busy === `cancel:${b.id}` ? "Cancelling…" : "Yes, cancel it"}
                </Button>
                <Button onClick={() => setConfirmCancel(null)} disabled={busy !== null}>
                  Keep it
                </Button>
              </span>
            ) : (
              <Button variant="text" onClick={() => setConfirmCancel(b.id)} disabled={busy !== null} aria-label={`Cancel the booking with ${b.guestName}`}>
                Cancel
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** After Create link, where the form was: "Link ready: Intro call · Copy · Open". */
export function LinkReady({
  link,
  address,
  onCopy,
  ref,
  copyRef,
}: {
  link: MyBookingLink;
  /** What Copy copies and Open opens: the link's address, as its row shows it. */
  address: string;
  onCopy: () => void;
  ref?: Ref<HTMLDivElement>;
  copyRef?: Ref<HTMLButtonElement>;
}) {
  const action =
    "rounded font-medium underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
  return (
    <div
      ref={ref}
      role="status"
      className="mt-4 rounded-xl bg-accent-container px-4 py-3 font-body text-sm break-words text-on-accent-container"
    >
      <CircleCheck className="mr-2 inline size-4 align-[-3px]" aria-hidden />
      Link ready: <span className="font-medium">{link.title}</span> ·{" "}
      <button ref={copyRef} type="button" onClick={onCopy} className={action}>
        Copy
      </button>
      {link.active && (
        <>
          {" "}
          ·{" "}
          <a href={address} target="_blank" rel="noopener noreferrer" className={action}>
            Open
          </a>
        </>
      )}
    </div>
  );
}

/** Enter in a field doesn't send the link form: only Create link or Save does. Enter in the description makes a new line. */
function keepEnter(event: React.KeyboardEvent<HTMLFormElement>) {
  if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT") event.preventDefault();
}

/** A booking link's fields, for a new link or one being changed. */
export function LinkForm({
  editing,
  horizonDays,
  busy,
  problem,
  onChange,
  onSubmit,
  onCancel,
}: {
  editing: Editing;
  horizonDays: number;
  busy: boolean;
  problem: string | null;
  onChange: (next: Editing) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const f = editing.fields;
  const set = (change: Partial<BookingLinkFields>) => onChange({ ...editing, fields: { ...f, ...change } });
  const toggleDay = (day: number) => set({ days: f.days.includes(day) ? f.days.filter((d) => d !== day) : [...f.days, day] });
  const label = "flex flex-col gap-1.5";
  const caption = "text-xs font-semibold text-fg";

  return (
    <form onSubmit={onSubmit} onKeyDown={keepEnter} className={cn("rounded-xl border border-grid p-4", !editing.id && "mt-4")}>
      <h3 className="text-sm font-semibold text-fg">{editing.id ? "Edit booking link" : "New booking link"}</h3>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <label className={cn(label, "sm:col-span-2")}>
          <span className={caption}>Title</span>
          <Input value={f.title} maxLength={80} placeholder="e.g. Intro call" onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className={cn(label, "sm:col-span-2")}>
          <span className={caption}>Description (optional)</span>
          <textarea
            value={f.description}
            maxLength={500}
            rows={2}
            placeholder="What the meeting is about"
            onChange={(e) => set({ description: e.target.value })}
            className="w-full rounded-lg border border-grid-strong bg-surface px-3 py-2 font-body text-sm text-fg placeholder:text-fg-3 focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-accent/30"
          />
        </label>
        <label className={label}>
          <span className={caption}>Length</span>
          <Select className="w-full" value={f.durationMin} onChange={(e) => set({ durationMin: Number(e.target.value) })}>
            {DURATIONS.map((d) => (
              <option key={d} value={d}>{lengthLabel(d)}</option>
            ))}
          </Select>
        </label>
        <div className={label}>
          <span className={caption}>Hours</span>
          <div className="flex items-center gap-1.5">
            <Select
              aria-label="From"
              className="min-w-0 flex-1"
              value={f.startMin}
              onChange={(e) => {
                const startMin = Number(e.target.value);
                // To stays after From: moved to or past it, To becomes From plus a meeting, at most 24:00.
                set({ startMin, endMin: startMin < f.endMin ? f.endMin : Math.min(1440, startMin + f.durationMin) });
              }}
            >
              {QUARTERS.slice(0, -1).map((m) => (
                <option key={m} value={m}>{clock(m)}</option>
              ))}
            </Select>
            <span className="font-body text-sm text-fg-2">to</span>
            <Select aria-label="To" className="min-w-0 flex-1" value={f.endMin} onChange={(e) => set({ endMin: Number(e.target.value) })}>
              {QUARTERS.filter((m) => m > f.startMin).map((m) => (
                <option key={m} value={m}>{clock(m)}</option>
              ))}
            </Select>
          </div>
        </div>
        <div className={cn(label, "sm:col-span-2")}>
          <span className={caption}>Days</span>
          <div className="flex flex-wrap gap-1.5">
            {WEEK.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={f.days.includes(d)}
                onClick={() => toggleDay(d)}
                className={cn(
                  "h-8 rounded-full border px-3 font-body text-sm focus-visible:outline-2 focus-visible:outline-accent",
                  f.days.includes(d) ? "border-accent bg-accent-container text-on-accent-container" : "border-grid-strong text-fg-2 hover:bg-hover",
                )}
              >
                {DAY_NAMES[d]}
              </button>
            ))}
          </div>
        </div>
        <label className={label}>
          <span className={caption}>Break between meetings</span>
          <Select className="w-full" value={f.bufferMin} onChange={(e) => set({ bufferMin: Number(e.target.value) })}>
            {BUFFERS.map((b) => (
              <option key={b} value={b}>{b ? lengthLabel(b) : "None"}</option>
            ))}
          </Select>
        </label>
        <label className={label}>
          <span className={caption}>Minimum notice</span>
          <Select className="w-full" value={f.noticeMin} onChange={(e) => set({ noticeMin: Number(e.target.value) })}>
            {NOTICES.map((n) => (
              <option key={n} value={n}>{noticeLabel(n)}</option>
            ))}
          </Select>
        </label>
        <label className={label}>
          <span className={caption}>Days ahead, today included</span>
          <Input
            type="number"
            min={1}
            max={horizonDays}
            value={editing.aheadText}
            onChange={(e) => onChange({ ...editing, aheadText: e.target.value })}
          />
        </label>
        <label className={label}>
          <span className={caption}>Bookings per day</span>
          <Select
            className="w-full"
            value={f.maxPerDay ?? ""}
            onChange={(e) => set({ maxPerDay: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">No limit</option>
            {Array.from({ length: MAX_PER_DAY }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>{`At most ${n}`}</option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2 font-body text-sm text-fg sm:col-span-2">
          <input type="checkbox" checked={f.meet} onChange={(e) => set({ meet: e.target.checked })} className="size-4 accent-[var(--accent)]" />
          Add a Google Meet link
        </label>
      </div>
      {problem && (
        <p role="alert" className="mt-3 font-body text-xs text-danger">
          {problem}
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <Button type="submit" variant="primary" disabled={busy || !f.title.trim() || f.days.length === 0}>
          {busy ? "Saving…" : editing.id ? "Save" : "Create link"}
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
