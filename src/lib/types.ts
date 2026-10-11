// Shapes shared by the API and the browser. Nothing here may carry calendar
// ids or tokens. Event titles only reach viewers allowed to see them (see
// getAvailability in sync.ts).

export type BusyBlock = {
  start: number;
  end: number;
  /** Index of the calendar among the person's included ones. */
  calendar: number;
  /** The label the person gave that calendar, e.g. "Agency". */
  label: string;
  /** The event's title, when this viewer may see it. */
  title?: string;
  /** Opens the event's details (GET /api/events/:ref). Only set along with `title`. */
  ref?: string;
  tentative?: boolean;
  allDay?: boolean;
};

export type Person = {
  id: string;
  name: string;
  /** Their Google account; invites go here. */
  email: string;
  team: string | null;
  /** Labels of the calendars they count as busy time. */
  calendars: string[];
  /** Their own colour, `#rrggbb`; nobody else has it. */
  color: string;
  /** IANA zone the person lives in. */
  timezone: string;
};

export type Zone = { label: string; zone: string };

export type WorkingHours = {
  timezone: string;
  /** Hours of the day in `timezone`, fractional allowed. */
  start: number;
  end: number;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
};

/**
 * Whether a person's busy times can be trusted. Anything but "ok" means the
 * app doesn't know when they're free, so they're left out of "everyone free".
 * - noCalendars: no calendar counts (or calendar access wasn't granted)
 * - signInAgain: Google access is gone; they need to sign in again
 * - syncing: a counted calendar hasn't been read yet
 * - failing: a counted calendar was never read, or nothing was read for hours
 */
export type DataStatus = "ok" | "noCalendars" | "signInAgain" | "syncing" | "failing";

export type PersonAvailability = Person & {
  busy: BusyBlock[];
  data: DataStatus;
  /** True until every calendar of this person has been synced at least once. */
  pending: boolean;
  /** A calendar failed on its last sync, or their Google access lapsed (data may be stale). */
  stale: boolean;
};

export type AvailabilityResponse = {
  /** The zone `start` and `coverage` are calendar days in (the viewer's). */
  timezone: string;
  start: string;
  days: number;
  syncedAt: number | null;
  /** Days (inclusive) that calendars are synced for; outside it there's no data. */
  coverage: { from: string; to: string };
  people: PersonAvailability[];
};

export type CalendarStatus = {
  person: string;
  personId: string;
  label: string;
  /** "events" reads the calendar's events; "freebusy" when it's only shared as free/busy. */
  access: "events" | "freebusy";
  state: "ok" | "error" | "pending";
  lastSuccess: number | null;
  lastAttempt: number | null;
  error: string | null;
  events: number;
};

export type StatusResponse = {
  /** The app's version, from package.json. */
  version: string;
  configError: string | null;
  syncedAt: number | null;
  syncing: boolean;
  calendars: CalendarStatus[];
  /** People whose Google access needs renewing: they have to sign in again. */
  signInAgain: { personId: string; person: string; error: string }[];
};

/** Who is signed in, if anyone. */
export type Viewer = {
  id: string;
  name: string;
  email: string;
  /** Calendars shared with them since they last saved their settings. */
  newCalendars: number;
};

export type ClientSettings = {
  /** Team default zone, used until the viewer's own is known. */
  timezone: string;
  displayHours: { start: number; end: number };
  weekStartsOn: 0 | 1;
  workingHours: WorkingHours;
  timezones: Zone[];
  teams: string[];
  people: Person[];
  configError: string | null;
  viewer: Viewer | null;
  /** "google" when Google sign-in is set up, "demo" in the demo, else null. */
  signIn: "google" | "demo" | null;
};

/** One of the viewer's Google calendars, as shown on their settings page. */
export type MyCalendar = {
  id: string;
  /** Name in Google Calendar. Only ever sent to its owner. */
  summary: string;
  label: string;
  included: boolean;
  primary: boolean;
  access: "events" | "freebusy";
  state: "ok" | "error" | "pending";
  error: string | null;
  lastSuccess: number | null;
  /** Shared with them after they joined and not reviewed yet. */
  isNew: boolean;
};

export type MySettings = {
  id: string;
  name: string;
  email: string;
  team: string | null;
  timezone: string;
  color: string;
  /** Colours other people have, so they can't be picked. */
  takenColors: { color: string; name: string }[];
  calendars: MyCalendar[];
  /** Calendar access wasn't granted at sign-in (the box was unticked). */
  missingCalendarAccess: boolean;
  /** Google access lapsed; signing in again fixes it. */
  tokenError: string | null;
  /** Why the calendar list couldn't be read from Google on the last try. */
  syncError: string | null;
};

/** An event's details, for someone allowed to see its title. */
export type EventInfo = {
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  tentative: boolean;
  label: string;
  personId: string;
  person: string;
  personTimezone: string;
  description: string | null;
  location: string | null;
  meetLink: string | null;
  /** The event in Google Calendar. */
  htmlLink: string | null;
};
