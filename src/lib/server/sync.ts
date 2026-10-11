import { ConfigError, buildConfig, configSource, configVersion, loadConfig, type AppConfig } from "./config";
import {
  bumpSessionVersion,
  busyBetween,
  getUser,
  listCalendars,
  listPeople,
  listUsers,
  markCalendarAttempt,
  setBusy,
  setCalendarError,
  setSyncError,
  setTokenError,
  syncCalendarList,
  type CalendarRow,
  type UserRow,
} from "./db";
import { seedDemo } from "./demo";
import { GoogleError, accessToken, eventBusy, freeBusy, listCalendars as googleCalendars } from "./google";
import { decrypt, googleConfigured, isDemo } from "./secrets";
import { DAY, addDays, dayKeyOf, dayStart } from "@/lib/time";
import { APP_VERSION } from "@/lib/version";
import type { AvailabilityResponse, CalendarStatus, ClientSettings, DataStatus, StatusResponse, Viewer } from "@/lib/types";

const CONCURRENCY = 3;
// Far enough back that the current month's grid is always covered.
const PAST_DAYS = 42;
const MANUAL_SYNC_COOLDOWN_MS = 30_000;
// Older than this, someone's busy times are no longer trusted to say they're free.
const STALE_AFTER_MS = 6 * 3_600_000;

type State = {
  config: AppConfig | null;
  configError: string | null;
  configVersion: string | null;
  running: Promise<void> | null;
  syncedAt: number | null;
  lastManual: number;
  /** Last "Refresh from Google" per person. */
  lastRefresh: Map<string, number>;
  timer: ReturnType<typeof setTimeout> | null;
  started: boolean;
};

// Route handlers and instrumentation are bundled separately, so module scope
// isn't shared between them; the process-wide global is.
const KEY = Symbol.for("ekip-takvim.sync");
const g = globalThis as typeof globalThis & { [KEY]?: State };
const state: State = (g[KEY] ??= {
  config: null,
  configError: null,
  configVersion: null,
  running: null,
  syncedAt: null,
  lastManual: 0,
  lastRefresh: new Map(),
  timer: null,
  started: false,
});

function log(level: "info" | "warn" | "error", msg: string, extra?: object) {
  const line = JSON.stringify({ level, msg, scope: "sync", ...extra });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

function refreshConfig(): void {
  const version = configVersion();
  if (version === state.configVersion && (state.config || state.configError)) return;
  state.configVersion = version;
  try {
    state.config = loadConfig();
    state.configError = null;
    log("info", "config loaded", { teams: state.config.teams.length });
  } catch (err) {
    state.configError = err instanceof ConfigError ? err.message : "Couldn't load config";
    log("error", "config error", { error: state.configError });
  }
}

/** Current config, or null if it doesn't load. */
export function getConfig(): AppConfig | null {
  refreshConfig();
  return state.config;
}

/** The date range calendars are read for. */
export function syncWindow(config: AppConfig): { from: Date; to: Date } {
  const today = dayKeyOf(Date.now(), config.timezone);
  const from = new Date(dayStart(addDays(today, -PAST_DAYS), config.timezone));
  const to = new Date(from.getTime() + (PAST_DAYS + config.horizonDays + 1) * DAY);
  return { from, to };
}

/**
 * Google said this person's access is gone (revoked, expired, account
 * suspended when someone leaves): they have to sign in again, so end their
 * sessions too.
 */
function accessLost(user: UserRow, message: string): void {
  // A sync that started before they signed in again still holds the old
  // token; its failure says nothing about the new one.
  if (getUser(user.id)?.refresh_token !== user.refresh_token) return;
  setTokenError(user.id, message);
  bumpSessionVersion(user.id);
  log("warn", "google access lost", { user: user.id, error: message });
}

/** Read one person's calendar list and the busy times of the calendars they count. */
async function syncUser(user: UserRow, config: AppConfig): Promise<void> {
  if (!user.refresh_token) return;
  let token: string;
  try {
    token = await accessToken(decrypt(user.refresh_token));
  } catch (err) {
    if (err instanceof GoogleError && err.signInAgain) {
      accessLost(user, err.message);
    } else {
      // Network trouble or a Google outage: try again next round, keep their data.
      const message = err instanceof GoogleError ? err.message : "Couldn't reach Google";
      setSyncError(user.id, `${message}; will retry`);
      log("warn", "token refresh failed", { user: user.id, error: message });
    }
    return;
  }
  if (user.token_error) setTokenError(user.id, null);
  if (!user.calendar_access) return;

  try {
    syncCalendarList(user.id, await googleCalendars(token));
    setSyncError(user.id, null);
  } catch (err) {
    // Keep going with the calendars already known; tell the person why the list is stale.
    const message = err instanceof GoogleError ? err.message : "Couldn't read your calendar list from Google";
    setSyncError(user.id, message);
    log("warn", "calendar list failed", { user: user.id, error: message });
    if (err instanceof GoogleError && err.signInAgain) {
      accessLost(user, err.message);
      return;
    }
  }

  const { from, to } = syncWindow(config);
  for (const cal of listCalendars(user.id).filter((c) => c.included)) {
    markCalendarAttempt(user.id, cal.calendar_id);
    try {
      const busy =
        cal.access === "freebusy"
          ? await freeBusy(token, cal.calendar_id, from, to)
          : await eventBusy(token, cal.calendar_id, from, to, user.timezone);
      setBusy(user.id, cal.calendar_id, busy);
    } catch (err) {
      const message = err instanceof GoogleError ? err.message : "Couldn't read the calendar";
      setCalendarError(user.id, cal.calendar_id, message);
      log("warn", "calendar failed", { user: user.id, label: cal.label, error: message });
    }
  }
}

async function runSync(): Promise<void> {
  refreshConfig();
  const config = state.config;
  if (!config) return;
  if (isDemo() || !googleConfigured()) {
    state.syncedAt = Date.now();
    return;
  }
  const queue = listUsers().filter((u) => u.refresh_token);
  const started = Date.now();
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let u = queue.shift(); u; u = queue.shift()) await syncUser(u, config);
    }),
  );
  state.syncedAt = Date.now();
  log("info", "sync finished", { people: listUsers().length, ms: Date.now() - started });
}

export function syncNow(): Promise<void> {
  state.running ??= runSync()
    .catch((err) => log("error", "sync crashed", { error: String(err) }))
    .finally(() => {
      state.running = null;
    });
  return state.running;
}

/** Sync one person right away, e.g. after they sign in or change their calendars. */
export async function syncOne(userId: string): Promise<void> {
  const config = getConfig();
  const user = getUser(userId);
  if (!config || !user || isDemo()) return;
  await syncUser(user, config).catch((err) => log("error", "user sync crashed", { user: userId, error: String(err) }));
}

function schedule(): void {
  const minutes = state.config?.refreshMinutes ?? 10;
  state.timer = setTimeout(async () => {
    await syncNow();
    schedule();
  }, minutes * 60_000);
  state.timer.unref?.();
}

/** Idempotent: safe to call from instrumentation and from every request. */
export function ensureStarted(): void {
  if (state.started) return;
  state.started = true;
  if (process.env.DEMO_MODE === "true" && !isDemo()) {
    log("error", "DEMO_MODE ignored: Google sign-in is configured, so this is a real deployment");
  }
  if (isDemo()) {
    refreshConfig();
    if (state.config && !seedDemo(state.config)) {
      log("error", "demo data not loaded: people have signed in to this database, so it was left as it is");
    }
  }
  if (googleConfigured() && !process.env.APP_URL) {
    log("warn", "APP_URL is not set: Google sends people back to whatever address the request came in on");
  }
  log("info", "starting", {
    version: APP_VERSION,
    config: configSource(),
    signIn: isDemo() ? "demo" : googleConfigured() ? "google" : "not set up (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET)",
    access: accessChecks(),
  });
  void syncNow().then(schedule);
}

/** Which of the app's own access checks are on, for the start-up log. */
function accessChecks(): string {
  const on = [
    process.env.CF_ACCESS_TEAM_DOMAIN || process.env.CF_ACCESS_AUD ? "Cloudflare Access" : null,
    process.env.BASIC_AUTH_USER || process.env.BASIC_AUTH_PASSWORD ? "basic auth" : null,
  ].filter(Boolean);
  return on.length ? on.join(", ") : "none: keep the app behind a VPN or an access proxy";
}

/** Manual refresh from the UI, rate limited so it can't hammer Google. */
export function requestSync(): { accepted: boolean; retryInMs: number } {
  const wait = state.lastManual + MANUAL_SYNC_COOLDOWN_MS - Date.now();
  if (wait > 0) return { accepted: false, retryInMs: wait };
  state.lastManual = Date.now();
  void syncNow();
  return { accepted: true, retryInMs: 0 };
}

/**
 * "Refresh from Google" on My settings, at most once every 30 s per person so
 * repeated clicks can't use up the Google quota. Earlier than that it's a
 * no-op: the last refresh is still current.
 */
export async function refreshMine(userId: string): Promise<void> {
  const now = Date.now();
  if (now - (state.lastRefresh.get(userId) ?? 0) < MANUAL_SYNC_COOLDOWN_MS) return;
  state.lastRefresh.set(userId, now);
  await syncOne(userId);
}

export async function waitForFirstSync(maxMs: number): Promise<void> {
  ensureStarted();
  if (state.syncedAt || !state.running) return;
  await Promise.race([state.running, new Promise((r) => setTimeout(r, maxMs))]);
}

export function getSettings(viewer: Viewer | null): ClientSettings {
  ensureStarted();
  refreshConfig();
  const signIn = isDemo() ? "demo" : googleConfigured() ? "google" : null;
  // With a broken config, render the defaults around the error message.
  const config = state.config ?? buildConfig({});
  return {
    timezone: config.timezone,
    displayHours: config.displayHours,
    weekStartsOn: config.weekStartsOn,
    workingHours: config.workingHours,
    timezones: config.timezones,
    teams: config.teams,
    people: state.config ? listPeople() : [],
    configError: state.configError,
    viewer,
    signIn,
  };
}

/** Whole calendar days in `tz` that the synced window fully covers. */
function coveredDays(window: { from: Date; to: Date }, tz: string): { from: string; to: string } {
  let from = dayKeyOf(window.from.getTime(), tz);
  if (dayStart(from, tz) < window.from.getTime()) from = addDays(from, 1);
  let to = dayKeyOf(window.to.getTime(), tz);
  if (dayStart(addDays(to, 1), tz) > window.to.getTime()) to = addDays(to, -1);
  return { from, to };
}

/**
 * Whether `viewerId` may see an event's title:
 * - their own events, on any of their calendars, always;
 * - other people's events on their company (primary) calendar, when signed
 *   in, unless the event is marked private;
 * - nothing else: other people's personal calendars only show their label.
 */
export function mayShowTitle(
  viewerId: string | null,
  ownerId: string,
  companyCalendar: boolean,
  isPrivate: boolean,
): boolean {
  if (!viewerId) return false;
  if (viewerId === ownerId) return true;
  return companyCalendar && !isPrivate;
}

/**
 * Whether someone's busy times can be trusted to tell when they're free.
 * Without that, an empty calendar would look like a free day.
 */
export function dataStatus(
  user: Pick<UserRow, "refresh_token" | "token_error" | "calendar_access">,
  counted: Pick<CalendarRow, "last_success" | "error">[],
  now: number,
  demo: boolean,
): DataStatus {
  if (user.token_error || (!demo && !user.refresh_token)) return "signInAgain";
  if (!user.calendar_access || counted.length === 0) return "noCalendars";
  const neverSynced = counted.filter((c) => c.last_success === null);
  if (neverSynced.some((c) => c.error !== null)) return "failing";
  if (neverSynced.length) return "syncing";
  const oldest = Math.min(...counted.map((c) => c.last_success!));
  if (!demo && now - oldest > STALE_AFTER_MS) return "failing";
  return "ok";
}

/** `start` and `days` are calendar days in `tz`, the viewer's zone. */
export function getAvailability(
  start: string,
  days: number,
  tz?: string,
  viewerId: string | null = null,
): AvailabilityResponse | null {
  const config = state.config;
  if (!config) return null;
  const zone = tz ?? config.timezone;
  const from = dayStart(start, zone);
  const to = dayStart(addDays(start, days), zone);
  const users = new Map(listUsers().map((u) => [u.id, u]));
  const included = listCalendars().filter((c) => c.included);
  const busy = busyBetween(from, to);
  const now = Date.now();
  const demo = isDemo();

  return {
    timezone: zone,
    start,
    days,
    syncedAt: state.syncedAt,
    coverage: coveredDays(syncWindow(config), zone),
    people: listPeople().map((p) => {
      const user = users.get(p.id)!;
      const own = included.filter((c) => c.user_id === p.id);
      const index = new Map(own.map((c, i) => [c.calendar_id, i]));
      return {
        ...p,
        data: dataStatus(user, own, now, demo),
        pending: own.some((c) => c.last_success === null && c.error === null) && !!user.refresh_token,
        stale: !!user.token_error || own.some((c) => c.error !== null),
        busy: busy
          .filter((b) => b.user_id === p.id && index.has(b.calendar_id))
          .map((b) => {
            const i = index.get(b.calendar_id)!;
            const showTitle = b.title && mayShowTitle(viewerId, p.id, !!own[i].is_primary, !!b.private);
            return {
              start: b.start_ms,
              end: b.end_ms,
              calendar: i,
              label: own[i].label,
              ...(showTitle ? { title: b.title!, ...(b.ref ? { ref: b.ref } : {}) } : {}),
              ...(b.tentative ? { tentative: true } : {}),
              ...(b.all_day ? { allDay: true } : {}),
            };
          }),
      };
    }),
  };
}

export function getStatus(): StatusResponse {
  const users = new Map(listUsers().map((u) => [u.id, u]));
  const calendars: CalendarStatus[] = listCalendars()
    .filter((c) => c.included && users.has(c.user_id))
    .map((c) => ({
      person: users.get(c.user_id)!.name,
      personId: c.user_id,
      label: c.label,
      access: c.access,
      state: c.error ? "error" : c.last_success ? "ok" : "pending",
      lastSuccess: c.last_success,
      lastAttempt: c.last_attempt,
      error: c.error,
      events: c.events,
    }));
  return {
    version: APP_VERSION,
    configError: state.configError,
    syncedAt: state.syncedAt,
    syncing: state.running !== null,
    calendars,
    signInAgain: [...users.values()]
      .filter((u) => u.token_error)
      .map((u) => ({ personId: u.id, person: u.name, error: u.token_error! })),
  };
}
