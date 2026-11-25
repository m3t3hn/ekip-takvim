// A fake Google for the sync tests, as the server sees it through fetch: the
// token endpoint (refresh tokens and sign-in codes) and the Calendar API. Every
// access token it hands out holds TOKEN_MARK, so a scan of log lines, rows and
// answers finds any of them. Nothing reaches the network: any other address
// throws.
import { vi } from "vitest";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const API = "https://www.googleapis.com/calendar/v3";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
/** In every access token handed out, and in nothing else. */
export const TOKEN_MARK = "AccessMark";

export type ApiKind = "list" | "events" | "freebusy";
export type RefreshCall = { kind: "refresh"; seq: number; at: number; refreshToken: string };
export type CodeCall = { kind: "code"; seq: number; at: number; code: string };
export type ApiCall = { kind: ApiKind; seq: number; at: number; token: string; calendarId: string | null };
export type Call = RefreshCall | CodeCall | ApiCall | { kind: "revoke"; seq: number; at: number; token: string };

/** Someone's Google account: the calendars their tokens open, the first one primary. */
export type Account = { email: string; calendars: { id: string; access?: "events" | "freebusy" }[] };

/** A sign-in, by its authorization code: who signed in and what the token endpoint answers. */
export type SignIn = {
  sub: string;
  email: string;
  name: string;
  /** Sent with the answer, or left out (null): Google then keeps the one it gave before. */
  refreshToken: string | null;
  /** expires_in; null leaves it out. */
  expiresIn: unknown;
};

/** What the token endpoint does with one request; `issue` hands out a new access token for whoever asked. */
export type TokenPlan = (issue: () => string) => Response | Promise<Response>;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const plans = {
  /** A new access token; expires_in left out when null. */
  token:
    (expiresIn: unknown = 3600): TokenPlan =>
    (issue) =>
      json({ access_token: issue(), ...(expiresIn === null ? {} : { expires_in: expiresIn }), scope: `openid ${CALENDAR_SCOPE}`, token_type: "Bearer" }),
  /** Google refuses the refresh token: revoked, expired, account gone. */
  invalidGrant: (): TokenPlan => () => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400),
  /** An outage: an HTML page. */
  serverError: (): TokenPlan => () => new Response("<html><body>503 Service Unavailable</body></html>", { status: 503 }),
  /** A 401 that isn't invalid_grant. */
  unauthorized: (): TokenPlan => () => json({ error: "invalid_client", error_description: "Unauthorized" }, 401),
  /** No connection. */
  noConnection: (): TokenPlan => () => Promise.reject(new TypeError("fetch failed")),
  /** The request's deadline passed. */
  timeout: (): TokenPlan => () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
};

/** A token request that waits until it's released with what it answers. */
export function held(): { plan: TokenPlan; release: (plan: TokenPlan) => void; asked: () => boolean } {
  let resolve!: (answer: Response | Promise<Response>) => void;
  const answer = new Promise<Response>((r) => (resolve = r));
  let issue: (() => string) | null = null;
  return {
    plan: (i) => {
      issue = i;
      return answer;
    },
    release: (plan) => {
      if (!issue) throw new Error("test: released before it was asked for");
      resolve(plan(issue));
    },
    asked: () => issue !== null,
  };
}

/** An answer that waits until it's released. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T | Promise<T>) => void } {
  let resolve!: (value: T | Promise<T>) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export type FakeGoogle = {
  /** Every request, in order; seq counts them. */
  calls: Call[];
  /** Each access token handed out: whose, and the seq of the request that asked for it. */
  issued: Map<string, { email: string; askedSeq: number }>;
  /** Accounts by refresh token: what the token endpoint gives a token for. */
  accounts: Map<string, Account>;
  /** Sign-ins by authorization code. */
  signIns: Map<string, SignIn>;
  /** What the next token requests for a refresh token do, in order; after them, a token lasting an hour. */
  next: (refreshToken: string, ...plans: TokenPlan[]) => void;
  /** Asked first about every API request: an answer, or undefined for the usual one. */
  onApi: ((call: ApiCall) => Response | Promise<Response> | undefined) | null;
  /** Token requests with a refresh token, of one or of all. */
  refreshes: (refreshToken?: string) => RefreshCall[];
  /** Calendar API requests made after request `since`. */
  api: (since?: number) => ApiCall[];
  /** The access token handed out for a token request (null: none). */
  tokenFor: (call: { seq: number }) => string | null;
  /** The seq of the last request. */
  seq: () => number;
};

/** Install the fake as the global fetch. */
export function fakeGoogle(): FakeGoogle {
  const calls: Call[] = [];
  const issued = new Map<string, { email: string; askedSeq: number }>();
  const accounts = new Map<string, Account>();
  const signIns = new Map<string, SignIn>();
  const queued = new Map<string, TokenPlan[]>();
  let seq = 0;
  let handedOut = 0;

  const issuer = (email: string, askedSeq: number) => () => {
    const token = `ya29.${TOKEN_MARK}${++handedOut}x`;
    issued.set(token, { email, askedSeq });
    return token;
  };

  const fake: FakeGoogle = {
    calls,
    issued,
    accounts,
    signIns,
    next: (refreshToken, ...more) => queued.set(refreshToken, [...(queued.get(refreshToken) ?? []), ...more]),
    onApi: null,
    refreshes: (refreshToken) =>
      calls.filter((c): c is RefreshCall => c.kind === "refresh" && (refreshToken === undefined || c.refreshToken === refreshToken)),
    api: (since = 0) => calls.filter((c): c is ApiCall => (c.kind === "list" || c.kind === "events" || c.kind === "freebusy") && c.seq > since),
    tokenFor: (call) => [...issued].find(([, v]) => v.askedSeq === call.seq)?.[0] ?? null,
    seq: () => seq,
  };

  /** The usual answer: the token owner's calendars, one busy hour on each, 401 for a token it never handed out. */
  function usual(call: ApiCall): Response {
    const owner = issued.get(call.token);
    const account = owner && [...accounts.values()].find((a) => a.email === owner.email);
    if (!account) return json({ error: { code: 401, status: "UNAUTHENTICATED" } }, 401);
    if (call.kind === "list") {
      return json({
        items: account.calendars.map((c, i) => ({
          id: c.id,
          summary: c.id,
          primary: i === 0,
          accessRole: c.access === "freebusy" ? "freeBusyReader" : "owner",
          timeZone: "UTC",
        })),
      });
    }
    if (!account.calendars.some((c) => c.id === call.calendarId)) return json({ error: { code: 404, status: "NOT_FOUND" } }, 404);
    const start = Math.floor(Date.now() / 3_600_000) * 3_600_000 + 48 * 3_600_000;
    const end = start + 3_600_000;
    if (call.kind === "freebusy") {
      return json({ calendars: { [call.calendarId!]: { busy: [{ start: new Date(start).toISOString(), end: new Date(end).toISOString() }] } } });
    }
    return json({
      items: [{ id: `ev-${call.calendarId}`, summary: "Planning", status: "confirmed", start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(end).toISOString() } }],
    });
  }

  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const at = Date.now();
    if (url === TOKEN_URL) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const n = ++seq;
      if (body.get("grant_type") === "refresh_token") {
        const refreshToken = body.get("refresh_token") ?? "";
        calls.push({ kind: "refresh", seq: n, at, refreshToken });
        const account = accounts.get(refreshToken);
        if (body.get("client_id") !== process.env.GOOGLE_CLIENT_ID || body.get("client_secret") !== process.env.GOOGLE_CLIENT_SECRET) {
          return json({ error: "invalid_client" }, 401);
        }
        const plan = queued.get(refreshToken)?.shift() ?? (account ? plans.token() : plans.invalidGrant());
        return plan(issuer(account?.email ?? "nobody@example.com", n));
      }
      if (body.get("grant_type") === "authorization_code") {
        const code = body.get("code") ?? "";
        calls.push({ kind: "code", seq: n, at, code });
        if (body.get("client_id") !== process.env.GOOGLE_CLIENT_ID || body.get("client_secret") !== process.env.GOOGLE_CLIENT_SECRET) {
          return json({ error: "invalid_client" }, 401);
        }
        const who = signIns.get(code);
        if (!who) return json({ error: "invalid_grant" }, 400);
        const claims = { sub: who.sub, email: who.email, email_verified: true, name: who.name };
        const idToken = `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
        if (who.refreshToken) {
          const before = [...accounts.values()].find((a) => a.email === who.email);
          accounts.set(who.refreshToken, before ?? { email: who.email, calendars: [{ id: who.email }] });
        }
        return json({
          access_token: issuer(who.email, n)(),
          ...(who.expiresIn === null ? {} : { expires_in: who.expiresIn }),
          ...(who.refreshToken ? { refresh_token: who.refreshToken } : {}),
          id_token: idToken,
          scope: `openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile ${CALENDAR_SCOPE}`,
          token_type: "Bearer",
        });
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }
    if (url.startsWith(REVOKE_URL)) {
      calls.push({ kind: "revoke", seq: ++seq, at, token: new URLSearchParams(String(init?.body ?? "")).get("token") ?? "" });
      return new Response("", { status: 200 });
    }
    if (url.startsWith(`${API}/`)) {
      const token = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
      const path = url.slice(API.length);
      let kind: ApiKind;
      let calendarId: string | null = null;
      if (path.startsWith("/users/me/calendarList")) kind = "list";
      else if (path.startsWith("/freeBusy")) {
        kind = "freebusy";
        calendarId = (JSON.parse(String(init?.body)) as { items: { id: string }[] }).items[0].id;
      } else if (/^\/calendars\/[^/]+\/events/.test(path)) {
        kind = "events";
        calendarId = decodeURIComponent(path.split("/")[2]);
      } else throw new TypeError(`test: no such Calendar API request (${path.split("?")[0]})`);
      const call: ApiCall = { kind, seq: ++seq, at, token, calendarId };
      calls.push(call);
      return (await fake.onApi?.(call)) ?? usual(call);
    }
    throw new TypeError(`test: no network (${new URL(url).host})`);
  });
  return fake;
}

/** Google's answer to a request with an access token it turned down. */
export const unauthorized = () => json({ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }, 401);
