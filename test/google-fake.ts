// A fake Google for the booking tests, behind a stubbed fetch: the token
// endpoint and the Calendar API calls the app makes. It keeps each account's
// calendars and events, so an event the app makes shows up in later reads
// and in free/busy, and one it deletes is gone. Every call is recorded.
// Nothing reaches the network: a request to any other address throws, and is
// kept in `problems`, which a test expects to stay empty.
//
// As Google does: an insert makes the event under the id its body gives (one
// Google takes: a-v and 0-9, 5 to 1024 of them), "primary" in a path is the
// account's primary calendar, and getting one event answers 404 for an id the
// calendar never had and status "cancelled" for one that was deleted.
import { randomBytes } from "node:crypto";
import { vi } from "vitest";

export type Kind = "token" | "revoke" | "calendarList" | "events" | "freeBusy" | "insert" | "delete" | "get";

export type Calendar = {
  id: string;
  summary: string;
  accessRole: "owner" | "writer" | "reader" | "freeBusyReader";
  primary?: boolean;
  timeZone?: string;
};

export type Account = {
  refreshToken: string;
  accessToken: string;
  /** The id of the account's primary calendar: its address. */
  primary: string;
  calendars: Calendar[];
};

export type Attendee = { email?: string; displayName?: string; self?: boolean; organizer?: boolean; responseStatus?: string };

export type GoogleEvent = {
  id: string;
  status?: string;
  transparency?: string;
  summary?: string;
  description?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  attendees?: Attendee[];
  organizer?: { email: string; self?: boolean };
  conferenceData?: unknown;
  hangoutLink?: string;
};

export type Call = {
  kind: Kind;
  method: string;
  url: URL;
  /** The body as sent. */
  body: string;
  /** A Calendar API call's JSON body. */
  json: Record<string, unknown> | null;
  /** A token or revoke call's form fields. */
  form: URLSearchParams | null;
  authorization: string | null;
  /** The signal the call can be given up with, if any. */
  signal: AbortSignal | null;
  /** Whose token it carried. */
  account: Account | null;
  /** Date.now() when it was made. */
  at: number;
};

/**
 * What a call gets instead of the fake's own answer: a Response; "timeout",
 * no answer until the caller gives up on it; "network", fetch throws; or
 * undefined for the fake's own answer.
 */
export type Outcome = Response | "timeout" | "network" | undefined;

const TOKEN_ORIGIN = "https://oauth2.googleapis.com";
const API_ORIGIN = "https://www.googleapis.com";
const API_PATH = "/calendar/v3";

export const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=UTF-8" } });

/** A Calendar API error, as Google writes it. */
export function apiError(status: number, reason: string, extra: { status?: string; details?: { reason: string }[] } = {}): Response {
  return jsonResponse(status, {
    error: { code: status, message: `Test error (${reason})`, errors: [{ domain: "global", reason, message: "Test error" }], ...extra },
  });
}

/** The failures every Google call is tried with, each a fresh Response. */
export const failures = {
  /** Google's servers failed. */
  serverError: () => apiError(500, "backendError"),
  /** The access token isn't (or is no longer) good. */
  unauthorized: () => apiError(401, "authError", { status: "UNAUTHENTICATED" }),
  /** The token doesn't allow it: the person didn't grant the scope. */
  forbidden: () => apiError(403, "insufficientPermissions", { status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] }),
  /** Too many requests: Calendar says so with a 403 too. */
  rateLimited: () => apiError(403, "rateLimitExceeded"),
  /** The token endpoint: the client isn't accepted. */
  tokenUnauthorized: () => jsonResponse(401, { error: "invalid_client", error_description: "Unauthorized" }),
  tokenForbidden: () => jsonResponse(403, { error: "access_denied", error_description: "Forbidden" }),
  tokenServerError: () => jsonResponse(500, { error: "internal_failure" }),
  /** The refresh token was revoked or expired. */
  invalidGrant: () => jsonResponse(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }),
};

/** A promise and the function that settles it. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Wait, on real timers, until `ready()` holds. */
export async function waitFor(ready: () => boolean, what: string, maxMs = 2000): Promise<void> {
  const until = performance.now() + maxMs;
  while (!ready()) {
    if (performance.now() > until) throw new Error(`test: gave up waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/**
 * Make every AbortSignal.timeout(ms) the app asks for give up after `ms`
 * milliseconds instead, so a call Google never answers times out quickly.
 * Returns the spy; mockRestore() undoes it.
 */
export function shortTimeouts(ms = 40) {
  const real = AbortSignal.timeout.bind(AbortSignal);
  return vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(ms));
}

const overlaps = (start: number, end: number, from: number, to: number) => start < to && end > from;
const ms = (t: { dateTime: string }) => Date.parse(t.dateTime);

export function fakeGoogle() {
  const calls: Call[] = [];
  const problems: string[] = [];
  const accounts: Account[] = [];
  /** Each calendar's events, by calendar id. */
  const events = new Map<string, GoogleEvent[]>();
  /** Busy times Google knows about apart from events, by calendar id. */
  const busy = new Map<string, { start: number; end: number }[]>();
  /** Per kind of call, what to answer instead of the usual. */
  const answer: Partial<Record<Kind, (call: Call) => Outcome | Promise<Outcome>>> = {};
  const options = { pageSize: Infinity };
  /** The id of every event made, deleted ones too. */
  const madeIds: string[] = [];
  /** Events deleted, by the app or in Google Calendar, as "<calendar id> <event id>". */
  const deleted = new Set<string>();
  let made = 0;
  let inFlight = 0;

  /** An account whose refresh token the app holds. */
  function account(a: { refreshToken: string; primary: string; timeZone?: string; calendars?: Calendar[] }): Account {
    const added: Account = {
      refreshToken: a.refreshToken,
      accessToken: `ya29.a0Secret${accounts.length + 1}${randomBytes(8).toString("hex")}`,
      primary: a.primary,
      calendars: a.calendars ?? [{ id: a.primary, summary: a.primary, accessRole: "owner", primary: true, timeZone: a.timeZone ?? "Europe/Istanbul" }],
    };
    accounts.push(added);
    if (!events.has(a.primary)) events.set(a.primary, []);
    return added;
  }

  function reset() {
    calls.length = 0;
    problems.length = 0;
    accounts.length = 0;
    events.clear();
    busy.clear();
    madeIds.length = 0;
    deleted.clear();
    for (const k of Object.keys(answer) as Kind[]) delete answer[k];
    options.pageSize = Infinity;
  }

  function kindOf(method: string, url: URL): { kind: Kind; calendarId?: string; eventId?: string } | null {
    if (url.origin === TOKEN_ORIGIN && method === "POST") {
      if (url.pathname === "/token") return { kind: "token" };
      if (url.pathname === "/revoke") return { kind: "revoke" };
      return null;
    }
    if (url.origin !== API_ORIGIN || !url.pathname.startsWith(`${API_PATH}/`)) return null;
    const path = url.pathname.slice(API_PATH.length);
    if (path === "/users/me/calendarList" && method === "GET") return { kind: "calendarList" };
    if (path === "/freeBusy" && method === "POST") return { kind: "freeBusy" };
    const list = /^\/calendars\/([^/]+)\/events$/.exec(path);
    if (list && method === "GET") return { kind: "events", calendarId: decodeURIComponent(list[1]) };
    if (list && method === "POST") return { kind: "insert", calendarId: decodeURIComponent(list[1]) };
    const one = /^\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(path);
    if (one && method === "DELETE") return { kind: "delete", calendarId: decodeURIComponent(one[1]), eventId: decodeURIComponent(one[2]) };
    if (one && method === "GET") return { kind: "get", calendarId: decodeURIComponent(one[1]), eventId: decodeURIComponent(one[2]) };
    return null;
  }

  /** A calendar's events within a range, as one page of a read. Taken when the request comes in. */
  function readEvents(call: Call, calendarId: string): Response {
    const from = Date.parse(call.url.searchParams.get("timeMin") ?? "");
    const to = Date.parse(call.url.searchParams.get("timeMax") ?? "");
    if (!Number.isFinite(from) || !Number.isFinite(to)) problems.push(`events: no timeMin or timeMax for ${calendarId}`);
    const inRange = (events.get(calendarId) ?? []).filter((e) => overlaps(ms(e.start), ms(e.end), from, to));
    const offset = Number(call.url.searchParams.get("pageToken") ?? 0);
    const page = inRange.slice(offset, offset + options.pageSize);
    const next = offset + options.pageSize < inRange.length ? String(offset + options.pageSize) : undefined;
    return jsonResponse(200, { items: structuredClone(page), ...(next ? { nextPageToken: next } : {}) });
  }

  /** Take an event out of its calendar, as deleting it in Google does. False when the calendar doesn't have it. */
  function remove(calendarId: string, eventId: string): boolean {
    const list = events.get(calendarId) ?? [];
    const at = list.findIndex((e) => e.id === eventId);
    if (at === -1) return false;
    list.splice(at, 1);
    deleted.add(`${calendarId} ${eventId}`);
    return true;
  }

  /** An event, with only the top-level fields a `fields` parameter names (all of them without one). */
  function partial(event: Partial<GoogleEvent>, fields: string | null): Record<string, unknown> {
    const whole = structuredClone(event) as Record<string, unknown>;
    if (!fields) return whole;
    const names = fields.split(",").map((f) => f.trim().replace(/\(.*$/, ""));
    return Object.fromEntries(Object.entries(whole).filter(([k]) => names.includes(k)));
  }

  /** Whether an event makes its calendar's owner busy, as free/busy says. */
  const blocks = (e: GoogleEvent) =>
    e.status !== "cancelled" && e.transparency !== "transparent" && e.attendees?.find((a) => a.self)?.responseStatus !== "declined";

  function usual(call: Call, where: { calendarId?: string; eventId?: string }): Response {
    const { kind, account: who } = call;
    if (kind === "token") {
      const grant = call.form?.get("grant_type");
      if (grant === "refresh_token" && who) {
        return jsonResponse(200, { access_token: who.accessToken, expires_in: 3599, token_type: "Bearer", scope: "openid" });
      }
      problems.push(`token: no account for this ${grant} request`);
      return jsonResponse(500, { error: "test_unknown_grant" });
    }
    if (kind === "revoke") return jsonResponse(200, {});
    if (!who) {
      problems.push(`${kind}: a request without a known access token`);
      return apiError(500, "testUnknownToken");
    }
    if (kind === "calendarList") return jsonResponse(200, { items: who.calendars });
    if (kind === "freeBusy") {
      const body = call.json as { timeMin?: string; timeMax?: string; items?: { id: string }[] } | null;
      const from = Date.parse(body?.timeMin ?? "");
      const to = Date.parse(body?.timeMax ?? "");
      const calendars: Record<string, { busy: { start: string; end: string }[] }> = {};
      for (const { id } of body?.items ?? []) {
        const spans = [
          ...(busy.get(id) ?? []),
          ...(events.get(id) ?? []).filter(blocks).map((e) => ({ start: ms(e.start), end: ms(e.end) })),
        ]
          .filter((b) => overlaps(b.start, b.end, from, to))
          .sort((a, b) => a.start - b.start)
          .map((b) => ({ start: new Date(Math.max(b.start, from)).toISOString(), end: new Date(Math.min(b.end, to)).toISOString() }));
        calendars[id] = { busy: spans };
      }
      return jsonResponse(200, { kind: "calendar#freeBusy", timeMin: body?.timeMin, timeMax: body?.timeMax, calendars });
    }
    if (kind === "insert") {
      if (where.calendarId !== "primary") problems.push(`insert: on calendar ${where.calendarId}, not primary`);
      const body = (call.json ?? {}) as Partial<GoogleEvent> & { attendees?: Attendee[] };
      if (body.id !== undefined && !(typeof body.id === "string" && /^[a-v0-9]{5,1024}$/.test(body.id))) {
        problems.push(`insert: an event id Google doesn't take: ${String(body.id)}`);
        return apiError(400, "invalid");
      }
      if (body.id && (events.get(who.primary) ?? []).some((e) => e.id === body.id)) return apiError(409, "duplicate");
      made++;
      const id = body.id ?? `ev${made}k${randomBytes(6).toString("hex")}`;
      madeIds.push(id);
      const meet = (body.conferenceData as { createRequest?: unknown } | undefined)?.createRequest;
      const event: GoogleEvent = {
        id,
        status: "confirmed",
        summary: body.summary,
        description: body.description,
        start: body.start!,
        end: body.end!,
        attendees: [...(body.attendees ?? []), { email: who.primary, self: true, organizer: true, responseStatus: "accepted" }],
        organizer: { email: who.primary, self: true },
        ...(meet ? { conferenceData: { createRequest: meet }, hangoutLink: `https://meet.google.com/tst-${made}` } : {}),
      };
      if (!events.has(who.primary)) events.set(who.primary, []);
      events.get(who.primary)!.push(event);
      return jsonResponse(200, { kind: "calendar#event", etag: `"${made}"`, htmlLink: `https://www.google.com/calendar/event?eid=${id}`, ...event });
    }
    if (kind === "delete" || kind === "get") {
      const calendarId = where.calendarId === "primary" ? who.primary : (where.calendarId ?? "");
      const event = (events.get(calendarId) ?? []).find((e) => e.id === where.eventId);
      const wasDeleted = deleted.has(`${calendarId} ${where.eventId}`);
      if (kind === "delete") {
        if (event) {
          remove(calendarId, event.id);
          return new Response(null, { status: 204 });
        }
        return wasDeleted ? apiError(410, "deleted") : apiError(404, "notFound");
      }
      const fields = call.url.searchParams.get("fields");
      if (event) return jsonResponse(200, partial(event, fields));
      // Google keeps a deleted event, as cancelled, for a get by its id.
      if (wasDeleted) return jsonResponse(200, partial({ id: where.eventId, status: "cancelled" }, fields));
      return apiError(404, "notFound");
    }
    // Only events reads are left, and they're answered when they come in.
    problems.push(`${kind}: no answer`);
    return apiError(500, "testNoAnswer");
  }

  function hang(call: Call): Promise<Response> {
    const { signal } = call;
    if (!signal) {
      problems.push(`${call.kind}: a call that can't time out`);
      return Promise.reject(new TypeError("test: Google never answered"));
    }
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }

  async function bodyOf(input: string | URL | Request, init?: RequestInit): Promise<string> {
    const body = init?.body ?? null;
    if (body === null) return input instanceof Request ? await input.clone().text() : "";
    if (typeof body === "string") return body;
    if (body instanceof URLSearchParams) return body.toString();
    return await new Response(body).text();
  }

  async function fetchStub(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const where = kindOf(method, url);
    if (!where) {
      problems.push(`unexpected request: ${method} ${url.origin}${url.pathname}`);
      throw new TypeError(`test: no network (${url.host})`);
    }
    const body = await bodyOf(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null) ?? null;
    let json: Record<string, unknown> | null = null;
    let form: URLSearchParams | null = null;
    if (where.kind === "token" || where.kind === "revoke") {
      form = new URLSearchParams(body);
    } else if (body) {
      try {
        json = JSON.parse(body) as Record<string, unknown>;
      } catch {
        problems.push(`${where.kind}: a body that isn't JSON`);
      }
    }
    const authorization = headers.get("authorization");
    const who =
      where.kind === "token"
        ? (accounts.find((a) => a.refreshToken === form?.get("refresh_token")) ?? null)
        : (accounts.find((a) => authorization === `Bearer ${a.accessToken}`) ?? null);
    const call: Call = { kind: where.kind, method, url, body, json, form, authorization, signal, account: who, at: Date.now() };
    calls.push(call);
    // A read returns what the calendar held when it came in.
    const early = where.kind === "events" ? (who ? readEvents(call, where.calendarId!) : null) : null;
    inFlight++;
    try {
      const custom = answer[where.kind] ? await answer[where.kind]!(call) : undefined;
      if (custom === "network") throw new TypeError("test: Google can't be reached");
      if (custom === "timeout") return await hang(call);
      if (custom) return custom;
      if (where.kind === "events" && !who) {
        problems.push("events: a request without a known access token");
        return apiError(500, "testUnknownToken");
      }
      return early ?? usual(call, where);
    } finally {
      inFlight--;
    }
  }

  return {
    calls,
    problems,
    accounts,
    events,
    busy,
    answer,
    options,
    made: madeIds,
    account,
    reset,
    remove,
    /** What Google itself answers a call, with what it does (an insert makes its event): for an answer that does that and then fails. */
    usual: (call: Call) => usual(call, kindOf(call.method, call.url) ?? {}),
    /** Stub fetch with this fake. */
    install: () => vi.stubGlobal("fetch", fetchStub),
    /** The calls of one kind, in order. */
    of: (kind: Kind) => calls.filter((c) => c.kind === kind),
    /** Wait until no call is waiting for its answer, and none came for a few turns. */
    async idle(maxMs = 5000) {
      const until = performance.now() + maxMs;
      let quiet = 0;
      while (quiet < 5) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        quiet = inFlight === 0 ? quiet + 1 : 0;
        if (performance.now() > until) throw new Error("test: Google calls still waiting");
      }
    },
  };
}

export type FakeGoogle = ReturnType<typeof fakeGoogle>;
