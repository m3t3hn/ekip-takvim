import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AvailabilityResponse, MySettings, StatusResponse } from "@/lib/types";
import {
  calendarServer,
  calendarText,
  captureConsole,
  closedPort,
  googleRefusesEveryToken,
  utcDay,
  vevent,
  type CalendarServer,
  type Handler,
} from "./link-helpers";

// A calendar link that stopped working (calendar links part 2, fix round,
// criterion 2). Read again after it was added, by syncOne (POST /api/me/sync,
// PUT /api/me) or the sync round, an answer of 401, 403 or 404 is stored on the
// calendar as "remove this calendar and add the new link": a calendar can't take
// a new link. Adding a link that answers so still says to copy it again, and
// every other failure keeps the message it had at 9812894, when adding and when
// stored. Calendars are served from 127.0.0.1 (CALENDAR_LINKS=private); nothing
// reaches the network.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const SECRET = "r".repeat(40);
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = SECRET;
// At refresh_minutes 10 or more every round reads every link, as before sync
// every minute: "the sync round" reads a link right after it was added.
process.env.CONFIG_YAML = "timezone: UTC\nhorizon_days: 30\nrefresh_minutes: 10\n";
process.env.CALENDAR_LINKS = "private";
delete process.env.DEMO_MODE;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.EXPOSURE;

const { NextRequest } = await import("next/server");
const db = await import("@/lib/server/db");
const secrets = await import("@/lib/server/secrets");
const sync = await import("@/lib/server/sync");
const meRoute = await import("@/app/api/me/route");
const meSyncRoute = await import("@/app/api/me/sync/route");
const calendarsRoute = await import("@/app/api/me/calendars/route");
const availabilityRoute = await import("@/app/api/availability/route");
const statusRoute = await import("@/app/api/status/route");

/** Stored on a calendar link, already added, that a later read finds reset. */
const RESET_STORED = "The link didn't work. It may have been reset: remove this calendar and add the new link.";
/** The answer to adding a link that is reset: as at 9812894. */
const RESET_ADDING = "The link didn't work. It may have been reset; copy it again.";
/** Every other failure's message at 9812894, the same when adding and when stored. */
const AT_9812894 = {
  http: (status: number) => `The calendar's server answered ${status}.`,
  invalid: "That doesn't look like a calendar link.",
  blocked: "That link points to a private network address, which this server doesn't allow.",
  unreachable: "Couldn't reach that address.",
  timeout: "The calendar took too long to answer.",
  tooLarge: "That calendar is too big.",
  tooManyRedirects: "That link redirects too many times.",
  notCalendar: "That address didn't return a calendar.",
  unreadable: "Couldn't read that calendar.",
  secretChanged: "This server's secret changed, so the stored link can't be read. Remove this calendar and add its link again.",
};
const RESET_CODES = [401, 403, 404];
const OTHER_CODES = [400, 402, 405, 410, 429, 500, 502, 503];

// Every link's path and query carry these, and so do the redirects: no message may.
const PATH_MARK = "PathSecret";
const QUERY_MARK = "QuerySecret";
const REDIRECT_MARK = "RedirSecret";
const SECRET_MARKS = /PathSecret|QuerySecret|RedirSecret/i;

const D1 = utcDay(2);
const D2 = utcDay(3);
const FEED = calendarText(
  vevent("standup@side", "Side-job standup", `DTSTART:${D1}T100000Z`, `DTEND:${D1}T103000Z`),
  vevent("client@side", "Client call", `DTSTART:${D2}T140000Z`, `DTEND:${D2}T150000Z`),
);
const VERSION = { etag: '"v1"', lastModified: "Thu, 12 Nov 2026 09:00:00 GMT" };
const TODAY = new Date().toISOString().slice(0, 10);
const realSetTimeout = globalThis.setTimeout;

type Answer = { status: number; text: string; json: unknown };
type Row = Record<string, unknown>;

let server: CalendarServer;
let n = 0;

beforeAll(async () => {
  captureConsole();
  server = await calendarServer();
  // The sync loop starts here, without Google: it reads nothing.
  sync.ensureStarted();
  await sync.syncNow();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  db.resetAll();
  jar.session = undefined;
  server.hits.length = 0;
  googleRefusesEveryToken();
  server.handle(plainFeed);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env.CALENDAR_LINKS = "private";
  process.env.SESSION_SECRET = SECRET;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

// ---------------------------------------------------------------------------
// What the calendar server does.

const plainFeed: Handler = (_req, res) => {
  res.setHeader("Content-Type", "text/calendar");
  res.end(FEED);
};
/** The feed with a version, so the next read within a day asks what changed. */
const versionedFeed: Handler = (_req, res) => {
  res.setHeader("ETag", VERSION.etag);
  res.setHeader("Last-Modified", VERSION.lastModified);
  res.setHeader("Content-Type", "text/calendar");
  res.end(FEED);
};
/** Answers `code`, echoing what it was asked for. */
const answers =
  (code: number): Handler =>
  (req, res) => {
    res.statusCode = code;
    res.setHeader("X-Requested", req.url ?? "");
    if (code === 304) return void res.end();
    res.end(`${code} for ${req.url}`);
  };
/** Redirects once, to an address on the same link that answers `code`. */
const redirectThen =
  (code: number): Handler =>
  (req, res) => {
    if (req.url?.includes(REDIRECT_MARK)) return answers(code)(req, res);
    res.statusCode = 302;
    res.setHeader("Location", `${req.url!.split("?")[0]}-${REDIRECT_MARK}?r=${REDIRECT_MARK}`);
    res.end();
  };
/** Asked what changed since VERSION: answers `code`; asked for the whole calendar: the feed. */
const conditionalThen =
  (code: number): Handler =>
  (req, res) => {
    if (req.headers["if-none-match"] === VERSION.etag) return answers(code)(req, res);
    versionedFeed(req, res);
  };
const redirectWithoutLocation: Handler = (_req, res) => {
  res.statusCode = 302;
  res.end();
};
const redirectToFtp: Handler = (_req, res) => {
  res.statusCode = 302;
  res.setHeader("Location", `ftp://127.0.0.1/${REDIRECT_MARK}.ics`);
  res.end();
};
const redirectLoop: Handler = (req, res) => {
  res.statusCode = 302;
  res.setHeader("Location", `${req.url!.split("?")[0]}x?r=${REDIRECT_MARK}`);
  res.end();
};
const hangUp: Handler = (req) => {
  req.socket.destroy();
};
const neverAnswers: Handler = () => {};
const tooLarge: Handler = (_req, res) => {
  res.setHeader("Content-Type", "text/calendar");
  res.setHeader("Content-Length", String(64 * 1024 * 1024));
  res.write("BEGIN:VCALENDAR\r\n");
};
const html: Handler = (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(`<html><body>Sign in to see ${req.url}</body></html>`);
};
const brokenCalendar: Handler = (_req, res) => {
  res.setHeader("Content-Type", "text/calendar");
  res.end("BEGIN:VCALENDARX\r\nVERSION:2.0\r\nEND:VCALENDARX\r\n");
};

type Failure = {
  name: string;
  /** What it says, as at 9812894 unless it's the reset. */
  message: string;
  handler?: Handler;
  /** Set for the read, and put back after it. */
  env?: Record<string, string>;
  /** The server never answers: the read's deadline is brought forward. */
  hangs?: boolean;
  /** Adding only: the link given, when it isn't one on the test server. */
  url?: () => Promise<string>;
};

/** Failures of a link already added, read again, other than the reset. */
const STORED_OTHERS: Failure[] = [
  ...OTHER_CODES.map((code) => ({ name: `answers ${code}`, message: AT_9812894.http(code), handler: answers(code) })),
  { name: "a redirect that ends in 410", message: AT_9812894.http(410), handler: redirectThen(410) },
  { name: "a 302 without a Location", message: AT_9812894.http(302), handler: redirectWithoutLocation },
  { name: "a 304 to a request that didn't ask what changed", message: AT_9812894.http(304), handler: answers(304) },
  { name: "a redirect to an address that isn't http", message: AT_9812894.invalid, handler: redirectToFtp },
  { name: "a private address while CALENDAR_LINKS=on", message: AT_9812894.blocked, env: { CALENDAR_LINKS: "on" } },
  { name: "the connection dropped", message: AT_9812894.unreachable, handler: hangUp },
  { name: "no answer", message: AT_9812894.timeout, handler: neverAnswers, hangs: true },
  { name: "too big", message: AT_9812894.tooLarge, handler: tooLarge },
  { name: "redirects without end", message: AT_9812894.tooManyRedirects, handler: redirectLoop },
  { name: "a page that isn't a calendar", message: AT_9812894.notCalendar, handler: html },
  { name: "a calendar that can't be read", message: AT_9812894.unreadable, handler: brokenCalendar },
  { name: "SESSION_SECRET changed", message: AT_9812894.secretChanged, env: { SESSION_SECRET: "another secret, at least 32 characters long" } },
];

/** Failures while adding a link, other than the reset. */
const ADDING_OTHERS: Failure[] = [
  ...STORED_OTHERS.filter((f) => !f.env?.SESSION_SECRET),
  { name: "not a link", message: AT_9812894.invalid, url: async () => `ftp://127.0.0.1/${PATH_MARK}.ics?token=${QUERY_MARK}` },
  {
    name: "nothing listens there",
    message: AT_9812894.unreachable,
    url: async () => `http://127.0.0.1:${await closedPort()}/${PATH_MARK}-closed/${PATH_MARK}.ics?token=${QUERY_MARK}`,
  },
];

// ---------------------------------------------------------------------------
// Through the API, as the signed-in person.

async function parse(res: Response): Promise<Answer> {
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json };
}

const signIn = (userId: string) => {
  jar.session = secrets.sessionValue(db.getUser(userId)!).value;
};
const getMe = async () => parse(await meRoute.GET());
const putMe = async (body: unknown) =>
  parse(await meRoute.PUT(new NextRequest("http://localhost/api/me", { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } })));
const refreshMe = async () => parse(await meSyncRoute.POST());
const post = async (body: unknown) =>
  parse(
    await calendarsRoute.POST(
      new NextRequest("http://localhost/api/me/calendars", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    ),
  );
const status = async () => parse(await statusRoute.GET());
const availability = async () =>
  parse(await availabilityRoute.GET(new NextRequest(`http://localhost/api/availability?start=${TODAY}&days=14&tz=UTC`)));
const settings = (a: Answer) => a.json as MySettings;

/** A link on the test server whose path and query are marked secret. */
const secretLink = (tag: string) => `${server.origin}/${PATH_MARK}-${tag}/${PATH_MARK}.ics?token=${QUERY_MARK}-${tag}`;
const hitsFor = (tag: string) => server.hits.filter((h) => h.url.includes(`/${PATH_MARK}-${tag}/`));
const linkCalendars = (userId: string) => db.listCalendars(userId).filter((c) => c.kind === "link");
const busyRows = (calendarId: string) => db.db().prepare("SELECT * FROM busy WHERE calendar_id = ? ORDER BY rowid").all(calendarId) as Row[];

/** Someone new, without Google: only their calendar link is ever read. */
function newPerson() {
  n++;
  return db.upsertGoogleUser({ sub: `g-${n}`, email: `p${n}@example.com`, name: `Person ${n}`, timezone: "Europe/Istanbul", refreshToken: null, calendarAccess: true })
    .user;
}

/** How a link already added is read again. */
const READERS = {
  "POST /api/me/sync": async (userId: string) => {
    signIn(userId);
    expect((await refreshMe()).status).toBe(200);
  },
  "PUT /api/me": async (userId: string) => {
    signIn(userId);
    const mine = settings(await getMe());
    const saved = await putMe({
      team: null,
      timezone: mine.timezone,
      color: mine.color,
      calendars: mine.calendars.map((c) => ({ id: c.id, label: c.label, included: c.included })),
    });
    expect(saved.status).toBe(200);
  },
  "syncOne": async (userId: string) => {
    await sync.syncOne(userId);
  },
  "the sync round": async () => {
    process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    await sync.syncNow();
  },
} satisfies Record<string, (userId: string) => Promise<void>>;
type Reader = keyof typeof READERS;
const READER_NAMES = Object.keys(READERS) as Reader[];

type Added = { userId: string; tag: string; id: string; rows: Row[]; lastSuccess: number };

/** Someone who added one calendar link through POST /api/me/calendars, read fine there. */
async function added(tag: string, handler: Handler = plainFeed): Promise<Added> {
  const user = newPerson();
  server.handle(handler);
  signIn(user.id);
  const res = await post({ url: secretLink(tag), label: "Side job" });
  expect(res.status, tag).toBe(200);
  const [cal] = linkCalendars(user.id);
  expect(cal.error, tag).toBeNull();
  const rows = busyRows(cal.calendar_id);
  expect(rows, tag).toHaveLength(2);
  expect(hitsFor(tag), tag).toHaveLength(1);
  return { userId: user.id, tag, id: cal.calendar_id, rows, lastSuccess: cal.last_success! };
}

/** Run `work` with the failure's settings, then put them back. */
async function withEnv<T>(env: Record<string, string> | undefined, work: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env ?? {}).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await work();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Run `start`; when the server never answers, bring the read's deadline forward once the link is asked for. */
async function settle<T>(tag: string, hangs: boolean | undefined, start: () => Promise<T>): Promise<T> {
  if (!hangs) return start();
  const asked = hitsFor(tag).length;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const pending = start();
    for (let i = 0; hitsFor(tag).length === asked; i++) {
      if (i > 500) throw new Error(`${tag}: the link was never asked for`);
      await new Promise((r) => realSetTimeout(r, 10));
    }
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

/** Read the link of `a` again on `reader`, while it fails so. */
async function readFailing(a: Added, reader: Reader, failure: Pick<Failure, "handler" | "env" | "hangs">) {
  server.handle(failure.handler ?? plainFeed);
  await withEnv(failure.env, () => settle(a.tag, failure.hangs, () => READERS[reader](a.userId)));
  server.handle(plainFeed);
}

/** What its owner's My settings (GET /api/me) and the Status page (/api/status) show for the calendar. Neither holds anything of the link. */
async function shown(a: Added) {
  signIn(a.userId);
  const me = await getMe();
  expect(me.status).toBe(200);
  const mine = settings(me).calendars.find((c) => c.id === a.id)!;
  expect(mine).toBeDefined();
  const st = await status();
  const rows = (st.json as StatusResponse).calendars.filter((c) => c.personId === a.userId && c.kind === "link");
  expect(rows).toHaveLength(1);
  expect(me.text).not.toMatch(SECRET_MARKS);
  expect(st.text).not.toMatch(SECRET_MARKS);
  return { settings: { state: mine.state, error: mine.error }, status: { state: rows[0].state, error: rows[0].error } };
}

/** The calendar shows `message` as its error, and keeps its blocks and last success. */
async function expectStored(a: Added, message: string, label: string) {
  expect(await shown(a), label).toEqual({ settings: { state: "error", error: message }, status: { state: "error", error: message } });
  expect(busyRows(a.id), label).toEqual(a.rows);
  expect(linkCalendars(a.userId)[0].last_success, label).toBe(a.lastSuccess);
  const owner = ((await availability()).json as AvailabilityResponse).people.find((p) => p.id === a.userId)!;
  expect(owner.busy.filter((b) => b.label === "Side job"), label).toHaveLength(2);
}

/** Add a link that fails so: the answer's status and error. Nothing is added. */
async function addFailing(tag: string, failure: Failure): Promise<{ status: number; error: unknown }> {
  const user = newPerson();
  signIn(user.id);
  server.handle(failure.handler ?? plainFeed);
  const url = failure.url ? await failure.url() : secretLink(tag);
  const res = await withEnv(failure.env, () => settle(tag, failure.hangs, () => post({ url, label: "Side job" })));
  server.handle(plainFeed);
  expect(linkCalendars(user.id), tag).toEqual([]);
  expect(res.text, tag).not.toMatch(SECRET_MARKS);
  return { status: res.status, error: (res.json as { error?: unknown }).error };
}

const slug = (name: string) => name.replace(/[^a-z0-9]+/gi, "-");

// ---------------------------------------------------------------------------

describe("a calendar link already added that answers 401, 403 or 404 when read again (criterion 2)", () => {
  it.each(READER_NAMES)("stores the message to remove it and add the new link, on My settings and the Status page, and keeps its blocks: %s", async (reader) => {
    for (const code of RESET_CODES) {
      db.resetAll();
      const a = await added(`reset-${code}`);
      await readFailing(a, reader, { handler: answers(code) });
      expect(hitsFor(a.tag), `${code}`).toHaveLength(2);
      await expectStored(a, RESET_STORED, `${reader}, ${code}`);
    }
  });

  it.each(READER_NAMES)("the same at the end of a redirect: %s", async (reader) => {
    for (const code of RESET_CODES) {
      db.resetAll();
      const a = await added(`redirected-${code}`);
      await readFailing(a, reader, { handler: redirectThen(code) });
      expect(hitsFor(a.tag).map((h) => h.url.includes(REDIRECT_MARK)), `${code}`).toEqual([false, false, true]);
      await expectStored(a, RESET_STORED, `${reader}, redirect to ${code}`);
    }
  });

  it.each(READER_NAMES)("the same for a request asking what changed; another code there keeps its message: %s", async (reader) => {
    for (const [code, message] of [...RESET_CODES.map((c) => [c, RESET_STORED] as const), [410, AT_9812894.http(410)] as const, [500, AT_9812894.http(500)] as const]) {
      db.resetAll();
      const a = await added(`conditional-${code}`, versionedFeed);
      await readFailing(a, reader, { handler: conditionalThen(code) });
      const hits = hitsFor(a.tag);
      expect(hits, `${code}`).toHaveLength(2);
      expect(hits[1].headers["if-none-match"], `${code}`).toBe(VERSION.etag);
      expect(hits[1].headers["if-modified-since"], `${code}`).toBe(VERSION.lastModified);
      await expectStored(a, message, `${reader}, conditional ${code}`);
    }
  });
});

describe("adding a calendar link (criterion 2)", () => {
  it("that answers 401, 403 or 404, at once or after a redirect, is still refused with 400 and the message to copy it again", async () => {
    for (const code of RESET_CODES) {
      for (const [how, handler] of [
        ["at once", answers(code)],
        ["after a redirect", redirectThen(code)],
      ] as const) {
        const tag = `add-${code}-${slug(how)}`;
        expect(await addFailing(tag, { name: tag, message: RESET_ADDING, handler }), `${code} ${how}`).toEqual({ status: 400, error: RESET_ADDING });
        expect(hitsFor(tag).length, `${code} ${how}`).toBe(how === "at once" ? 1 : 2);
      }
    }
  });

  it.each(ADDING_OTHERS.map((f) => [f.name, f] as const))("keeps its message at 9812894 for every other failure: %s", async (_name, failure) => {
    const tag = `add-${slug(failure.name)}`;
    expect(await addFailing(tag, failure)).toEqual({ status: 400, error: failure.message });
  });
});

describe("every other failure of a calendar link already added keeps its message at 9812894 (criterion 2)", () => {
  it.each(READER_NAMES)("stored, shown on My settings and the Status page, its blocks kept: %s", async (reader) => {
    for (const failure of STORED_OTHERS) {
      db.resetAll();
      const a = await added(`stored-${slug(failure.name)}`);
      await readFailing(a, reader, failure);
      await expectStored(a, failure.message, `${reader}: ${failure.name}`);
    }
  });
});
