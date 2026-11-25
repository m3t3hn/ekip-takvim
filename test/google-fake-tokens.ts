// Access tokens on top of booking's fake Google (google-fake.ts), as Google
// hands them out: a new one at every token request and at every sign-in, so
// the old token can be told from the new one. Each carries the scopes the
// account had granted when it was handed out: without calendar.events, an
// insert or a delete gets a 403 for the missing permission. Google can turn a
// token down (a stale one): it then answers 401 to the Calendar API requests
// that carry it. The token each request carried is its call's `authorization`
// in fake.calls. Nothing here reaches the network.
import { randomBytes } from "node:crypto";
import { failures, jsonResponse, type Account, type Call, type FakeGoogle, type Kind, type Outcome } from "./google-fake";

export const READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

const API_KINDS = ["calendarList", "events", "freeBusy", "insert", "delete", "get"] as const satisfies readonly Kind[];
export type ApiKind = (typeof API_KINDS)[number];

/** A token Google handed out: to whom, with what, and the token call (a refresh or a sign-in's code) that got it. */
export type Handed = { token: string; account: Account; scopes: string[]; call: Call; how: "refresh" | "sign-in" };

/**
 * What the token endpoint does with one refresh: hand out a token Google takes
 * ("token"), one it turns down for these requests (or all of them), refuse the
 * refresh token (invalid_grant), fail, or anything else (a function, given a
 * way to hand out a token).
 */
export type Refresh =
  | "token"
  | { turnedDown: ApiKind[] | "all" }
  | "invalid_grant"
  | "server error"
  | ((handOut: () => string) => Outcome | Promise<Outcome>);

/** A sign-in through Google's consent screen, by its code: who, what they granted, and what Google answers. */
export type SignIn = {
  account: Account;
  sub: string;
  email: string;
  name: string;
  scopes: string[];
  /** A new refresh token, or null: Google sends none and keeps the one it gave before. */
  refreshToken: string | null;
  /** expires_in, or null to leave it out. */
  expiresIn: number | null;
};

const idToken = (claims: object) => ["eyJhbGciOiJSUzI1NiJ9", Buffer.from(JSON.stringify(claims)).toString("base64url"), "c2lnbmF0dXJl"].join(".");

export function fakeTokens(fake: FakeGoogle) {
  const handed: Handed[] = [];
  const turnedDown = new Map<string, ApiKind[] | "all">();
  /** What each account granted: the scopes a token handed out now carries. Both by default. */
  const granted = new Map<Account, string[]>();
  /** Refresh tokens a sign-in gave, beside each account's own. */
  const moreRefresh = new Map<string, Account>();
  const queued = new Map<Account, Refresh[]>();
  const signIns = new Map<string, SignIn>();
  /** Per kind, an answer after the token checks; undefined for Google's own. */
  const answer: Partial<Record<ApiKind, (call: Call, token: Handed) => Outcome | Promise<Outcome>>> = {};
  const options = { expiresIn: 3600 as number | null };
  let n = 0;
  let codes = 0;

  const accountOf = (refreshToken: string | null | undefined) =>
    refreshToken ? (moreRefresh.get(refreshToken) ?? fake.accounts.find((a) => a.refreshToken === refreshToken) ?? null) : null;
  const refreshTokensOf = (account: Account) => [account.refreshToken, ...[...moreRefresh].filter(([, a]) => a === account).map(([rt]) => rt)];

  /** The access token a Calendar API call carried. */
  const carried = (call: Call) => call.authorization?.replace(/^Bearer /, "") ?? null;

  function handOut(account: Account, call: Call, how: Handed["how"], scopes: string[]): string {
    const token = `ya29.a0Handed${++n}x${randomBytes(8).toString("hex")}`;
    handed.push({ token, account, scopes: [...scopes], call, how });
    // The fake's own answers know the account by its newest token.
    account.accessToken = token;
    return token;
  }

  const tokenAnswer = (token: string) =>
    jsonResponse(200, {
      access_token: token,
      ...(options.expiresIn === null ? {} : { expires_in: options.expiresIn }),
      token_type: "Bearer",
      scope: handed.find((h) => h.token === token)!.scopes.join(" "),
    });

  async function refresh(call: Call): Promise<Outcome> {
    const account = accountOf(call.form?.get("refresh_token"));
    // Not one of ours: the fake answers, and complains.
    if (!account) return undefined;
    const plan = queued.get(account)?.shift() ?? "token";
    const give = () => handOut(account, call, "refresh", granted.get(account) ?? [READ_SCOPE, EVENTS_SCOPE]);
    if (plan === "token") return tokenAnswer(give());
    if (plan === "invalid_grant") return failures.invalidGrant();
    if (plan === "server error") return failures.tokenServerError();
    if (typeof plan === "function") return plan(give);
    const token = give();
    turnedDown.set(token, plan.turnedDown);
    return tokenAnswer(token);
  }

  function signIn(call: Call): Outcome {
    const s = signIns.get(call.form?.get("code") ?? "");
    if (!s) return jsonResponse(400, { error: "invalid_grant" });
    granted.set(s.account, s.scopes);
    if (s.refreshToken) moreRefresh.set(s.refreshToken, s.account);
    const token = handOut(s.account, call, "sign-in", s.scopes);
    return jsonResponse(200, {
      access_token: token,
      ...(s.expiresIn === null ? {} : { expires_in: s.expiresIn }),
      ...(s.refreshToken ? { refresh_token: s.refreshToken } : {}),
      id_token: idToken({ sub: s.sub, email: s.email, email_verified: true, name: s.name }),
      scope: ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile", ...s.scopes].join(" "),
      token_type: "Bearer",
    });
  }

  /** A calendar's events in the range asked for, for a token that's good but no longer the account's newest. */
  function eventsPage(call: Call): Response {
    const calendarId = decodeURIComponent(call.url.pathname.split("/")[4]);
    const from = Date.parse(call.url.searchParams.get("timeMin") ?? "");
    const to = Date.parse(call.url.searchParams.get("timeMax") ?? "");
    const items = (fake.events.get(calendarId) ?? []).filter((e) => Date.parse(e.start.dateTime) < to && Date.parse(e.end.dateTime) > from);
    return jsonResponse(200, { items: structuredClone(items) });
  }

  async function api(kind: ApiKind, call: Call): Promise<Outcome> {
    const token = carried(call);
    const h = handed.find((x) => x.token === token);
    // A token Google never handed out here: the fake answers, and complains.
    if (!h) return undefined;
    const down = turnedDown.get(h.token);
    if (down === "all" || down?.includes(kind)) return failures.unauthorized();
    if ((kind === "insert" || kind === "delete") && !h.scopes.includes(EVENTS_SCOPE)) return failures.forbidden();
    const custom = await answer[kind]?.(call, h);
    if (custom !== undefined) return custom;
    if (call.account) return undefined;
    // A good token, older than the account's newest: answered as Google answers that account.
    return kind === "events" ? eventsPage(call) : fake.usual({ ...call, account: h.account });
  }

  return {
    handed,
    answer,
    options,
    carried,
    /** Answer token requests and Calendar API requests as above. Call after fake.reset() and fake.install(). */
    install() {
      fake.answer.token = (call) => {
        const grant = call.form?.get("grant_type");
        if (grant === "refresh_token") return refresh(call);
        if (grant === "authorization_code") return signIn(call);
        return undefined;
      };
      for (const kind of API_KINDS) fake.answer[kind] = (call) => api(kind, call);
    },
    reset() {
      handed.length = 0;
      turnedDown.clear();
      granted.clear();
      moreRefresh.clear();
      queued.clear();
      signIns.clear();
      for (const k of Object.keys(answer) as ApiKind[]) delete answer[k];
      options.expiresIn = 3600;
    },
    /** Google answers 401 from now on to requests carrying `token` (of these kinds, or all). */
    turnDown(token: string, kinds: ApiKind[] | "all" = "all") {
      turnedDown.set(token, kinds);
    },
    /** The scopes the account has granted: tokens handed out from now on carry these. */
    grant(account: Account, scopes: string[]) {
      granted.set(account, scopes);
    },
    /** What the next refreshes of the account's refresh tokens get, in order; after them, a token Google takes. */
    next(account: Account, ...plans: Refresh[]) {
      queued.set(account, [...(queued.get(account) ?? []), ...plans]);
    },
    /** Register a sign-in; its authorization code. */
    signIn(s: SignIn): string {
      const code = `code-${++codes}-${randomBytes(4).toString("hex")}`;
      signIns.set(code, s);
      return code;
    },
    /** The tokens handed out to an account, in order. */
    tokensOf: (account: Account) => handed.filter((h) => h.account === account).map((h) => h.token),
    /** The token requests with one of the account's refresh tokens (all of them without one) among `calls`, in order. */
    refreshes(account?: Account, calls: Call[] = fake.calls) {
      return calls.filter(
        (c) =>
          c.kind === "token" &&
          c.form?.get("grant_type") === "refresh_token" &&
          (!account || refreshTokensOf(account).includes(c.form.get("refresh_token") ?? "")),
      );
    },
    /** The token a token call handed out, if it handed one out. */
    handedBy: (call: Call) => handed.find((h) => h.call === call)?.token ?? null,
    /** Where a token is in the order they were handed out; -1 for one never handed out. */
    order: (token: string | null) => handed.findIndex((h) => h.token === token),
  };
}

export type FakeTokens = ReturnType<typeof fakeTokens>;
