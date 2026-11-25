import { LinkError, fetchCalendar } from "./calendar-link";
import { ConfigError, buildConfig, configSource, configVersion, loadConfig, type AppConfig } from "./config";
import {
  bumpSessionVersion,
  busyBetween,
  countsAsBusy,
  getUser,
  linkOf,
  linkRequested,
  listCalendars,
  listPeople,
  listUsers,
  markCalendarAttempt,
  markLinkRequested,
  setBusy,
  setCalendarError,
  setLinkUnchanged,
  setLinkVersion,
  setSyncError,
  setTokenError,
  syncCalendarList,
  type CalendarRow,
  type UserRow,
} from "./db";
import { seedDemo } from "./demo";
import { exposureProblem, exposureSetting } from "./exposure";
import { GoogleError, accessToken, dropAccessToken, eventBusy, freeBusy, listCalendars as googleCalendars, type Busy } from "./google";
import { icsBusy } from "./ics";
import { linksAllowed, linksCheck, linksSetting, privateLinksAllowed } from "./link-setting";
import { decrypt, googleConfigured, isDemo } from "./secrets";
import { DAY, addDays, dayKeyOf, dayStart } from "@/lib/time";
import { APP_VERSION } from "@/lib/version";
import type {
  AvailabilityResponse,
  CalendarKind,
  CalendarStatus,
  ClientSettings,
  DataStatus,
  StatusResponse,
  Viewer,
} from "@/lib/types";

const CONCURRENCY = 3;
// Far enough back that the current month's grid is always covered.
const PAST_DAYS = 42;
const MANUAL_SYNC_COOLDOWN_MS = 30_000;
// Older than this, someone's busy times are no longer trusted to say they're free.
const STALE_AFTER_MS = 6 * 3_600_000;
// A calendar link answered "not modified" keeps the blocks of its last full
// read, which cover that read's sync window: it's read in full once the window
// moves (a new day, another horizon_days or team zone), and at least once a day.
const FULL_READ_EVERY_MS = DAY;
// Calendar links are other people's servers (Outlook, iCloud and others), and
// some throttle. While rounds come more often than this, a round leaves a link
// alone for this long after any request to it: adding it, a round, or its
// owner's own sync, whatever came of it.
const LINK_FLOOR_MS = 10 * 60_000;
// Someone whose refresh token Google refused is marked to sign in again. Rounds
// still ask for them now and then, so access that comes back (an account
// restored) is noticed. While rounds come more often than this, a round leaves
// them alone for this long after Google refused.
const REFUSED_FLOOR_MS = 10 * 60_000;

type State = {
  config: AppConfig | null;
  configError: string | null;
  configVersion: string | null;
  running: Promise<void> | null;
  syncedAt: number | null;
  lastManual: number;
  /** Last "Refresh from Google" per person. */
  lastRefresh: Map<string, number>;
  /** When Google last refused each person's refresh token, and which one: as stored, encrypted. */
  refused: Map<string, { sealed: string | null; at: number }>;
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
  refused: new Map(),
  timer: null,
  started: false,
});
// After `next dev` reloads this file, the state may be one an older version made, without this.
state.refused ??= new Map();

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
    const config = loadConfig();
    // An exposed app that any Google account could sign in to, or that sends
    // its session cookie over plain http, doesn't serve anything.
    const problem =
      exposureSetting() === "exposed" && !isDemo() ? exposureProblem(config.googleDomain, process.env.APP_URL) : null;
    if (problem) throw new ConfigError(problem);
    state.config = config;
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
 * A sync that started before they signed in again still holds their old
 * refresh token: its failures say nothing about the new one.
 */
const signedInAgain = (user: UserRow) => getUser(user.id)?.refresh_token !== user.refresh_token;

/**
 * Google refused this person's refresh token (revoked, expired, account
 * suspended when someone leaves): they have to sign in again, so end their
 * sessions too, unless they're marked already. Rounds then leave them alone a
 * while (see refusedLately).
 */
function refreshTokenRefused(user: UserRow, message: string): void {
  if (signedInAgain(user)) return;
  state.refused.set(user.id, { sealed: user.refresh_token, at: Date.now() });
  // Marked already: their sessions ended then.
  if (getUser(user.id)?.token_error) return;
  setTokenError(user.id, message);
  bumpSessionVersion(user.id);
  log("warn", "google access lost", { user: user.id, error: message });
}

/**
 * Whether a round leaves this person alone: rounds come more often than
 * REFUSED_FLOOR_MS, they're marked, and Google refused the refresh token they
 * still have less than that ago. A refusal recorded later than now means the
 * clock was set back since, so it isn't recent.
 */
function refusedLately(user: UserRow, config: AppConfig): boolean {
  const refused = state.refused.get(user.id);
  const now = Date.now();
  return (
    config.refreshMinutes * 60_000 < REFUSED_FLOOR_MS &&
    !!user.token_error &&
    refused !== undefined &&
    refused.sealed === user.refresh_token &&
    refused.at <= now &&
    now - refused.at < REFUSED_FLOOR_MS
  );
}

/**
 * A Google request for this person answered 401 (`message`). Access tokens
 * are used again (see accessToken), so that can mean only that theirs went
 * stale: it's dropped and a new one asked for, which their later requests use.
 * Only Google refusing their refresh token means they have to sign in again.
 * Returns the new token, or null: Google refused or couldn't be asked, or they
 * signed in again since this request's sync started. Never throws.
 */
async function accessLost(user: UserRow, message: string): Promise<string | null> {
  if (!user.refresh_token || signedInAgain(user)) return null;
  try {
    const refreshToken = decrypt(user.refresh_token);
    dropAccessToken(refreshToken);
    return await accessToken(refreshToken);
  } catch (err) {
    if (err instanceof GoogleError && err.signInAgain) refreshTokenRefused(user, message);
    else log("warn", "token refresh failed", { user: user.id, error: err instanceof GoogleError ? err.message : "Couldn't reach Google" });
    return null;
  }
}

/** Read one person's calendar list from Google and the busy times of the Google calendars they count. */
async function syncUser(user: UserRow, config: AppConfig): Promise<void> {
  if (!user.refresh_token) return;
  let refreshToken: string;
  let token: string;
  try {
    refreshToken = decrypt(user.refresh_token);
    token = await accessToken(refreshToken);
  } catch (err) {
    if (err instanceof GoogleError && err.signInAgain) {
      // Google refused the refresh token itself: asking again would get the same answer.
      refreshTokenRefused(user, err.message);
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

  const turnedDown = await readGoogle(user, config, token);
  if (!turnedDown) return;
  // Their token may only have gone stale: with a new one they're read again, once.
  const renewed = await accessLost(user, turnedDown.message);
  if (!renewed) return;
  // Google turned the new one down too: it isn't used again either, and the next round asks for another.
  if (await readGoogle(user, config, renewed)) dropAccessToken(refreshToken, renewed);
}

/**
 * Read someone's calendar list and the Google calendars they count, with
 * `token`. A request that answers 401 stops it, and its error is returned.
 */
async function readGoogle(user: UserRow, config: AppConfig, token: string): Promise<GoogleError | null> {
  try {
    syncCalendarList(user.id, await googleCalendars(token));
    setSyncError(user.id, null);
  } catch (err) {
    // Keep going with the calendars already known; tell the person why the list is stale.
    const message = err instanceof GoogleError ? err.message : "Couldn't read your calendar list from Google";
    setSyncError(user.id, message);
    log("warn", "calendar list failed", { user: user.id, error: message });
    if (err instanceof GoogleError && err.signInAgain) return err;
  }

  const { from, to } = syncWindow(config);
  for (const cal of listCalendars(user.id).filter((c) => c.included && c.kind === "google")) {
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
      if (err instanceof GoogleError && err.signInAgain) return err;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Calendar links, read apart from Google: whatever the state of the person's
// Google access, and in a queue of their own, so a slow link holds up no one's
// Google calendars. A link's path and query are its secret, so no message,
// stored error or log line holds anything of it; the log names the calendar by
// its label.

/**
 * What to tell someone about a calendar link that couldn't be read, nothing of
 * the link itself: while they add it, or stored on its calendar when a later
 * read fails. A calendar can't take a new link, so there a reset link is
 * removed and the new one added.
 */
export function linkProblem(error: unknown, when: "adding" | "stored" = "adding"): string {
  if (error instanceof LinkError) {
    switch (error.reason) {
      case "invalid":
        return "That doesn't look like a calendar link.";
      case "blocked":
        return "That link points to a private network address, which this server doesn't allow.";
      case "unreachable":
        return "Couldn't reach that address.";
      case "timeout":
        return "The calendar took too long to answer.";
      case "tooLarge":
        return "That calendar is too big.";
      case "tooManyRedirects":
        return "That link redirects too many times.";
      case "http":
        if (error.status === 401 || error.status === 403 || error.status === 404) {
          return when === "stored"
            ? "The link didn't work. It may have been reset: remove this calendar and add the new link."
            : "The link didn't work. It may have been reset; copy it again.";
        }
        return `The calendar's server answered ${error.status ?? "with an error"}.`;
      case "notCalendar":
        return "That address didn't return a calendar.";
    }
  }
  // An IcsError, or anything else.
  return "Couldn't read that calendar.";
}

const LINK_UNREADABLE = "This server's secret changed, so the stored link can't be read. Remove this calendar and add its link again.";

/** What a calendar link's server said about the version last read in full. */
type LinkVersion = { etag: string | null; lastModified: string | null };

/** A calendar link read in full: its busy blocks over the sync window, that window, and its version. */
export type LinkRead = LinkVersion & { busy: Busy[]; window: { from: Date; to: Date } };

/**
 * Read a calendar link: its events become busy blocks over the sync window as
 * of the answer, times without a zone and all-day events read in `timezone`.
 * Given the version last read in full, it's null when the server says nothing
 * changed. Throws a LinkError, an IcsError or whatever else went wrong.
 */
export function readLink(link: string, timezone: string, config: AppConfig): Promise<LinkRead>;
export function readLink(link: string, timezone: string, config: AppConfig, since: LinkVersion): Promise<LinkRead | null>;
export async function readLink(link: string, timezone: string, config: AppConfig, since?: LinkVersion): Promise<LinkRead | null> {
  const reply = await fetchCalendar(link, {
    allowPrivate: privateLinksAllowed(),
    etag: since?.etag,
    lastModified: since?.lastModified,
  });
  if (reply.notModified) return null;
  const { from, to } = syncWindow(config);
  return {
    busy: icsBusy(reply.text, { from, to, timezone }).busy,
    window: { from, to },
    etag: reply.etag,
    lastModified: reply.lastModified,
  };
}

/** Store a calendar link read in full: its blocks first, so a version is never kept without them. */
export function storeLinkRead(userId: string, calendarId: string, read: LinkRead): void {
  setBusy(userId, calendarId, read.busy);
  setLinkVersion(userId, calendarId, read);
}

/**
 * Whether a round may ask for a calendar link last asked for at `requested`
 * (null: never). A time later than now means the clock was set back since, so
 * the link is due; reading it sets the time to now.
 */
const linkDue = (requested: number | null) => {
  const now = Date.now();
  return requested === null || requested > now || now - requested >= LINK_FLOOR_MS;
};

/**
 * Read one calendar link and store what it says. A failure is recorded on the
 * calendar, which keeps its blocks. With `floor`, a round's, a link asked for
 * less than LINK_FLOOR_MS ago is left alone.
 */
async function syncLink(user: UserRow, cal: CalendarRow, config: AppConfig, floor = false): Promise<void> {
  let problem: string;
  try {
    // Its owner's own sync may have asked for it since the round started.
    if (floor && !linkDue(linkRequested(user.id, cal.calendar_id))) return;
    let link: string | null;
    try {
      link = linkOf(user.id, cal.calendar_id);
    } catch {
      setCalendarError(user.id, cal.calendar_id, LINK_UNREADABLE);
      log("warn", "calendar link can't be decrypted", { user: user.id, label: cal.label });
      return;
    }
    // Removed since this sync started.
    if (!link) return;
    markCalendarAttempt(user.id, cal.calendar_id);
    markLinkRequested(user.id, cal.calendar_id);
    // "Changed since?" only while the last full read is less than a day old and
    // was made for the window as it is now: a window that moved has days its
    // blocks don't cover.
    const { from, to } = syncWindow(config);
    const conditional =
      cal.link_full_read !== null &&
      Date.now() - cal.link_full_read < FULL_READ_EVERY_MS &&
      cal.link_window_from === from.getTime() &&
      cal.link_window_to === to.getTime();
    const read = conditional
      ? await readLink(link, user.timezone, config, { etag: cal.link_etag, lastModified: cal.link_last_modified })
      : await readLink(link, user.timezone, config);
    if (read) storeLinkRead(user.id, cal.calendar_id, read);
    else setLinkUnchanged(user.id, cal.calendar_id);
    return;
  } catch (err) {
    problem = linkProblem(err, "stored");
  }
  log("warn", "calendar link failed", { user: user.id, label: cal.label, error: problem });
  setCalendarError(user.id, cal.calendar_id, problem);
}

/** syncLink, with anything it throws (the database) logged instead. */
function syncLinkLogged(user: UserRow, cal: CalendarRow, config: AppConfig, floor = false): Promise<void> {
  return syncLink(user, cal, config, floor).catch((err) =>
    log("error", "calendar link sync crashed", { user: user.id, label: cal.label, error: String(err) }),
  );
}

/** Someone's calendar links that count, or everyone's: none while this server doesn't take links. */
function countedLinks(userId?: string): CalendarRow[] {
  return linksAllowed() ? listCalendars(userId).filter((c) => c.kind === "link" && c.included) : [];
}

/** `work` on every item, CONCURRENCY at a time. */
async function inTurn<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) await work(item);
    }),
  );
}

async function runSync(): Promise<void> {
  refreshConfig();
  const config = state.config;
  if (!config) return;
  if (isDemo() || !googleConfigured()) {
    state.syncedAt = Date.now();
    return;
  }
  const users = listUsers();
  const owners = new Map(users.map((u) => [u.id, u]));
  // While rounds come more often than LINK_FLOOR_MS, a link asked for less than that ago waits.
  const floor = config.refreshMinutes * 60_000 < LINK_FLOOR_MS;
  const links = countedLinks().filter((c) => owners.has(c.user_id) && (!floor || linkDue(c.link_requested)));
  const started = Date.now();
  // A queue each, so slow calendar links and slow Google calls don't wait on each other.
  await Promise.all([
    inTurn(users.filter((u) => u.refresh_token && !refusedLately(u, config)), (u) => syncUser(u, config)),
    inTurn(links, (cal) => syncLinkLogged(owners.get(cal.user_id)!, cal, config, floor)),
  ]);
  state.syncedAt = Date.now();
  log("info", "sync finished", { people: listUsers().length, links: links.length, ms: Date.now() - started });
}

export function syncNow(): Promise<void> {
  state.running ??= runSync()
    .catch((err) => log("error", "sync crashed", { error: String(err) }))
    .finally(() => {
      state.running = null;
    });
  return state.running;
}

/**
 * Sync one person right away, e.g. after they sign in or change their
 * calendars. Their calendar links are read beside Google (all at once: there
 * are at most 10), whatever the state of their Google access and however
 * recently they were read: LINK_FLOOR_MS is for rounds. The demo has no
 * Google, so there it's only the links.
 */
export async function syncOne(userId: string): Promise<void> {
  const config = getConfig();
  const user = getUser(userId);
  if (!config || !user) return;
  await Promise.all([
    isDemo() ? null : syncUser(user, config).catch((err) => log("error", "user sync crashed", { user: userId, error: String(err) })),
    ...countedLinks(user.id).map((cal) => syncLinkLogged(user, cal, config)),
  ]);
}

function schedule(): void {
  const minutes = state.config?.refreshMinutes ?? 1;
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
  if (linksSetting() === "invalid") {
    log("error", "CALENDAR_LINKS must be on, private or off: calendar links are off until it is");
  }
  log("info", "starting", {
    version: APP_VERSION,
    config: configSource(),
    signIn: isDemo() ? "demo" : googleConfigured() ? "google" : "not set up (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET)",
    access: accessChecks(),
    exposure: exposureSetting(),
  });
  void syncNow().then(schedule);
}

/** Which of the app's own access checks are on, and where calendar links may go, for the start-up log. */
function accessChecks(): string {
  const on = [
    process.env.CF_ACCESS_TEAM_DOMAIN || process.env.CF_ACCESS_AUD ? "Cloudflare Access" : null,
    process.env.BASIC_AUTH_USER || process.env.BASIC_AUTH_PASSWORD ? "basic auth" : null,
    exposureSetting() === "exposed" ? "sign-in for everything (EXPOSURE=exposed)" : null,
  ].filter(Boolean);
  return `${on.length ? on.join(", ") : "none: keep the app behind a VPN or an access proxy"}; ${linksCheck()}`;
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

type DataUser = Pick<UserRow, "refresh_token" | "token_error" | "calendar_access">;
/** A calendar without a kind is a Google one. */
type DataCalendar = Pick<CalendarRow, "last_success" | "error"> & { kind?: CalendarKind };

/**
 * Of someone's ticked calendars, the ones their data rests on: Google ones
 * only when they granted calendar access, calendar links while this server
 * takes links.
 */
function counted<T extends DataCalendar>(user: DataUser, included: T[]): { google: T[]; links: T[] } {
  return {
    google: user.calendar_access ? included.filter((c) => c.kind !== "link") : [],
    links: linksAllowed() ? included.filter((c) => c.kind === "link") : [],
  };
}

/** Their Google access is gone: Google said so, or there's no refresh token (outside the demo). */
const googleGone = (user: DataUser, demo: boolean) => !!user.token_error || (!demo && !user.refresh_token);

/**
 * Whether someone's busy times can be trusted to tell when they're free.
 * Without that, an empty calendar would look like a free day. `included` are
 * their ticked calendars. Their Google access only matters while a Google
 * calendar counts: someone counting only calendar links is judged on those.
 */
export function dataStatus(user: DataUser, included: DataCalendar[], now: number, demo: boolean): DataStatus {
  const { google, links } = counted(user, included);
  if (google.length && googleGone(user, demo)) return "signInAgain";
  const all = [...google, ...links];
  if (all.length === 0) return "noCalendars";
  const neverSynced = all.filter((c) => c.last_success === null);
  if (neverSynced.some((c) => c.error !== null)) return "failing";
  if (neverSynced.length) return "syncing";
  const oldest = Math.min(...all.map((c) => c.last_success!));
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
  const included = listCalendars().filter(countsAsBusy);
  const busy = busyBetween(from, to);
  const now = Date.now();
  const demo = isDemo();
  const waiting = (c: CalendarRow) => c.last_success === null && c.error === null;

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
      // The same split as dataStatus: Google's state only matters for a Google calendar that counts.
      const { google, links } = counted(user, own);
      return {
        ...p,
        data: dataStatus(user, own, now, demo),
        pending: (google.some(waiting) && !!user.refresh_token) || links.some(waiting),
        stale: (google.length > 0 && !!user.token_error) || [...google, ...links].some((c) => c.error !== null),
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
  const included = listCalendars().filter((c) => countsAsBusy(c) && users.has(c.user_id));
  const calendars: CalendarStatus[] = included.map((c) => ({
    person: users.get(c.user_id)!.name,
    personId: c.user_id,
    label: c.label,
    kind: c.kind,
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
    // The same split as dataStatus: Google's access only matters while a Google calendar of theirs counts.
    signInAgain: [...users.values()]
      .filter((u) => u.token_error && counted(u, included.filter((c) => c.user_id === u.id)).google.length > 0)
      .map((u) => ({ personId: u.id, person: u.name, error: u.token_error! })),
  };
}
