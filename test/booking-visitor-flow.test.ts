import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingMade, BookingPageInfo, BookingToCancel } from "@/lib/types";
import { at } from "./booking-reference";
import { elements, fake } from "./fake-react";

// Booking links' quick wins (run 2026-11-25-ekip-quick-wins-visitor), the
// visitor's pages run in node with fake-react.ts's hooks in place of React's:
// - criterion 1: right after booking, the address bar holds the booking's
//   cancel link in place of the booking page's history entry (replaceState,
//   no new entry); the cancel page reads its own address for Copy.
// - criterion 5: a message on the form goes when the visitor changes a field
//   or presses "Pick another time", and never shows above the list after it;
//   the 409's message shows above the refreshed list.
// - criterion 7: after the limit per address, Book stays disabled until
//   Retry-After has passed, so a waiting visitor's press sends nothing; a full
//   link's message is a message like any other.
// - criterion 8: focus goes to the form's heading after a pick, to the
//   confirmation's heading after booking, and to the cancelled message after
//   cancelling.
// The pages' fetch is stubbed; window is a stub with history and location.

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  const { fake } = await import("./fake-react");
  return { ...real, ...fake.hooks, default: { ...real, ...fake.hooks } };
});

const { BookingPage, BookingForm, Confirmation, FLOW_START, TimeList, canBook, nextFlow, replaceAddressWithCancelLink } = await import(
  "@/app/book/[id]/booking-page"
);
const { BookingStatus, CancelPage } = await import("@/app/book/cancel/[token]/cancel-page");
const { Message } = await import("@/app/book/shell");

type Any = ReactElement<Record<string, unknown>>;
const IST = "Europe/Istanbul";
const ist = (d: number, h: number, m = 0) => at(IST, 2026, 11, d, h, m);
const MIN = 60_000;
const ID = "Ab3dE5gH7jK9mN1pQ3sT5v";
const TOKEN = "Zy8xW6vU4tS2rQ0pO8nM6lK4jI2hG0fE";
const SLOTS = [ist(26, 10), ist(26, 10, 30), ist(27, 10)].map((start) => ({ start, end: start + 30 * MIN }));
const PAGE: BookingPageInfo = {
  title: "Intro call",
  description: "",
  durationMin: 30,
  hostName: "Zeynep Şahin",
  meet: true,
  slots: SLOTS,
  fullDays: [],
};
const MADE: BookingMade = {
  start: SLOTS[0].start,
  end: SLOTS[0].end,
  title: "Intro call",
  hostName: "Zeynep Şahin",
  cancelUrl: `https://cal.example.com/book/cancel/${TOKEN}`,
  invited: true,
};
const TAKEN = "That time was just taken. Pick another.";
const LINK_FULL = "This booking link is taking no more bookings for now. Try again in an hour.";

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
/** How the stubbed server answers each request. */
let server: (call: Call) => Response | Promise<Response>;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const history = { replaceState: vi.fn(), pushState: vi.fn() };
const location = { origin: "https://cal.example.com", pathname: `/book/${ID}` };

beforeEach(() => {
  calls = [];
  history.replaceState.mockReset();
  history.pushState.mockReset();
  location.pathname = `/book/${ID}`;
  vi.stubGlobal("window", { history, location });
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const call: Call = { url: String(input), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return server(call);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The one element of `type` in the latest tree. */
function the(type: unknown, tree: ReactNode = fake.tree): Any {
  const found = elements(tree).filter((e) => e.type === type);
  if (found.length !== 1) throw new Error(`expected one ${String((type as { name?: string })?.name ?? type)}, found ${found.length}: ${elements(tree).map((e) => (typeof e.type === "string" ? e.type : (e.type as { name?: string }).name)).join(",")}`);
  return found[0];
}
const has = (type: unknown, tree: ReactNode = fake.tree) => elements(tree).some((e) => e.type === type);
const posts = () => calls.filter((c) => c.method === "POST");
const gets = () => calls.filter((c) => c.method === "GET");

/** The booking page's own component, as BookingPage renders it inside its toast provider. */
const Booking = ((BookingPage({ id: ID }) as Any).props.children as Any).type as (p: { id: string }) => ReactNode;
const Cancel = ((CancelPage({ token: TOKEN }) as Any).props.children as Any).type as (p: { token: string }) => ReactNode;

/** Open the booking page, pick the first time and fill in the form. */
async function toTheForm() {
  fake.mount(Booking, { id: ID });
  expect(the(Message).props.children).toBe("Loading…");
  await fake.settle();
  (the(TimeList).props.onPick as (s: unknown) => void)(SLOTS[0]);
  fake.flush();
  type(["name", "Ayşe Visitor"], ["email", "ayse@example.org"]);
  return the(BookingForm);
}
function type(...fields: [string, string][]) {
  for (const [field, value] of fields) {
    (the(BookingForm).props.onField as (f: string, v: string) => void)(field, value);
    fake.flush();
  }
}
async function pressBook() {
  const preventDefault = vi.fn();
  await (the(BookingForm).props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault });
  await fake.settle();
  expect(preventDefault).toHaveBeenCalled();
}

describe("right after booking, the address is the cancel link (criterion 1)", () => {
  it("replaces the booking page's history entry with /book/cancel/<token>, adding none, and shows the confirmation", async () => {
    server = (c) => (c.method === "GET" ? json(PAGE) : json(MADE));
    const form = await toTheForm();
    expect(form.props.canBook).toBe(true);
    expect(history.replaceState).not.toHaveBeenCalled();
    await pressBook();
    expect(posts()).toEqual([
      { url: `/api/book/${ID}`, method: "POST", body: { start: SLOTS[0].start, name: "Ayşe Visitor", email: "ayse@example.org", note: null } },
    ]);
    expect(history.replaceState).toHaveBeenCalledTimes(1);
    expect(history.replaceState.mock.calls[0][1]).toBe("");
    expect(history.replaceState.mock.calls[0][2]).toBe(`/book/cancel/${TOKEN}`);
    expect(history.pushState).not.toHaveBeenCalled();
    const confirmation = the(Confirmation);
    expect(confirmation.props).toMatchObject({ made: MADE, email: "ayse@example.org", meet: true });
  });

  it("keeps the link's own path whatever origin APP_URL gives it, and survives a browser that refuses", () => {
    replaceAddressWithCancelLink(`http://internal-host:3000/book/cancel/${TOKEN}`);
    expect(history.replaceState.mock.calls).toEqual([[null, "", `/book/cancel/${TOKEN}`]]);
    history.replaceState.mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => replaceAddressWithCancelLink(MADE.cancelUrl)).not.toThrow();
  });

  it("doesn't touch the address when Book fails", async () => {
    for (const [status, body] of [
      [409, { error: TAKEN }],
      [400, { error: "Give a valid email address." }],
      [503, { error: "This booking link can't take bookings right now." }],
      [429, { error: LINK_FULL }],
    ] as const) {
      server = (c) => (c.method === "GET" ? json(PAGE) : json(body, status));
      await toTheForm();
      await pressBook();
      expect(has(Confirmation), String(status)).toBe(false);
    }
    expect(history.replaceState).not.toHaveBeenCalled();
    expect(history.pushState).not.toHaveBeenCalled();
  });
});

describe("the list names the zone at its first time (criterion 4)", () => {
  it("hands the list its first time, or the moment the page loaded when it has none", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(ist(25, 12));
    server = () => json(PAGE);
    fake.mount(Booking, { id: ID });
    await fake.settle();
    expect(the(TimeList).props.at).toBe(SLOTS[0].start);
    server = () => json({ ...PAGE, slots: [] });
    fake.mount(Booking, { id: ID });
    await fake.settle();
    expect(the(TimeList).props.at).toBe(ist(25, 12));
  });
});

describe("the cancel page reads its own address (criterion 1)", () => {
  const ACTIVE: BookingToCancel = { title: "Intro call", start: SLOTS[0].start, end: SLOTS[0].end, hostName: "Zeynep Şahin", cancelled: false, ended: false, bookAgain: null };

  it("shows the booking with the page's address, without its query or fragment, as the link to copy", async () => {
    location.pathname = `/book/cancel/${TOKEN}`;
    server = () => json(ACTIVE);
    fake.mount(Cancel, { token: TOKEN });
    await fake.settle();
    expect(gets().map((c) => c.url)).toEqual([`/api/book/cancel/${TOKEN}`]);
    expect(the(BookingStatus).props).toMatchObject({ booking: ACTIVE, address: `https://cal.example.com/book/cancel/${TOKEN}`, focusCancelled: false });
  });

  it("cancels with one press, then shows the cancelled booking with the focus to move", async () => {
    location.pathname = `/book/cancel/${TOKEN}`;
    const cancelled = { ...ACTIVE, cancelled: true, bookAgain: `/book/${ID}` };
    server = (c) => json(c.method === "GET" ? ACTIVE : cancelled);
    fake.mount(Cancel, { token: TOKEN });
    await fake.settle();
    (the(BookingStatus).props.onCancel as () => Promise<void>)();
    await fake.settle();
    expect(posts().map((c) => c.url)).toEqual([`/api/book/cancel/${TOKEN}`]);
    expect(the(BookingStatus).props).toMatchObject({ booking: cancelled, focusCancelled: true });
  });

  it("after a refusal because the meeting ended, reads the booking again and shows it as taken place", async () => {
    location.pathname = `/book/cancel/${TOKEN}`;
    const ended = { ...ACTIVE, ended: true, bookAgain: `/book/${ID}` };
    let n = 0;
    server = (c) => (c.method === "POST" ? json({ error: "This meeting has ended, so it can't be cancelled." }, 409) : json(n++ === 0 ? ACTIVE : ended));
    fake.mount(Cancel, { token: TOKEN });
    await fake.settle();
    (the(BookingStatus).props.onCancel as () => Promise<void>)();
    await fake.settle();
    expect(gets()).toHaveLength(2);
    expect(the(BookingStatus).props).toMatchObject({ booking: ended, focusCancelled: false });
  });
});

describe("stale messages go (criterion 5)", () => {
  it("a message on the form goes when the visitor changes a field", async () => {
    server = (c) => (c.method === "GET" ? json(PAGE) : json({ error: "Give a valid email address." }, 400));
    await toTheForm();
    await pressBook();
    expect(the(BookingForm).props.problem).toBe("Give a valid email address.");
    for (const field of ["name", "email", "note"]) {
      await pressBook();
      expect(the(BookingForm).props.problem, field).toBe("Give a valid email address.");
      type([field, field === "email" ? "ayse@example.org " : `${field} changed`]);
      expect(the(BookingForm).props.problem, field).toBeNull();
    }
  });

  it("a message on the form goes on Pick another time, and isn't shown above the list", async () => {
    server = (c) => (c.method === "GET" ? json(PAGE) : json({ error: "Give a valid email address." }, 400));
    await toTheForm();
    await pressBook();
    expect(the(BookingForm).props.problem).toBe("Give a valid email address.");
    (the(BookingForm).props.onBack as () => void)();
    fake.flush();
    expect(has(BookingForm)).toBe(false);
    expect(the(TimeList).props.problem).toBeNull();
    // Picking a time again: the form has no message either.
    (the(TimeList).props.onPick as (s: unknown) => void)(SLOTS[1]);
    fake.flush();
    expect(the(BookingForm).props.problem).toBeNull();
  });

  it("'Couldn't reach the server' goes the same way", async () => {
    server = (c) => {
      if (c.method === "GET") return json(PAGE);
      throw new TypeError("Failed to fetch");
    };
    await toTheForm();
    await pressBook();
    expect(the(BookingForm).props.problem).toBe("Couldn't reach the server. Try again.");
    type(["note", "Hello"]);
    expect(the(BookingForm).props.problem).toBeNull();
    await pressBook();
    (the(BookingForm).props.onBack as () => void)();
    fake.flush();
    expect(the(TimeList).props.problem).toBeNull();
  });

  it("the 409's message shows above the refreshed list, read again, with the details kept", async () => {
    let read = 0;
    server = (c) => {
      if (c.method === "POST") return json({ error: TAKEN }, 409);
      read++;
      return json(read === 1 ? PAGE : { ...PAGE, slots: SLOTS.slice(1) });
    };
    await toTheForm();
    await pressBook();
    expect(gets()).toHaveLength(2);
    expect(has(BookingForm)).toBe(false);
    const list = the(TimeList);
    expect(list.props.problem).toBe(TAKEN);
    expect(list.props.slots).toEqual(SLOTS.slice(1));
    expect(list.props.focus).toBe(true);
    // Picking another time drops it; what was typed is still there.
    (list.props.onPick as (s: unknown) => void)(SLOTS[1]);
    fake.flush();
    expect(the(BookingForm).props).toMatchObject({ problem: null, guest: { name: "Ayşe Visitor", email: "ayse@example.org", note: "" } });
  });
});

describe("the try limit on the page (criterion 7)", () => {
  const TOO_MANY = "Too many tries. Try again in 5 minutes.";

  it("keeps Book disabled for Retry-After's seconds, so a press meanwhile sends nothing, then lets it go", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(ist(25, 12));
    server = (c) => (c.method === "GET" ? json(PAGE) : posts().length === 1 ? json({ error: TOO_MANY }, 429, { "Retry-After": "270" }) : json(MADE));
    await toTheForm();
    await pressBook();
    expect(posts()).toHaveLength(1);
    const waiting = the(BookingForm);
    expect(waiting.props.canBook).toBe(false);
    expect(waiting.props.wait).toEqual({ until: ist(25, 12) + 270_000, now: ist(25, 12) });
    expect(waiting.props.problem).toBeNull();

    // A press, Enter included, while it waits: nothing is sent.
    await pressBook();
    // Typing doesn't end the wait either.
    type(["name", "Ayşe V."]);
    expect(the(BookingForm).props.canBook).toBe(false);
    await pressBook();
    // Nor does picking another time.
    (the(BookingForm).props.onBack as () => void)();
    fake.flush();
    (the(TimeList).props.onPick as (s: unknown) => void)(SLOTS[2]);
    fake.flush();
    expect(the(BookingForm).props.canBook).toBe(false);
    await pressBook();
    expect(posts()).toHaveLength(1);

    // One second short of the wait: still disabled.
    vi.advanceTimersByTime(269_000);
    fake.flush();
    expect(the(BookingForm).props.canBook).toBe(false);
    expect((the(BookingForm).props.wait as { now: number }).now).toBe(ist(25, 12) + 269_000);
    await pressBook();
    expect(posts()).toHaveLength(1);
    // Then Book works again.
    vi.advanceTimersByTime(1000);
    fake.flush();
    expect(the(BookingForm).props).toMatchObject({ canBook: true, wait: null });
    await pressBook();
    expect(posts()).toHaveLength(2);
    expect(has(Confirmation)).toBe(true);
  });

  it("shows a full link's message as a message, with Book still there to press", async () => {
    server = (c) => (c.method === "GET" ? json(PAGE) : json({ error: LINK_FULL }, 429));
    await toTheForm();
    await pressBook();
    expect(the(BookingForm).props).toMatchObject({ problem: LINK_FULL, wait: null, canBook: true });
  });
});

describe("nextFlow and canBook (criteria 5 and 7)", () => {
  const picked = nextFlow(
    nextFlow(nextFlow(FLOW_START, { type: "pick", slot: SLOTS[0] }), { type: "field", field: "name", value: "Ayşe" }),
    { type: "field", field: "email", value: "a@example.org" },
  );
  const answered = (status: number, body: unknown, retryAfter = 0, now = 1_000_000) => nextFlow({ ...picked, sending: true }, { type: "answer", status, body, retryAfter, now });

  it("drops the message on a pick, a field change and Pick another time", () => {
    const withProblem = answered(400, { error: "Give a valid email address." });
    expect(withProblem.problem).toBe("Give a valid email address.");
    expect(nextFlow(withProblem, { type: "field", field: "note", value: "x" }).problem).toBeNull();
    expect(nextFlow(withProblem, { type: "back" }).problem).toBeNull();
    expect(nextFlow(withProblem, { type: "pick", slot: SLOTS[1] }).problem).toBeNull();
    expect(nextFlow(nextFlow(picked, { type: "unreachable" }), { type: "field", field: "name", value: "B" }).problem).toBeNull();
  });

  it("goes back to the list with the 409's message and reads it again", () => {
    const lost = answered(409, { error: TAKEN });
    expect(lost).toMatchObject({ problem: TAKEN, picked: null, back: true, reload: picked.reload + 1, sending: false });
  });

  it("waits Retry-After's seconds after a 429 that carries it, and not a moment less", () => {
    const waiting = answered(429, { error: "Too many tries. Try again in 7 minutes." }, 401, 5_000);
    expect(canBook(waiting)).toBe(false);
    expect(waiting.wait).toEqual({ until: 5_000 + 401_000, now: 5_000 });
    expect(canBook(nextFlow(waiting, { type: "tick", now: 405_999 }))).toBe(false);
    expect(canBook(nextFlow(waiting, { type: "field", field: "email", value: "b@example.org" }))).toBe(false);
    expect(canBook(nextFlow(nextFlow(waiting, { type: "back" }), { type: "pick", slot: SLOTS[1] }))).toBe(false);
    expect(canBook(nextFlow(waiting, { type: "tick", now: 406_000 }))).toBe(true);
  });

  it("can't book without a time, a name and an email, or while a try is on its way", () => {
    expect(canBook(picked)).toBe(true);
    expect(canBook(FLOW_START)).toBe(false);
    expect(canBook({ ...picked, sending: true })).toBe(false);
    expect(canBook(nextFlow(picked, { type: "field", field: "name", value: "  " }))).toBe(false);
    expect(canBook(nextFlow(picked, { type: "field", field: "email", value: "" }))).toBe(false);
  });
});

describe("where the focus goes (criterion 8)", () => {
  const clock = { zone: IST, hour12: false };
  const formProps = (slot = SLOTS[0]) => ({
    slot,
    clock,
    guest: { name: "", email: "", note: "" },
    problem: null,
    wait: null,
    sending: false,
    canBook: false,
    onField: () => {},
    onBack: () => {},
    onSubmit: () => {},
  });

  it("after picking a time: to the form's heading, the picked time; and again for another time", () => {
    fake.mount(BookingForm, formProps());
    expect(fake.focused.map((n) => [n.tag, n.text])).toEqual([["h2", "Thursday 26 November, 10:00–10:30"]]);
    fake.update(formProps());
    expect(fake.focused).toHaveLength(1);
    fake.update(formProps(SLOTS[2]));
    expect(fake.focused.map((n) => n.text)).toEqual(["Thursday 26 November, 10:00–10:30", "Friday 27 November, 10:00–10:30"]);
  });

  it("after booking: to the confirmation's heading", () => {
    fake.mount(Confirmation, { made: MADE, email: "a@example.org", meet: true, clock });
    expect(fake.focused.map((n) => [n.tag, n.text])).toEqual([["h1", "Booked"]]);
  });

  it("after cancelling: to the cancelled message, and only after cancelling here", () => {
    const booking: BookingToCancel = { title: "Intro call", start: SLOTS[0].start, end: SLOTS[0].end, hostName: "Zeynep Şahin", cancelled: true, ended: false, bookAgain: null };
    const props = (focusCancelled: boolean) => ({ booking, clock, address: "https://cal.example.com/book/cancel/x", busy: false, problem: null, focusCancelled, onCancel: () => {} });
    fake.mount(BookingStatus, props(false));
    expect(fake.focused).toEqual([]);
    fake.mount(BookingStatus, props(true));
    expect(fake.focused.map((n) => [n.tag, n.text])).toEqual([["p", "This booking is cancelled."]]);
  });

  it("the list's heading takes it only when the list comes back", () => {
    const listProps = (focus: boolean) => ({ slots: SLOTS, fullDays: [], clock, at: SLOTS[0].start, problem: null, focus, onPick: () => {} });
    fake.mount(TimeList, listProps(false));
    expect(fake.focused).toEqual([]);
    fake.mount(TimeList, listProps(true));
    expect(fake.focused.map((n) => [n.tag, n.text])).toEqual([["h2", "Pick a time"]]);
  });

  it("after a pick on the page itself: the form appears for that time", async () => {
    server = () => json(PAGE);
    fake.mount(Booking, { id: ID });
    await fake.settle();
    (the(TimeList).props.onPick as (s: unknown) => void)(SLOTS[1]);
    fake.flush();
    expect(the(BookingForm).props.slot).toEqual(SLOTS[1]);
    expect(has(TimeList)).toBe(false);
  });
});
