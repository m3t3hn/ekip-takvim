import { readFileSync } from "node:fs";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingMade, BookingPageInfo, BookingToCancel } from "@/lib/types";
import { at } from "./booking-reference";
import { all, byTag, classesOf, one, phoneHeight, render, renderElement, textOf, type El } from "./booking-html";

// Booking links' quick wins (run 2026-11-25-ekip-quick-wins-visitor), the
// visitor's views as react-dom/server renders them:
// - criterion 1: the confirmation shows what it showed (heading, title with
//   host, time and zone, the invitation line outside the demo) and its box
//   says this page's address is the cancel link, to keep or bookmark, and
//   anyone who has it can cancel; "shown only this once" goes; Copy copies the
//   same link. The cancel page, while booked: "You're booked", title, host,
//   time, zone, Copy for the page's address, Cancel booking. Nothing loads
//   from another origin.
// - criterion 2: the header says Google Meet video call when the link adds
//   Meet, and the confirmation (outside the demo) that the Meet link comes
//   with the invitation; with Meet off, nothing about where.
// - criterion 6: after cancelling, a cancelled booking and an ended one offer
//   "Book another time" when there's a link to give, and an ended one says it
//   took place, with no Cancel booking.
// - criterion 8: "Loading…" and the cancelled message are role="status"; the
//   focus targets can take the focus.
// - criterion 10: under 640 px Book is full width, and Book, Pick another
//   time, Cancel booking, Copy and the time buttons are 44 px tall or more;
//   long words wrap. From the classes: node has no layout.
// Copy is pressed by calling the handler the view gave it, with useCopy
// mocked.

const copied = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("@/components/ui", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/ui")>();
  return { ...real, useCopy: () => (...args: unknown[]) => void copied.calls.push(args) };
});

const { BookingPage, BookingForm, Confirmation, LinkHeader, TimeList } = await import("@/app/book/[id]/booking-page");
const { BookingStatus, CancelPage } = await import("@/app/book/cancel/[token]/cancel-page");
const { KeepLink, Message } = await import("@/app/book/shell");

const IST = "Europe/Istanbul";
const ist = (d: number, h: number, m = 0) => at(IST, 2026, 11, d, h, m);
const MIN = 60_000;
const CLOCK = { zone: IST, hour12: false };
const CANCEL_URL = "https://cal.example.com/book/cancel/Zy8xW6vU4tS2rQ0pO8nM6lK4jI2hG0fE";
const ADDRESS = "https://cal.example.com/book/cancel/Zy8xW6vU4tS2rQ0pO8nM6lK4jI2hG0fE";

beforeEach(() => {
  copied.calls.length = 0;
});

type Any = ReactElement<Record<string, unknown>>;
/** Every element of a tree a component returned, children included (nested components aren't run). */
function elements(node: ReactNode): Any[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as Any;
  return [el, ...elements(el.props.children as ReactNode)];
}
const ownText = (el: Any) =>
  [el.props.children]
    .flat(Infinity)
    .filter((c) => typeof c === "string")
    .join("")
    .trim();

/** What a component returns, called inside a render so its hooks work. */
function treeOf<P>(component: (props: P) => ReactNode, props: P): ReactNode {
  let tree: ReactNode = null;
  const Harness = () => {
    tree = component(props);
    return tree as ReactElement;
  };
  renderToStaticMarkup(createElement(Harness));
  return tree;
}

const made = (more: Partial<BookingMade> = {}): BookingMade => ({
  start: ist(30, 16),
  end: ist(30, 16, 30),
  title: "Intro call",
  hostName: "Zeynep Şahin",
  cancelUrl: CANCEL_URL,
  invited: true,
  ...more,
});
const confirmation = (m: Partial<BookingMade> = {}, meet = false) => render(Confirmation, { made: made(m), email: "ayse.visitor@example.org", meet, clock: CLOCK });

const booking = (more: Partial<BookingToCancel> = {}): BookingToCancel => ({
  title: "Intro call",
  start: ist(30, 16),
  end: ist(30, 16, 30),
  hostName: "Zeynep Şahin",
  cancelled: false,
  ended: false,
  bookAgain: null,
  ...more,
});
const statusProps = (b: BookingToCancel, more: Record<string, unknown> = {}) => ({
  booking: b,
  clock: CLOCK,
  address: ADDRESS,
  busy: false,
  problem: null,
  focusCancelled: false,
  onCancel: () => {},
  ...more,
});
const status = (b: Partial<BookingToCancel> = {}) => render(BookingStatus, statusProps(booking(b)));

const page = (more: Partial<BookingPageInfo> = {}): BookingPageInfo => ({
  title: "Portfolio review",
  description: "A first look at your work.",
  durationMin: 30,
  hostName: "Zeynep Şahin",
  meet: false,
  slots: [],
  fullDays: [],
  ...more,
});

const buttonNamed = (root: El, name: RegExp) => one(root, (e) => e.tag === "button" && name.test(textOf(e)), `button ${name}`);
const linkNamed = (root: El, name: RegExp) => all(root, (e) => e.tag === "a" && name.test(textOf(e)));

describe("the confirmation right after booking (criterion 1)", () => {
  it("shows the heading, the title with the host, the time and the zone, and the invitation line", () => {
    const { root, text } = confirmation();
    expect(textOf(one(root, (e) => e.tag === "h1", "h1"))).toBe("Booked");
    expect(text).toContain("Intro call with Zeynep Şahin");
    expect(text).toMatch(/Monday 30 November, 16:00–16:30/);
    expect(text).toContain("Istanbul time (GMT+3)");
    expect(text).toContain("An invitation is on its way to ayse.visitor@example.org.");
  });

  it("in the demo (no invitation) has no invitation line", () => {
    const { text } = confirmation({ invited: false });
    expect(text).not.toMatch(/invitation/i);
    expect(text).toContain("Intro call with Zeynep Şahin");
  });

  it("says this page's address is the cancel link, to keep or bookmark, and that anyone who has it can cancel", () => {
    const { root, text } = confirmation();
    expect(text).toMatch(/this page.s address is (your|the) cancel link/i);
    expect(text).toMatch(/\bkeep\b/i);
    expect(text).toMatch(/bookmark/i);
    expect(text).toMatch(/anyone who has it can cancel/i);
    expect(text).not.toMatch(/only this once|shown only once|only way to cancel/i);
    // The link itself is shown, as before.
    const input = one(root, (e) => e.tag === "input", "the link's box");
    expect(input.attrs.value).toBe(CANCEL_URL);
    expect(input.attrs.readonly).toBeDefined();
  });

  it("copies the same link as before: the answer's cancelUrl", () => {
    const tree = treeOf(Confirmation, { made: made(), email: "a@example.org", meet: false, clock: CLOCK });
    const box = elements(tree).find((e) => e.type === KeepLink);
    expect(box?.props.url).toBe(CANCEL_URL);
    const copy = elements(treeOf(KeepLink, { url: CANCEL_URL })).find((e) => typeof e.props.onClick === "function" && ownText(e) === "Copy");
    expect(copy, "a Copy button").toBeTruthy();
    (copy!.props.onClick as () => void)();
    expect(copied.calls).toEqual([[CANCEL_URL, "Cancel link copied"]]);
  });
});

describe("the cancel link's page while the booking is on (criterion 1)", () => {
  it("is headed You're booked, with the title, host, time and zone, the page's address with Copy, and Cancel booking", () => {
    const { root, text } = status();
    expect(textOf(one(root, (e) => e.tag === "h1", "h1"))).toBe("You're booked");
    expect(text).toContain("Intro call with Zeynep Şahin");
    expect(text).toMatch(/Monday 30 November, 16:00–16:30/);
    expect(text).toContain("Istanbul time (GMT+3)");
    expect(one(root, (e) => e.tag === "input", "the link's box").attrs.value).toBe(ADDRESS);
    expect(buttonNamed(root, /^Cancel booking$/)).toBeTruthy();
    expect(buttonNamed(root, /^Copy$/)).toBeTruthy();
    expect(text).not.toMatch(/took place|is cancelled|Book another time/);
  });

  it("copies the page's address, and Cancel booking calls the handler it was given", () => {
    const onCancel = vi.fn();
    const tree = treeOf(BookingStatus, statusProps(booking(), { onCancel }));
    expect(elements(tree).find((e) => e.type === KeepLink)?.props.url).toBe(ADDRESS);
    const cancel = elements(tree).find((e) => typeof e.props.onClick === "function" && /Cancel booking/.test(ownText(e)));
    (cancel!.props.onClick as () => void)();
    expect(onCancel).toHaveBeenCalledTimes(1);
    const copy = elements(treeOf(KeepLink, { url: ADDRESS })).find((e) => typeof e.props.onClick === "function" && ownText(e) === "Copy");
    (copy!.props.onClick as () => void)();
    expect(copied.calls).toEqual([[ADDRESS, "Cancel link copied"]]);
  });

  it("disables Cancel booking while it's on its way, and shows a refusal", () => {
    const { root } = render(BookingStatus, statusProps(booking(), { busy: true, problem: "This meeting has ended, so it can't be cancelled." }));
    const button = buttonNamed(root, /Cancelling…|Cancel booking/);
    expect(button.attrs.disabled).toBeDefined();
    expect(textOf(root)).toContain("This meeting has ended, so it can't be cancelled.");
  });
});

describe("Google Meet (criterion 2)", () => {
  it("the header says it's a Google Meet video call when the link adds Meet", () => {
    expect(render(LinkHeader, { page: page({ meet: true }) }).text).toMatch(/Google Meet video call/);
  });

  it("with Meet off, the header says nothing about where the meeting is", () => {
    const { text } = render(LinkHeader, { page: page({ meet: false }) });
    expect(text).not.toMatch(/meet|video|phone|in person|location|online|zoom|address/i);
    expect(text).toBe("Zeynep Şahin Portfolio review 30 min A first look at your work.");
  });

  it("the confirmation says the Meet link comes with the invitation, outside the demo, with Meet on", () => {
    const { text } = confirmation({}, true);
    expect(text).toMatch(/Google Meet/);
    expect(text).toMatch(/Meet[^.]*link comes with (your|the) invitation/i);
  });

  it("the confirmation says nothing about where with Meet off, nor about the Meet link in the demo", () => {
    expect(confirmation({}, false).text).not.toMatch(/meet|video|phone|in person|location/i);
    expect(confirmation({ invited: false }, true).text).not.toMatch(/link comes with|invitation/i);
  });
});

describe("the cancel page once cancelled or ended (criterion 6)", () => {
  it("after cancelling: the cancelled message, announced, and Book another time to the link's page", () => {
    const { root, text } = status({ cancelled: true, bookAgain: "/book/Ab3dE5gH7jK9mN1pQ3sT5v" });
    const message = one(root, (e) => e.tag === "p" && textOf(e) === "This booking is cancelled.", "the cancelled message");
    expect(message.attrs.role).toBe("status");
    const links = linkNamed(root, /^Book another time$/);
    expect(links.map((a) => a.attrs.href)).toEqual(["/book/Ab3dE5gH7jK9mN1pQ3sT5v"]);
    expect(text).not.toMatch(/Cancel booking|You're booked|took place/);
  });

  it("without a link to give (off, deleted, or the host left): no Book another time", () => {
    for (const b of [{ cancelled: true }, { ended: true }, { cancelled: true, ended: true }]) {
      const { root, text } = status({ ...b, bookAgain: null });
      expect(linkNamed(root, /Book another time/), JSON.stringify(b)).toEqual([]);
      expect(text, JSON.stringify(b)).not.toContain("Book another time");
    }
  });

  it("an ended booking says it took place, with no Cancel booking, and Book another time while there's a link", () => {
    const { root, text } = status({ ended: true, bookAgain: "/book/Ab3dE5gH7jK9mN1pQ3sT5v" });
    expect(text).toContain("This meeting took place on Monday 30 November.");
    expect(all(root, (e) => e.tag === "button" && /Cancel/.test(textOf(e)))).toEqual([]);
    expect(linkNamed(root, /^Book another time$/).map((a) => a.attrs.href)).toEqual(["/book/Ab3dE5gH7jK9mN1pQ3sT5v"]);
    expect(text).not.toMatch(/You're booked|is cancelled/);
  });

  it("says the day it took place on the visitor's clock", () => {
    // Monday 30 November 01:00 in Istanbul is still Sunday the 29th in Los Angeles.
    const { text } = render(BookingStatus, { ...statusProps(booking({ ended: true, start: ist(30, 1), end: ist(30, 1, 30) })), clock: { zone: "America/Los_Angeles", hour12: true } });
    expect(text).toContain("This meeting took place on Sunday 29 November.");
  });

  it("a cancelled booking whose time has passed is still shown as cancelled, not as taken place", () => {
    const { text } = status({ cancelled: true, ended: true, bookAgain: "/book/x" });
    expect(text).toContain("This booking is cancelled.");
    expect(text).not.toContain("took place");
  });
});

describe("screen readers (criterion 8)", () => {
  it("announces Loading… on both pages' first HTML, before the visitor's clock is known", () => {
    for (const element of [createElement(BookingPage, { id: "Ab3dE5gH7jK9mN1pQ3sT5v" }), createElement(CancelPage, { token: "tok3n" })]) {
      const { root } = renderElement(element);
      const loading = one(root, (e) => textOf(e) === "Loading…" && e.tag === "p", "Loading…");
      expect(loading.attrs.role).toBe("status");
    }
    expect(one(render(Message, { children: "Loading…", status: true }).root, (e) => e.tag === "p" && textOf(e) === "Loading…", "p").attrs.role).toBe("status");
  });

  it("lets the focus land on the form's heading, the confirmation's heading, the list's heading and the cancelled message", () => {
    const form = render(BookingForm, {
      slot: { start: ist(30, 16), end: ist(30, 16, 30) },
      clock: CLOCK,
      guest: { name: "", email: "", note: "" },
      problem: null,
      wait: null,
      sending: false,
      canBook: false,
      onField: () => {},
      onBack: () => {},
      onSubmit: () => {},
    }).root;
    const formHeading = one(form, (e) => e.tag === "h2", "the form's heading");
    expect(textOf(formHeading)).toMatch(/^Monday 30 November, 16:00/);
    expect(formHeading.attrs.tabindex).toBe("-1");
    expect(one(confirmation().root, (e) => e.tag === "h1", "h1").attrs.tabindex).toBe("-1");
    expect(one(status({ cancelled: true }).root, (e) => textOf(e) === "This booking is cancelled." && e.tag === "p", "the message").attrs.tabindex).toBe("-1");
  });
});

describe("phones (criterion 10)", () => {
  const form = (canBook = true) =>
    render(BookingForm, {
      slot: { start: ist(30, 16), end: ist(30, 16, 30) },
      clock: CLOCK,
      guest: { name: "Ayşe", email: "a@example.org", note: "" },
      problem: null,
      wait: null,
      sending: false,
      canBook,
      onField: () => {},
      onBack: () => {},
      onSubmit: () => {},
    }).root;
  const tall = (e: El, what: string) => expect(phoneHeight(e), `${what}: ${classesOf(e).join(" ")}`).toBeGreaterThanOrEqual(44);

  it("makes Book full width under 640 px, and Book and Pick another time 44 px tall or more", () => {
    const book = buttonNamed(form(), /^Book$/);
    expect(classesOf(book).some((c) => c === "max-sm:w-full" || c === "w-full"), classesOf(book).join(" ")).toBe(true);
    tall(book, "Book");
    tall(buttonNamed(form(), /Pick another time/), "Pick another time");
  });

  it("makes the time buttons, Cancel booking and Copy 44 px tall or more", () => {
    const slots = [ist(30, 10), ist(30, 16)].map((start) => ({ start, end: start + 30 * MIN }));
    const list = render(TimeList, { slots, fullDays: [], clock: CLOCK, at: slots[0].start, problem: null, focus: false, onPick: () => {} }).root;
    for (const b of byTag(list, "button")) tall(b, `time ${textOf(b)}`);
    tall(buttonNamed(status().root, /^Cancel booking$/), "Cancel booking");
    tall(buttonNamed(status().root, /^Copy$/), "Copy on the cancel page");
    tall(buttonNamed(confirmation().root, /^Copy$/), "Copy on the confirmation");
  });

  const WRAPS = ["break-words", "wrap-break-word", "wrap-anywhere", "break-all"];
  const wraps = (e: El) => classesOf(e).some((c) => WRAPS.includes(c));

  it("wraps a long word or address in the description, the title and the host's name", () => {
    const long = "https://example.com/" + "averyveryverylongpathwithoutanyspaces".repeat(4);
    const { root } = render(LinkHeader, { page: page({ description: `See ${long} first.`, title: "T".repeat(80), hostName: "N".repeat(100) }) });
    const description = one(root, (e) => e.tag === "p" && textOf(e).includes(long), "the description");
    expect(wraps(description), classesOf(description).join(" ")).toBe(true);
    for (const e of [one(root, (x) => x.tag === "h1", "the title"), one(root, (x) => x.tag === "p" && textOf(x) === "N".repeat(100), "the host")]) {
      expect(wraps(e), classesOf(e).join(" ")).toBe(true);
    }
  });

  it("wraps long titles, names and addresses on the confirmation and the cancel page, and lets the link's box shrink", () => {
    const longTitle = "T".repeat(80);
    const longName = "N".repeat(100);
    const longEmail = `${"a".repeat(64)}@${"b".repeat(63)}.example.org`;
    const c = render(Confirmation, { made: made({ title: longTitle, hostName: longName }), email: longEmail, meet: true, clock: CLOCK }).root;
    const lines = all(c, (e) => (e.tag === "p" || e.tag === "span" || e.tag === "h1") && (textOf(e).includes(longTitle) || textOf(e).includes(longEmail)) && e.children.some((x) => typeof x === "string"));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const e of lines) expect(wraps(e), `${e.tag}: ${classesOf(e).join(" ")}`).toBe(true);
    for (const b of [{}, { cancelled: true }, { ended: true }]) {
      const s = render(BookingStatus, statusProps(booking({ ...b, title: longTitle, hostName: longName }))).root;
      const shown = all(s, (e) => (e.tag === "p" || e.tag === "h1") && (textOf(e).includes(longTitle) || textOf(e) === longName) && e.children.some((x) => typeof x === "string"));
      expect(shown.length, JSON.stringify(b)).toBeGreaterThanOrEqual(1);
      for (const e of shown) expect(wraps(e), `${JSON.stringify(b)} ${e.tag}: ${classesOf(e).join(" ")}`).toBe(true);
    }
    // The cancel link's box can shrink below its text, and its row wraps.
    const box = one(c, (e) => e.tag === "input", "the link's box");
    expect(classesOf(box)).toContain("min-w-0");
    const row = all(c, (e) => e.children.includes(box))[0];
    expect(classesOf(row)).toContain("flex-wrap");
  });
});

describe("nothing from another origin (criterion 1)", () => {
  const ATTRS = ["src", "href", "action", "srcset", "poster", "data", "formaction", "xlink:href"];
  const external = (root: El) =>
    all(root, (e) => ATTRS.some((a) => a in e.attrs && /^(https?:)?\/\//i.test(e.attrs[a].trim()))).map((e) => `${e.tag} ${JSON.stringify(e.attrs)}`);

  it("the views load nothing by an absolute address: the cancel link is shown, not fetched", () => {
    const views = [
      confirmation({}, true).root,
      status().root,
      status({ cancelled: true, bookAgain: "/book/x" }).root,
      status({ ended: true, bookAgain: "/book/x" }).root,
      render(LinkHeader, { page: page({ meet: true, description: "See https://example.com/x" }) }).root,
      renderElement(createElement(BookingPage, { id: "x" })).root,
      renderElement(createElement(CancelPage, { token: "tok3n" })).root,
    ];
    for (const root of views) {
      expect(external(root)).toEqual([]);
      expect(byTag(root, "script")).toEqual([]);
      expect(byTag(root, "img").filter((i) => !(i.attrs.src ?? "").startsWith("/"))).toEqual([]);
    }
  });

  it("the layout and the stylesheet name no other origin: the font is served by the app", () => {
    const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/url\(\s*["']?(https?:)?\/\//i);
    expect(css).not.toMatch(/@import\s+(url\()?["']?(https?:)?\/\//i);
    const layout = readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
    expect(layout).not.toMatch(/(src|href)=["'{]+\s*["']?(https?:)?\/\//i);
    // next/font/google downloads the font at build time and serves it from the app.
    expect(layout).toMatch(/from "next\/font\/google"/);
  });
});
