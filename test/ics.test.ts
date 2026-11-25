import { afterEach, describe, expect, it, vi } from "vitest";
import { htmlToText, type Busy } from "@/lib/server/google";
import { IcsError, icsBusy } from "@/lib/server/ics";

// Calendar files here are written the way Google Calendar and Outlook export
// them: CRLF lines, long lines folded, VTIMEZONE blocks, Windows zone names,
// X-MICROSOFT-CDO-* properties. Expected instants are UTC, worked out by hand
// and checked against Intl, never taken from the code under test.

type Lines = string | string[];
const ics = (...lines: Lines[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ekip-takvim//tests//EN", ...lines.flat(), "END:VCALENDAR", ""].join("\r\n");
const vevent = (...props: string[]) => ["BEGIN:VEVENT", ...props, "END:VEVENT"];

type Result = ReturnType<typeof icsBusy>;
const read = (text: string, from: string, to: string, timezone = "UTC", limit?: number): Result =>
  icsBusy(text, { from: new Date(from), to: new Date(to), timezone, ...(limit === undefined ? {} : { limit }) });

const iso = (ms: number) => new Date(ms).toISOString().replace(":00.000Z", "Z");
const spans = (r: Result) => r.busy.map((b) => `${iso(b.start)}/${iso(b.end)}`);
const starts = (r: Result) => r.busy.map((b) => iso(b.start));
const startsByTitle = (r: Result) => Object.fromEntries(r.busy.map((b) => [b.title, iso(b.start)]));
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const MIN = 60_000;

/** Every block has an id, and no two blocks the same one. */
function expectDistinctIds(r: Result) {
  const seen = new Set<string>();
  const repeated: string[] = [];
  let missing = 0;
  for (const { eventId } of r.busy) {
    if (typeof eventId !== "string" || !eventId) missing++;
    else if (seen.has(eventId)) repeated.push(eventId);
    else seen.add(eventId);
  }
  expect(missing, "blocks without an id").toBe(0);
  expect(repeated, "ids given to more than one block").toEqual([]);
}

// The keys of google.ts's Busy: part 2 hands these blocks to setBusy unchanged.
const BUSY_KEYS = ["start", "end", "tentative", "allDay", "title", "private", "eventId", "details"];
const DETAIL_KEYS = ["description", "location", "meetLink", "htmlLink"];
function expectBusyShape(b: Busy) {
  expect(Object.keys(b).filter((k) => !BUSY_KEYS.includes(k))).toEqual([]);
  expect(Number.isInteger(b.start) && Number.isInteger(b.end)).toBe(true);
  for (const k of ["tentative", "allDay", "private"] as const) if (b[k] !== undefined) expect(typeof b[k]).toBe("boolean");
  for (const k of ["title", "eventId"] as const) if (b[k] !== undefined) expect(typeof b[k]).toBe("string");
  if (b.details !== undefined) expect(Object.keys(b.details).filter((k) => !DETAIL_KEYS.includes(k))).toEqual([]);
}

// The process zone is changed at runtime (vitest starts every file in UTC).
const PROCESS_ZONES = ["UTC", "Asia/Tokyo", "America/New_York", "Europe/Berlin", "Pacific/Chatham", "Australia/Lord_Howe", "America/St_Johns"];
const REF = Date.UTC(2026, 0, 15, 12);
function offsetIn(zone: string, at: number) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return (Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute")) - at) / MIN;
}
function inProcessZone<T>(zone: string, fn: () => T): T {
  process.env.TZ = zone;
  try {
    // The switch took effect, or comparing zones would prove nothing.
    expect(0 - new Date(REF).getTimezoneOffset()).toBe(offsetIn(zone, REF));
    return fn();
  } finally {
    process.env.TZ = "UTC";
  }
}
/** The result in UTC, after checking every other process zone gives the same. */
function sameInEveryProcessZone(fn: () => Result): Result {
  const base = inProcessZone("UTC", fn);
  for (const zone of PROCESS_ZONES) expect(inProcessZone(zone, fn), `process zone ${zone}`).toEqual(base);
  return base;
}
afterEach(() => {
  process.env.TZ = "UTC";
});

// ---------------------------------------------------------------- zones

const BERLIN_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Berlin",
  "X-LIC-LOCATION:Europe/Berlin",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

const ISTANBUL_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Istanbul",
  "X-LIC-LOCATION:Europe/Istanbul",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300",
  "TZNAME:GMT+3",
  "DTSTART:19700101T000000",
  "END:STANDARD",
  "END:VTIMEZONE",
];

const NEW_YORK_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "X-LIC-LOCATION:America/New_York",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

/** Outlook's block for a zone with the EU rules (W. Europe, or a "Customized Time Zone"). */
const outlookEuZone = (tzid: string) => [
  "BEGIN:VTIMEZONE",
  `TZID:${tzid}`,
  "BEGIN:STANDARD",
  "DTSTART:16010101T030000",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:16010101T020000",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
];

const TURKEY_OUTLOOK_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Turkey Standard Time",
  "BEGIN:STANDARD",
  "DTSTART:16010101T000000",
  "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:16010101T000000",
  "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
];

// A zone that exists only in this file: +02:00, and +03:00 from the first Sunday
// of April to the first Sunday of October. No IANA zone has these rules, so only
// reading the block itself gives the right offsets.
const LAB_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Lab Time",
  "BEGIN:STANDARD",
  "DTSTART:20001001T030000",
  "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0200",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:20000402T020000",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0300",
  "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
];

// ---------------------------------------------------------------- exports

const GOOGLE_EXPORT = ics(
  "CALSCALE:GREGORIAN",
  "METHOD:PUBLISH",
  "X-WR-CALNAME:Work",
  "X-WR-TIMEZONE:Europe/Istanbul",
  BERLIN_VTIMEZONE,
  ISTANBUL_VTIMEZONE,
  vevent(
    "DTSTART;TZID=Europe/Berlin:20261020T180000",
    "DTEND;TZID=Europe/Berlin:20261020T190000",
    "RRULE:FREQ=WEEKLY;COUNT=3;BYDAY=TU",
    "DTSTAMP:20261101T120000Z",
    "UID:4q3n1j5c4l0s9m2a8b6d1e0f3k@google.com",
    "CREATED:20261001T090000Z",
    "DESCRIPTION:",
    "LAST-MODIFIED:20261001T090000Z",
    "LOCATION:",
    "SEQUENCE:0",
    "STATUS:CONFIRMED",
    "SUMMARY:Planning",
    "TRANSP:OPAQUE",
  ),
  vevent(
    "DTSTART;TZID=Europe/Istanbul:20261111T143000",
    "DTEND;TZID=Europe/Istanbul:20261111T151500",
    "DTSTAMP:20261101T120000Z",
    "ORGANIZER;CN=Ayşe Yılmaz:mailto:ayse@example.com",
    "UID:0a1b2c3d4e5f6g7h8i9j@google.com",
    'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN="Doe, J',
    ' ane";X-NUM-GUESTS=0:mailto:jane@example.com',
    "CREATED:20261020T080000Z",
    "DESCRIPTION:Bring the Q4 numbers\\, and the hiring plan.\\nLink: https://exam",
    " ple.com/doc?id=42",
    "LAST-MODIFIED:20261020T080000Z",
    "LOCATION:Kadıköy Office\\, Room 3",
    "SEQUENCE:0",
    "STATUS:CONFIRMED",
    "SUMMARY:1:1 with Ayşe",
    "TRANSP:OPAQUE",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:This is an event reminder",
    "TRIGGER:-P0DT0H10M0S",
    "END:VALARM",
  ),
  vevent(
    "DTSTART;VALUE=DATE:20261105",
    "DTEND;VALUE=DATE:20261107",
    "DTSTAMP:20261101T120000Z",
    "UID:3conf2026xyz@google.com",
    "SUMMARY:Conference",
    "TRANSP:OPAQUE",
  ),
  vevent(
    "DTSTART;TZID=Europe/Istanbul:20261109T093000",
    "DTEND;TZID=Europe/Istanbul:20261109T094500",
    "RRULE:FREQ=WEEKLY;WKST=MO;UNTIL=20261113T205959Z;BYDAY=FR,MO,TH,TU,WE",
    "EXDATE;TZID=Europe/Istanbul:20261111T093000",
    "DTSTAMP:20261101T120000Z",
    "UID:standup7q8w9e@google.com",
    "SEQUENCE:0",
    "SUMMARY:Standup",
  ),
  vevent(
    "DTSTART;TZID=Europe/Istanbul:20261112T110000",
    "DTEND;TZID=Europe/Istanbul:20261112T111500",
    "DTSTAMP:20261101T120000Z",
    "UID:standup7q8w9e@google.com",
    "RECURRENCE-ID;TZID=Europe/Istanbul:20261112T093000",
    "SEQUENCE:1",
    "SUMMARY:Standup (moved)",
  ),
  vevent(
    "DTSTART;TZID=Europe/Istanbul:20261113T093000",
    "DTEND;TZID=Europe/Istanbul:20261113T094500",
    "DTSTAMP:20261101T120000Z",
    "UID:standup7q8w9e@google.com",
    "RECURRENCE-ID;TZID=Europe/Istanbul:20261113T093000",
    "SEQUENCE:1",
    "STATUS:CANCELLED",
    "SUMMARY:Standup",
  ),
  vevent(
    "DTSTART;TZID=Europe/Istanbul:20261112T160000",
    "DTEND;TZID=Europe/Istanbul:20261112T170000",
    "DTSTAMP:20261101T120000Z",
    "UID:doctor55@google.com",
    "CLASS:PRIVATE",
    "SUMMARY:Doctor",
  ),
  vevent(
    "DTSTART:20261110T100000Z",
    "DTEND:20261110T110000Z",
    "DTSTAMP:20261101T120000Z",
    "UID:focus66@google.com",
    "SUMMARY:Focus time",
    "TRANSP:TRANSPARENT",
  ),
  vevent(
    "DTSTART:20261110T120000Z",
    "DTEND:20261110T130000Z",
    "DTSTAMP:20261101T120000Z",
    "UID:lunch77@google.com",
    "STATUS:TENTATIVE",
    "SUMMARY:Maybe lunch",
  ),
);

const GOOGLE_SPANS = [
  "2026-10-20T16:00Z/2026-10-20T17:00Z",
  "2026-10-27T17:00Z/2026-10-27T18:00Z",
  "2026-11-03T17:00Z/2026-11-03T18:00Z",
  "2026-11-04T21:00Z/2026-11-06T21:00Z",
  "2026-11-09T06:30Z/2026-11-09T06:45Z",
  "2026-11-10T06:30Z/2026-11-10T06:45Z",
  "2026-11-10T12:00Z/2026-11-10T13:00Z",
  "2026-11-11T11:30Z/2026-11-11T12:15Z",
  "2026-11-12T08:00Z/2026-11-12T08:15Z",
  "2026-11-12T13:00Z/2026-11-12T14:00Z",
];

const OUTLOOK_UID = "040000008200E00074C5B7101A82E0080000000010F2C3A1B2D3DC010000000000000000100000000A1B2C3D4E5F60718293A4B5C6D7E8F90";
const OUTLOOK_EXPORT = ics(
  "METHOD:PUBLISH",
  "X-WR-CALNAME:Calendar",
  outlookEuZone("W. Europe Standard Time"),
  TURKEY_OUTLOOK_VTIMEZONE,
  outlookEuZone("Customized Time Zone"),
  vevent(
    "DESCRIPTION:\\n",
    "RRULE:FREQ=WEEKLY;UNTIL=20261201T170000Z;INTERVAL=1;BYDAY=TU;WKST=MO",
    "EXDATE;TZID=W. Europe Standard Time:20261110T180000",
    // The UID folded, as Outlook folds lines past 75 octets; the override below has it on one line.
    `UID:${OUTLOOK_UID.slice(0, 70)}`,
    ` ${OUTLOOK_UID.slice(70)}`,
    "SUMMARY;LANGUAGE=en-US:Team sync",
    "DTSTART;TZID=W. Europe Standard Time:20261020T180000",
    "DTEND;TZID=W. Europe Standard Time:20261020T190000",
    "CLASS:PUBLIC",
    "PRIORITY:5",
    "DTSTAMP:20261101T120000Z",
    "TRANSP:OPAQUE",
    "STATUS:CONFIRMED",
    "SEQUENCE:0",
    "LOCATION;LANGUAGE=en-US:Microsoft Teams Meeting",
    "X-MICROSOFT-CDO-APPT-SEQUENCE:0",
    "X-MICROSOFT-CDO-BUSYSTATUS:BUSY",
    "X-MICROSOFT-CDO-INTENDEDSTATUS:BUSY",
    "X-MICROSOFT-CDO-ALLDAYEVENT:FALSE",
    "X-MICROSOFT-CDO-IMPORTANCE:1",
    "X-MICROSOFT-CDO-INSTTYPE:1",
    "X-MICROSOFT-DONOTFORWARDMEETING:FALSE",
    "X-MICROSOFT-DISALLOW-COUNTER:FALSE",
  ),
  vevent(
    "DESCRIPTION:\\n",
    `UID:${OUTLOOK_UID}`,
    "RECURRENCE-ID;TZID=W. Europe Standard Time:20261117T180000",
    "SUMMARY;LANGUAGE=en-US:Team sync (moved)",
    "DTSTART;TZID=W. Europe Standard Time:20261118T140000",
    "DTEND;TZID=W. Europe Standard Time:20261118T150000",
    "CLASS:PUBLIC",
    "DTSTAMP:20261101T120000Z",
    "TRANSP:OPAQUE",
    "STATUS:CONFIRMED",
    "SEQUENCE:1",
    "X-MICROSOFT-CDO-BUSYSTATUS:BUSY",
    "X-MICROSOFT-CDO-INSTTYPE:3",
  ),
  vevent(
    "DESCRIPTION:Agenda for the call with the vendor about the renewal of the su",
    " pport contract.\\n\\nDial-in details follow.",
    "UID:040000008200E00074C5B7101A82E00800000000F0E1D2C3B4A5DC0100000000000000001000000AABBCCDDEEFF00112233445566778899",
    "SUMMARY;LANGUAGE=en-US:Vendor call",
    "DTSTART;TZID=Turkey Standard Time:20261112T100000",
    "DTEND;TZID=Turkey Standard Time:20261112T110000",
    "CLASS:PUBLIC",
    "DTSTAMP:20261101T120000Z",
    "TRANSP:OPAQUE",
    "STATUS:CONFIRMED",
    "X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE",
    "X-MICROSOFT-CDO-INTENDEDSTATUS:BUSY",
  ),
  vevent(
    "UID:040000008200E00074C5B7101A82E00800000000AAAABBBBCCCCDC01000000000000000010000000F00DF00DF00DF00DF00DF00DF00DF00D",
    "SUMMARY;LANGUAGE=en-US:Out of office",
    "DTSTART;VALUE=DATE:20261119",
    "DTEND;VALUE=DATE:20261120",
    "CLASS:PUBLIC",
    "DTSTAMP:20261101T120000Z",
    "TRANSP:OPAQUE",
    "X-MICROSOFT-CDO-BUSYSTATUS:OOF",
    "X-MICROSOFT-CDO-ALLDAYEVENT:TRUE",
  ),
  vevent(
    "UID:040000008200E00074C5B7101A82E00800000000DDDDEEEEFFFFDC01000000000000000010000000BEEFBEEFBEEFBEEFBEEFBEEFBEEFBEEF",
    "SUMMARY;LANGUAGE=en-US:Lunch (shown as free)",
    "DTSTART;TZID=W. Europe Standard Time:20261105T120000",
    "DTEND;TZID=W. Europe Standard Time:20261105T130000",
    "DTSTAMP:20261101T120000Z",
    "TRANSP:OPAQUE",
    "X-MICROSOFT-CDO-BUSYSTATUS:FREE",
  ),
  vevent(
    "UID:040000008200E00074C5B7101A82E0080000000012121212DC0100000000000000001000000034343434343434343434343434343434",
    "CLASS:PRIVATE",
    "SUMMARY;LANGUAGE=en-US:Dentist",
    "DTSTART;TZID=Customized Time Zone:20261105T090000",
    "DTEND;TZID=Customized Time Zone:20261105T100000",
    "DTSTAMP:20261101T120000Z",
    "TRANSP:OPAQUE",
    "X-MICROSOFT-CDO-BUSYSTATUS:BUSY",
  ),
);

const OUTLOOK_SPANS = [
  "2026-10-20T16:00Z/2026-10-20T17:00Z",
  "2026-10-27T17:00Z/2026-10-27T18:00Z",
  "2026-11-03T17:00Z/2026-11-03T18:00Z",
  "2026-11-05T08:00Z/2026-11-05T09:00Z",
  "2026-11-12T07:00Z/2026-11-12T08:00Z",
  "2026-11-18T13:00Z/2026-11-18T14:00Z",
  "2026-11-18T21:00Z/2026-11-19T21:00Z",
  "2026-11-24T17:00Z/2026-11-24T18:00Z",
  "2026-12-01T17:00Z/2026-12-01T18:00Z",
];

// ---------------------------------------------------------------- tests

describe("icsBusy: blocks from a calendar file (criterion 1)", () => {
  it("returns one block per event overlapping [from, to), sorted by start, in the Busy shape", () => {
    const text = ics(
      vevent("UID:late@test", "SUMMARY:Late", "DTSTART:20261110T140000Z", "DTEND:20261110T150000Z"),
      vevent("UID:early@test", "SUMMARY:Early", "DTSTART:20261110T090000Z", "DTEND:20261110T100000Z"),
      vevent("UID:across-from@test", "SUMMARY:Across from", "DTSTART:20261109T230000Z", "DTEND:20261110T010000Z"),
      vevent("UID:across-to@test", "SUMMARY:Across to", "DTSTART:20261110T233000Z", "DTEND:20261111T003000Z"),
      vevent("UID:ends-at-from@test", "SUMMARY:Ends at from", "DTSTART:20261109T220000Z", "DTEND:20261110T000000Z"),
      vevent("UID:starts-at-to@test", "SUMMARY:Starts at to", "DTSTART:20261111T000000Z", "DTEND:20261111T010000Z"),
      vevent("UID:later@test", "SUMMARY:Later", "DTSTART:20261112T100000Z", "DTEND:20261112T110000Z"),
    );
    const r = read(text, "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z");
    expect(r.busy.map((b) => b.title)).toEqual(["Across from", "Early", "Late", "Across to"]);
    expect(spans(r)).toEqual([
      "2026-11-09T23:00Z/2026-11-10T01:00Z",
      "2026-11-10T09:00Z/2026-11-10T10:00Z",
      "2026-11-10T14:00Z/2026-11-10T15:00Z",
      "2026-11-10T23:30Z/2026-11-11T00:30Z",
    ]);
    expect(r.skipped).toBe(0);
    expect(r.truncated).toBe(false);
    r.busy.forEach(expectBusyShape);
  });

  it("fills every Busy field it has", () => {
    const text = ics(
      vevent(
        "UID:shape-1@example.com",
        "DTSTAMP:20261101T000000Z",
        "DTSTART:20261110T090000Z",
        "DTEND:20261110T103000Z",
        "SUMMARY:Design review\\, phase 2",
        "LOCATION:Room 4\\; north wing",
        "DESCRIPTION:Agenda:\\n1. Scope\\n2. Risks",
        "CLASS:PRIVATE",
        "STATUS:TENTATIVE",
      ),
    );
    const [b] = read(text, "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z").busy;
    expectBusyShape(b);
    expect(b).toMatchObject({
      start: Date.parse("2026-11-10T09:00:00Z"),
      end: Date.parse("2026-11-10T10:30:00Z"),
      title: "Design review, phase 2",
      private: true,
      tentative: true,
      details: { location: "Room 4; north wing", description: "Agenda:\n1. Scope\n2. Risks" },
    });
    expect(b.eventId).toEqual(expect.any(String));
    expect(b.allDay).toBeFalsy();
  });

  it("reads the Google Calendar export", () => {
    const r = sameInEveryProcessZone(() => read(GOOGLE_EXPORT, "2026-10-19T00:00:00Z", "2026-11-16T00:00:00Z", "Europe/Istanbul"));
    expect(spans(r)).toEqual(GOOGLE_SPANS);
    expect(r.busy.map((b) => b.title)).toEqual([
      "Planning",
      "Planning",
      "Planning",
      "Conference",
      "Standup",
      "Standup",
      "Maybe lunch",
      "1:1 with Ayşe",
      "Standup (moved)",
      "Doctor",
    ]);
    expect(r.busy.map((b) => (b.allDay ? "allDay" : b.tentative ? "tentative" : b.private ? "private" : "-"))).toEqual(
      ["-", "-", "-", "allDay", "-", "-", "tentative", "-", "-", "private"],
    );
    // The VEVENT's own DESCRIPTION, not its VALARM's; folded lines unfolded, escapes read.
    expect(r.busy[7].details).toEqual({
      location: "Kadıköy Office, Room 3",
      description: "Bring the Q4 numbers, and the hiring plan.\nLink: https://example.com/doc?id=42",
    });
    expect(r.skipped).toBe(0);
    expect(r.truncated).toBe(false);
    r.busy.forEach(expectBusyShape);
  });

  it("reads the Outlook export", () => {
    const r = sameInEveryProcessZone(() => read(OUTLOOK_EXPORT, "2026-10-19T00:00:00Z", "2026-12-15T00:00:00Z", "Europe/Istanbul"));
    expect(spans(r)).toEqual(OUTLOOK_SPANS);
    expect(r.busy.map((b) => b.title)).toEqual([
      "Team sync",
      "Team sync",
      "Team sync",
      "Dentist",
      "Vendor call",
      "Team sync (moved)",
      "Out of office",
      "Team sync",
      "Team sync",
    ]);
    expect(r.busy.map((b) => (b.allDay ? "allDay" : b.tentative ? "tentative" : b.private ? "private" : "-"))).toEqual(
      ["-", "-", "-", "private", "tentative", "-", "allDay", "-", "-"],
    );
    expect(r.busy[4].details?.description).toBe("Agenda for the call with the vendor about the renewal of the support contract.\n\nDial-in details follow.");
    expect(r.busy[0].details?.location).toBe("Microsoft Teams Meeting");
    expect(r.skipped).toBe(0);
    r.busy.forEach(expectBusyShape);
  });

  it("reads files with bare LF line ends too", () => {
    const lf = GOOGLE_EXPORT.replace(/\r\n/g, "\n");
    expect(spans(read(lf, "2026-10-19T00:00:00Z", "2026-11-16T00:00:00Z", "Europe/Istanbul"))).toEqual(GOOGLE_SPANS);
  });

  it("takes DURATION when there is no DTEND", () => {
    const text = ics(
      vevent("UID:dur@test", "DTSTART:20261110T090000Z", "DURATION:PT1H30M"),
      vevent("UID:dur-weekly@test", "DTSTART;TZID=Europe/Berlin:20261020T180000", "DURATION:PT45M", "RRULE:FREQ=WEEKLY;COUNT=2"),
    );
    expect(spans(read(text, "2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z"))).toEqual([
      "2026-10-20T16:00Z/2026-10-20T16:45Z",
      "2026-10-27T17:00Z/2026-10-27T17:45Z",
      "2026-11-10T09:00Z/2026-11-10T10:30Z",
    ]);
  });
});

describe("recurring events (criterion 2)", () => {
  const range = ["2026-11-01T00:00:00Z", "2027-07-01T00:00:00Z"] as const;
  const one = (...props: string[]) => read(ics(vevent("UID:rule@test", "SUMMARY:Rule", ...props)), ...range);

  it("expands DAILY with COUNT, and with INTERVAL and UNTIL", () => {
    expect(spans(one("DTSTART:20261102T090000Z", "DTEND:20261102T100000Z", "RRULE:FREQ=DAILY;COUNT=5"))).toEqual([
      "2026-11-02T09:00Z/2026-11-02T10:00Z",
      "2026-11-03T09:00Z/2026-11-03T10:00Z",
      "2026-11-04T09:00Z/2026-11-04T10:00Z",
      "2026-11-05T09:00Z/2026-11-05T10:00Z",
      "2026-11-06T09:00Z/2026-11-06T10:00Z",
    ]);
    // UNTIL is inclusive: the 15th starts exactly at UNTIL.
    expect(starts(one("DTSTART:20261103T090000Z", "DTEND:20261103T093000Z", "RRULE:FREQ=DAILY;INTERVAL=3;UNTIL=20261115T090000Z"))).toEqual([
      "2026-11-03T09:00Z",
      "2026-11-06T09:00Z",
      "2026-11-09T09:00Z",
      "2026-11-12T09:00Z",
      "2026-11-15T09:00Z",
    ]);
  });

  it("expands WEEKLY with BYDAY and COUNT, and with INTERVAL and UNTIL", () => {
    expect(starts(one("DTSTART:20261102T080000Z", "DTEND:20261102T083000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=7"))).toEqual([
      "2026-11-02T08:00Z",
      "2026-11-04T08:00Z",
      "2026-11-06T08:00Z",
      "2026-11-09T08:00Z",
      "2026-11-11T08:00Z",
      "2026-11-13T08:00Z",
      "2026-11-16T08:00Z",
    ]);
    expect(starts(one("DTSTART:20261103T120000Z", "DTEND:20261103T130000Z", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20261204T000000Z"))).toEqual([
      "2026-11-03T12:00Z",
      "2026-11-05T12:00Z",
      "2026-11-17T12:00Z",
      "2026-11-19T12:00Z",
      "2026-12-01T12:00Z",
      "2026-12-03T12:00Z",
    ]);
  });

  it("expands MONTHLY with INTERVAL, BYDAY and UNTIL", () => {
    expect(spans(one("DTSTART:20261103T100000Z", "DTEND:20261103T110000Z", "RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=1TU;UNTIL=20270601T000000Z"))).toEqual([
      "2026-11-03T10:00Z/2026-11-03T11:00Z",
      "2027-01-05T10:00Z/2027-01-05T11:00Z",
      "2027-03-02T10:00Z/2027-03-02T11:00Z",
      "2027-05-04T10:00Z/2027-05-04T11:00Z",
    ]);
  });

  it("reads a monthly last Monday the same written as BYSETPOS=-1 and as -1MO, in wall-clock time", () => {
    // Berlin summer time starts on 2027-03-28, so the last one is an hour earlier in UTC.
    const expected = [
      "2026-11-30T09:00Z/2026-11-30T10:00Z",
      "2026-12-28T09:00Z/2026-12-28T10:00Z",
      "2027-01-25T09:00Z/2027-01-25T10:00Z",
      "2027-02-22T09:00Z/2027-02-22T10:00Z",
      "2027-03-29T08:00Z/2027-03-29T09:00Z",
    ];
    const base = ["DTSTART;TZID=Europe/Berlin:20261130T100000", "DTEND;TZID=Europe/Berlin:20261130T110000"];
    for (const rule of ["RRULE:FREQ=MONTHLY;BYDAY=-1MO;COUNT=5", "RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;COUNT=5"]) {
      const r = sameInEveryProcessZone(() => one(...base, rule));
      expect(spans(r), rule).toEqual(expected);
    }
  });

  it("gives only the occurrences that overlap the window for a rule without an end", () => {
    const r = read(
      ics(vevent("UID:forever@test", "DTSTART:20200106T090000Z", "DTEND:20200106T100000Z", "RRULE:FREQ=DAILY")),
      "2026-11-09T00:00:00Z",
      "2026-11-16T00:00:00Z",
    );
    expect(starts(r)).toEqual([
      "2026-11-09T09:00Z",
      "2026-11-10T09:00Z",
      "2026-11-11T09:00Z",
      "2026-11-12T09:00Z",
      "2026-11-13T09:00Z",
      "2026-11-14T09:00Z",
      "2026-11-15T09:00Z",
    ]);
    expect(r.truncated).toBe(false);
  });

  it("includes an occurrence that started before the window and runs into it", () => {
    const r = read(
      ics(vevent("UID:night@test", "DTSTART:20260101T230000Z", "DTEND:20260102T010000Z", "RRULE:FREQ=DAILY")),
      "2026-11-10T00:00:00Z",
      "2026-11-12T00:00:00Z",
    );
    expect(spans(r)).toEqual([
      "2026-11-09T23:00Z/2026-11-10T01:00Z",
      "2026-11-10T23:00Z/2026-11-11T01:00Z",
      "2026-11-11T23:00Z/2026-11-12T01:00Z",
    ]);
  });

  it("reaches the window for a COUNT rule that started decades ago", () => {
    // Walking a COUNT rule from its start takes more than 10,000 steps here.
    const r = read(
      ics(vevent("UID:old@test", "DTSTART:19900101T090000Z", "DTEND:19900101T091500Z", "RRULE:FREQ=DAILY;COUNT=20000")),
      "2026-11-09T00:00:00Z",
      "2026-11-12T00:00:00Z",
    );
    expect(spans(r)).toEqual([
      "2026-11-09T09:00Z/2026-11-09T09:15Z",
      "2026-11-10T09:00Z/2026-11-10T09:15Z",
      "2026-11-11T09:00Z/2026-11-11T09:15Z",
    ]);
    expect(r.skipped).toBe(0);
  });

  it("drops occurrences named by EXDATE, in the series' zone or in UTC, one per line or listed", () => {
    const series = ["DTSTART;TZID=Europe/Berlin:20261104T100000", "DTEND;TZID=Europe/Berlin:20261104T110000", "RRULE:FREQ=WEEKLY;COUNT=4"];
    const expected = ["2026-11-04T09:00Z/2026-11-04T10:00Z", "2026-11-25T09:00Z/2026-11-25T10:00Z"];
    expect(spans(one(...series, "EXDATE;TZID=Europe/Berlin:20261111T100000", "EXDATE:20261118T090000Z"))).toEqual(expected);
    expect(spans(one(...series, "EXDATE;TZID=Europe/Berlin:20261111T100000,20261118T100000"))).toEqual(expected);
  });

  describe("overrides (RECURRENCE-ID)", () => {
    const UID = "UID:weekly-review@test";
    const OVERRIDES = ics(
      BERLIN_VTIMEZONE,
      // Listed before its series.
      vevent(UID, "RECURRENCE-ID;TZID=Europe/Berlin:20261130T100000", "DTSTART;TZID=Europe/Berlin:20261130T160000", "DTEND;TZID=Europe/Berlin:20261130T170000", "SUMMARY:Later that day"),
      vevent(UID, "DTSTART;TZID=Europe/Berlin:20261102T100000", "DTEND;TZID=Europe/Berlin:20261102T110000", "RRULE:FREQ=WEEKLY;COUNT=6", "SUMMARY:Weekly review"),
      vevent(UID, "RECURRENCE-ID;TZID=Europe/Berlin:20261109T100000", "DTSTART;TZID=Europe/Berlin:20261110T140000", "DTEND;TZID=Europe/Berlin:20261110T150000", "SUMMARY:Moved to Tuesday"),
      vevent(UID, "RECURRENCE-ID;TZID=Europe/Berlin:20261116T100000", "DTSTART;TZID=Europe/Berlin:20261116T100000", "DTEND;TZID=Europe/Berlin:20261116T110000", "STATUS:CANCELLED", "SUMMARY:Weekly review"),
      // RECURRENCE-ID in UTC names the 23rd's 10:00 Berlin occurrence by its instant.
      vevent(UID, "RECURRENCE-ID:20261123T090000Z", "DTSTART;TZID=Europe/Berlin:20270115T100000", "DTEND;TZID=Europe/Berlin:20270115T110000", "SUMMARY:Moved out"),
      vevent(UID, "RECURRENCE-ID;TZID=Europe/Berlin:20261207T100000", "DTSTART;TZID=Europe/Berlin:20261127T120000", "DTEND;TZID=Europe/Berlin:20261127T130000", "SUMMARY:Moved in"),
    );

    it("replaces moved occurrences, drops cancelled ones, and follows them into and out of the window", () => {
      const r = sameInEveryProcessZone(() => read(OVERRIDES, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", "Europe/Istanbul"));
      expect(spans(r)).toEqual([
        "2026-11-02T09:00Z/2026-11-02T10:00Z",
        "2026-11-10T13:00Z/2026-11-10T14:00Z",
        "2026-11-27T11:00Z/2026-11-27T12:00Z",
        "2026-11-30T15:00Z/2026-11-30T16:00Z",
      ]);
      expect(r.busy.map((b) => b.title)).toEqual(["Weekly review", "Moved to Tuesday", "Moved in", "Later that day"]);
      expect(r.skipped).toBe(0);
    });

    it("still blocks the time of an override whose series isn't in the file", () => {
      // Google exports a lone instance when someone was invited to just that one.
      const orphan = ics(vevent("UID:not-here@test", "RECURRENCE-ID;TZID=Europe/Berlin:20261112T100000", "DTSTART;TZID=Europe/Berlin:20261112T150000", "DTEND;TZID=Europe/Berlin:20261112T160000", "SUMMARY:Only this one"));
      const r = read(orphan, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", "Europe/Istanbul");
      expect(spans(r)).toEqual(["2026-11-12T14:00Z/2026-11-12T15:00Z"]);
      expect(r.skipped).toBe(0);
    });

    it("puts a moved occurrence at its new time only, outside the first window too", () => {
      const r = read(OVERRIDES, "2026-11-01T00:00:00Z", "2027-02-01T00:00:00Z", "Europe/Istanbul");
      expect(spans(r)).toEqual([
        "2026-11-02T09:00Z/2026-11-02T10:00Z",
        "2026-11-10T13:00Z/2026-11-10T14:00Z",
        "2026-11-27T11:00Z/2026-11-27T12:00Z",
        "2026-11-30T15:00Z/2026-11-30T16:00Z",
        "2027-01-15T09:00Z/2027-01-15T10:00Z",
      ]);
      // The old times are gone: the 9th, 16th, 23rd, 30th and 7th at 10:00 Berlin.
      const seen = starts(r);
      for (const old of ["2026-11-09T09:00Z", "2026-11-16T09:00Z", "2026-11-23T09:00Z", "2026-11-30T09:00Z", "2026-12-07T09:00Z"]) expect(seen).not.toContain(old);
    });

    it("takes an EXDATE or RECURRENCE-ID whatever the case of its TZID, on the day the clocks spring forward too", () => {
      // Lab Time springs forward on Sunday 2027-04-04 at 02:00, so that day's 02:30 isn't on the clock.
      const series = ["UID:gap-day@test", "SUMMARY:Night shift", "DTSTART;TZID=Lab Time:20270328T023000", "DTEND;TZID=Lab Time:20270328T033000", "RRULE:FREQ=WEEKLY;COUNT=3"];
      const window = ["2027-03-01T00:00:00Z", "2027-05-01T00:00:00Z", "Europe/Istanbul"] as const;
      const first = "2027-03-28T00:30Z/2027-03-28T01:30Z";
      const third = "2027-04-10T23:30Z/2027-04-11T00:30Z";
      for (const tzid of ["Lab Time", "LAB TIME", "lab time"]) {
        const excluded = read(ics(LAB_VTIMEZONE, vevent(...series, `EXDATE;TZID=${tzid}:20270404T023000`)), ...window);
        expect(spans(excluded), `EXDATE;TZID=${tzid}`).toEqual([first, third]);
        const override = vevent("UID:gap-day@test", "SUMMARY:Moved", `RECURRENCE-ID;TZID=${tzid}:20270404T023000`, "DTSTART;TZID=Lab Time:20270404T100000", "DTEND;TZID=Lab Time:20270404T110000");
        const moved = read(ics(LAB_VTIMEZONE, vevent(...series), override), ...window);
        expect(spans(moved), `RECURRENCE-ID;TZID=${tzid}`).toEqual([first, "2027-04-04T07:00Z/2027-04-04T08:00Z", third]);
      }
    });
  });

  describe("in the hour the clocks skip", () => {
    // Berlin springs forward on Sunday 2027-03-28 at 02:00 (01:00Z), so that day's
    // 02:30 isn't on the clock. RFC 5545 3.3.5 reads it with the offset from before
    // the change: 01:30Z, which the clock shows as 03:30. An EXDATE or RECURRENCE-ID
    // naming that instant names the occurrence, in whatever zone it is written.
    // Offsets and change times checked with Intl.
    const SPRING = ["2027-03-01T00:00:00Z", "2027-05-01T00:00:00Z", "Europe/Istanbul"] as const;
    const SERIES = ["UID:night-shift@test", "SUMMARY:Night shift", "DTSTART;TZID=Europe/Berlin:20270321T023000", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;COUNT=3"];
    const FIRST = "2027-03-21T01:30Z/2027-03-21T02:30Z";
    const GAP_DAY = "2027-03-28T01:30Z/2027-03-28T02:30Z";
    const THIRD = "2027-04-04T00:30Z/2027-04-04T01:30Z";
    const SAME_INSTANT: [string, string][] = [
      ["UTC", ":20270328T013000Z"],
      ["Istanbul time", ";TZID=Europe/Istanbul:20270328T043000"],
      ["New York time, the evening before", ";TZID=America/New_York:20270327T213000"],
      ["a Windows zone name", ";TZID=Turkey Standard Time:20270328T043000"],
      ["Berlin time, as the clock shows it", ";TZID=Europe/Berlin:20270328T033000"],
      ["Berlin time, as the series names it", ";TZID=Europe/Berlin:20270328T023000"],
    ];
    const override = (rid: string, ...props: string[]) => vevent("UID:night-shift@test", "SUMMARY:Moved", `RECURRENCE-ID${rid}`, ...props);

    it("puts the gap-day occurrence at 01:30Z", () => {
      const r = sameInEveryProcessZone(() => read(ics(vevent(...SERIES)), ...SPRING));
      expect(spans(r)).toEqual([FIRST, GAP_DAY, THIRD]);
    });

    it.each(SAME_INSTANT)("drops it for an EXDATE in %s", (_, value) => {
      const r = sameInEveryProcessZone(() => read(ics(vevent(...SERIES, `EXDATE${value}`)), ...SPRING));
      expect(spans(r)).toEqual([FIRST, THIRD]);
    });

    it.each(SAME_INSTANT)("puts it at its new time only for a RECURRENCE-ID in %s", (_, value) => {
      const moved = override(value, "DTSTART;TZID=Europe/Berlin:20270328T100000", "DURATION:PT1H");
      const r = sameInEveryProcessZone(() => read(ics(vevent(...SERIES), moved), ...SPRING));
      expect(spans(r)).toEqual([FIRST, "2027-03-28T08:00Z/2027-03-28T09:00Z", THIRD]);
      expect(r.busy.map((b) => b.title)).toEqual(["Night shift", "Moved", "Night shift"]);
    });

    it("drops it for an override in UTC that is cancelled, moved out of the window, or listed before its series", () => {
      const cancelled = override(":20270328T013000Z", "DTSTART:20270328T013000Z", "DURATION:PT1H", "STATUS:CANCELLED");
      expect(spans(read(ics(vevent(...SERIES), cancelled), ...SPRING)), "cancelled").toEqual([FIRST, THIRD]);
      const away = override(":20270328T013000Z", "DTSTART;TZID=Europe/Berlin:20270601T100000", "DURATION:PT1H");
      expect(spans(read(ics(vevent(...SERIES), away), ...SPRING)), "moved out of the window").toEqual([FIRST, THIRD]);
      const first = override(":20270328T013000Z", "DTSTART;TZID=Europe/Berlin:20270328T100000", "DURATION:PT1H");
      expect(spans(read(ics(first, vevent(...SERIES)), ...SPRING)), "listed first").toEqual([FIRST, "2027-03-28T08:00Z/2027-03-28T09:00Z", THIRD]);
    });

    it("keeps it for an EXDATE that names another time that night", () => {
      // 00:30Z is 01:30 in Berlin, an hour before; 02:30Z is 04:30, an hour after.
      for (const other of ["EXDATE:20270328T003000Z", "EXDATE:20270328T023000Z", "EXDATE;TZID=Europe/Berlin:20270328T013000", "EXDATE;TZID=Europe/Berlin:20270328T043000"]) {
        expect(spans(read(ics(vevent(...SERIES, other)), ...SPRING)), other).toEqual([FIRST, GAP_DAY, THIRD]);
      }
    });

    it("drops a monthly last Sunday's March occurrence for an EXDATE in UTC", () => {
      // The last Sunday of March is the day the clocks spring forward.
      const text = ics(vevent("UID:last-sunday@test", "DTSTART;TZID=Europe/Berlin:20270131T023000", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;BYDAY=-1SU;COUNT=4", "EXDATE:20270328T013000Z"));
      expect(starts(read(text, "2027-01-01T00:00:00Z", "2027-06-01T00:00:00Z", "Europe/Istanbul"))).toEqual(["2027-01-31T01:30Z", "2027-02-28T01:30Z", "2027-04-25T00:30Z"]);
    });

    it("matches by instant in New York, in a zone the file defines, and in the person's zone for a floating series", () => {
      // New York springs forward on 2027-03-14 at 02:00 (07:00Z): that day's 02:30 is 07:30Z.
      const ny = vevent("UID:ny@test", "DTSTART;TZID=America/New_York:20270307T023000", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;COUNT=3", "EXDATE:20270314T073000Z");
      expect(starts(read(ics(ny), ...SPRING)), "New York").toEqual(["2027-03-07T07:30Z", "2027-03-21T06:30Z"]);
      // Lab Time springs forward on 2027-04-04 at 02:00 (+02:00 to +03:00): that day's 02:30 is 00:30Z.
      const lab = ["UID:lab@test", "SUMMARY:Lab", "DTSTART;TZID=Lab Time:20270328T023000", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;COUNT=3"];
      expect(starts(read(ics(LAB_VTIMEZONE, vevent(...lab, "EXDATE:20270404T003000Z")), ...SPRING)), "Lab Time EXDATE").toEqual(["2027-03-28T00:30Z", "2027-04-10T23:30Z"]);
      const labMoved = vevent("UID:lab@test", "SUMMARY:Moved", "RECURRENCE-ID:20270404T003000Z", "DTSTART;TZID=Lab Time:20270404T100000", "DURATION:PT1H");
      expect(starts(read(ics(LAB_VTIMEZONE, vevent(...lab), labMoved), ...SPRING)), "Lab Time RECURRENCE-ID").toEqual(["2027-03-28T00:30Z", "2027-04-04T07:00Z", "2027-04-10T23:30Z"]);
      // No zone: read in the person's, Berlin here.
      const floating = ["UID:floating@test", "SUMMARY:Floating", "DTSTART:20270321T023000", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;COUNT=3"];
      const inBerlin = [SPRING[0], SPRING[1], "Europe/Berlin"] as const;
      expect(starts(read(ics(vevent(...floating, "EXDATE:20270328T013000Z")), ...inBerlin)), "floating EXDATE").toEqual(["2027-03-21T01:30Z", "2027-04-04T00:30Z"]);
      const floatingMoved = vevent("UID:floating@test", "SUMMARY:Moved", "RECURRENCE-ID:20270328T013000Z", "DTSTART:20270328T100000", "DURATION:PT1H");
      expect(starts(read(ics(vevent(...floating), floatingMoved), ...inBerlin)), "floating RECURRENCE-ID").toEqual(["2027-03-21T01:30Z", "2027-03-28T08:00Z", "2027-04-04T00:30Z"]);
    });
  });

  describe("one block per instant, each with its own id", () => {
    // A rule that gives 02:30 and 03:30 on the night Berlin springs forward gives
    // 01:30Z twice. Within one recurring event that is one occurrence, so one
    // block, and no two blocks of a result share an eventId.
    const NIGHT = ["2027-03-27T00:00:00Z", "2027-03-29T00:00:00Z", "Europe/Istanbul"] as const;
    const HOURLY = ["UID:hourly@test", "SUMMARY:Hourly", "DTSTART;TZID=Europe/Berlin:20270328T003000", "DURATION:PT30M", "RRULE:FREQ=HOURLY;UNTIL=20270328T030000Z"];
    const H1 = "2027-03-27T23:30Z/2027-03-28T00:00Z";
    const H2 = "2027-03-28T00:30Z/2027-03-28T01:00Z";
    const H3 = "2027-03-28T01:30Z/2027-03-28T02:00Z";
    const H4 = "2027-03-28T02:30Z/2027-03-28T03:00Z";
    // 01:30Z as an exception can name it (Intl: Istanbul is +03:00, New York -04:00 that night).
    const AT_0130Z = [
      ":20270328T013000Z",
      ";TZID=Europe/Berlin:20270328T023000",
      ";TZID=Europe/Berlin:20270328T033000",
      ";TZID=Europe/Istanbul:20270328T043000",
      ";TZID=America/New_York:20270327T213000",
      ";TZID=Turkey Standard Time:20270328T043000",
    ];

    it("gives an hourly rule through the gap four blocks, and lets an exception naming 01:30Z in any form take that one", () => {
      const r = sameInEveryProcessZone(() => read(ics(vevent(...HOURLY)), ...NIGHT));
      expect(spans(r)).toEqual([H1, H2, H3, H4]);
      expectDistinctIds(r);
      expect(r.skipped).toBe(0);
      for (const value of AT_0130Z) {
        expect(spans(read(ics(vevent(...HOURLY, `EXDATE${value}`)), ...NIGHT)), `EXDATE${value}`).toEqual([H1, H2, H4]);
        const moved = vevent("UID:hourly@test", "SUMMARY:Moved", `RECURRENCE-ID${value}`, "DTSTART;TZID=Europe/Berlin:20270328T100000", "DURATION:PT30M");
        const m = read(ics(vevent(...HOURLY), moved), ...NIGHT);
        expect(spans(m), `RECURRENCE-ID${value}`).toEqual([H1, H2, H4, "2027-03-28T08:00Z/2027-03-28T08:30Z"]);
        expect(m.busy.map((b) => b.title)).toEqual(["Hourly", "Hourly", "Hourly", "Moved"]);
        expectDistinctIds(m);
      }
    });

    it("gives a daily rule at 02:30 and 03:30 three blocks over the two nights, not four", () => {
      const text = ics(vevent("UID:by-hour@test", "SUMMARY:By hour", "DTSTART;TZID=Europe/Berlin:20270327T023000", "DURATION:PT30M", "RRULE:FREQ=DAILY;COUNT=4;BYHOUR=2,3;BYMINUTE=30"));
      const r = sameInEveryProcessZone(() => read(text, "2027-03-26T00:00:00Z", "2027-03-30T00:00:00Z", "Europe/Istanbul"));
      expect(spans(r)).toEqual(["2027-03-27T01:30Z/2027-03-27T02:00Z", "2027-03-27T02:30Z/2027-03-27T03:00Z", "2027-03-28T01:30Z/2027-03-28T02:00Z"]);
      expectDistinctIds(r);
      expect(r.skipped).toBe(0);
    });

    it("keeps one of two overrides that name one occurrence in different forms: the higher SEQUENCE, even cancelled", () => {
      const SPRING = ["2027-03-01T00:00:00Z", "2027-05-01T00:00:00Z", "Europe/Istanbul"] as const;
      const series = vevent("UID:night-shift@test", "SUMMARY:Night shift", "DTSTART;TZID=Europe/Berlin:20270321T023000", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;COUNT=3");
      const FIRST = "2027-03-21T01:30Z/2027-03-21T02:30Z";
      const THIRD = "2027-04-04T00:30Z/2027-04-04T01:30Z";
      const TEN = "2027-03-28T08:00Z/2027-03-28T09:00Z";
      const ELEVEN = "2027-03-28T09:00Z/2027-03-28T10:00Z";
      const moved = (rid: string, sequence: number, hh: string, ...more: string[]) =>
        vevent("UID:night-shift@test", `SUMMARY:At ${hh}`, `RECURRENCE-ID${rid}`, `SEQUENCE:${sequence}`, `DTSTART;TZID=Europe/Berlin:20270328T${hh}0000`, "DURATION:PT1H", ...more);
      const pairs = [
        [AT_0130Z[1], AT_0130Z[0]],
        [AT_0130Z[2], AT_0130Z[1]],
        [AT_0130Z[3], AT_0130Z[2]],
        [AT_0130Z[0], AT_0130Z[4]],
      ];
      for (const [a, b] of pairs) {
        const label = `${a} and ${b}`;
        // The later revision wins wherever it is in the file.
        for (const text of [ics(series, moved(a, 1, "10"), moved(b, 2, "11")), ics(moved(b, 2, "11"), series, moved(a, 1, "10"))]) {
          const r = read(text, ...SPRING);
          expect(spans(r), label).toEqual([FIRST, ELEVEN, THIRD]);
          expectDistinctIds(r);
        }
        const tie = spans(read(ics(series, moved(a, 0, "10"), moved(b, 0, "11")), ...SPRING));
        expect([[FIRST, TEN, THIRD], [FIRST, ELEVEN, THIRD]], `${label}, same SEQUENCE: ${tie.join(" ")}`).toContainEqual(tie);
        const cancelled = read(ics(series, moved(a, 1, "10"), moved(b, 2, "11", "STATUS:CANCELLED")), ...SPRING);
        expect(spans(cancelled), `${label}, the later one cancelled`).toEqual([FIRST, THIRD]);
      }
    });

    it("gives an all-day series one block a day, however many times a day its rule gives", () => {
      const NOVEMBER = ["2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", "Europe/Istanbul"] as const;
      // 30 hours from midnight on the 10th: 24 on the 10th and 6 on the 11th.
      const hourly = ["UID:away@test", "SUMMARY:Away", "DTSTART;VALUE=DATE:20261110", "RRULE:FREQ=HOURLY;COUNT=30"];
      const r = sameInEveryProcessZone(() => read(ics(vevent(...hourly)), ...NOVEMBER));
      expect(spans(r)).toEqual(["2026-11-09T21:00Z/2026-11-10T21:00Z", "2026-11-10T21:00Z/2026-11-11T21:00Z"]);
      expect(r.busy.every((b) => b.allDay === true)).toBe(true);
      expectDistinctIds(r);
      // An exception names the day.
      expect(spans(read(ics(vevent(...hourly, "EXDATE;VALUE=DATE:20261110")), ...NOVEMBER)), "EXDATE").toEqual(["2026-11-10T21:00Z/2026-11-11T21:00Z"]);
      const moved = vevent("UID:away@test", "SUMMARY:Away (moved)", "RECURRENCE-ID;VALUE=DATE:20261111", "DTSTART;VALUE=DATE:20261113");
      const m = read(ics(vevent(...hourly), moved), ...NOVEMBER);
      expect(spans(m), "RECURRENCE-ID").toEqual(["2026-11-09T21:00Z/2026-11-10T21:00Z", "2026-11-12T21:00Z/2026-11-13T21:00Z"]);
      expectDistinctIds(m);
      // BYHOUR on a date: whole days, none of them twice.
      const byHour = read(ics(vevent("UID:twice-a-day@test", "DTSTART;VALUE=DATE:20261110", "RRULE:FREQ=DAILY;COUNT=4;BYHOUR=9,17")), ...NOVEMBER);
      expect(byHour.busy.length).toBeGreaterThan(0);
      expect(byHour.busy.every((b) => b.allDay === true && b.end - b.start === 24 * 60 * MIN)).toBe(true);
      expect(new Set(starts(byHour)).size).toBe(byHour.busy.length);
      expectDistinctIds(byHour);
    });

    it("gives one block per instant when a long window is expanded in pieces", () => {
      // A rule for every minute over five weeks: more occurrences than node-ical
      // expands in one call, so the window is read piece by piece. The instants
      // run on minute by minute through the night Berlin springs forward.
      const text = ics(vevent("UID:minutes@test", "DTSTART;TZID=Europe/Berlin:20270301T000000", "DURATION:PT1M", "RRULE:FREQ=MINUTELY"));
      const from = Date.parse("2027-03-10T03:01:00Z");
      const to = Date.parse("2027-04-15T00:00:00Z");
      const r = icsBusy(text, { from, to, timezone: "Europe/Istanbul", limit: 100_000 });
      const wrong = r.busy.filter((b, i) => b.start !== from + i * MIN || b.end !== b.start + MIN).slice(0, 3);
      expect(wrong.map((b) => `${iso(b.start)}/${iso(b.end)}`)).toEqual([]);
      expect(r.busy).toHaveLength((to - from) / MIN);
      expect(r.skipped).toBe(0);
      expectDistinctIds(r);
    });

    it("never gives two blocks one id, whatever the UIDs and overrides", () => {
      const NOVEMBER = ["2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", "Europe/Istanbul"] as const;
      const events = [
        vevent("UID:daily@test", "SUMMARY:Daily", "DTSTART:20261110T100000Z", "DTEND:20261110T110000Z", "RRULE:FREQ=DAILY;COUNT=3"),
        // Moved onto the next day's occurrence.
        vevent("UID:daily@test", "SUMMARY:Moved onto the 11th", "RECURRENCE-ID:20261110T100000Z", "DTSTART:20261111T100000Z", "DTEND:20261111T120000Z"),
        // Two overrides of a series that isn't in the file, naming 10:00 in two zones.
        vevent("UID:gone@test", "SUMMARY:Gone, Berlin", "RECURRENCE-ID;TZID=Europe/Berlin:20261112T100000", "DTSTART:20261112T140000Z", "DTEND:20261112T150000Z"),
        vevent("UID:gone@test", "SUMMARY:Gone, Istanbul", "RECURRENCE-ID;TZID=Europe/Istanbul:20261112T100000", "DTSTART:20261112T160000Z", "DTEND:20261112T170000Z"),
        vevent(`UID:${"long-uid-".repeat(30)}@test`, "SUMMARY:Long UID", "DTSTART:20261113T090000Z", "DTEND:20261113T100000Z"),
        vevent("SUMMARY:No UID", "DTSTART:20261113T110000Z", "DTEND:20261113T120000Z"),
        vevent("SUMMARY:No UID", "DTSTART:20261113T110000Z", "DTEND:20261113T120000Z"),
        vevent(...HOURLY.map((p) => p.replace("20270328T003000", "20261114T003000").replace("20270328T030000Z", "20261114T030000Z"))),
      ];
      const first = read(ics(...events), ...NOVEMBER);
      const titles = new Set(first.busy.map((b) => b.title));
      for (const title of ["Daily", "Moved onto the 11th", "Gone, Berlin", "Gone, Istanbul", "Long UID", "No UID", "Hourly"]) expect(titles, title).toContain(title);
      expect(starts(first), "the 10th's occurrence moved away").not.toContain("2026-11-10T10:00Z");
      expect(starts(first), "the 11th stays busy").toContain("2026-11-11T10:00Z");
      expectDistinctIds(first);
      // Each block's id is now also the UID of another event.
      const later = Date.parse("2026-11-20T00:00:00Z");
      const twins = first.busy.map((b, i) => vevent(`UID:${b.eventId}`, "SUMMARY:Same UID as an id", `DTSTART:${stamp(later + i * 60 * MIN)}`, `DTEND:${stamp(later + i * 60 * MIN + 30 * MIN)}`));
      const second = read(ics(...events, ...twins), ...NOVEMBER);
      expect(second.busy).toHaveLength(2 * first.busy.length);
      expect(spans(second).slice(0, first.busy.length)).toEqual(spans(first));
      expectDistinctIds(second);
    });
  });
});

describe("what blocks and what doesn't (criterion 3)", () => {
  const text = ics(
    vevent("UID:s1@test", "SUMMARY:Cancelled", "DTSTART:20261110T080000Z", "DTEND:20261110T090000Z", "STATUS:CANCELLED"),
    vevent("UID:s2@test", "SUMMARY:Transparent", "DTSTART:20261110T090000Z", "DTEND:20261110T100000Z", "TRANSP:TRANSPARENT"),
    vevent("UID:s3@test", "SUMMARY:Outlook free", "DTSTART:20261110T100000Z", "DTEND:20261110T110000Z", "TRANSP:OPAQUE", "X-MICROSOFT-CDO-BUSYSTATUS:FREE"),
    vevent("UID:s4@test", "SUMMARY:Tentative", "DTSTART:20261110T110000Z", "DTEND:20261110T120000Z", "STATUS:TENTATIVE"),
    vevent("UID:s5@test", "SUMMARY:Outlook tentative", "DTSTART:20261110T120000Z", "DTEND:20261110T130000Z", "STATUS:CONFIRMED", "X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE"),
    vevent("UID:s6@test", "SUMMARY:Confirmed", "DTSTART:20261110T130000Z", "DTEND:20261110T140000Z", "STATUS:CONFIRMED", "TRANSP:OPAQUE"),
    vevent("UID:s7@test", "SUMMARY:Out of office", "DTSTART:20261110T140000Z", "DTEND:20261110T150000Z", "X-MICROSOFT-CDO-BUSYSTATUS:OOF"),
    vevent("UID:s8@test", "SUMMARY:Outlook busy", "DTSTART:20261110T150000Z", "DTEND:20261110T160000Z", "X-MICROSOFT-CDO-BUSYSTATUS:BUSY"),
    vevent("UID:s9@test", "SUMMARY:Cancelled series", "DTSTART:20261110T160000Z", "DTEND:20261110T170000Z", "RRULE:FREQ=DAILY;COUNT=3", "STATUS:CANCELLED"),
    vevent("UID:s10@test", "SUMMARY:Free series", "DTSTART:20261110T170000Z", "DTEND:20261110T180000Z", "RRULE:FREQ=DAILY;COUNT=3", "TRANSP:TRANSPARENT"),
    vevent("UID:s11@test", "SUMMARY:Tentative series", "DTSTART:20261110T180000Z", "DTEND:20261110T190000Z", "RRULE:FREQ=DAILY;COUNT=2", "STATUS:TENTATIVE"),
  );
  const statuses = () => read(text, "2026-11-10T00:00:00Z", "2026-11-20T00:00:00Z");

  it("gives no block for cancelled, transparent or Outlook-free events", () => {
    const titles = statuses().busy.map((b) => b.title);
    for (const gone of ["Cancelled", "Transparent", "Outlook free", "Cancelled series", "Free series"]) expect(titles).not.toContain(gone);
    expect(titles).toEqual(["Tentative", "Outlook tentative", "Confirmed", "Out of office", "Outlook busy", "Tentative series", "Tentative series"]);
  });

  it("marks STATUS:TENTATIVE and Outlook's TENTATIVE as tentative, and nothing else", () => {
    expect(statuses().busy.map((b) => [b.title, b.tentative === true])).toEqual([
      ["Tentative", true],
      ["Outlook tentative", true],
      ["Confirmed", false],
      ["Out of office", false],
      ["Outlook busy", false],
      ["Tentative series", true],
      ["Tentative series", true],
    ]);
  });
});

describe("times and zones (criterion 4)", () => {
  // The New York and Lab blocks are in the file, so node-ical alone would lend one of them to the floating time.
  const TIMES = ics(
    NEW_YORK_VTIMEZONE,
    LAB_VTIMEZONE,
    vevent("UID:t-utc@test", "SUMMARY:utc", "DTSTART:20261110T090000Z", "DTEND:20261110T100000Z"),
    vevent("UID:t-iana@test", "SUMMARY:iana", "DTSTART;TZID=America/New_York:20261110T090000", "DTEND;TZID=America/New_York:20261110T100000"),
    vevent("UID:t-lab-apr@test", "SUMMARY:lab-apr", "DTSTART;TZID=Lab Time:20260403T100000", "DTEND;TZID=Lab Time:20260403T110000"),
    vevent("UID:t-lab-jul@test", "SUMMARY:lab-jul", "DTSTART;TZID=Lab Time:20260715T100000", "DTEND;TZID=Lab Time:20260715T110000"),
    vevent("UID:t-lab-oct@test", "SUMMARY:lab-oct", "DTSTART;TZID=Lab Time:20261010T100000", "DTEND;TZID=Lab Time:20261010T110000"),
    vevent("UID:t-win-berlin@test", "SUMMARY:win-berlin", "DTSTART;TZID=W. Europe Standard Time:20261110T090000", "DTEND;TZID=W. Europe Standard Time:20261110T100000"),
    vevent("UID:t-win-berlin-summer@test", "SUMMARY:win-berlin-summer", 'DTSTART;TZID="W. Europe Standard Time":20260710T090000', 'DTEND;TZID="W. Europe Standard Time":20260710T100000'),
    vevent("UID:t-win-turkey@test", "SUMMARY:win-turkey", "DTSTART;TZID=Turkey Standard Time:20261110T090000", "DTEND;TZID=Turkey Standard Time:20261110T100000"),
    vevent("UID:t-win-eastern@test", "SUMMARY:win-eastern", "DTSTART;TZID=Eastern Standard Time:20261110T090000", "DTEND;TZID=Eastern Standard Time:20261110T100000"),
    vevent("UID:t-floating@test", "SUMMARY:floating", "DTSTART:20261110T090000", "DTEND:20261110T100000"),
    vevent("UID:t-unknown@test", "SUMMARY:unknown", "DTSTART;TZID=Mars/Olympus_Mons:20261110T090000", "DTEND;TZID=Mars/Olympus_Mons:20261110T100000"),
  );
  const fixed = {
    utc: "2026-11-10T09:00Z",
    iana: "2026-11-10T14:00Z",
    "lab-apr": "2026-04-03T08:00Z",
    "lab-jul": "2026-07-15T07:00Z",
    "lab-oct": "2026-10-10T08:00Z",
    "win-berlin": "2026-11-10T08:00Z",
    "win-berlin-summer": "2026-07-10T07:00Z",
    "win-turkey": "2026-11-10T06:00Z",
    "win-eastern": "2026-11-10T14:00Z",
  };

  it("reads UTC, IANA, file-defined and Windows zones in their zone; floating and unknown in the person's", () => {
    const r = sameInEveryProcessZone(() => read(TIMES, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z", "Europe/Istanbul"));
    expect(startsByTitle(r)).toEqual({ ...fixed, floating: "2026-11-10T06:00Z", unknown: "2026-11-10T06:00Z" });
    expect(r.busy.every((b) => b.end - b.start === 60 * MIN)).toBe(true);
    expect(r.skipped).toBe(0);
  });

  it("moves only the floating and unknown-zone times with the person's zone", () => {
    const r = sameInEveryProcessZone(() => read(TIMES, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z", "America/Los_Angeles"));
    expect(startsByTitle(r)).toEqual({ ...fixed, floating: "2026-11-10T17:00Z", unknown: "2026-11-10T17:00Z" });
  });
});

describe("summer time in recurring events (criterion 5)", () => {
  const CRITERION_5 = ["2026-10-20T16:00Z/2026-10-20T17:00Z", "2026-10-27T17:00Z/2026-10-27T18:00Z", "2026-11-03T17:00Z/2026-11-03T18:00Z"];
  const weekly = (tzid: string, zone: string[] = []) =>
    ics(zone, vevent("UID:weekly@test", "SUMMARY:Weekly", `DTSTART;TZID=${tzid}:20261020T180000`, `DTEND;TZID=${tzid}:20261020T190000`, "RRULE:FREQ=WEEKLY;COUNT=3"));
  const cases: [string, string][] = [
    ["IANA name", weekly("Europe/Berlin")],
    ["IANA name with Google's VTIMEZONE", weekly("Europe/Berlin", BERLIN_VTIMEZONE)],
    ["custom VTIMEZONE", weekly("Customized Time Zone", outlookEuZone("Customized Time Zone"))],
    ["Windows name", weekly("W. Europe Standard Time")],
    ["Windows name with Outlook's VTIMEZONE", weekly("W. Europe Standard Time", outlookEuZone("W. Europe Standard Time"))],
  ];

  it.each(cases)("gives 16:00Z, 17:00Z, 17:00Z through the %s", (_, text) => {
    const r = sameInEveryProcessZone(() => read(text, "2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z", "Europe/Istanbul"));
    expect(spans(r)).toEqual(CRITERION_5);
  });

  it.each([["America/New_York"], ["Eastern Standard Time"]])("follows the spring change too (%s)", (tzid) => {
    const text = ics(vevent("UID:friday@test", `DTSTART;TZID=${tzid}:20270305T180000`, `DTEND;TZID=${tzid}:20270305T190000`, "RRULE:FREQ=WEEKLY;COUNT=3"));
    const r = sameInEveryProcessZone(() => read(text, "2027-03-01T00:00:00Z", "2027-04-01T00:00:00Z", "Europe/Istanbul"));
    expect(spans(r)).toEqual(["2027-03-05T23:00Z/2027-03-06T00:00Z", "2027-03-12T23:00Z/2027-03-13T00:00Z", "2027-03-19T22:00Z/2027-03-19T23:00Z"]);
  });
});

describe("all-day events (criterion 6)", () => {
  it("runs from midnight to midnight in the person's zone, DTEND exclusive", () => {
    const text = ics(vevent("UID:ad@test", "SUMMARY:Off", "DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261107"));
    const r = sameInEveryProcessZone(() => read(text, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", "Europe/Istanbul"));
    expect(spans(r)).toEqual(["2026-11-04T21:00Z/2026-11-06T21:00Z"]);
    expect(r.busy[0].allDay).toBe(true);
  });

  it("lasts one day without DTEND", () => {
    const text = ics(vevent("UID:ad1@test", "DTSTART;VALUE=DATE:20261105"));
    const r = sameInEveryProcessZone(() => read(text, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", "Europe/Istanbul"));
    expect(spans(r)).toEqual(["2026-11-04T21:00Z/2026-11-05T21:00Z"]);
    expect(r.busy[0].allDay).toBe(true);
  });

  it("takes the person's midnights across a clock change", () => {
    const autumn = ics(vevent("UID:ad2@test", "DTSTART;VALUE=DATE:20261024", "DTEND;VALUE=DATE:20261026"));
    expect(spans(sameInEveryProcessZone(() => read(autumn, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z", "Europe/Berlin")))).toEqual(["2026-10-23T22:00Z/2026-10-25T23:00Z"]);
    const spring = ics(vevent("UID:ad3@test", "DTSTART;VALUE=DATE:20270313", "DTEND;VALUE=DATE:20270315"));
    expect(spans(sameInEveryProcessZone(() => read(spring, "2027-03-01T00:00:00Z", "2027-04-01T00:00:00Z", "America/New_York")))).toEqual(["2027-03-13T05:00Z/2027-03-15T04:00Z"]);
  });

  it("repeats whole days, with an all-day EXDATE", () => {
    const text = ics(
      vevent("UID:ad4@test", "SUMMARY:Gym", "DTSTART;VALUE=DATE:20261102", "DTEND;VALUE=DATE:20261103", "RRULE:FREQ=WEEKLY;COUNT=3", "EXDATE;VALUE=DATE:20261109"),
    );
    const r = sameInEveryProcessZone(() => read(text, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", "Europe/Istanbul"));
    expect(spans(r)).toEqual(["2026-11-01T21:00Z/2026-11-02T21:00Z", "2026-11-15T21:00Z/2026-11-16T21:00Z"]);
    expect(r.busy.every((b) => b.allDay === true)).toBe(true);
  });

  it("lasts one day when DTEND is its start date, as without DTEND", () => {
    const text = ics(vevent("UID:same-day@test", "SUMMARY:Off", "DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261105"));
    const r = sameInEveryProcessZone(() => read(text, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", "Europe/Istanbul"));
    expect(spans(r)).toEqual(["2026-11-04T21:00Z/2026-11-05T21:00Z"]);
    expect(r.busy[0].allDay).toBe(true);
    // Days the clocks change on, in the person's zone (midnights from Intl).
    const changes: [string, string, string][] = [
      ["20261025", "Europe/Berlin", "2026-10-24T22:00Z/2026-10-25T23:00Z"],
      ["20270314", "America/New_York", "2027-03-14T05:00Z/2027-03-15T04:00Z"],
      ["20261004", "Australia/Lord_Howe", "2026-10-03T13:30Z/2026-10-04T13:00Z"],
      ["20260927", "Pacific/Chatham", "2026-09-26T11:15Z/2026-09-27T10:15Z"],
    ];
    for (const [date, zone, span] of changes) {
      const window = ["2026-09-01T00:00:00Z", "2027-04-01T00:00:00Z", zone] as const;
      const same = read(ics(vevent("UID:same-day@test", `DTSTART;VALUE=DATE:${date}`, `DTEND;VALUE=DATE:${date}`)), ...window);
      const none = read(ics(vevent("UID:same-day@test", `DTSTART;VALUE=DATE:${date}`)), ...window);
      expect(spans(same), `${date} in ${zone}`).toEqual([span]);
      expect(same).toEqual(none);
    }
  });

  it("gives each occurrence of a series that ends on its start date one day, an override too", () => {
    const NOVEMBER = ["2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", "Europe/Istanbul"] as const;
    const weekly = ics(vevent("UID:zero-week@test", "SUMMARY:Gym", "DTSTART;VALUE=DATE:20261102", "DTEND;VALUE=DATE:20261102", "RRULE:FREQ=WEEKLY;COUNT=3"));
    const r = sameInEveryProcessZone(() => read(weekly, ...NOVEMBER));
    expect(spans(r)).toEqual(["2026-11-01T21:00Z/2026-11-02T21:00Z", "2026-11-08T21:00Z/2026-11-09T21:00Z", "2026-11-15T21:00Z/2026-11-16T21:00Z"]);
    expect(r.busy.every((b) => b.allDay === true)).toBe(true);
    // Through the night Berlin goes back an hour: that Sunday is 25 hours long.
    const autumn = ics(vevent("UID:zero-autumn@test", "DTSTART;VALUE=DATE:20261018", "DTEND;VALUE=DATE:20261018", "RRULE:FREQ=WEEKLY;COUNT=3"));
    expect(spans(read(autumn, "2026-10-01T00:00:00Z", "2026-11-15T00:00:00Z", "Europe/Berlin"))).toEqual([
      "2026-10-17T22:00Z/2026-10-18T22:00Z",
      "2026-10-24T22:00Z/2026-10-25T23:00Z",
      "2026-10-31T23:00Z/2026-11-01T23:00Z",
    ]);
    // An override of an ordinary all-day series, written that way.
    const moved = ics(
      vevent("UID:gym@test", "SUMMARY:Gym", "DTSTART;VALUE=DATE:20261102", "DTEND;VALUE=DATE:20261103", "RRULE:FREQ=WEEKLY;COUNT=3"),
      vevent("UID:gym@test", "SUMMARY:Gym (moved)", "RECURRENCE-ID;VALUE=DATE:20261109", "DTSTART;VALUE=DATE:20261111", "DTEND;VALUE=DATE:20261111"),
    );
    const m = read(moved, ...NOVEMBER);
    expect(spans(m)).toEqual(["2026-11-01T21:00Z/2026-11-02T21:00Z", "2026-11-10T21:00Z/2026-11-11T21:00Z", "2026-11-15T21:00Z/2026-11-16T21:00Z"]);
    expect(m.busy.map((b) => [b.title, b.allDay])).toEqual([
      ["Gym", true],
      ["Gym (moved)", true],
      ["Gym", true],
    ]);
  });
});

describe("titles, privacy, details and ids (criterion 7)", () => {
  it("maps SUMMARY, CLASS, LOCATION and DESCRIPTION", () => {
    const text = ics(
      vevent("UID:c1@test", "SUMMARY:Private one", "CLASS:PRIVATE", "DTSTART:20261110T080000Z", "DTEND:20261110T090000Z"),
      vevent("UID:c2@test", "SUMMARY:Confidential one", "CLASS:CONFIDENTIAL", "DTSTART:20261110T090000Z", "DTEND:20261110T100000Z"),
      vevent("UID:c3@test", "SUMMARY:Public one", "CLASS:PUBLIC", "DTSTART:20261110T100000Z", "DTEND:20261110T110000Z"),
      vevent("UID:c4@test", "SUMMARY:No class", "LOCATION:Floor 2", "DESCRIPTION:Line one\\nLine two", "DTSTART:20261110T110000Z", "DTEND:20261110T120000Z"),
    );
    const r = read(text, "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z");
    expect(r.busy.map((b) => [b.title, b.private === true])).toEqual([
      ["Private one", true],
      ["Confidential one", true],
      ["Public one", false],
      ["No class", false],
    ]);
    expect(r.busy[3].details).toEqual({ location: "Floor 2", description: "Line one\nLine two" });
  });

  it("cuts location and description at google.ts's caps, and the title at its title cap", () => {
    const text = ics(
      vevent("UID:long@test", `SUMMARY:${"t".repeat(300)}`, `LOCATION:${"l".repeat(600)}`, `DESCRIPTION:${"d".repeat(9000)}`, "DTSTART:20261110T080000Z", "DTEND:20261110T090000Z"),
    );
    const [b] = read(text, "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z").busy;
    expect(b.details?.location).toBe("l".repeat(500));
    expect(b.details?.description).toBe("d".repeat(8000));
    expect(b.title).toBe("t".repeat(200));
  });

  it("gives every occurrence its own id, the same on every read", () => {
    const first = read(GOOGLE_EXPORT, "2026-10-19T00:00:00Z", "2026-11-16T00:00:00Z", "Europe/Istanbul");
    const again = read(GOOGLE_EXPORT, "2026-10-19T00:00:00Z", "2026-11-16T00:00:00Z", "Europe/Istanbul");
    expect(again).toEqual(first);
    const ids = first.busy.map((b) => b.eventId);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    const outlookIds = read(OUTLOOK_EXPORT, "2026-10-19T00:00:00Z", "2026-12-15T00:00:00Z", "Europe/Istanbul").busy.map((b) => b.eventId);
    expect(new Set(outlookIds).size).toBe(outlookIds.length);
  });

  it("keeps an occurrence's id when the window moves", () => {
    const key = (b: Busy) => `${b.start} ${b.title}`;
    const a = read(GOOGLE_EXPORT, "2026-10-19T00:00:00Z", "2026-11-16T00:00:00Z", "Europe/Istanbul").busy;
    const b = read(GOOGLE_EXPORT, "2026-11-09T00:00:00Z", "2026-11-30T00:00:00Z", "Europe/Istanbul").busy;
    const shared = b.filter((x) => a.some((y) => key(y) === key(x)));
    expect(shared.length).toBe(6);
    for (const x of shared) expect(x.eventId).toBe(a.find((y) => key(y) === key(x))?.eventId);
    // A series read through two windows that start days apart.
    const daily = ics(vevent("UID:daily-ids@test", "DTSTART:20261101T090000Z", "DTEND:20261101T093000Z", "RRULE:FREQ=DAILY"));
    const early = read(daily, "2026-11-01T00:00:00Z", "2026-11-20T00:00:00Z").busy;
    const late = read(daily, "2026-11-10T00:00:00Z", "2026-11-30T00:00:00Z").busy;
    const overlap = late.filter((x) => x.start < Date.parse("2026-11-20T00:00:00Z"));
    expect(overlap).toHaveLength(10);
    for (const x of overlap) expect(x.eventId).toBe(early.find((y) => y.start === x.start)?.eventId);
  });

  it("gives stable, distinct ids to events without a UID", () => {
    const text = ics(
      vevent("SUMMARY:No uid one", "DTSTART:20261110T080000Z", "DTEND:20261110T090000Z"),
      vevent("SUMMARY:No uid two", "DTSTART:20261110T100000Z", "DTEND:20261110T110000Z"),
      vevent("SUMMARY:No uid series", "DTSTART:20261110T120000Z", "DTEND:20261110T130000Z", "RRULE:FREQ=DAILY;COUNT=2"),
    );
    const first = read(text, "2026-11-10T00:00:00Z", "2026-11-12T00:00:00Z").busy.map((b) => b.eventId);
    const again = read(text, "2026-11-10T00:00:00Z", "2026-11-12T00:00:00Z").busy.map((b) => b.eventId);
    expect(first).toHaveLength(4);
    expect(again).toEqual(first);
    expect(new Set(first).size).toBe(4);
  });
});

describe("descriptions in HTML", () => {
  // Google's iCal feeds write descriptions as HTML. One with a tag from this list,
  // opening or closing, in any case, is read through google.ts's htmlToText and
  // then cut at its cap; any other description is kept as written.
  const TAGS = ["a", "b", "br", "div", "em", "i", "li", "ol", "p", "span", "strong", "u", "ul"];
  const asText = (html: string) => htmlToText(html).slice(0, 8000);
  /** A TEXT value as a file writes it (RFC 5545 3.3.11). */
  const escaped = (text: string) => text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const DAY_START = Date.parse("2026-11-10T00:00:00Z");
  /** details.description of an event with each description, in order. */
  function descriptions(...texts: string[]): (string | undefined)[] {
    const text = ics(
      ...texts.map((d, i) => vevent(`UID:html-${i}@test`, `SUMMARY:${i}`, `DTSTART:${stamp(DAY_START + i * MIN)}`, `DTEND:${stamp(DAY_START + (i + 1) * MIN)}`, `DESCRIPTION:${escaped(d)}`)),
    );
    const r = read(text, "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z");
    expect(r.busy.map((b) => b.title)).toEqual(texts.map((_, i) => String(i)));
    expect(r.skipped).toBe(0);
    return r.busy.map((b) => b.details?.description);
  }

  it("reads the HTML of a Google feed as text and leaves a description without a listed tag alone", () => {
    const text = ics(
      vevent(
        "UID:agenda@test",
        "SUMMARY:<b>Planning</b>",
        "LOCATION:<br>Room 4",
        "DTSTART:20261110T090000Z",
        "DTEND:20261110T100000Z",
        'DESCRIPTION:Agenda<br>1. Budget<br><a href="https://example.com/doc">Doc</a>',
      ),
      vevent("UID:apples@test", "DTSTART:20261110T100000Z", "DTEND:20261110T110000Z", "DESCRIPTION:Bring 2 < 3 apples & <ctrl> keys"),
    );
    const r = read(text, "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z");
    expect(r.busy.map((b) => b.details?.description)).toEqual(["Agenda\n1. Budget\nDoc (https://example.com/doc)", "Bring 2 < 3 apples & <ctrl> keys"]);
    // Only the description is read as HTML.
    expect(r.busy[0].title).toBe("<b>Planning</b>");
    expect(r.busy[0].details?.location).toBe("<br>Room 4");
  });

  it("reads a description with a listed tag, opening or closing, in any case, through htmlToText, and keeps any other as written", () => {
    const mixed = (t: string) => [...t].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join("");
    const LONG = "Read this before the planning call on Tuesday, and bring the numbers. ";
    const html = TAGS.flatMap((t) => [
      `Notes <${t}>here`,
      `Notes </${t}> here`,
      `Notes <${t.toUpperCase()}>here</${t.toUpperCase()}>`,
      `Notes <${mixed(t)} class="note">here</${mixed(t)}>`,
      `Notes<${t}/>here`,
      `${LONG.repeat(3)}<${t}>Item</${t}>`,
    ]);
    // htmlToText changes each of them, so reading them through it shows.
    for (const h of html) expect(htmlToText(h), h).not.toBe(h);
    const plain = [
      "Bring 2 < 3 apples & <ctrl> keys",
      "Ask Ayşe <a.yilmaz@example.com> or the ops team <b_ops@example.com>",
      "Slides at <https://example.com/deck> and <i-team@example.com>",
      '<bold>x</bold> <abbr>y</abbr> <h1>z</h1> <table><tr><td>1</td></tr></table> <img src="x.png">',
      "<pre>code</pre> <script>alert(1)</script> <style>p { color: red }</style> <q>q</q> <s>s</s>",
      "x<br2>y <p1> <ulx> <divx> <spanner> <emx> <lix> <olx> <strongx> <ux> <ix> <ab>",
      "&lt;b&gt;bold&lt;/b&gt; &amp; &nbsp; as written",
      "a <b and nothing closes it",
      "< b>spaced</ b> <!-- b -->",
      "Line one\nLine two; three, four \\ five",
    ];
    // A hex character reference is read like the rest of the markup.
    const hex = "&#x41;<br>B";
    expect(descriptions(...html, ...plain, hex)).toEqual([...html.map(asText), ...plain, "A\nB"]);
  });

  it("cuts the text at the cap after reading the HTML", () => {
    // 13,500 characters of markup and 3,000 of text; then 8,100 characters of text.
    const markup = "<b>ab</b>".repeat(1500);
    const long = `<div class="note">${"x".repeat(8100)}</div>`;
    expect(descriptions(markup, long)).toEqual(["ab".repeat(1500), "x".repeat(8000)]);
  });

  it("reads the text unescaped and unfolded, as Google's feeds write it", () => {
    const text = ics(
      vevent(
        "UID:folded@test",
        "DTSTART:20261110T090000Z",
        "DTEND:20261110T100000Z",
        "DESCRIPTION:Hi all\\, the plan:<br><ul><li>Budget\\; Q4</li><li>Hiring</li></u",
        ' l>\\n\\n\\n\\n<p>See <a href="https://example.com/a?x=1\\,2">the doc</a></p>',
      ),
    );
    const [b] = read(text, "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z").busy;
    expect(b.details?.description).toBe(asText('Hi all, the plan:<br><ul><li>Budget; Q4</li><li>Hiring</li></ul>\n\n\n\n<p>See <a href="https://example.com/a?x=1,2">the doc</a></p>'));
  });

  it("reads the description an override takes from its series as text too", () => {
    const DESCRIPTION = "<p>Agenda</p><ul><li>Scope</li><li>Risks</li></ul>";
    const text = ics(
      vevent("UID:review@test", "SUMMARY:Review", "DTSTART:20261110T090000Z", "DTEND:20261110T100000Z", "RRULE:FREQ=DAILY;COUNT=2", `DESCRIPTION:${DESCRIPTION}`),
      vevent("UID:review@test", "SUMMARY:Review (moved)", "RECURRENCE-ID:20261111T090000Z", "DTSTART:20261111T140000Z", "DTEND:20261111T150000Z"),
    );
    const r = read(text, "2026-11-10T00:00:00Z", "2026-11-12T00:00:00Z");
    expect(asText(DESCRIPTION)).not.toContain("<");
    expect(r.busy.map((b) => [b.title, b.details?.description])).toEqual([
      ["Review", asText(DESCRIPTION)],
      ["Review (moved)", asText(DESCRIPTION)],
    ]);
  });

  it("reads a long description with a listed tag through htmlToText too, whatever else its markup holds", () => {
    const NOTE = " Notes for the whole team: read them before the call, and bring questions.";
    const long = [
      // A '<' that nothing closes.
      `Agenda<br>Budget: 2 < 3<br>Hiring${NOTE}`,
      // A script after the text.
      `<p>Hello team${NOTE}</p><script>track()</script>`,
      // A link without its </a>.
      `<p>See <a href="https://example.com/doc">the doc${NOTE}</p>`,
      // Long runs of spaces and of non-breaking spaces, in well-formed HTML.
      `<b>Agenda</b>${" ".repeat(300)}end${NOTE}`,
      `<p>Agenda</p>${"&nbsp;".repeat(300)}<p>end${NOTE}</p>`,
    ];
    for (const h of long) expect(htmlToText(h), h).not.toBe(h);
    expect(descriptions(...long)).toEqual(long.map(asText));
  });

  it("reads a description with a listed tag through htmlToText whatever its character references and link attributes, short or long", () => {
    const NOTE = " Notes for the whole team: read them before the call, and bring questions.";
    // An apostrophe as Python's html.escape writes it, a '<' that nothing closes in
    // 100 characters, and a link with a data-href besides its href.
    const apostrophe = "<p>Don&#x27;t forget</p>";
    const budget = "<p>Budget is < 5000 this quarter, please plan the offsite accordingly and send numbers</p><p>Thanks</p>";
    const link = '<p>See <a href="https://example.com/a" data-href="https://example.com/a">the agenda document for this week</a> before the call</p>';
    expect(asText(budget)).not.toBe(budget);
    expect(descriptions(apostrophe, budget, link)).toEqual(["Don't forget", asText(budget), "See the agenda document for this week (https://example.com/a) before the call"]);
    // References in hex, in either case, and references that name no character, short and long.
    const references = [
      "<b>&#X41;&#x42;&#x63;</b>",
      `<p>Don&#x27;t forget${NOTE}</p>`,
      "<i>&#99999999; &#x110000; &#Infinity; &#1_0; &#x41zz; &#xFFFFFFFFFFFFFFFFFFFF;</i>",
      `<p>&#99999999; &#x110000; &#Infinity; &#1_0;${NOTE}</p>`,
    ];
    for (const h of references) expect(asText(h), h).not.toBe(h);
    const got = descriptions(...references);
    expect(got).toEqual(references.map(asText));
    expect(got.slice(0, 2)).toEqual(["ABc", `Don't forget${NOTE}`]);
  });
});

describe("events that can't be read (criterion 8)", () => {
  it("leaves out and counts unreadable events, and keeps the rest", () => {
    const text = ics(
      // First in the file: node-ical alone throws for the whole file on this one.
      vevent("UID:bad-rrule@test", "SUMMARY:bad", "DTSTART:not-a-time", "DTEND:20261110T100000Z", "RRULE:FREQ=DAILY;COUNT=3"),
      vevent("UID:good-1@test", "SUMMARY:good 1", "DTSTART:20261110T090000Z", "DTEND:20261110T100000Z"),
      vevent("UID:bad-garbage@test", "SUMMARY:bad", "DTSTART:garbage", "DTEND:20261110T100000Z"),
      vevent("UID:bad-no-start@test", "SUMMARY:bad", "DTEND:20261110T100000Z"),
      vevent("UID:bad-format@test", "SUMMARY:bad", "DTSTART;TZID=Europe/Berlin:2026-11-10 10:00", "DTEND;TZID=Europe/Berlin:20261110T110000"),
      vevent("UID:good-2@test", "SUMMARY:good 2", "DTSTART:20261110T110000Z", "DTEND:20261110T120000Z"),
    );
    const r = read(text, "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z");
    expect(r.busy.map((b) => b.title)).toEqual(["good 1", "good 2"]);
    expect(r.skipped).toBe(4);
  });

  it("gives no block for zero-length or inverted events", () => {
    const text = ics(
      vevent("UID:zero@test", "SUMMARY:zero", "DTSTART:20261110T090000Z", "DTEND:20261110T090000Z"),
      vevent("UID:no-end@test", "SUMMARY:no end", "DTSTART:20261110T093000Z"),
      vevent("UID:inverted@test", "SUMMARY:inverted", "DTSTART:20261110T100000Z", "DTEND:20261110T090000Z"),
      // An all-day event that ends on its start date lasts that day (see all-day events);
      // one that ends before it is still inverted, alone or repeating.
      vevent("UID:zero-day@test", "SUMMARY:zero day", "DTSTART;VALUE=DATE:20261110", "DTEND;VALUE=DATE:20261110"),
      vevent("UID:inverted-day@test", "SUMMARY:inverted day", "DTSTART;VALUE=DATE:20261111", "DTEND;VALUE=DATE:20261110"),
      vevent("UID:inverted-days@test", "SUMMARY:inverted days", "DTSTART;VALUE=DATE:20261111", "DTEND;VALUE=DATE:20261110", "RRULE:FREQ=DAILY;COUNT=2"),
      vevent("UID:zero-series@test", "SUMMARY:zero series", "DTSTART:20261110T130000Z", "DTEND:20261110T130000Z", "RRULE:FREQ=DAILY;COUNT=3"),
      vevent("UID:ok@test", "SUMMARY:ok", "DTSTART:20261110T110000Z", "DTEND:20261110T120000Z"),
    );
    const r = read(text, "2026-11-09T00:00:00Z", "2026-11-14T00:00:00Z");
    expect(r.busy.map((b) => b.title)).toEqual(["zero day", "ok"]);
  });

  it("keeps what came before a file cut off mid-event", () => {
    const text = ["BEGIN:VCALENDAR", "VERSION:2.0", ...vevent("UID:before@test", "SUMMARY:before", "DTSTART:20261110T090000Z", "DTEND:20261110T100000Z"), "BEGIN:VEVENT", "UID:cut@test", "DTSTART:2026"].join("\r\n");
    expect(read(text, "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z").busy.map((b) => b.title)).toEqual(["before"]);
  });

  describe("an event that is never closed", () => {
    const open = (uid: string, hh = "09") => ["BEGIN:VEVENT", `UID:${uid}`, `DTSTART:20261110T${hh}0000Z`, `DTEND:20261110T${hh}3000Z`];
    const Y = vevent("UID:y", "DTSTART:20261110T110000Z", "DTEND:20261110T120000Z");
    const DAY = ["2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z", "Europe/Istanbul"] as const;

    it("doesn't hide the event after it, and counts as skipped", () => {
      const text = ["BEGIN:VCALENDAR", "VERSION:2.0", ...open("x"), ...Y, "END:VCALENDAR", ""].join("\r\n");
      const r = read(text, ...DAY);
      expect(spans(r)).toEqual(["2026-11-10T11:00Z/2026-11-10T12:00Z"]);
      expect(r.skipped).toBe(1);
    });

    it("doesn't hide a time zone, a second calendar or a run of events after it", () => {
      const cases: [string, string[], string[], number][] = [
        // Lab Time is +02:00 in November: y's 09:00 is 07:00Z only if the block is read.
        [
          "a VTIMEZONE, then an event in it",
          ["BEGIN:VCALENDAR", ...open("x"), ...LAB_VTIMEZONE, ...vevent("UID:y", "DTSTART;TZID=Lab Time:20261110T090000", "DTEND;TZID=Lab Time:20261110T100000"), "END:VCALENDAR"],
          ["2026-11-10T07:00Z/2026-11-10T08:00Z"],
          1,
        ],
        ["an alarm left open inside it", ["BEGIN:VCALENDAR", ...open("x"), "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT10M", ...Y, "END:VCALENDAR"], ["2026-11-10T11:00Z/2026-11-10T12:00Z"], 1],
        ["a component of another kind, then an event in it", ["BEGIN:VCALENDAR", ...open("x"), "BEGIN:X-GROUP", ...Y, "END:X-GROUP", "END:VCALENDAR"], ["2026-11-10T11:00Z/2026-11-10T12:00Z"], 1],
        ["a second calendar after a first cut off", ["BEGIN:VCALENDAR", "VERSION:2.0", ...open("x"), "BEGIN:VCALENDAR", "VERSION:2.0", ...Y, "END:VCALENDAR"], ["2026-11-10T11:00Z/2026-11-10T12:00Z"], 1],
        ["three never closed", ["BEGIN:VCALENDAR", ...open("x1", "08"), ...open("x2", "09"), ...open("x3", "10"), ...Y, "END:VCALENDAR"], ["2026-11-10T11:00Z/2026-11-10T12:00Z"], 3],
        ["the next one in lower case", ["BEGIN:VCALENDAR", ...open("x"), "begin:vevent", "UID:y", "DTSTART:20261110T110000Z", "DTEND:20261110T120000Z", "end:vevent", "END:VCALENDAR"], ["2026-11-10T11:00Z/2026-11-10T12:00Z"], 1],
        ["200,000 never closed", ["BEGIN:VCALENDAR", ...Array<string>(200_000).fill("BEGIN:VEVENT"), ...Y, "END:VCALENDAR"], ["2026-11-10T11:00Z/2026-11-10T12:00Z"], 200_000],
      ];
      for (const [name, lines, expected, skipped] of cases) {
        const r = read([...lines, ""].join("\r\n"), ...DAY);
        expect(spans(r), name).toEqual(expected);
        expect(r.skipped, name).toBe(skipped);
      }
    });
  });

  it("reads on past END lines that close nothing, or close what was left open inside", () => {
    const at = (h: string, title: string, uid: string) => [`UID:${uid}@test`, `SUMMARY:${title}`, `DTSTART:20261110T${h}0000Z`, `DTEND:20261110T${h}3000Z`];
    const text = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      // Its alarm is never closed: END:VEVENT closes both.
      ...["BEGIN:VEVENT", ...at("08", "alarm left open", "m1"), "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT10M", "END:VEVENT"],
      "END:VALARM",
      // RFC 5545's grammar takes BEGIN:VEVENT in any letter case.
      ...["begin:vevent", ...at("09", "lower case", "m2"), "end:vevent"],
      // Closed with its wrapper before it had a start: it can't be read.
      ...["BEGIN:X-WRAPPER", "BEGIN:VEVENT", "UID:m3@test", "SUMMARY:cut off", "END:X-WRAPPER"],
      ...["BEGIN:VEVENT", ...at("10", "after the mess", "m4"), "END:VEVENT"],
      "END:VEVENT",
      "END:VCALENDAR",
      // A second calendar appended to the first, as merged feeds do.
      ...["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", ...at("11", "second calendar", "m5"), "END:VEVENT", "END:VCALENDAR"],
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    const r = read(text, "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z");
    expect(r.busy.map((b) => b.title)).toEqual(["alarm left open", "lower case", "after the mess", "second calendar"]);
    expect(r.skipped).toBe(1);
  });

  it("throws IcsError for text that isn't a calendar", () => {
    for (const text of ["", "Not Found", "<!DOCTYPE html><html><body>Sign in</body></html>", '{"error":"forbidden"}', "BEGIN:VEVENT\r\nDTSTART:20261110T090000Z\r\nEND:VEVENT\r\n"]) {
      expect(() => read(text, "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z"), JSON.stringify(text.slice(0, 20))).toThrow(IcsError);
    }
  });
});

describe("the console", () => {
  // A file is read at every sync: what it can't hold goes in `skipped`, never
  // in the server's log.
  const METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const NONE = { log: 0, info: 0, warn: 0, error: 0, debug: 0, trace: 0 };
  function watchConsole() {
    const spies = METHODS.map((name) => vi.spyOn(console, name).mockImplementation(() => undefined));
    return { spies, calls: () => Object.fromEntries(METHODS.map((name, i) => [name, spies[i].mock.calls.length])) };
  }
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls no console method for 20,000 rules it can't read, and counts each in skipped", () => {
    const text = ics(...Array.from({ length: 20_000 }, (_, n) => vevent(`UID:bogus-${n}@test`, "DTSTART:20261110T090000Z", "DTEND:20261110T100000Z", `RRULE:FREQ=BOGUS${n}`)));
    const watch = watchConsole();
    const r = read(text, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z");
    expect(watch.calls()).toEqual(NONE);
    expect(r.skipped).toBe(20_000);
    expect(r.busy).toEqual([]);
  });

  it("calls no console method whatever else the file holds, and leaves the console as it was", () => {
    const at = (uid: string, ...props: string[]) => vevent(`UID:${uid}@junk`, "DTSTART:20261110T090000Z", "DTEND:20261110T100000Z", ...props);
    const junk = ics(
      // A zone whose rules node-ical can't read, and an event in it.
      ["BEGIN:VTIMEZONE", "TZID:Broken Rules", "BEGIN:STANDARD", "DTSTART:19701025T030000", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "RRULE:FREQ=YEARLY;BYMONTH=13", "END:STANDARD"],
      ["BEGIN:DAYLIGHT", "DTSTART:19700329T020000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "RRULE:FREQ=NOPE", "END:DAYLIGHT", "END:VTIMEZONE"],
      vevent("UID:z1@junk", "DTSTART;TZID=Broken Rules:20261110T090000", "DTEND;TZID=Broken Rules:20261110T100000"),
      // Zones that are no IANA or Windows name, block or offset.
      vevent("UID:z2@junk", "DTSTART;TZID=Junk/Olympus_Mons:20261110T090000", "DTEND;TZID=Junk/Olympus_Mons:20261110T100000", "RRULE:FREQ=DAILY;COUNT=2"),
      vevent("UID:z3@junk", "DTSTART;TZID=Junk Standard Time:20261110T090000", "DURATION:PT1H"),
      vevent("UID:z4@junk", "DTSTART;TZID=(UTC+99:00) Junk:20261110T090000", "DURATION:PT1H"),
      // Rules that can't be read.
      ...["FREQ=WEEKLY;BYDAY=XX", "FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;COUNT=abc", "FREQ=", "BYDAY=MO", "FREQ=MONTHLY;BYMONTHDAY=99", "FREQ=DAILY;UNTIL=garbage", "FREQ=YEARLY;BYWEEKNO=60", "FREQ=HOURLY;BYHOUR=25", ";;;"].map((rule, i) => at(`r${i}`, `RRULE:${rule}`)),
      // Exceptions, revisions and ends that can't be read.
      at("x1", "RRULE:FREQ=DAILY;COUNT=3", "EXDATE:garbage", "EXDATE;TZID=Junk/Elsewhere:20261111T090000"),
      vevent("UID:x1@junk", "RECURRENCE-ID:garbage", "DTSTART:20261111T120000Z", "DTEND:20261111T130000Z"),
      vevent("UID:x1@junk", "RECURRENCE-ID;TZID=Junk/Nowhere:20261112T090000", "DTSTART:20261112T150000Z", "DTEND:20261112T160000Z"),
      at("x2", "RRULE:FREQ=DAILY;COUNT=2", "SEQUENCE:5"),
      at("x2", "RRULE:FREQ=DAILY;COUNT=2", "SEQUENCE:2"),
      vevent("UID:x2@junk", "RECURRENCE-ID:20261111T090000Z", "SEQUENCE:1", "DTSTART:20261111T110000Z", "DTEND:20261111T120000Z"),
      vevent("UID:x2@junk", "RECURRENCE-ID:20261111T090000Z", "SEQUENCE:0", "DTSTART:20261111T130000Z", "DTEND:20261111T140000Z"),
      vevent("UID:x3@junk", "DTSTART:20261110T090000Z", "DURATION:P1X"),
      vevent("UID:x4@junk", "DTSTART:20261110T090000Z", "DTEND;VALUE=DATE:20261111"),
      vevent("UID:x5@junk", "DTSTART:99991231T230000Z", "DTEND:99991231T233000Z", "RRULE:FREQ=MINUTELY"),
      vevent("UID:fine@junk", "SUMMARY:fine", "DTSTART:20261110T120000Z", "DTEND:20261110T130000Z"),
    );
    const watch = watchConsole();
    const given = METHODS.map((name) => console[name]);
    const r = read(junk, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", "Europe/Istanbul");
    expect(r.busy.map((b) => b.title)).toContain("fine");
    expect(() => read("Not Found", "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z")).toThrow(IcsError);
    expect(watch.calls()).toEqual(NONE);
    // After a result and after an IcsError, the console is the one it was given, and it works.
    METHODS.forEach((name, i) => expect(console[name], name).toBe(given[i]));
    for (const name of METHODS) console[name]("after icsBusy");
    expect(watch.calls()).toEqual({ log: 1, info: 1, warn: 1, error: 1, debug: 1, trace: 1 });
  });
});

describe("limit and truncation (criterion 9)", () => {
  const START = Date.parse("2026-11-01T00:00:00Z");
  const many = (n: number) =>
    ics(...Array.from({ length: n }, (_, i) => vevent(`UID:many-${i}@test`, `DTSTART:${stamp(START + i * 15 * MIN)}`, `DTEND:${stamp(START + i * 15 * MIN + 10 * MIN)}`)));

  it("returns at most 5000 blocks by default, the earliest", () => {
    const over = read(many(5001), "2026-11-01T00:00:00Z", "2027-01-01T00:00:00Z");
    expect(over.busy).toHaveLength(5000);
    expect(over.truncated).toBe(true);
    expect(over.busy[0].start).toBe(START);
    expect(over.busy[4999].start).toBe(START + 4999 * 15 * MIN);
    const exact = read(many(5000), "2026-11-01T00:00:00Z", "2027-01-01T00:00:00Z");
    expect(exact.busy).toHaveLength(5000);
    expect(exact.truncated).toBe(false);
  });

  it("keeps the first `limit` by start, whatever the order in the file", () => {
    const hh = (h: number) => String(h).padStart(2, "0");
    const text = ics(...[13, 12, 11, 10, 9, 8].map((h) => vevent(`UID:h${h}@test`, `SUMMARY:${h}`, `DTSTART:20261110T${hh(h)}0000Z`, `DTEND:20261110T${hh(h)}3000Z`)));
    const four = read(text, "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z", "UTC", 4);
    expect(four.busy.map((b) => b.title)).toEqual(["8", "9", "10", "11"]);
    expect(four.truncated).toBe(true);
    const six = read(text, "2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z", "UTC", 6);
    expect(six.busy).toHaveLength(6);
    expect(six.truncated).toBe(false);
  });

  it("counts only occurrences in the window, across series and single events", () => {
    const text = ics(
      vevent("UID:daily@test", "SUMMARY:daily", "DTSTART:20261001T090000Z", "DTEND:20261001T093000Z", "RRULE:FREQ=DAILY"),
      vevent("UID:one-a@test", "SUMMARY:one", "DTSTART:20261103T080000Z", "DTEND:20261103T083000Z"),
      vevent("UID:one-b@test", "SUMMARY:one", "DTSTART:20261105T120000Z", "DTEND:20261105T123000Z"),
    );
    const r = read(text, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", "UTC", 6);
    expect(r.busy.map((b) => iso(b.start))).toEqual([
      "2026-11-01T09:00Z",
      "2026-11-02T09:00Z",
      "2026-11-03T08:00Z",
      "2026-11-03T09:00Z",
      "2026-11-04T09:00Z",
      "2026-11-05T09:00Z",
    ]);
    expect(r.truncated).toBe(true);
    // The 30 days of November and the two single events fit under the default limit.
    const all = read(text, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z");
    expect(all.busy).toHaveLength(32);
    expect(all.truncated).toBe(false);
  });
});

describe("files built to hold up the server", () => {
  // icsBusy is synchronous: while it reads a file, the server answers nobody.
  // Each trap is timed against a file of about the same size without it, on the
  // same machine, so the check holds on a slow one too. Reading time has to grow
  // with the file, not with the file times itself. The time limit is raised
  // because a loaded machine slows both files alike, which isn't what's tested.
  const SLOW_MACHINE = { timeout: 60_000 };

  /** The fastest of three interleaved runs of each, in ms: a pause for garbage collection shouldn't decide. */
  function fastest(...runs: (() => unknown)[]): number[] {
    const best = runs.map(() => Infinity);
    for (let round = 0; round < 3; round++) {
      runs.forEach((run, i) => {
        const t0 = performance.now();
        run();
        best[i] = Math.min(best[i], performance.now() - t0);
      });
    }
    return best;
  }
  function expectAsFastAs(plain: () => unknown, trap: () => unknown, name = "trap") {
    const [plainMs, trapMs] = fastest(plain, trap);
    expect(trapMs, `${name} ${Math.round(trapMs)} ms, plain ${Math.round(plainMs)} ms`).toBeLessThan(4 * plainMs + 50);
  }

  it("passes over END lines that close nothing, under deep nesting", SLOW_MACHINE, () => {
    const event = (title: string, hh: string) => vevent(`UID:${title}@test`, `SUMMARY:${title}`, `DTSTART:20261110T${hh}0000Z`, `DTEND:20261110T${hh}3000Z`).join("\r\n") + "\r\n";
    // 2,000 levels open, then a million END lines for a type that isn't open (7 MB).
    // Nesting itself, much deeper, is in the tests below.
    const file = (depth: number) =>
      ["BEGIN:VCALENDAR\r\nVERSION:2.0\r\n", event("outside 1", "08"), "BEGIN:X-NEST\r\n".repeat(depth), event("inside", "09")].join("") +
      ["END:B\r\n".repeat(1_000_000), "END:X-NEST\r\n".repeat(depth), event("outside 2", "10"), "END:VCALENDAR\r\n"].join("");
    const trap = file(2000);
    const plain = file(0);
    const range = ["2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z"] as const;
    const r = read(trap, ...range);
    expect(r.busy.map((b) => b.title)).toEqual(["outside 1", "inside", "outside 2"]);
    expect(r.skipped).toBe(0);
    expectAsFastAs(
      () => read(plain, ...range),
      () => read(trap, ...range),
    );
  });

  const DEEP_EVENT = vevent("UID:deep@test", "SUMMARY:deep", "DTSTART:20261110T090000Z", "DTEND:20261110T100000Z");
  const DEEP_RANGE = ["2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z"] as const;

  it("reads an event under 200,000 levels of components that never close", SLOW_MACHINE, () => {
    const levels = Array.from({ length: 200_000 }, (_, i) => (i % 2 ? "BEGIN:B" : "BEGIN:A"));
    const text = ["BEGIN:VCALENDAR", ...levels, ...DEEP_EVENT, "END:VCALENDAR", ""].join("\r\n");
    const r = read(text, ...DEEP_RANGE);
    expect(r.busy.map((b) => b.title)).toEqual(["deep"]);
    expect(r.skipped).toBe(0);
  });

  it("throws nothing but IcsError, however deep the nesting and of what", SLOW_MACHINE, () => {
    const DEEP = 200_000;
    const many = (line: string, n = DEEP) => Array<string>(n).fill(line);
    const alarmed = ["BEGIN:VEVENT", "UID:alarmed@test", "SUMMARY:alarmed", "DTSTART:20261110T080000Z", "DTEND:20261110T083000Z", ...many("BEGIN:VALARM"), "END:VEVENT"];
    const zoned = vevent("UID:zoned@test", "SUMMARY:zoned", "DTSTART;TZID=Deep Time:20261110T090000", "DTEND;TZID=Deep Time:20261110T100000");
    // What each gives: the titles read, "any" for a calendar whose event a component that's never closed holds, or IcsError.
    const cases: [string, string[], string[] | "any" | typeof IcsError][] = [
      ["calendars in calendars", [...many("BEGIN:VCALENDAR"), ...DEEP_EVENT], ["deep"]],
      ["one type, opened and closed again", ["BEGIN:VCALENDAR", ...many("BEGIN:X-A"), ...many("END:X-A"), ...DEEP_EVENT, "END:VCALENDAR"], ["deep"]],
      ["two types, closed in turn", ["BEGIN:VCALENDAR", ...many("BEGIN:A\r\nBEGIN:B", DEEP / 2), ...DEEP_EVENT, ...many("END:B\r\nEND:A", DEEP / 2), "END:VCALENDAR"], ["deep"]],
      ["alarms in an event", ["BEGIN:VCALENDAR", ...alarmed, ...DEEP_EVENT, "END:VCALENDAR"], ["alarmed", "deep"]],
      ["parts in a time zone", ["BEGIN:VCALENDAR", "BEGIN:VTIMEZONE", "TZID:Deep Time", ...many("BEGIN:STANDARD"), "END:VTIMEZONE", ...zoned, "END:VCALENDAR"], ["zoned"]],
      ["time zones in time zones", ["BEGIN:VCALENDAR", ...many("BEGIN:VTIMEZONE"), ...DEEP_EVENT, "END:VCALENDAR"], "any"],
      ["a million levels", ["BEGIN:VCALENDAR", ...many("BEGIN:X-NEST", 1_000_000), ...DEEP_EVENT, "END:VCALENDAR"], ["deep"]],
      ["no calendar at all", [...many("BEGIN:X-A"), ...DEEP_EVENT], IcsError],
    ];
    for (const [name, lines, expected] of cases) {
      let result: Result | undefined;
      let error: unknown;
      try {
        result = read([...lines, ""].join("\r\n"), ...DEEP_RANGE);
      } catch (e) {
        error = e;
      }
      if (expected === IcsError) {
        expect(error, name).toBeInstanceOf(IcsError);
      } else {
        expect(error, name).toBeUndefined();
        if (expected !== "any") expect(result?.busy.map((b) => b.title), name).toEqual(expected);
      }
    }
  });

  it("reads components nested 500,000 deep as fast as the same lines side by side", SLOW_MACHINE, () => {
    const N = 250_000;
    const event = DEEP_EVENT.join("\r\n") + "\r\n";
    // The same lines and components; only the depth differs.
    const trap = "BEGIN:VCALENDAR\r\n" + "BEGIN:A\r\nBEGIN:B\r\n".repeat(N) + event + "END:B\r\nEND:A\r\n".repeat(N) + "END:VCALENDAR\r\n";
    const plain = "BEGIN:VCALENDAR\r\n" + "BEGIN:A\r\nEND:A\r\n".repeat(N) + event + "BEGIN:B\r\nEND:B\r\n".repeat(N) + "END:VCALENDAR\r\n";
    expect(trap.length).toBe(plain.length);
    expect(read(trap, ...DEEP_RANGE).busy.map((b) => b.title)).toEqual(["deep"]);
    expectAsFastAs(
      () => read(plain, ...DEEP_RANGE),
      () => read(trap, ...DEEP_RANGE),
    );
  });

  it("searches the file's VTIMEZONE blocks once, not once for every TZID it can't resolve", SLOW_MACHINE, () => {
    // 50,000 blocks, and 1,000 events each in a zone that no block, IANA name or Windows name gives (2.4 MB).
    const blocks = (type: string) => Array.from({ length: 50_000 }, (_, i) => [`BEGIN:${type}`, `TZID:q${i}`, `END:${type}`]).flat();
    const events = Array.from({ length: 1000 }, (_, i) => vevent(`UID:w${i}@test`, `DTSTART;TZID=w${i}:20261110T090000`, `DTEND;TZID=w${i}:20261110T093000`)).flat();
    const trap = ics(blocks("VTIMEZONE"), events);
    const plain = ics(blocks("X-NOTZONE"), events);
    const range = ["2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z", "Europe/Istanbul"] as const;
    const r = read(trap, ...range);
    // Read in the person's zone, as a TZID that can't be resolved is.
    expect(r.busy).toHaveLength(1000);
    expect(new Set(spans(r))).toEqual(new Set(["2026-11-10T06:00Z/2026-11-10T06:30Z"]));
    expect(r.skipped).toBe(0);
    expectAsFastAs(
      () => read(plain, ...range),
      () => read(trap, ...range),
    );
  });

  it("reads a VTIMEZONE block once, however many letter cases of its TZID ask for it", SLOW_MACHINE, () => {
    // Lab Time's rules restated for 200 years (400 parts), then asked for under 400 spellings of its name.
    const parts = Array.from({ length: 200 }, (_, i) => [
      ...["BEGIN:DAYLIGHT", `DTSTART:${1700 + i}0402T020000`, "TZOFFSETFROM:+0200", "TZOFFSETTO:+0300", "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU", "END:DAYLIGHT"],
      ...["BEGIN:STANDARD", `DTSTART:${1700 + i}1001T030000`, "TZOFFSETFROM:+0300", "TZOFFSETTO:+0200", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU", "END:STANDARD"],
    ]).flat();
    const NAME = "Harbour Lab Time";
    const zone = ["BEGIN:VTIMEZONE", `TZID:${NAME}`, ...parts, "END:VTIMEZONE"];
    /** The name's letters in upper or lower case by the bits of n; none of 0 to 399 spells it as the block does. */
    const spelled = (n: number) => {
      let bit = 0;
      return [...NAME].map((c) => (c === " " ? c : (n >> bit++) & 1 ? c.toUpperCase() : c.toLowerCase())).join("");
    };
    const events = (tzid: (i: number) => string) =>
      Array.from({ length: 400 }, (_, i) => {
        const day = i % 2 ? "20260715" : "20261110";
        return vevent(`UID:h${i}@test`, `DTSTART;TZID=${tzid(i)}:${day}T090000`, `DTEND;TZID=${tzid(i)}:${day}T093000`);
      });
    // The block comes after the events that use it.
    const trap = ics(...events(spelled), zone);
    const plain = ics(...events(() => NAME), zone);
    const range = ["2026-07-01T00:00:00Z", "2026-12-01T00:00:00Z", "Europe/Istanbul"] as const;
    const r = read(trap, ...range);
    // +03:00 in July and +02:00 in November, by the block, whatever the spelling.
    expect(starts(r)).toEqual([...Array<string>(200).fill("2026-07-15T06:00Z"), ...Array<string>(200).fill("2026-11-10T07:00Z")]);
    expect(r.skipped).toBe(0);
    expectAsFastAs(
      () => read(plain, ...range),
      () => read(trap, ...range),
    );
  });

  it("reads a long HTML description as fast as plain text of the same length, whatever its markup", SLOW_MACHINE, () => {
    // Each has a listed tag, so htmlToText reads it. Each shape made one of the regular
    // expressions htmlToText was first written with scan to the end of the text from
    // every character of a run: at 128 K characters, from a tenth of a second to ten
    // seconds. Each is read at that length, then at a million characters, where a scan
    // that is quick for each character still adds up.
    const shapes: [string, (n: number) => string][] = [
      ["a '<' that nothing closes", (n) => `<p>Agenda</p>${"<".repeat(n)}`],
      ["a run of spaces", (n) => `<b>Agenda</b>${" ".repeat(n)}end`],
      ["a run of spaces and tabs", (n) => `<b>Agenda</b>${" \t".repeat(n / 2)}end`],
      ["a run of &nbsp;", (n) => `<p>Agenda</p>${"&nbsp;".repeat(n / 6)}<p>end</p>`],
      ["links without </a>", (n) => `<p>See</p>${'<a href="x">y'.repeat(n / 13)}`],
      ["'<a ' over and over in one tag", (n) => `<p>See</p>${"<a ".repeat(n / 3)}>`],
      ["one link tag with many hrefs", (n) => `<p>See</p><a ${"href='x' ".repeat(n / 9)}>`],
      ["a link label of '<'", (n) => `<a href="https://example.com/doc">${"<".repeat(n)}</a>`],
      ["scripts without an end tag", (n) => `<p>Hi</p>${"<script>".repeat(n / 8)}`],
      ["'<script' over and over in one tag", (n) => `<p>Hi</p>${"<script".repeat(n / 7)}>`],
      ["'<li' that nothing closes", (n) => `<p>Hi</p>${"<li".repeat(n / 3)}`],
    ];
    const range = ["2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z"] as const;
    const file = (description: string) =>
      ics(vevent("UID:long@test", "DTSTART:20261110T090000Z", "DTEND:20261110T100000Z", `DESCRIPTION:${description.replace(/[\\;,]/g, "\\$&")}`));
    for (const n of [128_000, 1_000_000]) {
      for (const [shape, html] of shapes.map(([name, make]) => [`${name}, ${n} characters`, make(n)])) {
        const trap = file(html);
        // The same text with no tag in it, so it is kept as written.
        const plain = file(html.replace(/</g, "["));
        const text = htmlToText(html).slice(0, 8000);
        // Kept as written, the description would show otherwise.
        expect(text, shape).not.toBe(html.slice(0, 8000));
        expect(read(trap, ...range).busy[0]?.details?.description, shape).toBe(text);
        expectAsFastAs(
          () => read(plain, ...range),
          () => read(trap, ...range),
          shape,
        );
      }
    }
  });
});
