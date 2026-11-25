import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LINK, bookingApp, type LinkBody } from "./booking-helpers";
import { captureConsole } from "./link-helpers";
import { collapse, fakeBrowser, mount, textOf, type HostNode, type Ui } from "./ui-harness";

// Booking links' quick wins on the host's side (run 2026-11-25-ekip-quick-wins-host,
// piece B of .claude/team/plans/booking-quick-wins.md): the link rows (criteria 1
// and 2), the line after Create link (3), the link form (6) and what new links
// start with (9). Written from the criteria; the components were read only for
// their props.
//
// My settings is rendered as Next renders it: SettingsPage, called with its
// searchParams, gives the SettingsView element, whose BookingLinks is then
// mounted as the browser would run it (test/ui-harness.ts), behind a fetch that
// goes to the app's own route handlers. In the demo, as the lead's demo runs.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));
// SettingsView asks for the router; nothing here navigates.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
}));

const APP_URL = "https://cal.example.com";
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "q".repeat(40);
process.env.CONFIG_YAML = "timezone: Europe/Istanbul\nhorizon_days: 30\n";
process.env.CALENDAR_LINKS = "private";
process.env.BOOKING_LINKS = "on";
process.env.DEMO_MODE = "true";
process.env.APP_URL = APP_URL;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.EXPOSURE;

const app = await bookingApp(jar);
const { db, NextRequest } = app;
const { linksRoute, linkRoute, myCancelRoute } = app.routes;
const { default: SettingsPage } = await import("@/app/settings/page");
const { BookingLinks } = await import("@/components/booking-links");

/** 09:00 and 17:00, the config's working hours: where a new link starts. */
const NINE = 540;
const FIVE = 1020;
const OFF_WARNING = "Link copied. It's off: turn it on before you send it.";

type Call = { method: string; path: string; body: unknown };

let lines: string[] = [];
beforeAll(() => {
  lines = captureConsole();
});
beforeEach(() => {
  db.resetAll();
  app.signOut();
  process.env.APP_URL = APP_URL;
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("ekip-takvim.booking-limits")];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.env.APP_URL = APP_URL;
});

/** The app's own routes behind fetch, as the browser reaches them; anything else is no network. */
function appFetch(calls: Call[], problems: string[]) {
  return async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input), APP_URL);
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : undefined;
    calls.push({ method, path: url.pathname, body: body === undefined ? undefined : JSON.parse(body) });
    const request = new NextRequest(url, { method, headers: init.headers, body });
    if (url.pathname === "/api/me/booking-links") {
      return method === "GET" ? linksRoute.GET() : linksRoute.POST(request);
    }
    const link = /^\/api\/me\/booking-links\/([^/]+)$/.exec(url.pathname);
    if (link) {
      const params = Promise.resolve({ id: decodeURIComponent(link[1]) });
      return method === "PUT" ? linkRoute.PUT(request, { params }) : linkRoute.DELETE(request, { params });
    }
    const cancel = /^\/api\/me\/bookings\/([^/]+)\/cancel$/.exec(url.pathname);
    if (cancel) return myCancelRoute.POST(request, { params: Promise.resolve({ id: decodeURIComponent(cancel[1]) }) });
    problems.push(`${method} ${url.href}`);
    throw new TypeError(`test: no network (${url.host})`);
  };
}

/** SettingsPage for the signed-in host, as Next calls it, with ?access= when given. */
async function settingsElement(query: Record<string, string> = {}) {
  return SettingsPage({ params: Promise.resolve({}), searchParams: Promise.resolve(query) } as never);
}

/**
 * Open My settings as `host`, in a browser at `href`: the booking links
 * section mounted with the props My settings gives it.
 */
async function openSettings(hostId: string, { href = `${APP_URL}/settings`, width = 1280 }: { href?: string; width?: number } = {}) {
  app.signIn(hostId);
  const query = Object.fromEntries(new URL(href).searchParams);
  const page = await settingsElement(query);
  // The page as the server renders it, to read what My settings hands the section.
  const server = await mount(page, { effects: false });
  const [props] = server.propsOf(BookingLinks);
  expect(props, "My settings renders the booking links").toBeTruthy();
  const browser = fakeBrowser(href, { width }).install();
  const calls: Call[] = [];
  const problems: string[] = [];
  vi.stubGlobal("fetch", appFetch(calls, problems));
  const ui = await mount(createElement(BookingLinks, props as never));
  return { ui, browser, calls, problems };
}

/** The Booking links section: the element headed "Booking links". */
function sectionOf(ui: Ui): HostNode {
  const heading = ui.get((n) => /^h[1-6]$/.test(n.tag) && collapse(textOf(n)) === "Booking links", "Booking links heading");
  let n: HostNode | null = heading;
  while (n && n.tag !== "section") n = n.parent;
  return n ?? heading.parent!;
}

/** The link list's row for `title`. */
function rowOf(ui: Ui, title: string): HostNode {
  const rows = ui.all().filter((n) => n.tag === "li" && ui.all(n).some((x) => collapse(textOf(x)) === title && x.children.every((c) => typeof c === "string")));
  if (rows.length !== 1) throw new Error(`test: ${rows.length} rows for ${title} in:\n${ui.html(sectionOf(ui))}`);
  return rows[0];
}
const hasRow = (ui: Ui, title: string) =>
  ui.all().some((n) => n.tag === "li" && ui.all(n).some((x) => collapse(textOf(x)) === title && x.children.every((c) => typeof c === "string")));

/** A row's summary line: "30 min · Mon–Fri · 09:00–17:00 …". */
function summaryOf(ui: Ui, title: string): string {
  const row = rowOf(ui, title);
  const found = ui.all(row).filter((n) => /^(\d+ min|1 hour|\d+ hours|\d+ h \d+ min) · /.test(collapse(textOf(n))));
  if (found.length === 0) throw new Error(`test: no summary in ${ui.html(row)}`);
  return collapse(textOf(found[found.length - 1]));
}

/** Where a host would find the link's address as text in its row: elements whose whole text is it. */
function addressShown(ui: Ui, row: HostNode, address: string): HostNode[] {
  return ui.all(row).filter((n) => collapse(textOf(n)) === address);
}

/** Selectable: not inside a button or link, nothing on the way up turns selection off, not hidden. */
function selectable(n: HostNode, row: HostNode): boolean {
  for (let p: HostNode | null = n; p && p !== row.parent; p = p.parent) {
    if (p.tag === "button" || p.tag === "a" || p.tag === "input") return false;
    const cls = String(p.props.className ?? "").split(/\s+/);
    if (cls.includes("select-none") || cls.includes("sr-only") || cls.includes("hidden")) return false;
    const style = (p.props.style ?? {}) as Record<string, unknown>;
    if (style.userSelect === "none" || p.props["aria-hidden"] === true || p.props["aria-hidden"] === "true") return false;
  }
  return true;
}

/** Press it, and where it opened what: from a link the browser follows, or window.open. */
async function opens(ui: Ui, browser: ReturnType<typeof fakeBrowser>, n: HostNode) {
  const before = { links: ui.opened.length, windows: browser.opened.length };
  await ui.click(n);
  const link = ui.opened.slice(before.links);
  const windows = browser.opened.slice(before.windows);
  if (link.length + windows.length !== 1) throw new Error(`test: ${link.length + windows.length} pages opened`);
  if (link.length) return { url: link[0].href, target: link[0].target, how: (link[0].rel ?? "").toLowerCase().split(/\s+/) };
  return { url: windows[0].url, target: windows[0].target, how: (windows[0].features ?? "").toLowerCase().split(/[\s,]+/) };
}

/** The toast or message the page shows now, if it reads exactly `text`. */
const shows = (ui: Ui, text: string) => ui.withText(text).length > 0;

describe("Meet in the row (criterion 1)", () => {
  it("a link with Meet on says Meet in its row's summary; one without doesn't", async () => {
    const host = app.person("Row Host");
    app.signIn(host.id);
    const week = { durationMin: 30, days: [1, 2, 3, 4, 5], startMin: NINE, endMin: FIVE };
    await app.newLink({ ...week, title: "Intro call", meet: true });
    await app.newLink({ ...week, title: "Plain call", meet: false });
    await app.newLink({ title: "Long one", meet: true, durationMin: 90, days: [1, 3, 5], startMin: 600, endMin: 960 });
    const { ui } = await openSettings(host.id);
    expect(summaryOf(ui, "Intro call")).toBe("30 min · Mon–Fri · 09:00–17:00 · Meet");
    expect(summaryOf(ui, "Plain call")).toBe("30 min · Mon–Fri · 09:00–17:00");
    expect(summaryOf(ui, "Long one")).toBe("1 h 30 min · Mon, Wed, Fri · 10:00–16:00 · Meet");
  });

  it("shows Meet in the HTML the server sends, too", async () => {
    const host = app.person("Server Host");
    app.signIn(host.id);
    await app.newLink({ title: "Intro call", meet: true, durationMin: 30, days: [1, 2, 3, 4, 5], startMin: NINE, endMin: FIVE });
    const html = renderToStaticMarkup(await settingsElement()).replace(/<!-- -->/g, "");
    expect(html).toContain("30 min · Mon–Fri · 09:00–17:00 · Meet");
  });
});

describe("each row shows and opens its address (criterion 2)", () => {
  it("shows the address Copy link copies, as selectable text, from APP_URL", async () => {
    const host = app.person("Address Host");
    app.signIn(host.id);
    const id = await app.newLink({ title: "Intro call" });
    const address = `${APP_URL}/book/${id}`;
    const { ui, browser } = await openSettings(host.id, { href: "http://10.0.0.7:3000/settings" });
    const row = rowOf(ui, "Intro call");
    const shown = addressShown(ui, row, address);
    expect(shown.length, `the address in ${ui.html(row)}`).toBeGreaterThan(0);
    expect(shown.some((n) => selectable(n, row)), "selectable, outside any button or link").toBe(true);

    await ui.click(ui.getNamed("Copy link to Intro call", row));
    expect(browser.clipboard).toEqual([address]);
    expect(shows(ui, "Link copied")).toBe(true);
    expect(shows(ui, OFF_WARNING)).toBe(false);
  });

  it("with APP_URL unset, shows and copies the page's own address", async () => {
    delete process.env.APP_URL;
    const host = app.person("Origin Host");
    app.signIn(host.id);
    const id = await app.newLink({ title: "Intro call" });
    const address = `http://intranet.example:3000/book/${id}`;
    const { ui, browser } = await openSettings(host.id, { href: "http://intranet.example:3000/settings" });
    const row = rowOf(ui, "Intro call");
    expect(addressShown(ui, row, address).some((n) => selectable(n, row)), ui.html(row)).toBe(true);
    await ui.click(ui.getNamed("Copy link to Intro call", row));
    expect(browser.clipboard).toEqual([address]);
    const opened = await opens(ui, browser, ui.getNamed("Open Intro call", row));
    expect(opened.url).toBe(address);
  });

  it("a link that's on has Open: its address, in a new tab, with noopener and noreferrer", async () => {
    const host = app.person("Open Host");
    app.signIn(host.id);
    const id = await app.newLink({ title: "Intro call" });
    const other = await app.newLink({ title: "Second call" });
    const { ui, browser } = await openSettings(host.id);
    const opened = await opens(ui, browser, ui.getNamed("Open Intro call", rowOf(ui, "Intro call")));
    expect(opened.url).toBe(`${APP_URL}/book/${id}`);
    expect(opened.target).toBe("_blank");
    expect(opened.how).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
    // Each row opens its own link.
    expect((await opens(ui, browser, ui.getNamed("Open Second call", rowOf(ui, "Second call")))).url).toBe(`${APP_URL}/book/${other}`);
    // Opening it doesn't change the page or ask the server anything.
    expect(hasRow(ui, "Intro call")).toBe(true);
  });

  it("a link that's off has no Open, says visitors can't book it, and copying it warns", async () => {
    const host = app.person("Off Host");
    app.signIn(host.id);
    const id = await app.newLink({ title: "Intro call", meet: true });
    await app.newLink({ title: "Still on" });
    expect((await app.updateLink(id, { active: false })).status).toBe(200);
    const { ui, browser } = await openSettings(host.id);
    const row = rowOf(ui, "Intro call");
    expect(ui.named(/^Open\b/, row), "no Open on an off link").toBeNull();
    expect(ui.all(row).some((n) => n.tag === "a" && String(n.props.href ?? "").includes(`/book/${id}`)), "no link to its page").toBe(false);
    const summary = summaryOf(ui, "Intro call");
    expect(summary.split(" · ")).toEqual(expect.arrayContaining(["Meet", "Off: visitors can't book it"]));
    expect(ui.text(row)).not.toContain("its page doesn't open");
    // It still shows its address, and Copy link still copies it, with the warning.
    expect(addressShown(ui, row, `${APP_URL}/book/${id}`).length).toBeGreaterThan(0);
    await ui.click(ui.getNamed("Copy link to Intro call", row));
    expect(browser.clipboard).toEqual([`${APP_URL}/book/${id}`]);
    expect(shows(ui, OFF_WARNING), ui.html()).toBe(true);
    // The link that's on is as before.
    expect(ui.named("Open Still on", rowOf(ui, "Still on"))).not.toBeNull();
    expect(summaryOf(ui, "Still on")).not.toContain("Off");
  });

  it("turning a link off takes its Open away, and on again brings it back", async () => {
    const host = app.person("Switch Host");
    app.signIn(host.id);
    await app.newLink({ title: "Intro call" });
    const { ui, browser } = await openSettings(host.id);
    await ui.click(ui.getNamed("Intro call: on", rowOf(ui, "Intro call")));
    expect(ui.named("Open Intro call", rowOf(ui, "Intro call"))).toBeNull();
    expect(summaryOf(ui, "Intro call")).toContain("Off: visitors can't book it");
    await ui.click(ui.getNamed("Copy link to Intro call", rowOf(ui, "Intro call")));
    expect(shows(ui, OFF_WARNING)).toBe(true);
    await ui.click(ui.getNamed("Intro call: off", rowOf(ui, "Intro call")));
    expect(ui.named("Open Intro call", rowOf(ui, "Intro call"))).not.toBeNull();
    expect(summaryOf(ui, "Intro call")).not.toContain("Off");
    expect(browser.clipboard).toHaveLength(1);
  });

  it("names Copy link and Open after the link's title", async () => {
    const host = app.person("Names Host");
    app.signIn(host.id);
    await app.newLink({ title: "Intro call" });
    await app.newLink({ title: "Ödeme görüşmesi" });
    const { ui } = await openSettings(host.id);
    for (const title of ["Intro call", "Ödeme görüşmesi"]) {
      const row = rowOf(ui, title);
      const copy = ui.getNamed(`Copy link to ${title}`, row);
      const open = ui.getNamed(`Open ${title}`, row);
      expect(copy.tag).toBe("button");
      expect(["a", "button"]).toContain(open.tag);
    }
  });
});

/** The list of links: the section's list whose rows have Copy link (or its "No booking links yet."). */
function linksList(ui: Ui): HostNode {
  return ui.get((n) => n.tag === "ul", "the list of links", sectionOf(ui));
}

/** Where `n` sits in the section: in which of its children, and whether that's just above the list of links. */
function placeOf(ui: Ui, n: HostNode) {
  const section = sectionOf(ui);
  let holder = n;
  while (holder.parent && holder.parent !== section) holder = holder.parent;
  const kids = section.children.filter((c): c is HostNode => typeof c !== "string");
  return { inSection: holder.parent === section, justAboveTheLinks: kids[kids.indexOf(holder) + 1] === linksList(ui) };
}

/** The innermost element whose text starts "Link ready:", or null. */
function readyLine(ui: Ui): HostNode | null {
  const all = ui.all(sectionOf(ui)).filter((n) => collapse(textOf(n)).startsWith("Link ready:"));
  return all.find((n) => !ui.all(n).some((x) => collapse(textOf(x)).startsWith("Link ready:"))) ?? null;
}

/** A field of the open link form, by its label. */
function field(ui: Ui, label: string): HostNode {
  const form = ui.get((n) => n.tag === "form", "a link form", sectionOf(ui));
  return ui.getNamed(label, form);
}
const theForm = (ui: Ui) => ui.find((n) => n.tag === "form", sectionOf(ui));
const optionsOf = (ui: Ui, select: HostNode) => ui.all(select).filter((o) => o.tag === "option").map((o) => Number(o.props.value));
const valueOf = (n: HostNode) => n.el.value;

/** A signed-in host with links titled `titles`, and My settings open. */
async function hostWith(titles: string[], body: Partial<LinkBody> = {}) {
  const host = app.person("Form Host");
  app.signIn(host.id);
  for (const title of titles) await app.newLink({ ...body, title });
  return { host, ...(await openSettings(host.id)) };
}

/** Open the new-link form and give it a title. */
async function startLink(ui: Ui, title = "Intro call") {
  await ui.click(ui.getNamed("New booking link", sectionOf(ui)));
  await ui.change(field(ui, "Title"), title);
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === "/api/me/booking-links");
const puts = (calls: Call[]) => calls.filter((c) => c.method === "PUT");

describe("after Create link (criterion 3)", () => {
  it("where the form was, a line says the link is ready, with its title, Copy and Open", async () => {
    const { ui, browser, calls } = await hostWith(["Existing"]);
    await ui.click(ui.getNamed("New booking link", sectionOf(ui)));
    const form = theForm(ui)!;
    const where = placeOf(ui, form);
    expect(where).toEqual({ inSection: true, justAboveTheLinks: true });
    await ui.change(field(ui, "Title"), "Intro call");
    await ui.click(ui.getNamed("Create link", theForm(ui)!));

    expect(posts(calls)).toHaveLength(1);
    const made = app.linkRows().find((r) => r.title === "Intro call");
    expect(made, "the link was made").toBeTruthy();
    const address = `${APP_URL}/book/${String(made!.id)}`;
    expect(theForm(ui), "the form closed").toBeNull();
    const line = readyLine(ui);
    expect(line, ui.html(sectionOf(ui))).not.toBeNull();
    expect(ui.text(line!)).toBe("Link ready: Intro call · Copy · Open");
    expect(placeOf(ui, line!)).toEqual(where);
    expect(hasRow(ui, "Intro call"), "and it's in the list").toBe(true);

    // Copy copies the new link's address, Open opens it in a new tab; the line stays.
    await ui.click(ui.getNamed("Copy", readyLine(ui)!));
    expect(browser.clipboard).toEqual([address]);
    expect(readyLine(ui)).not.toBeNull();
    const opened = await opens(ui, browser, ui.getNamed("Open", readyLine(ui)!));
    expect(opened.url).toBe(address);
    expect(opened.target).toBe("_blank");
    expect(opened.how).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
    expect(ui.text(readyLine(ui)!)).toBe("Link ready: Intro call · Copy · Open");
  });

  it("names the link it made, with no other links", async () => {
    const { ui } = await hostWith([]);
    await startLink(ui, "  Candidate interview ");
    await ui.click(ui.getNamed("Create link", theForm(ui)!));
    const line = readyLine(ui);
    expect(line, ui.html(sectionOf(ui))).not.toBeNull();
    expect(ui.text(line!)).toBe("Link ready: Candidate interview · Copy · Open");
  });

  const otherThings: [string, (ui: Ui) => Promise<void>][] = [
    ["copies another link", (ui) => ui.click(ui.getNamed("Copy link to Existing"))],
    ["opens another link", (ui) => ui.click(ui.getNamed("Open Existing"))],
    ["switches a link off", (ui) => ui.click(ui.getNamed("Existing: on"))],
    ["edits a link", (ui) => ui.click(ui.getNamed("Edit Existing"))],
    ["asks to delete a link", (ui) => ui.click(ui.getNamed("Delete Existing"))],
    ["starts another link", (ui) => ui.click(ui.getNamed("New booking link"))],
  ];
  it.each(otherThings)("goes once the host %s in the section", async (_what, act) => {
    const { ui } = await hostWith(["Existing"]);
    await startLink(ui);
    await ui.click(ui.getNamed("Create link", theForm(ui)!));
    expect(readyLine(ui)).not.toBeNull();
    await act(ui);
    expect(readyLine(ui), ui.html(sectionOf(ui))).toBeNull();
  });

  it("isn't shown after saving a change to a link, or when Create link fails", async () => {
    const { ui } = await hostWith(["Existing"]);
    await ui.click(ui.getNamed("Edit Existing"));
    await ui.change(field(ui, "Title"), "Existing, renamed");
    await ui.click(ui.getNamed("Save", theForm(ui)!));
    expect(hasRow(ui, "Existing, renamed")).toBe(true);
    expect(readyLine(ui)).toBeNull();

    // Hours shorter than a meeting: the server says no.
    await startLink(ui, "Too short");
    await ui.change(field(ui, "From"), "600");
    await ui.change(field(ui, "To"), "615");
    await ui.click(ui.getNamed("Create link", theForm(ui)!));
    expect(theForm(ui)).not.toBeNull();
    expect(readyLine(ui)).toBeNull();
  });
});

describe("the link form (criterion 6)", () => {
  it("Enter in the title or Days ahead doesn't create the link; Create link does", async () => {
    const { ui, calls } = await hostWith([]);
    await startLink(ui);
    for (const label of ["Title", "Days ahead, today included"]) {
      await ui.keyDown(field(ui, label), "Enter");
      expect(posts(calls), `Enter in ${label}`).toEqual([]);
      expect(theForm(ui), `the form is still open after Enter in ${label}`).not.toBeNull();
      expect(ui.loads, "nor does the page reload").toEqual([]);
    }
    expect(app.linkRows()).toEqual([]);
    await ui.click(ui.getNamed("Create link", theForm(ui)!));
    expect(posts(calls)).toHaveLength(1);
    expect(app.linkRows().map((r) => r.title)).toEqual(["Intro call"]);
  });

  it("Enter in the description makes a new line, and doesn't create the link", async () => {
    const { ui, calls } = await hostWith([]);
    await startLink(ui);
    await ui.change(field(ui, "Description (optional)"), "First line");
    await ui.keyDown(field(ui, "Description (optional)"), "Enter");
    expect(valueOf(field(ui, "Description (optional)"))).toBe("First line\n");
    await ui.change(field(ui, "Description (optional)"), "First line\nSecond line");
    expect(posts(calls)).toEqual([]);
    await ui.click(ui.getNamed("Create link", theForm(ui)!));
    expect(app.linkRows().map((r) => r.description)).toEqual(["First line\nSecond line"]);
  });

  it("Enter in a link being edited doesn't save it; Save does", async () => {
    const { ui, calls } = await hostWith(["Existing"]);
    await ui.click(ui.getNamed("Edit Existing"));
    await ui.change(field(ui, "Title"), "Renamed");
    for (const label of ["Title", "Days ahead, today included"]) {
      await ui.keyDown(field(ui, label), "Enter");
      expect(puts(calls), `Enter in ${label}`).toEqual([]);
      expect(theForm(ui), `the form is still open after Enter in ${label}`).not.toBeNull();
    }
    expect(app.linkRows().map((r) => r.title)).toEqual(["Existing"]);
    await ui.click(ui.getNamed("Save", theForm(ui)!));
    expect(puts(calls)).toHaveLength(1);
    expect(app.linkRows().map((r) => r.title)).toEqual(["Renamed"]);
  });

  /** Make the open form fail on the server: hours shorter than a meeting. The message the server gives. */
  async function failOnce(ui: Ui, button: "Create link" | "Save") {
    await ui.change(field(ui, "Length"), "30");
    await ui.change(field(ui, "From"), "600");
    await ui.change(field(ui, "To"), "615");
    await ui.click(ui.getNamed(button, theForm(ui)!));
    const expected = await app.createLink({ ...LINK, title: "Probe", durationMin: 30, startMin: 600, endMin: 615 });
    expect(expected.status).toBe(400);
    const message = (expected.json as { error: string }).error;
    expect(message.length).toBeGreaterThan(0);
    expect(shows(ui, message), `the form shows "${message}"`).toBe(true);
    return message;
  }

  const changes: [string, (ui: Ui) => Promise<void>][] = [
    ["Title", (ui) => ui.change(field(ui, "Title"), "Intro call 2")],
    ["Description", (ui) => ui.change(field(ui, "Description (optional)"), "About it")],
    ["Length", (ui) => ui.change(field(ui, "Length"), "15")],
    ["From", (ui) => ui.change(field(ui, "From"), "540")],
    ["To", (ui) => ui.change(field(ui, "To"), "720")],
    ["a day", (ui) => ui.click(ui.getNamed("Sat", theForm(ui)!))],
    ["Break between meetings", (ui) => ui.change(field(ui, "Break between meetings"), "15")],
    ["Minimum notice", (ui) => ui.change(field(ui, "Minimum notice"), "60")],
    ["Days ahead", (ui) => ui.change(field(ui, "Days ahead, today included"), "7")],
    ["Bookings per day", (ui) => ui.change(field(ui, "Bookings per day"), "3")],
    ["Add a Google Meet link", (ui) => ui.toggle(field(ui, "Add a Google Meet link"))],
  ];
  it.each(changes)("a message on the new link's form goes when %s changes", async (_what, act) => {
    const { ui } = await hostWith([]);
    await startLink(ui);
    const message = await failOnce(ui, "Create link");
    await act(ui);
    expect(theForm(ui)).not.toBeNull();
    expect(ui.text()).not.toContain(message);
  });

  it.each(changes.filter(([what]) => ["Title", "To", "a day", "Add a Google Meet link"].includes(what)))(
    "a message on an edited link's form goes when %s changes",
    async (_what, act) => {
      const { ui } = await hostWith(["Existing"]);
      await ui.click(ui.getNamed("Edit Existing"));
      const message = await failOnce(ui, "Save");
      await act(ui);
      expect(ui.text()).not.toContain(message);
    },
  );

  it("a message on the form goes with Cancel, and isn't shown once the form is closed", async () => {
    const { ui } = await hostWith(["Existing"]);
    await startLink(ui);
    const message = await failOnce(ui, "Create link");
    await ui.click(ui.getNamed("Cancel", theForm(ui)!));
    expect(theForm(ui)).toBeNull();
    expect(ui.text(), "after Cancel").not.toContain(message);
    // Nor in the next form.
    await ui.click(ui.getNamed("New booking link"));
    expect(ui.text(), "in the next form").not.toContain(message);
    await ui.click(ui.getNamed("Cancel", theForm(ui)!));

    // The same for a link being edited.
    await ui.click(ui.getNamed("Edit Existing"));
    const again = await failOnce(ui, "Save");
    await ui.click(ui.getNamed("Cancel", theForm(ui)!));
    expect(theForm(ui)).toBeNull();
    expect(ui.text(), "after Cancel on an edit").not.toContain(again);
    await ui.click(ui.getNamed("Edit Existing"));
    expect(ui.text(), "when editing it again").not.toContain(again);
  });

  it("a message from a save that didn't reach the server goes with a change or Cancel too", async () => {
    const { ui } = await hostWith([]);
    await startLink(ui);
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("test: offline");
    });
    await ui.click(ui.getNamed("Create link", theForm(ui)!));
    const alert = ui.find((n) => n.props.role === "alert", sectionOf(ui));
    expect(alert, "a message on the form").not.toBeNull();
    const message = ui.text(alert!);
    await ui.change(field(ui, "Title"), "Intro call, again");
    expect(ui.text()).not.toContain(message);
    await ui.click(ui.getNamed("Create link", theForm(ui)!));
    expect(ui.text()).toContain(message);
    await ui.click(ui.getNamed("Cancel", theForm(ui)!));
    expect(ui.text()).not.toContain(message);
  });

  /** To's options are the times after From, every one a meeting long or more included. */
  function expectToAfterFrom(ui: Ui) {
    const from = Number(valueOf(field(ui, "From")));
    const length = Number(valueOf(field(ui, "Length")));
    const to = optionsOf(ui, field(ui, "To"));
    expect(to.every((m) => m > from), `To offers ${to.filter((m) => m <= from).join(", ")} with From at ${from}`).toBe(true);
    for (let m = Math.min(from + length, 1440); m <= 1440; m += 15) expect(to, `To offers ${m} with From at ${from}`).toContain(m);
    expect(to).toContain(Number(valueOf(field(ui, "To"))));
  }

  it("To offers only times after From", async () => {
    const { ui } = await hostWith(["Existing"]);
    await startLink(ui);
    expect([Number(valueOf(field(ui, "From"))), Number(valueOf(field(ui, "To")))]).toEqual([NINE, FIVE]);
    expectToAfterFrom(ui);
    for (const from of [0, 15, 600, 1005, 1020, 1380, 1425]) {
      await ui.change(field(ui, "From"), String(from));
      expectToAfterFrom(ui);
    }
    await ui.click(ui.getNamed("Cancel", theForm(ui)!));
    // A link being edited too.
    await ui.click(ui.getNamed("Edit Existing"));
    expectToAfterFrom(ui);
    await ui.change(field(ui, "From"), "660");
    expectToAfterFrom(ui);
  });

  it("when From moves to or past To, To moves to From plus the meeting's length, at most 24:00", async () => {
    const { ui } = await hostWith([]);
    await startLink(ui);
    const hours = () => [Number(valueOf(field(ui, "From"))), Number(valueOf(field(ui, "To")))];
    const steps: [string, string, number[]][] = [
      // [field, value, From and To after it], from 09:00–17:00 and 30 minutes.
      ["From", "1020", [1020, 1050]], // to To: 17:00–17:30
      ["From", "1080", [1080, 1110]], // past To: 18:00–18:30
      ["From", "720", [720, 1110]], // before To: To stays
      ["Length", "60", [720, 1110]],
      ["From", "1140", [1140, 1200]], // past To with an hour: 19:00–20:00
      ["From", "1410", [1410, 1440]], // 23:30 plus an hour: at most 24:00
      ["Length", "120", [1410, 1440]],
      ["From", "1425", [1425, 1440]], // before 24:00: To stays
      ["From", "600", [600, 1440]],
      ["To", "660", [600, 660]],
      ["Length", "90", [600, 660]],
      ["From", "660", [660, 750]], // to To with 90 minutes: 11:00–12:30
    ];
    for (const [label, value, expected] of steps) {
      await ui.change(field(ui, label), value);
      expect(hours(), `${label} → ${value}`).toEqual(expected);
      expectToAfterFrom(ui);
    }
    // What the form shows is what it sends.
    await ui.click(ui.getNamed("Create link", theForm(ui)!));
    expect(app.linkRows().map((r) => [r.start_min, r.end_min, r.duration_min])).toEqual([[660, 750, 90]]);
  });

  it("moves To in a link being edited, from its own length", async () => {
    const { ui } = await hostWith(["Existing"], { durationMin: 45, startMin: 600, endMin: 720 });
    await ui.click(ui.getNamed("Edit Existing"));
    await ui.change(field(ui, "From"), "780");
    expect([valueOf(field(ui, "From")), valueOf(field(ui, "To"))]).toEqual(["780", "825"]);
    await ui.change(field(ui, "From"), "1410");
    expect(valueOf(field(ui, "To"))).toBe("1440");
  });
});

describe("what new links start with (criterion 9)", () => {
  it("a new link starts with Meet off, and On", async () => {
    const { ui } = await hostWith([]);
    await startLink(ui);
    expect(field(ui, "Add a Google Meet link").el.checked).toBe(false);
    await ui.click(ui.getNamed("Create link", theForm(ui)!));
    const [row] = app.linkRows();
    expect([row.title, row.meet, row.active]).toEqual(["Intro call", 0, 1]);
    const switched = ui.getNamed("Intro call: on", rowOf(ui, "Intro call"));
    expect(switched.props["aria-checked"]).toBe(true);
    expect(summaryOf(ui, "Intro call")).toBe("30 min · Mon–Fri · 09:00–17:00");
  });
});

describe("no Google request in the demo (criterion 9)", () => {
  it("making, copying, opening, switching, editing and deleting links ask only the app", async () => {
    const { ui, problems, calls } = await hostWith(["Existing"]);
    await startLink(ui);
    await ui.click(ui.getNamed("Create link", theForm(ui)!));
    const line = readyLine(ui);
    expect(line, "the ready line").not.toBeNull();
    await ui.click(ui.getNamed("Copy", line!));
    await ui.click(ui.getNamed("Open Intro call"));
    await ui.click(ui.getNamed("Intro call: on"));
    await ui.click(ui.getNamed("Edit Existing"));
    await ui.change(field(ui, "Title"), "Existing 2");
    await ui.click(ui.getNamed("Save", theForm(ui)!));
    await ui.click(ui.getNamed("Delete Existing 2"));
    await ui.click(ui.getNamed("Yes, delete"));
    expect(problems).toEqual([]);
    expect(calls.every((c) => c.path.startsWith("/api/me/"))).toBe(true);
    expect(lines.join("\n")).not.toMatch(/googleapis|accounts\.google/);
  });
});
