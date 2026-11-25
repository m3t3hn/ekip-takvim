"use client";

import { CalendarCheck, CalendarClock, CalendarPlus, CalendarX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, ToastProvider } from "@/components/ui";
import type { BookingToCancel } from "@/lib/types";
import { dayLabel, whenLabel, zoneName, type VisitorClock } from "../../clock";
import { BookShell, Card, KeepLink, Message, usePageAddress, useVisitorClock } from "../../shell";

/**
 * A booking's cancel link, which is also its confirmation's address: what was
 * booked, with whom and when, and a button to cancel it until the meeting
 * ends.
 */
export function CancelPage({ token }: { token: string }) {
  return (
    <ToastProvider>
      <Cancel token={token} />
    </ToastProvider>
  );
}

function Cancel({ token }: { token: string }) {
  const clock = useVisitorClock();
  const address = usePageAddress();
  const [booking, setBooking] = useState<BookingToCancel | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  /** Bumped to read the booking again. */
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** Whether it was cancelled here, just now: the cancelled message then takes the focus. */
  const [cancelledHere, setCancelledHere] = useState(false);

  const url = `/api/book/cancel/${encodeURIComponent(token)}`;

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const res = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (res.status === 404) {
          setState("missing");
          return;
        }
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        setBooking((await res.json()) as BookingToCancel);
        setState("ready");
      } catch {
        if (!controller.signal.aborted) setState("error");
      }
    };
    void load();
    return () => controller.abort();
  }, [url, reload]);

  const cancel = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch(url, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (res.status === 404) setState("missing");
      else if (!res.ok) {
        setProblem(body.error ?? "Couldn't cancel the booking. Try again.");
        // Its meeting may have ended meanwhile: show the booking as it is now.
        if (res.status === 409) setReload((n) => n + 1);
      } else {
        setBooking(body as BookingToCancel);
        setCancelledHere(true);
      }
    } catch {
      setProblem("Couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (state === "missing") return <Message>No booking matches this cancel link.</Message>;
  if (state === "error") return <Message>Couldn&apos;t load this booking. Try again in a moment.</Message>;
  if (!booking || !clock || address === null) return <Message status>Loading…</Message>;

  return (
    <BookingStatus
      booking={booking}
      clock={clock}
      address={address}
      busy={busy}
      problem={problem}
      focusCancelled={cancelledHere}
      onCancel={cancel}
    />
  );
}

/**
 * A booking as its cancel link shows it. While it's on and its meeting hasn't
 * ended: "You're booked", the page's address to keep, and Cancel booking.
 * Once it's cancelled, or its meeting took place, that's said instead, with a
 * way to book another time while its link is on. `focusCancelled` moves the
 * focus to the cancelled message.
 */
export function BookingStatus({
  booking,
  clock,
  address,
  busy,
  problem,
  focusCancelled,
  onCancel,
}: {
  booking: BookingToCancel;
  clock: VisitorClock;
  /** This page's address: the cancel link. */
  address: string;
  busy: boolean;
  problem: string | null;
  focusCancelled: boolean;
  onCancel: () => void;
}) {
  const cancelledMessage = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (focusCancelled && booking.cancelled) cancelledMessage.current?.focus();
  }, [focusCancelled, booking.cancelled]);

  const zone = <p className="font-body text-xs text-fg-3">{zoneName(clock.zone, booking.start)}</p>;

  if (!booking.cancelled && !booking.ended) {
    return (
      <BookShell>
        <Card>
          <CalendarCheck className="size-8 text-on-free" aria-hidden />
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-fg">You&apos;re booked</h1>
          <p className="mt-2 font-body text-sm break-words text-fg">
            {booking.title} with {booking.hostName}
          </p>
          <p className="mt-1 font-body text-sm text-fg-2">{whenLabel(booking, clock)}</p>
          {zone}
          <KeepLink url={address} />
          <div className="mt-5">
            <Button variant="danger" onClick={onCancel} disabled={busy} className="max-sm:h-11">
              {busy ? "Cancelling…" : "Cancel booking"}
            </Button>
            {problem && (
              <p role="alert" className="mt-2 font-body text-sm text-danger">
                {problem}
              </p>
            )}
          </div>
        </Card>
      </BookShell>
    );
  }

  return (
    <BookShell>
      <Card>
        <p className="font-body text-sm break-words text-fg-2">{booking.hostName}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight break-words text-fg">{booking.title}</h1>
        <p className="mt-2 font-body text-sm text-fg">{whenLabel(booking, clock)}</p>
        {zone}
        {booking.cancelled ? (
          <p
            ref={cancelledMessage}
            role="status"
            tabIndex={-1}
            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 font-body text-sm text-fg focus-visible:outline-2 focus-visible:outline-accent"
          >
            <CalendarX className="size-4 shrink-0 text-fg-2" aria-hidden /> This booking is cancelled.
          </p>
        ) : (
          <p className="mt-5 inline-flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 font-body text-sm text-fg">
            <CalendarClock className="size-4 shrink-0 text-fg-2" aria-hidden /> This meeting took place on {dayLabel(booking.start, clock)}.
          </p>
        )}
        {booking.bookAgain && (
          <div className="mt-4">
            <a
              href={booking.bookAgain}
              className="inline-flex h-9 items-center gap-2 rounded-full bg-accent-container px-4 text-sm font-medium text-on-accent-container hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-sm:h-11"
            >
              <CalendarPlus className="size-4" aria-hidden /> Book another time
            </a>
          </div>
        )}
      </Card>
    </BookShell>
  );
}
