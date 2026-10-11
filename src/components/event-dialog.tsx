"use client";

import { ExternalLink, MapPin, Video, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { dayKeyOf, formatDay, formatRange } from "@/lib/time";
import type { EventInfo, Person, Zone } from "@/lib/types";
import { localRange } from "./timezone";
import { Avatar, IconButton } from "./ui";

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;

/** Plain text with its web addresses turned into links that open in a new tab. */
function Linkified({ text }: { text: string }) {
  return (
    <>
      {text.split(URL_RE).map((part, i) =>
        i % 2 === 1 ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-accent underline-offset-2 hover:underline"
          >
            {part}
          </a>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * Google links open in whichever account is first in the browser; `authuser`
 * picks the viewer's company account instead. Other links (Zoom, Teams) are left alone.
 */
export function withAuthuser(link: string, email: string | null): string {
  if (!email) return link;
  try {
    const url = new URL(link);
    if (!/(^|\.)(google\.com)$/.test(url.hostname)) return link;
    url.searchParams.set("authuser", email);
    return url.toString();
  } catch {
    return link;
  }
}

/** An event's details, opened from the day view by someone allowed to see its title. */
export function EventDialog({
  eventRef,
  tz,
  zones,
  people,
  viewerEmail,
  onClose,
}: {
  eventRef: string;
  tz: string;
  zones: Zone[];
  people: Person[];
  /** The signed-in viewer's address, for opening Google links in their account. */
  viewerEmail: string | null;
  onClose: () => void;
}) {
  const [event, setEvent] = useState<EventInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/events/${encodeURIComponent(eventRef)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? "This event changed or is no longer there." : "Couldn't load the event.");
        setEvent((await res.json()) as EventInfo);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Couldn't load the event.");
      });
    return () => controller.abort();
  }, [eventRef]);

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

  const person = event ? people.find((p) => p.id === event.personId) : undefined;
  const day = event ? dayKeyOf(event.start, tz) : null;
  const theirs = event && !event.allDay ? localRange([event.start, event.end], event.personTimezone, tz, zones) : null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-3 sm:p-6" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="event-title"
        className="pop relative flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-surface shadow-[var(--shadow-card)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-5 pt-4 pb-3">
          <div className="min-w-0 flex-1">
            {event ? (
              <>
                <h2 id="event-title" className="text-lg leading-snug font-semibold tracking-tight break-words text-fg">
                  {event.title}
                  {event.tentative && (
                    <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 align-middle font-body text-xs font-medium text-fg-2">
                      Tentative
                    </span>
                  )}
                </h2>
                <p className="mt-0.5 font-body text-sm text-fg-2">
                  {formatDay(day!, "long")} · {event.allDay ? "all day" : formatRange(event.start, event.end, tz)}
                  {theirs && <span className="text-fg-3"> ({theirs} for {event.person.split(" ")[0]})</span>}
                </p>
              </>
            ) : (
              <h2 id="event-title" className="text-lg font-semibold text-fg">
                {error ? "Event" : "Loading…"}
              </h2>
            )}
          </div>
          <IconButton ref={closeRef} size="sm" aria-label="Close" onClick={onClose} className="-mr-2">
            <X className="size-[18px]" />
          </IconButton>
        </div>

        <div className="scrollbar-thin flex flex-col gap-4 overflow-y-auto px-5 pb-5 font-body text-sm">
          {error && <p className="text-danger">{error}</p>}
          {!event && !error && <div className="shimmer h-24 rounded-xl bg-surface-2" />}
          {event && (
            <>
              <div className="flex items-center gap-2.5">
                <Avatar name={event.person} color={person?.color ?? ""} size={24} />
                <span className="text-fg">{event.person}</span>
                <span className="text-fg-3">· {event.label}</span>
              </div>

              {event.meetLink && (
                <a
                  href={withAuthuser(event.meetLink, viewerEmail)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-10 w-fit items-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-on-accent hover:brightness-110"
                >
                  <Video className="size-4" aria-hidden /> Join meeting
                </a>
              )}

              {event.location && (
                <div className="flex gap-2.5 text-fg-2">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-fg-3" aria-hidden />
                  <span className="min-w-0 break-words">
                    <Linkified text={event.location} />
                  </span>
                </div>
              )}

              {event.description && (
                <div className="rounded-xl bg-surface-2 px-4 py-3 break-words whitespace-pre-wrap text-fg-2">
                  <Linkified text={event.description} />
                </div>
              )}

              {!event.meetLink && !event.location && !event.description && (
                <p className="text-fg-3">No description, place or meeting link.</p>
              )}

              {event.htmlLink && (
                <a
                  href={withAuthuser(event.htmlLink, viewerEmail)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-accent hover:underline"
                >
                  <ExternalLink className="size-3.5" aria-hidden /> Open in Google Calendar
                </a>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
