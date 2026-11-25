import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bookingApp } from "./booking-helpers";
import { EVENTS_SCOPE, READ_SCOPE, inTheDemo, withGoogle } from "./booking-google-helpers";
import { failures, fakeGoogle, jsonResponse } from "./google-fake";
import { captureConsole } from "./link-helpers";
import { NextRouter, type Router } from "./next-router";
import { collapse, fakeBrowser, mount, textOf, type HostNode, type Ui } from "./ui-harness";

// Booking links' quick wins on the host's side (run 2026-11-25-ekip-quick-wins-host),
// criterion 5: Allow access names Google's box, and always comes back to
// /settings#booking with one note, shown once. Signing in is as before
// (criterion 5's last line, and 9). Written from the criteria; the routes and
// the page were read only for how they're called.
//
// The routes are called as Next calls them, Google is the fake behind fetch,
// and My settings is SettingsPage called with the searchParams of the address
// the callback sent the host to.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
/** The router useRouter() gives: the stand-in for Next's (./next-router) while a test has one mounted. */
const nav = vi.hoisted(() => ({ router: null as null | Record<string, unknown> }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => nav.router ?? { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} },
}));

const APP_URL = "https://cal.example.com";
const CONFIG = "timezone: Europe/Istanbul\nhorizon_days: 30\n";
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "w".repeat(40);
process.env.CONFIG_YAML = CONFIG;
process.env.CALENDAR_LINKS = "private";
process.env.BOOKING_LINKS = "on";
process.env.APP_URL = APP_URL;
delete process.env.EXPOSURE;
withGoogle();

const app = await bookingApp(jar);
const { db, NextRequest } = app;
const fake = fakeGoogle();
const googleRoute = await import("@/app/auth/google/route");
const callbackRoute = await import("@/app/auth/google/callback/route");
const { default: SettingsPage } = await import("@/app/settings/page");
const { BookingLinks } = await import("@/components/booking-links");

const BOX = "View and edit events on all your calendars";
const NOTES = {
  granted: "Done: your booking links can take bookings.",
  missing: `Google didn't give the permission. Press Allow access again and tick ${BOX}.`,
  cancelled: "Access wasn't allowed. Nothing changed.",
};
/** The note, whether or not the box's name is in quote marks. */
const reads = (text: string, note: string) => {
  const unquoted = text.replace(new RegExp(`[“"‘']${BOX}[”"’']`, "g"), BOX);
  return collapse(unquoted) === note;
};

const PERSON = { sub: "g-allow-1", email: "allow.host@example.com", name: "Allow Host" };
const REFRESH = "1//allow-refresh-token";
const GOOGLE_EMAIL = "https://www.googleapis.com/auth/userinfo.email";
const GOOGLE_PROFILE = "https://www.googleapis.com/auth/userinfo.profile";

let lines: string[] = [];
beforeAll(() => {
  lines = captureConsole();
});
beforeEach(() => {
  db.resetAll();
  app.signOut();
  fake.reset();
  fake.install();
  withGoogle();
});
afterEach(async () => {
  await fake.idle();
  nav.router = null;
  vi.unstubAllGlobals();
  process.env.BOOKING_LINKS = "on";
  process.env.CONFIG_YAML = CONFIG;
  process.env.APP_URL = APP_URL;
  withGoogle();
  expect(fake.problems).toEqual([]);
});

const idToken = (claims: object) =>
  ["eyJhbGciOiJSUzI1NiJ9", Buffer.from(JSON.stringify(claims)).toString("base64url"), "c2lnbmF0dXJl"].join(".");

/** Google answers the code with the person's tokens and the scopes this sign-in granted. */
function grants(scopes: string[], who: { sub: string; email: string; name: string; hd?: string } = PERSON) {
  const account = fake.accounts.find((a) => a.refreshToken === REFRESH) ?? fake.account({ refreshToken: REFRESH, primary: who.email });
  fake.answer.token = (call) =>
    call.form?.get("grant_type") === "authorization_code"
      ? jsonResponse(200, {
          access_token: account.accessToken,
          refresh_token: REFRESH,
          id_token: idToken({ sub: who.sub, email: who.email, email_verified: true, name: who.name, ...(who.hd ? { hd: who.hd } : {}) }),
          scope: ["openid", GOOGLE_EMAIL, GOOGLE_PROFILE, ...scopes].join(" "),
          token_type: "Bearer",
          expires_in: 3599,
        })
      : undefined;
}

/** GET /auth/google with `query`: where it sends the browser, and the state cookie it set. */
function start(query: string) {
  const res = googleRoute.GET(new NextRequest(`${APP_URL}/auth/google${query}`));
  expect(res.status).toBeGreaterThanOrEqual(300);
  expect(res.status).toBeLessThan(400);
  return { location: new URL(res.headers.get("location")!), cookie: res.cookies.get("ekip_oauth_state")?.value ?? null };
}

/** Google sends the browser back to the callback with `query`, carrying `cookie` as the state cookie. */
async function back(query: string, cookie: string | null) {
  const res = await callbackRoute.GET(
    new NextRequest(`${APP_URL}/auth/google/callback?${query}`, cookie === null ? {} : { headers: { cookie: `ekip_oauth_state=${cookie}` } }),
  );
  await fake.idle();
  expect(res.status).toBeGreaterThanOrEqual(300);
  expect(res.status).toBeLessThan(400);
  const session = res.cookies.get("ekip_session")?.value;
  // The browser keeps the session it's given, as it would.
  if (session) jar.session = session;
  return { location: new URL(res.headers.get("location")!), session: session ?? null, stateCookie: res.cookies.get("ekip_oauth_state") };
}

/** Sign in with Google: start (with `query`), then Google comes back with a code and the state. */
async function signIn(query: string, scopes: string[], who = PERSON) {
  const { location, cookie } = start(query);
  const state = location.searchParams.get("state")!;
  grants(scopes, who);
  return back(`code=c0de&state=${encodeURIComponent(state)}`, cookie);
}

/** Someone already here, signed in with calendar access and nothing for booking links. */
async function signedInHost() {
  const first = await signIn("", [READ_SCOPE]);
  expect(first.session).toBeTruthy();
  const user = db.listUsers().find((u) => u.google_sub === PERSON.sub)!;
  expect(user.booking_access).toBe(0);
  return user;
}

/** Press Allow access, then on Google's screen: tick the box, leave it unticked, or cancel. */
async function allowAccess(outcome: "granted" | "missing" | "cancelled") {
  const { location, cookie } = start("?booking=1");
  expect(location.origin).toBe("https://accounts.google.com");
  const state = location.searchParams.get("state")!;
  if (outcome === "cancelled") return back(`error=access_denied&state=${encodeURIComponent(state)}`, cookie);
  grants(outcome === "granted" ? [READ_SCOPE, EVENTS_SCOPE] : [READ_SCOPE]);
  return back(`code=c0de&state=${encodeURIComponent(state)}&scope=${encodeURIComponent("openid email profile")}`, cookie);
}

/** The address holds the way back and a word for how it went, nothing about the person. */
function expectNoPersonalData(location: URL) {
  const href = decodeURIComponent(location.href);
  for (const secret of [PERSON.email, PERSON.name, PERSON.sub, "c0de", REFRESH, "access_denied", "allow.host"]) {
    expect(href, `the address holds ${secret}`).not.toContain(secret);
  }
  expect(location.origin).toBe(APP_URL);
  for (const [key, value] of location.searchParams) {
    expect(value, `?${key}=`).toMatch(/^[a-z]{1,20}$/);
  }
  expect(href).not.toMatch(/state=|token|session/i);
}

/** searchParams as Next gives them to a page: a key given more than once is an array. */
function query(location: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(location.searchParams.keys())) {
    const all = location.searchParams.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}

/** My settings at `location`, as the server renders it for the signed-in host: its booking links section. */
async function settingsAt(location: URL) {
  const page = await SettingsPage({ params: Promise.resolve({}), searchParams: Promise.resolve(query(location)) } as never);
  const ui = await mount(page, { effects: false });
  const html = renderToStaticMarkup(page).replace(/<!-- -->/g, "");
  return { ui, html, section: sectionOf(ui), page };
}

function sectionOf(ui: Ui): HostNode {
  const heading = ui.get((n) => /^h[1-6]$/.test(n.tag) && collapse(textOf(n)) === "Booking links", "Booking links heading");
  let n: HostNode | null = heading;
  while (n && n.tag !== "section") n = n.parent;
  return n ?? heading.parent!;
}

/** What `withNote` has that `without` doesn't, when that's one piece of text; null when they're the same. */
function added(without: string, withNote: string): string | null {
  if (without === withNote) return null;
  let start = 0;
  while (start < without.length && without[start] === withNote[start]) start++;
  let end = 0;
  while (end < without.length - start && without[without.length - 1 - end] === withNote[withNote.length - 1 - end]) end++;
  if (start + end !== without.length) throw new Error(`test: more than one change:\n${without}\n${withNote}`);
  return collapse(withNote.slice(start, withNote.length - end));
}

/**
 * The note My settings shows at `location`, compared with the same page
 * without ?access=: null when the section is exactly as without, markup and all.
 */
async function noteAt(location: URL): Promise<string | null> {
  const plain = new URL(location);
  plain.search = "";
  const without = (await settingsAt(plain)).ui;
  const withNote = (await settingsAt(location)).ui;
  const [a, b] = [sectionOf(without), sectionOf(withNote)];
  if (without.html(a) === withNote.html(b)) return null;
  // Something was added: say what it reads, even if that's nothing.
  return added(without.text(a), withNote.text(b)) ?? "";
}

const occurrences = (text: string, part: string) => text.split(part).length - 1;
const userRow = () => db.db().prepare("SELECT * FROM users WHERE google_sub = ?").get(PERSON.sub) as Record<string, unknown>;

describe("the note above the links (criterion 5)", () => {
  it("names the box to tick on Google's screen, and still says what the access is for and that nothing else changes", async () => {
    await signedInHost();
    const { ui, section } = await settingsAt(new URL(`${APP_URL}/settings`));
    const allow = ui.getNamed("Allow access", section);
    expect(allow.props.href).toBe("/auth/google?booking=1");
    // The smallest part of the section that holds Allow access and words about Google Calendar.
    let note: HostNode = allow;
    while (note.parent && !/Google Calendar/.test(textOf(note))) note = note.parent;
    const text = collapse(textOf(note));
    expect(text).toContain(BOX);
    expect(text).toMatch(/tick/i);
    expect(text).toMatch(/booked meeting/i);
    expect(text).toMatch(/Google Calendar/);
    expect(text).toMatch(/nothing else/i);
    // Above the links.
    const list = ui.get((n) => n.tag === "ul", "the list of links", section);
    const order = ui.all(section);
    expect(order.indexOf(note)).toBeLessThan(order.indexOf(list));
  });
});

describe("coming back from Allow access (criterion 5)", () => {
  it("access given: back to /settings#booking with “Done: your booking links can take bookings.”, once", async () => {
    await signedInHost();
    const { location } = await allowAccess("granted");
    expect([location.pathname, location.hash]).toEqual(["/settings", "#booking"]);
    expectNoPersonalData(location);
    expect(userRow().booking_access).toBe(1);
    const note = await noteAt(location);
    expect(note, "one note").not.toBeNull();
    expect(reads(note!, NOTES.granted), note!).toBe(true);
    const { ui, html } = await settingsAt(location);
    expect(occurrences(ui.text(), NOTES.granted)).toBe(1);
    expect(html).toContain(NOTES.granted);
    // The note above the links is gone with the access.
    expect(ui.named("Allow access")).toBeNull();
  });

  it("the box left unticked: back to /settings#booking, saying to press Allow access again and tick the box, once", async () => {
    await signedInHost();
    const { location } = await allowAccess("missing");
    expect([location.pathname, location.hash]).toEqual(["/settings", "#booking"]);
    expectNoPersonalData(location);
    expect(userRow().booking_access).toBe(0);
    const note = await noteAt(location);
    expect(note, "one note").not.toBeNull();
    expect(reads(note!, NOTES.missing), note!).toBe(true);
    const { ui } = await settingsAt(location);
    expect(occurrences(ui.text().replace(/[“"]/g, ""), "Google didn't give the permission.")).toBe(1);
    expect(ui.named("Allow access"), "Allow access is still there").not.toBeNull();
  });

  it("cancelled on Google's screen: back to /settings#booking with “Access wasn't allowed. Nothing changed.”, not “Sign-in cancelled.”", async () => {
    const before = await signedInHost();
    const session = jar.session;
    const { location, session: given } = await allowAccess("cancelled");
    expect([location.pathname, location.hash]).toEqual(["/settings", "#booking"]);
    expect(location.href).not.toMatch(/signin/);
    expectNoPersonalData(location);
    // Nothing changed: still signed in as before, the same person, no access.
    expect(given).toBeNull();
    expect(jar.session).toBe(session);
    expect(userRow()).toEqual(db.db().prepare("SELECT * FROM users WHERE id = ?").get(before.id));
    expect(userRow().booking_access).toBe(0);
    const note = await noteAt(location);
    expect(note).toBe(NOTES.cancelled);
    const { ui, html } = await settingsAt(location);
    expect(occurrences(ui.text(), NOTES.cancelled)).toBe(1);
    expect(html).not.toContain("Sign-in cancelled.");
  });

  it("drops the state cookie on every way back", async () => {
    await signedInHost();
    for (const outcome of ["granted", "missing", "cancelled"] as const) {
      const { stateCookie } = await allowAccess(outcome);
      // Deleted: sent again, empty and already expired. Not just left alone.
      expect(stateCookie, `${outcome}: the answer deletes the state cookie`).toBeDefined();
      expect(stateCookie!.value, outcome).toBe("");
      const expires = (stateCookie as { expires?: Date | number }).expires;
      const maxAge = (stateCookie as { maxAge?: number }).maxAge;
      expect(maxAge === 0 || (expires !== undefined && new Date(expires).getTime() <= Date.now()), `${outcome}: expired`).toBe(true);
    }
  });

  it("Allow access that fails as a sign-in can still comes back to /settings#booking, with one note", async () => {
    await signedInHost();
    const cases: [string, () => Promise<URL>][] = [
      [
        "no state cookie (another tab, or too late)",
        async () => {
          const { location } = start("?booking=1");
          grants([READ_SCOPE, EVENTS_SCOPE]);
          return (await back(`code=c0de&state=${encodeURIComponent(location.searchParams.get("state")!)}`, null)).location;
        },
      ],
      [
        "Google's token answer fails",
        async () => {
          const { location, cookie } = start("?booking=1");
          fake.answer.token = () => failures.tokenServerError();
          return (await back(`code=c0de&state=${encodeURIComponent(location.searchParams.get("state")!)}`, cookie)).location;
        },
      ],
      [
        "an account outside the company's domain",
        async () => {
          process.env.CONFIG_YAML = `${CONFIG}google_domain: example.com\n`;
          const { location, cookie } = start("?booking=1");
          grants([READ_SCOPE, EVENTS_SCOPE], { sub: "g-other", email: "someone@elsewhere.org", name: "Someone Else", hd: "elsewhere.org" });
          const landed = (await back(`code=c0de&state=${encodeURIComponent(location.searchParams.get("state")!)}`, cookie)).location;
          process.env.CONFIG_YAML = CONFIG;
          return landed;
        },
      ],
    ];
    for (const [what, run] of cases) {
      const session = jar.session;
      const location = await run();
      expect([location.pathname, location.hash], what).toEqual(["/settings", "#booking"]);
      expect(location.href, what).not.toMatch(/signin/);
      expectNoPersonalData(location);
      expect(jar.session, `${what}: still the same session`).toBe(session);
      const note = await noteAt(location);
      expect(note, `${what}: one note`).toBeTruthy();
      expect(note, what).not.toBe(NOTES.granted);
    }
    expect(userRow().booking_access).toBe(0);
  });

  it("Allow access on a server without Google sign-in comes back to /settings#booking too", async () => {
    await signedInHost();
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    const calls = fake.calls.length;
    const { location } = start("?booking=1");
    expect(location.origin).toBe(APP_URL);
    expect([location.pathname, location.hash]).toEqual(["/settings", "#booking"]);
    expectNoPersonalData(location);
    expect(fake.calls.slice(calls)).toEqual([]);
    withGoogle();
    expect(await noteAt(location)).toBeTruthy();
  });

  it("a reload doesn't show the note again: the page takes ?access= out of the address, keeping #booking", async () => {
    await signedInHost();
    const { location } = await allowAccess("cancelled");
    const page = await SettingsPage({ params: Promise.resolve({}), searchParams: Promise.resolve(query(location)) } as never);
    const server = await mount(page, { effects: false });
    const [props] = server.propsOf(BookingLinks);
    const browser = fakeBrowser(location.href).install();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("test: no network");
    });
    const ui = await mount(createElement(BookingLinks, props as never));
    expect(ui.text()).toContain(NOTES.cancelled);
    expect(browser.url.pathname).toBe("/settings");
    expect(browser.url.searchParams.has("access")).toBe(false);
    expect(browser.url.hash).toBe("#booking");
    expect(browser.entries, "replaced, not a new history entry").toHaveLength(1);
    // A reload is that address again.
    vi.unstubAllGlobals();
    fake.install();
    expect(await noteAt(browser.url)).toBeNull();
    const { ui: reloaded } = await settingsAt(browser.url);
    expect(reloaded.text()).not.toContain(NOTES.cancelled);
  });
});

// Fix round 1, finding 1: taking ?access= out of the address must go through
// Next's router. The page's effects run before the router's on a first load,
// so a replaceState made there reaches the browser's own: the entry loses
// Next's state (Back to it then does nothing) and the router keeps the old
// address (its next update writes ?access= back). ./next-router stands in for
// Next's router, as Next 16.4.6 handles history.
describe("the note leaves the address through Next's router (criterion 5)", () => {
  const heading = (ui: Ui) => ui.find((n) => /^h[1-6]$/.test(n.tag) && collapse(textOf(n)) === "Booking links");

  /**
   * Back from Allow access (`outcome`) to My settings, as the browser runs it
   * under Next's router: the booking links section mounts in the router's
   * first commit, as a page without loading.tsx hydrates. Timers and animation
   * frames get to run too, so how the page puts the change off doesn't matter.
   */
  async function landUnderRouter(outcome: "granted" | "missing" | "cancelled") {
    const { location } = await allowAccess(outcome);
    expect(location.searchParams.get("access"), "the way back").toBe(outcome);
    const page = await SettingsPage({ params: Promise.resolve({}), searchParams: Promise.resolve(query(location)) } as never);
    const [props] = (await mount(page, { effects: false })).propsOf(BookingLinks);
    const browser = fakeBrowser(location.href).install();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("test: no network");
    });
    const frame = (callback: (now: number) => void) => setTimeout(() => callback(Date.now()), 16);
    vi.stubGlobal("requestAnimationFrame", frame);
    Object.assign(browser.window, { requestAnimationFrame: frame });
    const got: { router?: Router } = {};
    const ui = await mount(
      createElement(
        NextRouter,
        {
          initialUrl: location.href,
          onRouter: (router: Router) => {
            got.router = router;
            nav.router = router;
          },
        },
        createElement(BookingLinks, props as never),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await ui.settle();
    return { ui, browser, router: got.router! };
  }

  it("each way back shows its note once, and the address loses ?access= with the entry still Next's and Next on the new address", async () => {
    await signedInHost();
    // Unticked and cancelled first: access given stays given.
    for (const outcome of ["missing", "cancelled", "granted"] as const) {
      const { ui, browser, router } = await landUnderRouter(outcome);
      const plain = ui.text().replace(new RegExp(`[“"‘']${BOX}[”"’']`, "g"), BOX);
      expect(occurrences(plain, NOTES[outcome]), `${outcome}: the note, once`).toBe(1);
      expect([browser.url.pathname, browser.url.search, browser.url.hash], outcome).toEqual(["/settings", "", "#booking"]);
      expect(browser.entries, `${outcome}: replaced, not a new history entry`).toHaveLength(1);
      // The entry is still Next's, so Back to it can show My settings again.
      const state = browser.history.state as { __NA?: unknown; __PRIVATE_NEXTJS_INTERNALS_TREE?: { tree?: { page?: string } } } | null;
      expect(state?.__NA, `${outcome}: history.state is ${JSON.stringify(state)}`).toBe(true);
      expect(state?.__PRIVATE_NEXTJS_INTERNALS_TREE?.tree?.page, outcome).toBe("settings");
      // Next's router is on the address without ?access=, so it won't write it back.
      expect(router.state().canonicalUrl, `${outcome}: the router's address`).toBe("/settings#booking");
      ui.unmount();
      nav.router = null;
      // Google (the fake) for the next Allow access.
      vi.unstubAllGlobals();
      fake.install();
    }
  });

  it("a router update afterwards doesn't put ?access= back in the address, so a reload still shows no note", async () => {
    await signedInHost();
    const { ui, browser, router } = await landUnderRouter("cancelled");
    expect(ui.text()).toContain(NOTES.cancelled);
    // Any change to the router's state (a refresh here) makes Next write its address into the entry again.
    router.refresh();
    await ui.settle();
    expect([browser.url.pathname, browser.url.search, browser.url.hash]).toEqual(["/settings", "", "#booking"]);
    expect(browser.entries).toHaveLength(1);
    // A reload is that address again.
    const reload = new URL(browser.url.href);
    ui.unmount();
    nav.router = null;
    vi.unstubAllGlobals();
    fake.install();
    expect(await noteAt(reload)).toBeNull();
  });

  it("← Calendar, then the browser's Back, shows My settings again", async () => {
    await signedInHost();
    const { ui, browser, router } = await landUnderRouter("cancelled");
    expect(heading(ui), "My settings' booking links").not.toBeNull();
    // ← Calendar is a next/link to /: Next pushes the calendar's entry.
    router.push("/");
    await ui.settle();
    expect(browser.url.pathname).toBe("/");
    expect(heading(ui), "the calendar is shown").toBeNull();
    expect(browser.entries).toHaveLength(2);
    // Back: the browser is on My settings' entry again, and Next shows it (a reload would fail the test).
    browser.history.back();
    await ui.settle();
    expect([browser.url.pathname, browser.url.search, browser.url.hash]).toEqual(["/settings", "", "#booking"]);
    expect(router.state().tree.page, "the page Next shows").toBe("settings");
    expect(heading(ui), "My settings' booking links are on screen again").not.toBeNull();
    ui.unmount();
  });
});

describe("the notes go by what the host has now (criterion 5)", () => {
  const at = (access: string | string[]) => {
    const url = new URL(`${APP_URL}/settings#booking`);
    for (const a of [access].flat()) url.searchParams.append("access", a);
    return url;
  };

  it("“Done” only with booking access, “didn't give” only without", async () => {
    const host = await signedInHost();
    // Without access, a ?access=granted someone typed or forged shows nothing.
    expect(await noteAt(at("granted"))).toBeNull();
    const missing = await noteAt(at("missing"));
    expect(missing, "the unticked note, without access").not.toBeNull();
    expect(reads(missing!, NOTES.missing), missing!).toBe(true);
    db.db().prepare("UPDATE users SET booking_access = 1 WHERE id = ?").run(host.id);
    expect(await noteAt(at("missing"))).toBeNull();
    expect(await noteAt(at("granted"))).toBe(NOTES.granted);
    // Cancelled doesn't depend on it.
    expect(await noteAt(at("cancelled"))).toBe(NOTES.cancelled);
  });

  it("anything else in ?access= shows no note, and the page still renders", async () => {
    await signedInHost();
    for (const value of ["", "constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "GRANTED", "granted ", "done", "signin", "1"]) {
      expect(await noteAt(at(value)), `?access=${JSON.stringify(value)}`).toBeNull();
    }
    // Given twice, Next hands the page an array: it still renders, with no more than one note.
    const twice = await noteAt(at(["cancelled", "cancelled"]));
    expect(twice === null || twice === NOTES.cancelled, String(twice)).toBe(true);
  });
});

describe("signing in (not Allow access) answers as before (criteria 5 and 9)", () => {
  it("an ordinary sign-in lands where it did: / for someone here with calendar access, /settings for someone new or without it", async () => {
    // New: /settings.
    expect((await signIn("", [READ_SCOPE])).location.href).toBe(`${APP_URL}/settings`);
    // Here, with calendar access: the calendar.
    expect((await signIn("", [READ_SCOPE])).location.href).toBe(`${APP_URL}/`);
    // Booking access granted before comes back with an ordinary sign-in: still the calendar.
    expect((await signIn("", [READ_SCOPE, EVENTS_SCOPE])).location.href).toBe(`${APP_URL}/`);
    // Without calendar access: /settings, where the notice is.
    expect((await signIn("", [])).location.href).toBe(`${APP_URL}/settings`);
  });

  it("an ordinary sign-in that fails goes back to the calendar with ?signin=, as before", async () => {
    const ordinary = () => {
      const { location, cookie } = start("");
      return { state: encodeURIComponent(location.searchParams.get("state")!), cookie };
    };
    let s = ordinary();
    expect((await back(`error=access_denied&state=${s.state}`, s.cookie)).location.href).toBe(`${APP_URL}/?signin=cancelled`);
    s = ordinary();
    expect((await back(`code=c0de&state=${s.state}`, null)).location.href).toBe(`${APP_URL}/?signin=expired`);
    s = ordinary();
    expect((await back(`code=c0de&state=${s.state}x`, s.cookie)).location.href).toBe(`${APP_URL}/?signin=expired`);
    s = ordinary();
    expect((await back(`state=${s.state}`, s.cookie)).location.href).toBe(`${APP_URL}/?signin=expired`);
    s = ordinary();
    fake.answer.token = () => failures.tokenServerError();
    expect((await back(`code=c0de&state=${s.state}`, s.cookie)).location.href).toBe(`${APP_URL}/?signin=failed`);
    process.env.CONFIG_YAML = `${CONFIG}google_domain: example.com\n`;
    s = ordinary();
    grants([READ_SCOPE], { sub: "g-other", email: "someone@elsewhere.org", name: "Someone Else", hd: "elsewhere.org" });
    expect((await back(`code=c0de&state=${s.state}`, s.cookie)).location.href).toBe(`${APP_URL}/?signin=domain`);
    process.env.CONFIG_YAML = CONFIG;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    expect(start("").location.href).toBe(`${APP_URL}/?signin=unavailable`);
    expect((await back(`code=c0de&state=abc`, "abc")).location.href).toBe(`${APP_URL}/?signin=unavailable`);
    expect(db.listUsers()).toEqual([]);
    expect(jar.session).toBeUndefined();
  });

  it("a state that ends like Allow access's but doesn't match the cookie signs nobody in", async () => {
    await signedInHost();
    app.signOut();
    const { location, cookie } = start("?booking=1");
    const state = location.searchParams.get("state")!;
    grants([READ_SCOPE, EVENTS_SCOPE]);
    // Another state with the same ending, and the real one without its cookie.
    const forged = `${"A".repeat(32)}${state.slice(32)}`;
    for (const [query, sent] of [
      [`code=c0de&state=${encodeURIComponent(forged)}`, cookie],
      [`code=c0de&state=${encodeURIComponent(state)}`, null],
      [`code=c0de&state=${encodeURIComponent(state)}`, forged],
    ] as const) {
      const res = await back(query, sent);
      expect(res.session, query).toBeNull();
      expect(res.location.searchParams.get("access") ?? res.location.searchParams.get("signin")).toBe("expired");
    }
    expect(jar.session).toBeUndefined();
    expect(userRow().booking_access).toBe(0);
  });

  it("while BOOKING_LINKS is off, ?booking=1 and a booking sign-in's way back are ordinary", async () => {
    await signedInHost();
    // Started while booking links were on, back after they were turned off.
    let begun = start("?booking=1");
    process.env.BOOKING_LINKS = "off";
    let state = encodeURIComponent(begun.location.searchParams.get("state")!);
    expect((await back(`error=access_denied&state=${state}`, begun.cookie)).location.href).toBe(`${APP_URL}/?signin=cancelled`);
    process.env.BOOKING_LINKS = "on";
    begun = start("?booking=1");
    process.env.BOOKING_LINKS = "off";
    state = encodeURIComponent(begun.location.searchParams.get("state")!);
    grants([READ_SCOPE, EVENTS_SCOPE]);
    const landed = (await back(`code=c0de&state=${state}`, begun.cookie)).location;
    expect(landed.searchParams.has("access")).toBe(false);
    expect(landed.hash).toBe("");
    // Started while off: an ordinary sign-in from the start.
    for (const setting of ["off", "", "yes"]) {
      process.env.BOOKING_LINKS = setting;
      grants([READ_SCOPE]);
      const { location } = await signIn("?booking=1", [READ_SCOPE]);
      expect(location.href, `BOOKING_LINKS=${setting}`).toBe(`${APP_URL}/`);
      const cancelled = start("?booking=1");
      expect(
        (await back(`error=access_denied&state=${encodeURIComponent(cancelled.location.searchParams.get("state")!)}`, cancelled.cookie)).location.href,
      ).toBe(`${APP_URL}/?signin=cancelled`);
    }
    delete process.env.GOOGLE_CLIENT_ID;
    expect(start("?booking=1").location.href).toBe(`${APP_URL}/?signin=unavailable`);
  });
});

describe("the demo (criterion 9)", () => {
  it("Allow access in the demo asks nothing of Google", async () => {
    inTheDemo();
    const { location } = start("?booking=1");
    expect(location.origin).toBe(APP_URL);
    expect(fake.calls).toEqual([]);
    expect(lines.join("\n")).not.toMatch(/accounts\.google\.com|oauth2\.googleapis/);
  });
});
