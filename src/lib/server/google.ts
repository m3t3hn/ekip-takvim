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
    /** The refresh token no longer works: the person has to sign in again. */
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
    // People can untick calendar access on Google's consent screen.
    calendarAccess: (t.scope ?? "").split(" ").includes(CALENDAR_SCOPE),
  };
}

export async function accessToken(refreshToken: string): Promise<string> {
  return (await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" })).access_token;
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
  const title = e.summary?.trim().slice(0, 200);
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
    ...(e.description?.trim() ? { description: htmlToText(e.description).slice(0, 8000) } : {}),
    ...(e.location?.trim() ? { location: e.location.trim().slice(0, 500) } : {}),
    ...(httpUrl(e.hangoutLink ?? video) ? { meetLink: httpUrl(e.hangoutLink ?? video) } : {}),
    ...(httpUrl(e.htmlLink) ? { htmlLink: httpUrl(e.htmlLink) } : {}),
  };
  return Object.keys(details).length ? details : undefined;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

/**
 * Google event descriptions are HTML. Keep the text and the link targets,
 * drop everything else, so it can be shown as plain text and never as markup.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => {
      const label = text.replace(/<[^>]+>/g, "").trim();
      return label && label !== href ? `${label} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#?\w+);/g, (m, name: string) => ENTITIES[name] ?? (name.startsWith("#") ? String.fromCodePoint(Number(name.slice(1))) : m))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
