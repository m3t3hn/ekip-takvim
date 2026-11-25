import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AvailabilityResponse, StatusResponse } from "@/lib/types";
import {
  HOUR_MS,
  calendarServer,
  calendarText,
  captureConsole,
  googleRefusesEveryToken,
  utcDay,
  utcMidnight,
  vevent,
  type CalendarServer,
} from "./link-helpers";

// The Status page's sign-in list (calendar links part 2, fix round, criterion 1):
// getStatus().signInAgain lists someone only while their Google access is gone
// (a token_error) and a Google calendar of theirs counts, by dataStatus's rule:
// kind google, ticked, and they granted calendar access. Someone whose counted
// calendars are all calendar links is left off, and /api/availability has them
// fine. Links are added through POST /api/me/calendars from a server on
// 127.0.0.1 (CALENDAR_LINKS=private); nothing reaches the network.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const SECRET = "q".repeat(40);
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = SECRET;
process.env.CONFIG_YAML = "timezone: UTC\nhorizon_days: 30\n";
process.env.CALENDAR_LINKS = "private";
delete process.env.DEMO_MODE;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.EXPOSURE;

const { NextRequest } = await import("next/server");
const db = await import("@/lib/server/db");
const secrets = await import("@/lib/server/secrets");
const sync = await import("@/lib/server/sync");
const calendarsRoute = await import("@/app/api/me/calendars/route");
const availabilityRoute = await import("@/app/api/availability/route");
const statusRoute = await import("@/app/api/status/route");

type Entry = StatusResponse["signInAgain"][number];
type User = { id: string; name: string };

const D1 = utcDay(2);
const FEED = calendarText(vevent("standup@side", "Side-job standup", `DTSTART:${D1}T100000Z`, `DTEND:${D1}T103000Z`));
const TODAY = new Date().toISOString().slice(0, 10);

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
  googleRefusesEveryToken();
  server.handle((_req, res) => {
    res.setHeader("Content-Type", "text/calendar");
    res.end(FEED);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env.CALENDAR_LINKS = "private";
});

/** Someone who signed in with Google: a refresh token unless told otherwise, calendar access unless told otherwise. */
function person(name: string, opts: { calendarAccess?: boolean; refreshToken?: boolean } = {}): User {
  n++;
  return db.upsertGoogleUser({
    sub: `g-${n}`,
    email: `p${n}@example.com`,
    name,
    timezone: "Europe/Istanbul",
    refreshToken: opts.refreshToken === false ? null : secrets.encrypt(`1//refresh-${n}`),
    calendarAccess: opts.calendarAccess ?? true,
  }).user;
}

/**
 * Their Google calendar list, as a sync stores it: the primary one ticked, the
 * others not. Each is read fine (one busy block) unless `read` is false.
 */
function googleCalendars(userId: string, list: { id: string; primary?: boolean; access?: "events" | "freebusy"; read?: boolean }[]) {
  db.syncCalendarList(
    userId,
    list.map((c) => ({ id: c.id, summary: c.id, access: c.access ?? "events", primary: !!c.primary })),
  );
  for (const c of list) {
    if (c.read === false) continue;
    const start = utcMidnight(D1) + 6 * HOUR_MS;
    db.setBusy(userId, c.id, [{ start, end: start + HOUR_MS, title: "Work", eventId: `${userId}-${c.id}` }]);
  }
}

/** Tick a calendar of theirs, or untick it, as saving My settings does. */
function tick(userId: string, calendarId: string, included: boolean) {
  const cal = db.listCalendars(userId).find((c) => c.calendar_id === calendarId)!;
  expect(cal, calendarId).toBeDefined();
  db.updateCalendarChoices(userId, [{ id: calendarId, label: cal.label, included }]);
}

/** Add a calendar link through POST /api/me/calendars: it's read there, fine. Returns its id. */
async function addLink(userId: string, tag: string): Promise<string> {
  jar.session = secrets.sessionValue(db.getUser(userId)!).value;
  const before = new Set(db.listCalendars(userId).map((c) => c.calendar_id));
  const res = await calendarsRoute.POST(
    new NextRequest("http://localhost/api/me/calendars", {
      method: "POST",
      body: JSON.stringify({ url: `${server.origin}/feeds/${tag}.ics`, label: `Link ${tag}` }),
      headers: { "Content-Type": "application/json" },
    }),
  );
  expect(res.status, tag).toBe(200);
  const added = db.listCalendars(userId).filter((c) => !before.has(c.calendar_id));
  expect(added, tag).toHaveLength(1);
  expect(added[0]).toMatchObject({ kind: "link", error: null });
  expect(added[0].last_success, tag).toEqual(expect.any(Number));
  return added[0].calendar_id;
}

/** Google said their access is gone. */
function accessGone(user: User, error: string): Entry {
  db.setTokenError(user.id, error);
  return { personId: user.id, person: user.name, error };
}

const byId = (entries: Entry[]) => [...entries].sort((a, b) => a.personId.localeCompare(b.personId));

/** The sign-in list, from getStatus() and as /api/status sends it to the Status page: the same either way. */
async function signInAgain(): Promise<Entry[]> {
  const res = await statusRoute.GET();
  expect(res.status).toBe(200);
  const sent = ((await res.json()) as StatusResponse).signInAgain;
  const direct = sync.getStatus().signInAgain;
  expect(sent).toEqual(direct);
  return byId(direct);
}

/** What /api/availability says of someone's data. */
async function availabilityOf(userId: string) {
  const res = await availabilityRoute.GET(new NextRequest(`http://localhost/api/availability?start=${TODAY}&days=14&tz=UTC`));
  expect(res.status).toBe(200);
  const p = ((await res.json()) as AvailabilityResponse).people.find((x) => x.id === userId)!;
  expect(p, userId).toBeDefined();
  return { data: p.data, stale: p.stale };
}

/** dataStatus's split: of people whose Google access is gone, those whose availability says to sign in again are the ones listed. */
async function sameSplitAsAvailability(withTokenError: User[], listed: Entry[]) {
  const ids = new Set(listed.map((e) => e.personId));
  for (const u of withTokenError) {
    expect((await availabilityOf(u.id)).data === "signInAgain", u.name).toBe(ids.has(u.id));
  }
}

describe("getStatus().signInAgain: the Status page's sign-in list (criterion 1)", () => {
  it("lists someone whose Google access is gone while a Google calendar of theirs counts, by their id, name and error, links beside it or not", async () => {
    // A ticked Google calendar, read fine.
    const ayse = person("Ayşe Demir");
    googleCalendars(ayse.id, [{ id: "ayse@example.com", primary: true }]);
    // A ticked Google calendar not read yet: it counts all the same.
    const burak = person("Burak Çelik");
    googleCalendars(burak.id, [{ id: "burak@example.com", primary: true, read: false }]);
    // Shared with them as free/busy only: still a Google calendar.
    const cem = person("Cem Arslan");
    googleCalendars(cem.id, [{ id: "cem@example.com", primary: true, access: "freebusy" }]);
    // A ticked Google calendar and two calendar links that read fine.
    const deniz = person("Deniz Aydın");
    googleCalendars(deniz.id, [{ id: "deniz@example.com", primary: true }]);
    await addLink(deniz.id, "deniz-1");
    await addLink(deniz.id, "deniz-2");
    // Their primary calendar unticked and another Google calendar ticked, beside an unticked link.
    const emre = person("Emre Koç");
    googleCalendars(emre.id, [{ id: "emre@example.com", primary: true }, { id: "team-emre@group.calendar.google.com" }]);
    tick(emre.id, "emre@example.com", false);
    tick(emre.id, "team-emre@group.calendar.google.com", true);
    tick(emre.id, await addLink(emre.id, "emre"), false);
    // Google access fine: not listed.
    const fatma = person("Fatma Şahin");
    googleCalendars(fatma.id, [{ id: "fatma@example.com", primary: true }]);

    const expected = [
      accessGone(ayse, "Google access expired or was revoked"),
      accessGone(burak, "Token has been expired or revoked."),
      accessGone(cem, "Account has been deleted"),
      accessGone(deniz, "Google access expired or was revoked (deniz)"),
      accessGone(emre, "invalid_grant"),
    ];
    const listed = await signInAgain();
    expect(listed).toEqual(byId(expected));
    await sameSplitAsAvailability([ayse, burak, cem, deniz, emre], listed);
  });

  it("leaves off someone whose Google access is gone when their counted calendars are all calendar links that read fine; /api/availability has them ok and not stale", async () => {
    // One calendar link and nothing else.
    const gul = person("Gül Yıldız");
    await addLink(gul.id, "gul");
    // Two calendar links.
    const hakan = person("Hakan Öz");
    await addLink(hakan.id, "hakan-1");
    await addLink(hakan.id, "hakan-2");
    // Google calendars, all unticked, and a ticked link.
    const irem = person("İrem Kara");
    googleCalendars(irem.id, [{ id: "irem@example.com", primary: true }, { id: "irem-other@example.com" }]);
    tick(irem.id, "irem@example.com", false);
    await addLink(irem.id, "irem");
    // A ticked Google calendar without calendar access granted, and a link.
    const kaan = person("Kaan Polat", { calendarAccess: false });
    googleCalendars(kaan.id, [{ id: "kaan@example.com", primary: true }]);
    await addLink(kaan.id, "kaan");
    // A ticked Google calendar beside a link: listed.
    const leyla = person("Leyla Tan");
    googleCalendars(leyla.id, [{ id: "leyla@example.com", primary: true }]);
    await addLink(leyla.id, "leyla");

    for (const u of [gul, hakan, irem, kaan]) accessGone(u, "Google access expired or was revoked");
    const leylaEntry = accessGone(leyla, "Google access expired or was revoked");

    const listed = await signInAgain();
    expect(listed).toEqual([leylaEntry]);
    for (const u of [gul, hakan, irem, kaan]) {
      expect(await availabilityOf(u.id), u.name).toEqual({ data: "ok", stale: false });
    }
    await sameSplitAsAvailability([gul, hakan, irem, kaan, leyla], listed);
  });

  it("leaves off someone whose Google access is gone when no Google calendar of theirs counts, links or not", async () => {
    // A ticked Google calendar, but no calendar access granted.
    const mert = person("Mert Acar", { calendarAccess: false });
    googleCalendars(mert.id, [{ id: "mert@example.com", primary: true }]);
    // Google calendars, all unticked.
    const nur = person("Nur Başak");
    googleCalendars(nur.id, [{ id: "nur@example.com", primary: true }, { id: "nur-team@example.com" }]);
    tick(nur.id, "nur@example.com", false);
    // No calendar at all.
    const okan = person("Okan Er");
    // Only an unticked calendar link.
    const pinar = person("Pınar Su");
    tick(pinar.id, await addLink(pinar.id, "pinar"), false);
    // Google calendars and a link, all unticked.
    const recep = person("Recep Uçar");
    googleCalendars(recep.id, [{ id: "recep@example.com", primary: true }]);
    tick(recep.id, "recep@example.com", false);
    tick(recep.id, await addLink(recep.id, "recep"), false);
    // A ticked Google calendar: listed.
    const rana = person("Rana Ece");
    googleCalendars(rana.id, [{ id: "rana@example.com", primary: true }]);

    for (const u of [mert, nur, okan, pinar, recep]) accessGone(u, "Google access expired or was revoked");
    const ranaEntry = accessGone(rana, "Google access expired or was revoked");

    const listed = await signInAgain();
    expect(listed).toEqual([ranaEntry]);
    await sameSplitAsAvailability([mert, nur, okan, pinar, recep, rana], listed);
  });

  it("while CALENDAR_LINKS is off, leaves off someone counting only calendar links and still lists someone counting a Google calendar", async () => {
    const selin = person("Selin Uz");
    await addLink(selin.id, "selin");
    // Google calendars unticked, a link ticked.
    const sinan = person("Sinan Ay");
    googleCalendars(sinan.id, [{ id: "sinan@example.com", primary: true }]);
    tick(sinan.id, "sinan@example.com", false);
    await addLink(sinan.id, "sinan");
    const tolga = person("Tolga Ak");
    googleCalendars(tolga.id, [{ id: "tolga@example.com", primary: true }]);
    await addLink(tolga.id, "tolga");
    accessGone(selin, "Google access expired or was revoked");
    accessGone(sinan, "Google access expired or was revoked");
    const tolgaEntry = accessGone(tolga, "Google access expired or was revoked");

    for (const setting of ["off", "OFF", "nonsense"]) {
      process.env.CALENDAR_LINKS = setting;
      const listed = await signInAgain();
      expect(listed, setting).toEqual([tolgaEntry]);
      await sameSplitAsAvailability([selin, sinan, tolga], listed);
    }
  });

  it("lists no one without a token error, whatever their calendars, and someone as soon as Google says their access is gone", async () => {
    // Google access fine, a Google calendar and a link.
    const umut = person("Umut Gök");
    googleCalendars(umut.id, [{ id: "umut@example.com", primary: true }]);
    await addLink(umut.id, "umut");
    // No refresh token and no token error, a ticked Google calendar not read.
    const veli = person("Veli Ay", { refreshToken: false });
    googleCalendars(veli.id, [{ id: "veli@example.com", primary: true, read: false }]);
    expect(await signInAgain()).toEqual([]);

    const umutEntry = accessGone(umut, "Google access expired or was revoked");
    expect(await signInAgain()).toEqual([umutEntry]);
  });

  it("follows what counts: unticking their last Google calendar, or no calendar access, takes them off the list; ticking one puts them back", async () => {
    const yasemin = person("Yasemin Ok");
    googleCalendars(yasemin.id, [{ id: "yasemin@example.com", primary: true }]);
    await addLink(yasemin.id, "yasemin");
    const entry = accessGone(yasemin, "Google access expired or was revoked");
    expect(await signInAgain()).toEqual([entry]);

    tick(yasemin.id, "yasemin@example.com", false);
    expect(await signInAgain()).toEqual([]);
    expect(await availabilityOf(yasemin.id)).toEqual({ data: "ok", stale: false });

    tick(yasemin.id, "yasemin@example.com", true);
    expect(await signInAgain()).toEqual([entry]);
    expect((await availabilityOf(yasemin.id)).data).toBe("signInAgain");

    db.db().prepare("UPDATE users SET calendar_access = 0 WHERE id = ?").run(yasemin.id);
    expect(await signInAgain()).toEqual([]);
    expect(await availabilityOf(yasemin.id)).toEqual({ data: "ok", stale: false });
  });
});
