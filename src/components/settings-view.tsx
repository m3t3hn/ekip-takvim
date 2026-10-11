"use client";

import { ArrowLeft, Check, CircleAlert, CircleCheck, CircleDashed, LogOut, Pipette, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PRESET_COLORS, colorStyle, normalizeColor } from "@/lib/colors";
import { offsetLabel } from "@/lib/time";
import type { MyCalendar, MySettings, Zone } from "@/lib/types";
import { useNow } from "./hooks";
import { Avatar, Button, Input, Select, cn } from "./ui";

function ago(ts: number | null, now: number): string {
  if (!ts) return "not yet";
  const m = Math.round((now - ts) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** The signed-in person's own page: team, zone, colour and which calendars count. */
export function SettingsView({
  initial,
  teams,
  zones,
  allZones,
  demo,
  serverNow,
}: {
  initial: MySettings;
  teams: string[];
  zones: Zone[];
  allZones: string[];
  demo: boolean;
  /** The server's clock when the page was rendered, so the first render matches. */
  serverNow: number;
}) {
  const router = useRouter();
  const now = useNow(serverNow);
  const [me, setMe] = useState(initial);
  const [team, setTeam] = useState(initial.team);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [color, setColor] = useState(initial.color);
  const [colorProblem, setColorProblem] = useState<string | null>(null);
  const [calendars, setCalendars] = useState<MyCalendar[]>(initial.calendars);
  const [busy, setBusy] = useState<"save" | "refresh" | "delete" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = (next: MySettings) => {
    setMe(next);
    // Keep unsaved label edits; take everything else (new calendars, sync state) from the server.
    setCalendars((prev) =>
      next.calendars.map((c) => {
        const mine = prev.find((p) => p.id === c.id);
        return mine ? { ...c, label: mine.label, included: mine.included } : c;
      }),
    );
  };

  const save = async () => {
    setBusy("save");
    setMessage(null);
    try {
      const res = await fetch("/api/me", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          team,
          timezone,
          color,
          calendars: calendars.map((c) => ({ id: c.id, label: c.label.trim(), included: c.included })),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Couldn't save");
      setMe(body);
      setCalendars(body.calendars);
      setMessage({ ok: true, text: "Saved. The calendar shows your changes now." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Couldn't save" });
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setBusy("refresh");
    setMessage(null);
    try {
      const res = await fetch("/api/me/sync", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Couldn't refresh");
      load(body);
      setMessage(
        body.syncError || body.tokenError
          ? { ok: false, text: "Google didn't return your calendars; see the note above." }
          : { ok: true, text: "Calendar list refreshed from Google." },
      );
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Couldn't refresh" });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("delete");
    const res = await fetch("/api/me", { method: "DELETE" });
    if (res.ok) {
      // Signed out now: render the calendar without them.
      router.replace("/");
      router.refresh();
    } else {
      setBusy(null);
      setMessage({ ok: false, text: "Couldn't remove you. Try again." });
    }
  };

  const patch = (id: string, change: Partial<MyCalendar>) =>
    setCalendars((list) => list.map((c) => (c.id === id ? { ...c, ...change } : c)));

  const configured = zones.map((z) => z.zone);

  return (
    <div className="scrollbar-thin h-full overflow-y-auto bg-chrome">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6 sm:px-6">
        <div className="flex items-center gap-2">
          <Link
            href="/"
            className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-fg-2 hover:bg-hover"
          >
            <ArrowLeft className="size-4" aria-hidden /> Calendar
          </Link>
          <h1 className="ml-1 text-xl font-semibold tracking-tight text-fg">My settings</h1>
          <form action="/auth/logout" method="post" className="ml-auto">
            <Button type="submit" variant="text">
              <LogOut className="size-4" aria-hidden /> Sign out
            </Button>
          </form>
        </div>

        <section className="flex items-center gap-4 rounded-2xl bg-surface p-5">
          <Avatar name={me.name} color={color} size={48} />
          <div className="min-w-0">
            <div className="truncate text-base font-semibold text-fg">{me.name}</div>
            <div className="truncate font-body text-sm text-fg-2">{me.email}</div>
            <div className="font-body text-xs text-fg-3">Invites to you go to this address.</div>
          </div>
        </section>

        {me.tokenError && (
          <Notice>
            Google access stopped working ({me.tokenError}). Your calendars show their last synced copy until you{" "}
            {demo ? "sign in again." : <a href="/auth/google" className="font-medium text-accent underline">sign in again</a>}
          </Notice>
        )}
        {me.syncError && !me.tokenError && (
          <Notice>Your calendars couldn&apos;t be read from Google: {me.syncError}.</Notice>
        )}
        {me.missingCalendarAccess && (
          <Notice>
            Calendar access wasn&apos;t allowed when you signed in, so nothing can be read.{" "}
            <a href="/auth/google" className="font-medium text-accent underline">Sign in again</a> and tick
            “See your calendars” on Google&apos;s screen.
          </Notice>
        )}

        <section className="grid gap-4 rounded-2xl bg-surface p-5 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-fg">Team</span>
            <Select className="w-full" value={team ?? ""} onChange={(e) => setTeam(e.target.value || null)}>
              <option value="">No team</option>
              {teams.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-fg">Where you are</span>
            <Select className="w-full" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              <optgroup label="Team zones">
                {zones.map((z) => (
                  <option key={z.zone} value={z.zone}>{`${z.label} — ${z.zone} (${offsetLabel(z.zone, now)})`}</option>
                ))}
              </optgroup>
              <optgroup label="All zones">
                {allZones
                  .filter((z) => !configured.includes(z))
                  .map((z) => (
                    <option key={z} value={z}>{z.replace(/_/g, " ")}</option>
                  ))}
              </optgroup>
            </Select>
            <span className="font-body text-xs text-fg-3">
              Others see your local time, and your all-day events cover whole days here.
            </span>
          </label>
          <ColorChoice
            color={color}
            taken={me.takenColors}
            problem={colorProblem}
            onPick={(next) => {
              const owner = me.takenColors.find((t) => t.color === normalizeColor(next));
              if (owner) {
                setColorProblem(`That colour is ${owner.name}'s. Pick another one.`);
                return;
              }
              setColorProblem(null);
              setColor(normalizeColor(next));
            }}
          />
        </section>

        <section className="rounded-2xl bg-surface p-5">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-fg">Calendars that count as your busy time</h2>
              <p className="mt-1 font-body text-xs text-fg-2">
                Tick your company calendar and the ones you shared with this account from your other jobs or personal
                accounts. Leave colleagues&apos; calendars and holidays unticked. You see all your own event titles.
                Signed-in colleagues see the titles on your company calendar, except events marked private; for your
                other calendars they only see the label.
              </p>
            </div>
            <Button
              variant="tonal"
              onClick={refresh}
              disabled={busy !== null || demo}
              title={demo ? "Not in the demo: there's no Google to ask" : "Pick up calendars shared with you since"}
            >
              <RefreshCw className={cn("size-4", busy === "refresh" && "animate-spin")} aria-hidden />
              Refresh from Google
            </Button>
          </div>

          {calendars.some((c) => c.isNew) && (
            <p className="mt-3 rounded-xl bg-accent-container px-4 py-2.5 font-body text-sm text-on-accent-container">
              {calendars.filter((c) => c.isNew).length === 1 ? "A calendar was" : `${calendars.filter((c) => c.isNew).length} calendars were`}{" "}
              shared with you since you last saved. Tick the ones that count as busy time, then Save; until then they
              don&apos;t count.
            </p>
          )}

          <ul className="mt-4 divide-y divide-grid rounded-xl border border-grid">
            {calendars.length === 0 && (
              <li className="px-4 py-6 text-center font-body text-sm text-fg-3">No calendars yet. Try “Refresh from Google”.</li>
            )}
            {calendars.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <input
                  type="checkbox"
                  checked={c.included}
                  onChange={(e) => patch(c.id, { included: e.target.checked })}
                  aria-label={`Count ${c.summary}`}
                  className="size-4 accent-[var(--accent)]"
                />
                <div className="min-w-0 flex-1 basis-48">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-body text-sm text-fg">{c.summary}</span>
                    {c.isNew && (
                      <span className="rounded-full bg-accent px-2 py-px font-body text-[11px] font-medium text-on-accent">New</span>
                    )}
                    {c.primary && <Badge>Company</Badge>}
                    {c.access === "freebusy" && <Badge title="Shared as “See only free/busy”: busy times only, no tentative or all-day marks">Free/busy only</Badge>}
                  </div>
                  {c.included && (
                    <div className="mt-0.5 font-body text-xs">
                      {c.state === "error" ? (
                        <span className="inline-flex items-center gap-1 text-danger">
                          <CircleAlert className="size-3.5" aria-hidden /> {c.error}
                        </span>
                      ) : c.state === "ok" ? (
                        <span className="inline-flex items-center gap-1 text-on-free">
                          <CircleCheck className="size-3.5" aria-hidden /> Synced {ago(c.lastSuccess, now)}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-fg-3">
                          <CircleDashed className="size-3.5" aria-hidden /> Syncs after you save
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <Input
                  aria-label={`Label for ${c.summary}`}
                  className={cn("h-8 w-full sm:w-44", c.included && !c.label.trim() && "border-danger")}
                  value={c.label}
                  maxLength={40}
                  disabled={!c.included}
                  placeholder="Label, e.g. Agency"
                  onChange={(e) => patch(c.id, { label: e.target.value })}
                />
              </li>
            ))}
          </ul>

          <details className="mt-4 font-body text-xs text-fg-2">
            <summary className="cursor-pointer font-medium text-fg">How do I add a calendar from another account?</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>Open Google Calendar with that account → Settings → pick the calendar → “Share with specific people”.</li>
              <li>Add {me.email}. “See only free/busy” is enough; “See all event details” also marks tentative and all-day events.</li>
              <li>Come back here, press “Refresh from Google”, tick it and give it a label.</li>
            </ol>
          </details>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={save} disabled={busy !== null}>
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
          {message && (
            <span role="status" className={cn("font-body text-sm", message.ok ? "text-on-free" : "text-danger")}>
              {message.text}
            </span>
          )}
        </div>

        <section className="mt-4 rounded-2xl border border-danger/30 p-5">
          <h2 className="text-sm font-semibold text-fg">Remove me</h2>
          <p className="mt-1 font-body text-xs text-fg-2">
            Takes you off the calendar, deletes your calendars and busy times here, and gives Google access back. You
            can sign in again any time.
          </p>
          {confirmDelete ? (
            <div className="mt-3 flex gap-2">
              <Button variant="danger" onClick={remove} disabled={busy !== null}>
                {busy === "delete" ? "Removing…" : "Yes, remove me"}
              </Button>
              <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </div>
          ) : (
            <Button variant="danger" className="mt-3" onClick={() => setConfirmDelete(true)}>
              Remove me
            </Button>
          )}
        </section>
      </div>
    </div>
  );
}

/** Suggested colours (taken ones can't be picked) plus a picker for any other colour. */
function ColorChoice({
  color,
  taken,
  problem,
  onPick,
}: {
  color: string;
  taken: { color: string; name: string }[];
  problem: string | null;
  onPick: (hex: string) => void;
}) {
  const owner = (hex: string) => taken.find((t) => t.color === hex)?.name;
  const allTaken = PRESET_COLORS.every((c) => owner(c.hex) && c.hex !== color);
  const custom = !PRESET_COLORS.some((c) => c.hex === color);
  return (
    <div className="flex flex-col gap-1.5 sm:col-span-2">
      <span className="text-sm font-semibold text-fg">Colour</span>
      <div className="flex flex-wrap items-center gap-2">
        {PRESET_COLORS.map((c) => {
          const by = owner(c.hex);
          const selected = color === c.hex;
          return (
            <button
              key={c.hex}
              type="button"
              aria-label={by ? `${c.name}, taken by ${by}` : c.name}
              aria-pressed={selected}
              disabled={!!by}
              title={by ? `Taken by ${by}` : c.name}
              onClick={() => onPick(c.hex)}
              style={colorStyle(c.hex)}
              className={cn(
                "swatch relative grid size-7 place-items-center rounded-full ring-offset-2 ring-offset-surface focus-visible:outline-2 focus-visible:outline-accent",
                selected && "ring-2 ring-fg",
                by && "cursor-not-allowed opacity-25",
              )}
            >
              {selected && <Check className="size-4 text-[var(--pc-on)]" strokeWidth={3} aria-hidden />}
              {by && <span aria-hidden className="absolute h-0.5 w-8 rotate-45 rounded bg-fg" />}
            </button>
          );
        })}
        <label
          title="Pick any colour"
          className={cn(
            "relative ml-1 inline-flex h-8 cursor-pointer items-center gap-2 rounded-full border border-grid-strong pr-3 pl-1 font-body text-sm text-fg-2 hover:bg-hover",
            "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
            custom && "ring-2 ring-fg ring-offset-2 ring-offset-surface",
          )}
        >
          <span className="swatch grid size-6 place-items-center rounded-full" style={colorStyle(color)}>
            <Pipette className="size-3.5 text-[var(--pc-on)]" aria-hidden />
          </span>
          {custom ? color : "Custom"}
          <input
            type="color"
            value={color}
            onChange={(e) => onPick(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-label="Pick any colour"
          />
        </label>
      </div>
      {problem ? (
        <span role="alert" className="font-body text-xs text-danger">{problem}</span>
      ) : allTaken ? (
        <span className="font-body text-xs text-fg-2">Every suggested colour is taken, so pick your own with Custom.</span>
      ) : (
        <span className="font-body text-xs text-fg-3">Everyone has their own colour: crossed-out ones are taken.</span>
      )}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3 rounded-2xl bg-danger-container p-4 font-body text-sm text-fg">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

function Badge({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className="rounded-full bg-surface-2 px-2 py-px font-body text-[11px] font-medium text-fg-2">
      {children}
    </span>
  );
}
