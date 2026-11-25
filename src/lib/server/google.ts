import { createHash } from "node:crypto";
import { dayStart } from "@/lib/time";

// Google sign-in and read-only Calendar access. Nothing here can write to a
// calendar: invites are handed to Google Calendar's own page instead.

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const TIMEOUT_MS = 20_000;

export class GoogleError extends Error {
  constructor(
    message: string,
    /**
     * Google turned the person's access down: their refresh token (invalid_grant),
     * or the access token a request used (401). See accessLost in sync.ts.
     */
    readonly signInAgain = false,
  ) {
    super(message);
  }
}

export function redirectUri(origin: string): string {
  return `${process.env.APP_URL?.replace(/\/$/, "") || origin}/auth/google/callback`;
}

export function authUrl(opts: { origin: string; state: string; domain: string | null }): string {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(opts.origin),
    response_type: "code",
    scope: `openid email profile ${CALENDAR_SCOPE}`,
    // A refresh token, so calendars keep syncing after the person leaves.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: opts.state,
  });
  // Only a hint for the account picker; the callback enforces the domain.
  if (opts.domain) q.set("hd", opts.domain);
  return `${AUTH_URL}?${q}`;
}

type TokenResponse = {
  access_token: string;
  /** Seconds the access token lasts. */
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      ...body,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // An outage can answer with an HTML page; that's a temporary failure, not
  // a reason to make someone sign in again.
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    throw new GoogleError(
      json.error === "invalid_grant" ? "Google access expired or was revoked" : `Google sign-in failed (${json.error ?? res.status})`,
      json.error === "invalid_grant",
    );
  }
  return json;
}

export type SignedIn = {
  sub: string;
  email: string;
  name: string;
  domain: string | null;
  refreshToken: string | null;
  accessToken: string;
  /** When accessToken expires, in ms; null when Google didn't say. */
  expiresAt: number | null;
  calendarAccess: boolean;
};

export async function exchangeCode(code: string, origin: string): Promise<SignedIn> {
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri(origin) });
  if (!t.id_token) throw new GoogleError("Google didn't say who signed in");
  // Straight from Google's token endpoint over TLS, so the ID token needs no
  // signature check (OpenID Connect Core §3.1.3.7).
  const claims = JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString("utf8")) as {
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    hd?: string;
  };
  if (!claims.email || !claims.email_verified) throw new GoogleError("That Google account has no verified email");
  return {
    sub: claims.sub,
    email: claims.email.toLowerCase(),
    name: claims.name?.trim() || claims.email.split("@")[0],
    domain: claims.hd?.toLowerCase() ?? null,
    refreshToken: t.refresh_token ?? null,
    accessToken: t.access_token,
    expiresAt: expiryOf(t),
    // People can untick calendar access on Google's consent screen.
    calendarAccess: (t.scope ?? "").split(" ").includes(CALENDAR_SCOPE),
  };
}

// ---------------------------------------------------------------------------
// An access token lasts an hour, so it's used again until shortly before it
// expires rather than asked for at every sync. Access tokens are kept in memory
// only, never stored or logged, on the process-wide global (route handlers and
// instrumentation are bundled apart), each under a hash of the refresh token it
// came from: people never share one.

/** An access token is used until this long before Google said it expires. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** Kept for a refresh token: an access token and when it expires, or none (see noToken). */
type Kept = { token: string | null; expiresAt: number };

const TOKENS = Symbol.for("ekip-takvim.google-tokens");
const g = globalThis as typeof globalThis & { [TOKENS]?: Map<string, Kept> };
const tokens = () => (g[TOKENS] ??= new Map());

const keyOf = (refreshToken: string) => createHash("sha256").update(refreshToken).digest("base64url");
const usable = (kept: Kept | undefined): kept is Kept & { token: string } =>
  !!kept?.token && Date.now() < kept.expiresAt - TOKEN_MARGIN_MS;
/** No token to use again; a token asked for before this was kept isn't kept or used either. */
const noToken = (): Kept => ({ token: null, expiresAt: Date.now() });

/** When a token answer's access token expires, or null when the answer doesn't say. */
function expiryOf(t: TokenResponse): number | null {
  const seconds = t.expires_in;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : null;
}

function keep(key: string, kept: Kept): void {
  const all = tokens();
  // What expired over an hour ago goes, such as what was kept for a refresh token a sign-in replaced.
  for (const [k, v] of all) if (v.expiresAt < Date.now() - 3_600_000) all.delete(k);
  all.set(key, kept);
}

/**
 * An access token for this refresh token: the one kept for it, until
 * TOKEN_MARGIN_MS before it expires, else a new one from Google, kept when
 * Google says how long it lasts.
 */
export async function accessToken(refreshToken: string): Promise<string> {
  const key = keyOf(refreshToken);
  const before = tokens().get(key);
  if (usable(before)) return before.token;
  const t = await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
  const now = tokens().get(key);
  // Something was kept while this one was asked for: a sign-in's token, a newer
  // one, or none. That's used, or else a token asked for after it: one asked for
  // before a sign-in may lack what the sign-in allowed.
  if (now && now !== before) return usable(now) ? now.token : accessToken(refreshToken);
  const expiresAt = expiryOf(t);
  if (expiresAt !== null) keep(key, { token: t.access_token, expiresAt });
  return t.access_token;
}

/**
 * After a sign-in: its own access token, which carries what the person just
 * allowed, replaces whatever was kept for the refresh token now stored for them.
 */
export function keepSignInToken(refreshToken: string, signedIn: Pick<SignedIn, "accessToken" | "expiresAt">): void {
  const { accessToken: token, expiresAt } = signedIn;
  keep(keyOf(refreshToken), expiresAt === null ? noToken() : { token, expiresAt });
}

/**
 * Google turned down the access token kept for this refresh token: the next
 * request asks for a new one. Given the token turned down, only while that's
 * the one kept, so one kept since (a sign-in's) stays.
 */
export function dropAccessToken(refreshToken: string, turnedDown?: string): void {
  const key = keyOf(refreshToken);
  if (turnedDown !== undefined && tokens().get(key)?.token !== turnedDown) return;
  keep(key, noToken());
}

export async function revoke(token: string): Promise<void> {
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => {});
}

async function api<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) throw new GoogleError("Google access expired or was revoked", true);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as GoogleErrorBody | null;
    throw new GoogleError(explain(res.status, body));
  }
  return (await res.json()) as T;
}

type GoogleErrorBody = {
  error?: { status?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] };
};

/**
 * A message that says what to do. Built from Google's machine-readable
 * reason only: its free-text message can name the calendar.
 */
export function explain(status: number, body: GoogleErrorBody | null): string {
  const reasons = [
    body?.error?.status,
    ...(body?.error?.errors ?? []).map((e) => e.reason),
    ...(body?.error?.details ?? []).map((d) => d.reason),
  ].filter(Boolean);
  const has = (...r: string[]) => r.some((x) => reasons.includes(x));
  if (has("accessNotConfigured", "SERVICE_DISABLED")) {
    return "The Google Calendar API isn't enabled for this app's Google Cloud project. An admin has to enable it in Google Cloud Console (APIs & Services → Library → Google Calendar API)";
  }
  if (has("insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
    return "Calendar access wasn't granted. Sign in again and allow “See your calendars”";
  }
  if (has("rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "RESOURCE_EXHAUSTED")) {
    return "Google's rate limit was hit; it'll retry on the next sync";
  }
  if (status === 404) return "Calendar not found: it may no longer be shared with this account";
  if (status === 403) return `Google refused access${reasons.length ? ` (${reasons[0]})` : ""}`;
  return `Google returned ${status}${reasons.length ? ` (${reasons[0]})` : ""}`;
}

export type GoogleCalendar = {
  id: string;
  summary: string;
  access: "events" | "freebusy";
  primary: boolean;
  timeZone: string | null;
};

export async function listCalendars(token: string): Promise<GoogleCalendar[]> {
  type Page = {
    items?: { id: string; summary?: string; summaryOverride?: string; primary?: boolean; accessRole: string; timeZone?: string; deleted?: boolean }[];
    nextPageToken?: string;
  };
  const out: GoogleCalendar[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({
      maxResults: "250",
      fields: "items(id,summary,summaryOverride,primary,accessRole,timeZone,deleted),nextPageToken",
    });
    if (pageToken) q.set("pageToken", pageToken);
    const page = await api<Page>(token, `/users/me/calendarList?${q}`);
    for (const c of page.items ?? []) {
      if (c.deleted) continue;
      out.push({
        id: c.id,
        summary: c.summaryOverride ?? c.summary ?? c.id,
        // Shared as "See only free/busy": events can't be listed, only free/busy asked.
        access: c.accessRole === "freeBusyReader" ? "freebusy" : "events",
        primary: !!c.primary,
        timeZone: c.timeZone ?? null,
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  // Primary first, then as Google lists them.
  return out.sort((a, b) => Number(b.primary) - Number(a.primary));
}

export type Busy = {
  start: number;
  end: number;
  tentative?: boolean;
  allDay?: boolean;
  /** The event's title. Who may see it is decided when it's served, see sync.ts. */
  title?: string;
  /** Marked private or confidential in Google: the title is for its owner only. */
  private?: boolean;
  /** Google's id for the event (the occurrence, for recurring ones). */
  eventId?: string;
  /** Details shown when someone allowed to see the title opens the event. */
  details?: EventDetails;
};

/** Longest title, description and place kept for an event, from Google or a calendar link. */
export const EVENT_TEXT_LIMITS = { title: 200, description: 8000, location: 500 } as const;

export type EventDetails = {
  /** Plain text: Google's HTML is flattened, links kept as URLs. */
  description?: string;
  location?: string;
  /** Video call: Google Meet, or Zoom/Teams added through Calendar. */
  meetLink?: string;
  /** The event in Google Calendar. */
  htmlLink?: string;
};

type GoogleEvent = {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  hangoutLink?: string;
  htmlLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  visibility?: string;
  status?: string;
  transparency?: string;
  eventType?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
};

/**
 * Busy time from one event, or null when it doesn't block the person: it
 * was cancelled, shows as free, is a working-location marker, or they
 * declined it. All-day events are whole days in the person's zone.
 */
export function busyFromEvent(e: GoogleEvent, timezone: string): Busy | null {
  if (e.status === "cancelled" || e.transparency === "transparent" || e.eventType === "workingLocation") return null;
  const self = e.attendees?.find((a) => a.self);
  if (self?.responseStatus === "declined") return null;
  const tentative = e.status === "tentative" || self?.responseStatus === "tentative";
  let start: number;
  let end: number;
  let allDay = false;
  if (e.start?.date && e.end?.date) {
    start = dayStart(e.start.date, timezone);
    end = dayStart(e.end.date, timezone);
    allDay = true;
  } else if (e.start?.dateTime && e.end?.dateTime) {
    start = Date.parse(e.start.dateTime);
    end = Date.parse(e.end.dateTime);
  } else {
    return null;
  }
  if (!(end > start)) return null;
  const title = e.summary?.trim().slice(0, EVENT_TEXT_LIMITS.title);
  const isPrivate = e.visibility === "private" || e.visibility === "confidential";
  const details = eventDetails(e);
  return {
    start,
    end,
    ...(tentative ? { tentative } : {}),
    ...(allDay ? { allDay } : {}),
    ...(title ? { title } : {}),
    ...(isPrivate ? { private: true } : {}),
    ...(e.id ? { eventId: e.id } : {}),
    ...(details ? { details } : {}),
  };
}

const httpUrl = (value: string | undefined) => (value && /^https?:\/\//i.test(value) ? value.slice(0, 2000) : undefined);

function eventDetails(e: GoogleEvent): EventDetails | undefined {
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
  const details: EventDetails = {
    ...(e.description?.trim() ? { description: htmlToText(e.description).slice(0, EVENT_TEXT_LIMITS.description) } : {}),
    ...(e.location?.trim() ? { location: e.location.trim().slice(0, EVENT_TEXT_LIMITS.location) } : {}),
    ...(httpUrl(e.hangoutLink ?? video) ? { meetLink: httpUrl(e.hangoutLink ?? video) } : {}),
    ...(httpUrl(e.htmlLink) ? { htmlLink: httpUrl(e.htmlLink) } : {}),
  };
  return Object.keys(details).length ? details : undefined;
}

/** The named character references read; numeric ones are read by characterReference. A Map, so &constructor; names nothing. */
const ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
]);

/**
 * Google event descriptions are HTML. Keep the text and the link targets,
 * drop everything else, so it can be shown as plain text and never as markup.
 *
 * In order: script and style elements go, each link becomes "label (href)", <br>
 * and the end of a paragraph, div, list item or heading become line breaks, a list
 * item starts with "• ", the other tags go, character references are read, spaces
 * before a line break go and three or more line breaks become two.
 *
 * It takes time in proportion to the length of the text, whatever the text holds:
 * a calendar link's descriptions can be megabytes, and these patterns, applied as
 * plain regular expressions, scan to the end of the text from every '<' that no '>'
 * follows, every script or link whose end tag never comes and every space of a long
 * run. And it never throws: a character reference that names no character, such as
 * &#99999999; or a name it doesn't list, stays as written.
 */
export function htmlToText(html: string): string {
  const text = withoutLinks(withoutScripts(html))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n");
  return stripTags(beforeLastGt(text, (head) => head.replace(/<li[^>]*>/gi, "• ")))
    .replace(/&(#?\w+);/g, (written, name: string) => ENTITIES.get(name) ?? characterReference(written, name))
    // A run of spaces and tabs goes when a line break follows it.
    .replace(/[ \t]+/g, (run, at: number, all: string) => (all[at + run.length] === "\n" ? "" : run))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * `edit` applied to the text up to its last '>', the rest kept as it is. A pattern
 * that starts at '<' and ends at the first '>' after it finds the same there, and
 * doesn't scan from each '<' after the last '>' to the end of the text.
 */
function beforeLastGt(text: string, edit: (head: string) => string): string {
  const last = text.lastIndexOf(">");
  return edit(text.slice(0, last + 1)) + text.slice(last + 1);
}

/** The text without its tags: what replacing /<[^>]+>/g with nothing gives. */
const stripTags = (text: string) => beforeLastGt(text, (head) => head.replace(/<[^>]+>/g, ""));

/** Where the last match of a global pattern begins, or -1. */
function lastMatch(text: string, pattern: RegExp): number {
  let at = -1;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) at = m.index;
  return at;
}

/**
 * The text without its script and style elements: what replacing
 * /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi with nothing gives. An element runs from
 * the first '>' after its name to the first end tag of the same name after that.
 */
function withoutScripts(html: string): string {
  const open = /<(script|style)/gi;
  const ends = { script: /<\/script>/gi, style: /<\/style>/gi };
  const last = { script: lastMatch(html, ends.script), style: lastMatch(html, ends.style) };
  const kept: string[] = [];
  let from = 0;
  let gt = -1;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    // Each search starts after the last one, so a '>' found earlier is still the first.
    if (gt < open.lastIndex) gt = html.indexOf(">", open.lastIndex);
    if (gt === -1) break;
    const name = m[1].toLowerCase() as keyof typeof ends;
    // No end tag of its name after its '>': nothing is removed from here.
    if (last[name] <= gt) continue;
    ends[name].lastIndex = gt + 1;
    const end = ends[name].exec(html)!;
    kept.push(html.slice(from, m.index));
    from = open.lastIndex = end.index + end[0].length;
  }
  kept.push(html.slice(from));
  return kept.join("");
}

/**
 * The text with each link written as "label (href)", or as its href when it has no
 * other label: what /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
 * finds. The [^>]* before href can't pass the tag's first '>', and backs off from it
 * to the last href in the tag that the rest of the pattern accepts; the rest is
 * fixed by the href. So a tag's hrefs are tried from the last, each once, and its
 * '>' and the next </a> are found without scanning the text again.
 */
function withoutLinks(html: string): string {
  const open = /<a\s/gi;
  const end = /<\/a>/gi;
  const lastEnd = lastMatch(html, end);
  const attribute = /\s*=\s*["']([^"']+)["']/y;
  const kept: string[] = [];
  let from = 0;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    const start = open.lastIndex;
    // The search goes on after this tag's '>' whatever is found, so each tag is read once.
    const gt = html.indexOf(">", start);
    if (gt === -1) break;
    // Where each "href" in the tag ends.
    const tag = html.slice(start, gt);
    const hrefs: number[] = [];
    const word = /href/gi;
    for (let h = word.exec(tag); h; h = word.exec(tag)) hrefs.push(start + h.index + 4);
    let link = false;
    for (let i = hrefs.length - 1; i >= 0 && !link; i--) {
      attribute.lastIndex = hrefs[i];
      const value = attribute.exec(html);
      if (!value) continue;
      // The tag ends at its '>', or at the first '>' after a value that runs past it.
      const close = attribute.lastIndex <= gt ? gt : html.indexOf(">", attribute.lastIndex);
      // The label runs to the first </a> after the tag; with none, this href doesn't make a link.
      if (close === -1 || lastEnd <= close) continue;
      end.lastIndex = close + 1;
      const endTag = end.exec(html)!;
      const label = stripTags(html.slice(close + 1, endTag.index)).trim();
      kept.push(html.slice(from, m.index), label && label !== value[1] ? `${label} (${value[1]})` : value[1]);
      from = open.lastIndex = endTag.index + endTag[0].length;
      link = true;
    }
    // No link begins at this '<a', nor at any other before the tag's '>': they share its hrefs.
    if (!link) open.lastIndex = gt + 1;
  }
  kept.push(html.slice(from));
  return kept.join("");
}

/** A numeric character reference, decimal or hex; one that names no character stays as written. */
function characterReference(written: string, name: string): string {
  if (!name.startsWith("#")) return written;
  const code = /^#x[0-9a-f]+$/i.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1));
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : written;
}

/** Busy times, with titles and details, from a calendar whose events can be read. Attendee lists are never requested. */
export async function eventBusy(token: string, calendarId: string, from: Date, to: Date, timezone: string): Promise<Busy[]> {
  type Page = { items?: GoogleEvent[]; nextPageToken?: string };
  const out: Busy[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: "true",
      maxResults: "2500",
      fields:
        "items(id,summary,description,location,hangoutLink,htmlLink,conferenceData(entryPoints(entryPointType,uri)),visibility,status,transparency,eventType,start,end,attendees(self,responseStatus)),nextPageToken",
    });
    if (pageToken) q.set("pageToken", pageToken);
    const page = await api<Page>(token, `/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
    for (const e of page.items ?? []) {
      const b = busyFromEvent(e, timezone);
      if (b) out.push(b);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

/** Busy times from a calendar shared as free/busy only. */
// Google turns down long free/busy ranges (400 timeRangeTooLong), so ask a month at a time.
const FREEBUSY_CHUNK_MS = 30 * 86_400_000;

export async function freeBusy(token: string, calendarId: string, from: Date, to: Date): Promise<Busy[]> {
  const busy: Busy[] = [];
  for (let start = from.getTime(); start < to.getTime(); start += FREEBUSY_CHUNK_MS) {
    const end = Math.min(start + FREEBUSY_CHUNK_MS, to.getTime());
    busy.push(...(await freeBusyRange(token, calendarId, new Date(start), new Date(end))));
  }
  // Join the pieces of a busy time that crossed from one month's answer into the next.
  return busy.reduce<Busy[]>((out, b) => {
    const last = out.at(-1);
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else out.push({ ...b });
    return out;
  }, []);
}

async function freeBusyRange(token: string, calendarId: string, from: Date, to: Date): Promise<Busy[]> {
  type Reply = { calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }> };
  const reply = await api<Reply>(token, "/freeBusy", {
    method: "POST",
    body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: calendarId }] }),
  });
  const cal = reply.calendars?.[calendarId];
  if (cal?.errors?.length) {
    throw new GoogleError(cal.errors[0].reason === "notFound" ? "Calendar not found: it may no longer be shared with this account" : "Google couldn't read this calendar's free/busy");
  }
  return (cal?.busy ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
}
