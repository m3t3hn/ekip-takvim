"use client";

import { ChevronLeft, ChevronRight, CircleAlert, CircleHelp, LogIn, Menu, Monitor, Moon, Sun, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { searchWindows, workingIntervals, type DayFilter } from "@/lib/availability";
import { docsUrl } from "@/lib/links";
import {
  addDays,
  addMonths,
  dayKeyOf,
  formatTime,
  isDayKey,
  startOfWeek,
  zoneLabel,
  zonedTime,
} from "@/lib/time";
import type { ClientSettings, WorkingHours, Zone } from "@/lib/types";
import { DayView } from "./day-view";
import { HelpDialog } from "./help-dialog";
import { InviteDialog } from "./invite-dialog";
import { MonthView } from "./month-view";
import { useNow, useStatus } from "./hooks";
import { ScheduleView } from "./schedule-view";
import { Sidebar } from "./sidebar";
import { StatusView } from "./status-view";
import type { GridSelection } from "./time-grid";
import { ZoneClocks, useViewerZone, zonesFor } from "./timezone";
import { Avatar, Button, IconButton, LogoMark, Select, ToastProvider, cn, useNotify } from "./ui";
import type { AppState, ViewName } from "./view-props";
import { WeekView } from "./week-view";

const VIEWS: ViewName[] = ["day", "week", "month", "schedule", "status"];

const TABS: { id: ViewName; label: string; key: string }[] = [
  { id: "day", label: "Day", key: "D" },
  { id: "week", label: "Week", key: "W" },
  { id: "month", label: "Month", key: "M" },
];

function parseState(q: Record<string, string>, settings: ClientSettings, today: string): AppState {
  const int = (v: string | undefined, lo: number, hi: number, fallback: number) => {
    const n = Number(v);
    return v !== undefined && Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
  };
  const start = int(q.from, 0, 23, settings.displayHours.start);
  const end = int(q.to, 1, 24, settings.displayHours.end);
  const ids = new Set(settings.people.map((p) => p.id));
  const view = q.view === "find" ? "schedule" : q.view;
  return {
    view: VIEWS.includes(view as ViewName) ? (view as ViewName) : "day",
    date: isDayKey(q.date) ? q.date : today,
    people: q.people !== undefined ? q.people.split(",").filter((id) => ids.has(id)) : null,
    hours: end > start ? { start, end } : settings.displayHours,
    min: int(q.min, 15, 480, 60),
    duration: int(q.duration, 15, 480, 60),
    ahead: int(q.ahead, 1, 31, 14),
    dayFilter: ["all", "weekdays", "weekends"].includes(q.days) ? (q.days as DayFilter) : "all",
    offHours: q.offhours === "1",
  };
}

function serialiseState(s: AppState, settings: ClientSettings, today: string): string {
  const q = new URLSearchParams();
  if (s.view !== "day") q.set("view", s.view);
  if (s.date !== today) q.set("date", s.date);
  if (s.people) q.set("people", s.people.join(","));
  if (s.hours.start !== settings.displayHours.start) q.set("from", String(s.hours.start));
  if (s.hours.end !== settings.displayHours.end) q.set("to", String(s.hours.end));
  if (s.min !== 60) q.set("min", String(s.min));
  if (s.duration !== 60) q.set("duration", String(s.duration));
  if (s.ahead !== 14) q.set("ahead", String(s.ahead));
  if (s.dayFilter !== "all") q.set("days", s.dayFilter);
  if (s.offHours) q.set("offhours", "1");
  const qs = q.toString();
  return qs ? `?${qs}` : window.location.pathname;
}

function monthYear(key: string, opts: Intl.DateTimeFormatOptions) {
  const [y, m, d] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...opts }).format(Date.UTC(y, m - 1, d));
}

function title(state: AppState, weekStartsOn: 0 | 1, today: string): string {
  if (state.view === "status") return "Calendar status";
  if (state.view === "day") return monthYear(state.date, { day: "numeric", month: "long", year: "numeric" });
  if (state.view === "month") return monthYear(state.date, { month: "long", year: "numeric" });
  const start = state.view === "week" ? startOfWeek(state.date, weekStartsOn) : state.date < today ? today : state.date;
  const end = addDays(start, state.view === "week" ? 6 : state.ahead - 1);
  if (start.slice(0, 7) === end.slice(0, 7)) return monthYear(start, { month: "long", year: "numeric" });
  if (start.slice(0, 4) === end.slice(0, 4))
    return `${monthYear(start, { month: "short" })} – ${monthYear(end, { month: "short", year: "numeric" })}`;
  return `${monthYear(start, { month: "short", year: "numeric" })} – ${monthYear(end, { month: "short", year: "numeric" })}`;
}

function shortTitle(state: AppState, weekStartsOn: 0 | 1, today: string): string {
  if (state.view === "status") return "Status";
  if (state.view === "day") return monthYear(state.date, { day: "numeric", month: "short" });
  if (state.view === "month") return monthYear(state.date, { month: "short", year: "numeric" });
  const start = state.view === "week" ? startOfWeek(state.date, weekStartsOn) : state.date < today ? today : state.date;
  return monthYear(start, { month: "short", year: "numeric" });
}

export function App(props: {
  settings: ClientSettings;
  today: string;
  serverZone: string;
  serverNow: number;
  initialQuery: Record<string, string>;
}) {
  return (
    <ToastProvider>
      <Shell {...props} />
    </ToastProvider>
  );
}

function Shell({
  settings,
  today: serverToday,
  serverZone,
  serverNow,
  initialQuery,
}: {
  settings: ClientSettings;
  today: string;
  /** The zone the server rendered in (the viewer's from a cookie, or the team's). */
  serverZone: string;
  serverNow: number;
  initialQuery: Record<string, string>;
}) {
  const [state, setState] = useState(() => parseState(initialQuery, settings, serverToday));
  const [selection, setSelection] = useState<GridSelection | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [lastView, setLastView] = useState<ViewName>("day");
  const [help, setHelp] = useState(false);
  const [invite, setInvite] = useState<{ day: string; range: [number, number] } | null>(null);
  const status = useStatus();
  const now = useNow(serverNow);
  const notify = useNotify();
  const viewer = useViewerZone(serverZone);
  const tz = viewer.zone;
  const zones = useMemo(() => zonesFor(settings.timezones, viewer), [settings.timezones, viewer]);
  const today = dayKeyOf(now, tz);
  const wh = settings.workingHours;

  const windowsFor = useCallback(
    (day: string) => searchWindows(day, state.hours, tz, state.offHours ? null : wh),
    [state.hours, state.offHours, tz, wh],
  );
  const selectableFor = useCallback(
    (day: string) => (state.offHours ? null : workingIntervals(day, tz, wh)),
    [state.offHours, tz, wh],
  );

  useEffect(() => {
    window.history.replaceState(null, "", serialiseState(state, settings, serverToday));
  }, [state, settings, serverToday]);

  const update = useCallback((patch: Partial<AppState>) => {
    setState((s) => ({ ...s, ...patch }));
  }, []);

  const go = useCallback(
    (patch: Partial<AppState>) => {
      setSelection(null);
      if (patch.view && patch.view !== "status") setLastView(patch.view);
      update(patch);
    },
    [update],
  );

  const checkedIds = useMemo(
    () => state.people ?? settings.people.map((p) => p.id),
    [state.people, settings.people],
  );
  const checkedPeople = useMemo(() => {
    const set = new Set(checkedIds);
    return settings.people.filter((p) => set.has(p.id));
  }, [checkedIds, settings.people]);
  const stale = useMemo(
    () =>
      new Set([
        ...(status.data?.calendars.filter((f) => f.state === "error").map((f) => f.personId) ?? []),
        ...(status.data?.signInAgain.map((p) => p.personId) ?? []),
      ]),
    [status.data],
  );
  const failing =
    (status.data?.calendars.filter((f) => f.state === "error").length ?? 0) + (status.data?.signInAgain.length ?? 0);

  // Coming back from Google without signing in: say why, once.
  const signInResult = initialQuery.signin;
  useEffect(() => {
    const messages: Record<string, string> = {
      unavailable: "Google sign-in isn't set up on this server.",
      cancelled: "Sign-in cancelled.",
      expired: "That sign-in took too long or came from another tab. Try again.",
      domain: "Only company Google accounts can sign in.",
      failed: "Google sign-in didn't work. Try again.",
    };
    if (signInResult && messages[signInResult]) notify(messages[signInResult]);
  }, [signInResult, notify]);

  const shift = useCallback(
    (dir: -1 | 1) => {
      if (state.view === "month") {
        go({ date: addMonths(state.date, dir) });
        return;
      }
      const step = state.view === "week" ? 7 : state.view === "schedule" ? state.ahead : 1;
      const base = state.view === "schedule" && state.date < today ? today : state.date;
      go({ date: addDays(base, dir * step) });
    },
    [go, state.view, state.ahead, state.date, today],
  );

  const [syncing, setSyncing] = useState(false);
  const refresh = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      if (res.status === 429) {
        notify("Calendars were just refreshed. Try again in a few seconds.");
        return;
      }
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const s = await fetch("/api/status", { cache: "no-store" }).then((r) => r.json());
        if (!s.syncing) break;
      }
      setRefreshKey((k) => k + 1);
      status.reload();
      notify("Calendars refreshed");
    } catch {
      notify("Couldn't reach the server");
    } finally {
      setSyncing(false);
    }
  }, [notify, status]);

  // Calendar-style keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || el.closest("input, select, textarea, [role=dialog]")) return;
      const k = e.key.toLowerCase();
      if (e.key === "?") setHelp(true);
      else if (k === "escape") setSelection(null);
      else if (k === "t") go({ date: today });
      else if (k === "d" || k === "1") go({ view: "day" });
      else if (k === "w" || k === "2") go({ view: "week" });
      else if (k === "m" || k === "3") go({ view: "month" });
      else if (k === "f" || k === "a" || k === "4") go({ view: "schedule" });
      else if (k === "o") update({ offHours: !state.offHours });
      else if (k === "j" || k === "n") shift(1);
      else if (k === "k" || k === "p") shift(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, shift, today, update, state.offHours]);

  // Jump from a slot in another view to the day view with it selected.
  const openSlot = useCallback(
    (day: string, range: [number, number]) => {
      setLastView("day");
      update({ view: "day", date: day });
      setSelection({ day, range, column: null });
    },
    [update],
  );

  const viewProps = {
    settings,
    tz,
    zones,
    windowsFor,
    selectableFor,
    state,
    update,
    people: checkedPeople,
    refreshKey,
    now,
    selection,
    setSelection,
    onInvite: (day: string, range: [number, number]) => setInvite({ day, range }),
  };

  const sidebar = (
    <Sidebar
      people={settings.people}
      checked={checkedIds}
      onChecked={(ids) => update({ people: ids })}
      stale={stale}
      date={state.date}
      today={today}
      weekStartsOn={settings.weekStartsOn}
      onPickDate={(date) => {
        go({ date, view: state.view === "status" ? lastView : state.view });
        setDrawer(false);
      }}
      hours={state.hours}
      onHours={(hours) => update({ hours })}
      min={state.min}
      onMin={(min) => update({ min })}
      offHours={state.offHours}
      onOffHours={(offHours) => {
        setSelection(null);
        update({ offHours });
      }}
      workingHoursText={describeWorkingHours(wh, tz, today, zones)}
      now={now}
      zones={zones}
      clocks={<ZoneClocks zones={zones} viewer={viewer} now={now} />}
      onFind={() => {
        go({ view: "schedule" });
        setDrawer(false);
      }}
      footer={
        <div className="flex flex-col gap-1.5 font-body text-xs leading-relaxed text-fg-3">
          <div>
            <SyncLabel syncedAt={status.data?.syncedAt ?? null} now={now} />
            {" · "}
            <button
              type="button"
              className="font-medium text-accent hover:underline disabled:opacity-60"
              onClick={refresh}
              disabled={syncing}
            >
              {syncing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          <div>
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => setHelp(true)}>
              How it works
            </button>
            {" · "}
            <button
              type="button"
              className="font-medium text-accent hover:underline"
              onClick={() => {
                go({ view: "status" });
                setDrawer(false);
              }}
            >
              Calendar status
            </button>
          </div>
          <p>Only busy times and job labels are shown. What the events are never leaves the server.</p>
        </div>
      }
    />
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-16 shrink-0 items-center gap-1 px-2 sm:gap-2 sm:px-4">
        <IconButton
          aria-label="Main menu"
          onClick={() => {
            if (window.matchMedia("(min-width: 1024px)").matches) setCollapsed((c) => !c);
            else setDrawer((d) => !d);
          }}
        >
          <Menu className="size-5" />
        </IconButton>
        <div className="mr-2 hidden items-center gap-2.5 pl-1 md:flex lg:w-[200px]">
          <LogoMark className="size-9" />
          <span className="text-lg font-semibold tracking-tight whitespace-nowrap text-fg max-lg:hidden">
            Ekip <span className="font-normal text-fg-3">Takvim</span>
          </span>
        </div>
        {state.view !== "status" ? (
          <>
            <Button className="mr-2 max-sm:hidden" onClick={() => go({ date: today })} title="Today (T)">
              Today
            </Button>
            <button
              type="button"
              onClick={() => go({ date: today })}
              aria-label="Today"
              className="mr-1 grid size-8 place-items-center rounded-md border-2 border-fg-2 text-xs font-semibold text-fg-2 sm:hidden"
            >
              {Number(today.slice(8))}
            </button>
            <IconButton aria-label="Previous" title="Previous (K)" onClick={() => shift(-1)} className="max-sm:size-8">
              <ChevronLeft className="size-5" />
            </IconButton>
            <IconButton aria-label="Next" title="Next (J)" onClick={() => shift(1)} className="max-sm:size-8">
              <ChevronRight className="size-5" />
            </IconButton>
          </>
        ) : (
          <IconButton aria-label="Back to calendar" onClick={() => go({ view: lastView })}>
            <ChevronLeft className="size-5" />
          </IconButton>
        )}
        <h1 className="ml-1 min-w-0 truncate text-lg font-semibold tracking-tight text-fg sm:ml-3 sm:text-xl">
          <span className="max-sm:hidden">{title(state, settings.weekStartsOn, today)}</span>
          <span className="sm:hidden">{shortTitle(state, settings.weekStartsOn, today)}</span>
        </h1>

        <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
          {failing > 0 && (
            <button
              type="button"
              onClick={() => go({ view: "status" })}
              title={`${failing} ${failing === 1 ? "calendar problem" : "calendar problems"} — open Status`}
              className="mr-1 hidden h-8 items-center gap-1.5 rounded-full bg-danger-container px-3 text-xs font-medium text-danger hover:brightness-95 focus-visible:outline-2 focus-visible:outline-accent sm:flex"
            >
              <CircleAlert className="size-3.5" aria-hidden />
              {failing}
              <span className="max-xl:hidden">{failing === 1 ? "calendar problem" : "calendar problems"}</span>
            </button>
          )}
          <nav aria-label="Views" className="mr-1 hidden rounded-full bg-surface-2 p-1 lg:flex">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-current={state.view === t.id ? "page" : undefined}
                title={`${t.label} (${t.key})`}
                onClick={() => go({ view: t.id })}
                className={cn(
                  "h-8 rounded-full px-4 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-accent",
                  state.view === t.id
                    ? "bg-surface text-fg shadow-[var(--shadow-raised)]"
                    : "text-fg-2 hover:text-fg",
                )}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <Select
            aria-label="View"
            className="ml-1 max-sm:pr-7 max-sm:pl-3 max-sm:text-[13px] lg:hidden"
            value={state.view}
            onChange={(e) => go({ view: e.target.value as ViewName })}
          >
            {TABS.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
            {/* Reached from the sidebar's Find a time button; listed so the picker can show it. */}
            {state.view === "schedule" && <option value="schedule">Find a time</option>}
            <option value="status">Status</option>
          </Select>
          <IconButton
            aria-label="How it works"
            title="How it works (?)"
            className="max-sm:hidden"
            onClick={() => setHelp(true)}
          >
            <CircleHelp className="size-5" />
          </IconButton>
          <ThemeToggle />
          <Account settings={settings} />
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <aside
          className={cn("hidden w-64 shrink-0 lg:block", collapsed && "lg:hidden")}
          aria-label="Sidebar"
        >
          {sidebar}
        </aside>
        {drawer && (
          <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setDrawer(false)}>
            <div className="absolute inset-0 bg-black/30" />
            <aside
              className="absolute inset-y-0 left-0 w-72 bg-chrome pt-3 shadow-[var(--shadow-card)]"
              onClick={(e) => e.stopPropagation()}
              aria-label="Sidebar"
            >
              {sidebar}
            </aside>
          </div>
        )}

        <main
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface sm:mr-4 sm:mb-4 sm:ml-4 sm:rounded-3xl lg:ml-0",
            collapsed && "lg:ml-4",
          )}
        >
          {settings.configError ? (
            <ConfigProblem message={settings.configError} />
          ) : settings.people.length === 0 && state.view !== "status" ? (
            <Welcome signIn={settings.signIn} />
          ) : state.view === "day" ? (
            <DayView {...viewProps} />
          ) : state.view === "week" ? (
            <WeekView {...viewProps} openSlot={openSlot} />
          ) : state.view === "month" ? (
            <MonthView {...viewProps} openSlot={openSlot} />
          ) : state.view === "schedule" ? (
            <ScheduleView {...viewProps} openSlot={openSlot} />
          ) : (
            <StatusView status={status} now={now} onRefresh={refresh} syncing={syncing} />
          )}
        </main>
      </div>
      {help && <HelpDialog onClose={() => setHelp(false)} />}
      {invite && (
        <InviteDialog
          day={invite.day}
          range={invite.range}
          defaultMinutes={state.duration}
          people={checkedPeople}
          tz={tz}
          zones={zones}
          organiser={settings.viewer?.email ?? null}
          now={now}
          onClose={() => setInvite(null)}
        />
      )}
    </div>
  );
}

function SyncLabel({ syncedAt, now }: { syncedAt: number | null; now: number }) {
  if (!syncedAt) return <span>Syncing calendars…</span>;
  const mins = Math.max(0, Math.round((now - syncedAt) / 60_000));
  return <span>Synced {mins === 0 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`}</span>;
}

function Welcome({ signIn }: { signIn: ClientSettings["signIn"] }) {
  return (
    <div className="m-auto flex max-w-md flex-col items-center px-6 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-accent-container text-on-accent-container">
        <Users className="size-6" aria-hidden />
      </span>
      <h2 className="mt-4 text-lg font-semibold tracking-tight text-fg">No one has signed in yet</h2>
      <p className="mt-1 font-body text-sm text-fg-2">
        Everyone adds themselves: sign in with your company Google account, pick your team and the calendars that
        count as your busy time. Share your other calendars (other jobs, personal) with your company account first.
      </p>
      {signIn === "google" ? (
        <a
          href="/auth/google"
          className="mt-5 inline-flex h-10 items-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-on-accent hover:brightness-110"
        >
          <LogIn className="size-4" aria-hidden /> Sign in with Google
        </a>
      ) : (
        signIn === null && (
          <p className="mt-3 font-body text-xs text-fg-3">
            Google sign-in isn&apos;t set up on this server yet: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
            SESSION_SECRET and APP_URL. See{" "}
            <a href={docsUrl("google-setup.md")} target="_blank" rel="noreferrer" className="underline hover:text-fg-2">
              Google setup
            </a>
            .
          </p>
        )
      )}
    </div>
  );
}

function ConfigProblem({ message }: { message: string }) {
  return (
    <div className="m-6 flex max-w-2xl gap-3 rounded-2xl bg-danger-container p-5 font-body">
      <CircleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
      <div className="text-sm">
        <p className="font-sans text-base font-medium text-fg">The app isn&apos;t configured correctly</p>
        <p className="mt-1 text-fg-2">{message}</p>
        <p className="mt-3 text-fg-2">
          Fix the YAML file and reload — no restart needed. See{" "}
          <a href={docsUrl("configuration.md")} target="_blank" rel="noreferrer" className="underline">
            Configuration
          </a>
          .
        </p>
      </div>
    </div>
  );
}

type Theme = "system" | "light" | "dark";
const themeListeners = new Set<() => void>();

function readTheme(): Theme {
  try {
    const t = localStorage.getItem("theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function ThemeToggle() {
  const theme = useSyncExternalStore(
    (cb) => {
      themeListeners.add(cb);
      return () => themeListeners.delete(cb);
    },
    readTheme,
    () => "system" as Theme,
  );
  const next: Theme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  return (
    <IconButton
      className="max-sm:hidden"
      aria-label={`Theme: ${theme}. Switch to ${next}`}
      title={`Theme: ${theme}`}
      onClick={() => {
        try {
          if (next === "system") localStorage.removeItem("theme");
          else localStorage.setItem("theme", next);
        } catch {}
        if (next === "system") delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = next;
        themeListeners.forEach((l) => l());
      }}
    >
      <Icon className="size-5" />
    </IconButton>
  );
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "10:00–18:00 Türkiye time, Mon–Fri (08:00–16:00 your time)" */
function describeWorkingHours(wh: WorkingHours, tz: string, today: string, zones: Zone[]): string {
  const start = zonedTime(today, wh.start, wh.timezone);
  const end = zonedTime(today, wh.end, wh.timezone);
  const hours = `${formatTime(start, wh.timezone)}–${wh.end === 24 ? "24:00" : formatTime(end, wh.timezone)}`;
  const days = [...wh.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const contiguous = days.every((d, i) => i === 0 || d === (days[i - 1] + 1) % 7);
  const dayText =
    days.length === 7
      ? "every day"
      : contiguous && days.length > 2
        ? `${DAY_NAMES[days[0]]}–${DAY_NAMES[days[days.length - 1]]}`
        : days.map((d) => DAY_NAMES[d]).join(", ");
  const own = `${formatTime(start, tz)}–${formatTime(end, tz)}`;
  const mine = own !== hours ? ` (${own} your time)` : "";
  return `${hours} ${zoneLabel(wh.timezone, zones)} time, ${dayText}${mine}`;
}

/** Sign in (Google, or pick someone in the demo), or the signed-in person's settings. */
function Account({ settings }: { settings: ClientSettings }) {
  const viewer = settings.viewer;
  if (viewer) {
    const me = settings.people.find((p) => p.id === viewer.id);
    const fresh = viewer.newCalendars;
    const review = fresh ? ` — ${fresh} new ${fresh === 1 ? "calendar" : "calendars"} to review` : "";
    return (
      <a
        href="/settings"
        title={`${viewer.email} — my settings${review}`}
        aria-label={`${viewer.name}, my settings${review}`}
        className="ml-1 flex h-10 items-center gap-2 rounded-full pr-1 pl-1 hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent sm:pr-3"
      >
        <span className="relative">
          <Avatar name={viewer.name} color={me?.color ?? ""} size={32} />
          {fresh > 0 && (
            <span
              aria-hidden
              className="absolute -top-1 -right-1 grid min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold text-on-accent ring-2 ring-chrome"
            >
              {fresh}
            </span>
          )}
        </span>
        <span className="text-sm font-medium whitespace-nowrap text-fg max-sm:hidden">{viewer.name}</span>
        {fresh > 0 && (
          <span className="text-xs whitespace-nowrap text-accent max-lg:hidden">{fresh} new {fresh === 1 ? "calendar" : "calendars"}</span>
        )}
      </a>
    );
  }
  if (settings.signIn === "google") {
    return (
      <a
        href="/auth/google"
        className="ml-1 inline-flex h-9 items-center gap-2 rounded-full border border-grid-strong px-3.5 text-sm font-medium text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
        title="Sign in with your company Google account to add your calendars"
      >
        <LogIn className="size-4" aria-hidden />
        <span className="max-sm:hidden">Sign in</span>
      </a>
    );
  }
  if (settings.signIn === "demo") {
    return (
      <details className="relative ml-1">
        <summary
          className="inline-flex h-9 cursor-pointer list-none items-center gap-2 rounded-full border border-grid-strong px-3.5 text-sm font-medium text-fg hover:bg-hover"
          title="Demo: sign in as one of the made-up people"
        >
          <LogIn className="size-4" aria-hidden />
          <span className="max-sm:hidden">Sign in (demo)</span>
        </summary>
        <div className="absolute right-0 z-50 mt-2 w-56 rounded-2xl bg-surface p-2 shadow-[var(--shadow-card)]">
          <p className="px-3 pt-1 pb-2 font-body text-xs text-fg-3">No Google in the demo: pick who to be.</p>
          {settings.people.map((p) => (
            <a
              key={p.id}
              href={`/auth/demo?as=${encodeURIComponent(p.id)}`}
              className="flex h-9 items-center gap-2.5 rounded-full px-3 font-body text-sm text-fg hover:bg-hover"
            >
              <Avatar name={p.name} color={p.color} size={22} />
              {p.name}
            </a>
          ))}
        </div>
      </details>
    );
  }
  return null;
}
