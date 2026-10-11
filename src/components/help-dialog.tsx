"use client";

import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { IconButton, LogoMark } from "./ui";

const STEPS = [
  {
    title: "Tick who you care about",
    body: "The people list on the left decides what every view is about. Tick a team's “All” to add everyone in it.",
  },
  {
    title: "Green means everyone ticked is free",
    body: "Green bands and chips are times when none of their calendars has anything. Click one to open it on the day view.",
  },
  {
    title: "Check any time range",
    body: "On the day view, drag down the grid (or click a slot). A card shows who's free and who's busy, and at which job.",
  },
  {
    title: "Let it find the time",
    body: "“Find a time” lists every gap that fits everyone for the length you choose, plus slots that work for all but one person.",
  },
];

const KEYS: [string, string][] = [
  ["T", "Today"],
  ["D / W / M", "Day, week, month"],
  ["F", "Find a time"],
  ["O", "Show or hide off-hours"],
  ["J / K", "Next / previous"],
  ["Esc", "Clear selection"],
  ["?", "This help"],
];

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        className="pop relative max-h-full w-full max-w-lg overflow-y-auto rounded-2xl bg-surface p-6 shadow-[var(--shadow-card)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <LogoMark className="size-10 shrink-0" />
          <div className="min-w-0 flex-1">
            <h2 id="help-title" className="text-lg font-semibold tracking-tight text-fg">
              How Ekip Takvim works
            </h2>
            <p className="font-body text-sm text-fg-2">
              Someone is free when none of their calendars has an event at that time.
            </p>
          </div>
          <IconButton ref={close} size="sm" aria-label="Close" onClick={onClose} className="-mt-1 -mr-2">
            <X className="size-[18px]" />
          </IconButton>
        </div>

        <ol className="mt-5 flex flex-col gap-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-container text-xs font-semibold text-on-accent-container">
                {i + 1}
              </span>
              <div>
                <div className="text-sm font-semibold text-fg">{s.title}</div>
                <p className="font-body text-sm text-fg-2">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-5 rounded-xl bg-surface-2 px-4 py-3">
          <div className="mb-2 text-xs font-semibold tracking-wide text-fg-3 uppercase">Keyboard</div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-body text-sm">
            {KEYS.map(([k, v]) => (
              <div key={k} className="flex items-center gap-2">
                <dt>
                  <kbd className="rounded border border-grid-strong bg-surface px-1.5 py-px font-sans text-xs font-medium text-fg">
                    {k}
                  </kbd>
                </dt>
                <dd className="text-fg-2">{v}</dd>
              </div>
            ))}
          </dl>
        </div>

        <p className="mt-4 font-body text-xs text-fg-3">
          Only busy times and the job name each calendar was added with are shown. Event titles, notes and
          attendees never leave the server.
        </p>
      </div>
    </div>
  );
}
