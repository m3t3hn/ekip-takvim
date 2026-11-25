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

/** "google": one of the person's Google calendars; "link": read from a calendar link they added. */
export type CalendarKind = "google" | "link";

export type CalendarStatus = {
  person: string;
  personId: string;
  label: string;
  kind: CalendarKind;
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
  /** People whose Google access needs renewing while a Google calendar of theirs counts: they have to sign in again. */
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

/** One of the viewer's calendars, from Google or a calendar link, as shown on their settings page. */
export type MyCalendar = {
  id: string;
  kind: CalendarKind;
  /** Name in Google Calendar; for a calendar link, the link's host. Only ever sent to its owner. */
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
  /** Whether this server takes new calendar links (CALENDAR_LINKS). */
  linksAllowed: boolean;
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

/** Why a Google sign-in sent the person back without signing them in. */
export type SignInFailure = "unavailable" | "cancelled" | "expired" | "domain" | "failed";

/**
 * How Allow access on My settings ended, as the sign-in sends the host back
 * there (/settings?access=…#booking): the permission given, the box left
 * unticked on Google's screen, or one of sign-in's failures, cancelled included.
 */
export type AllowAccessResult = "granted" | "missing" | SignInFailure;

/**
 * What a host sets on a booking link (POST and PUT /api/me/booking-links).
 * Days and hours are on the host's clock: the zone on their settings page.
 */
export type BookingLinkFields = {
  title: string;
  description: string;
  /** 15, 30, 45, 60, 90 or 120. */
  durationMin: number;
  /** The weekdays it offers, 0 = Sunday. */
  days: number[];
  /** The daily window, in minutes after midnight (multiples of 15, up to 1440). */
  startMin: number;
  endMin: number;
  /** Kept free before and after each booking. */
  bufferMin: number;
  /** How long before a time it can be booked at the latest. */
  noticeMin: number;
  /** How many days, today included, it offers times for. */
  aheadDays: number;
  /** Bookings on the link per day; null for no cap. */
  maxPerDay: number | null;
  /** Whether the booking's event gets a Google Meet link. */
  meet: boolean;
};

/** One of the signed-in person's booking links. Only ever sent to its owner. */
export type MyBookingLink = BookingLinkFields & {
  id: string;
  active: boolean;
  /** "/book/<id>": anyone with it can book a time. */
  path: string;
};

/** A booking someone made with the signed-in person. Only ever sent to that person. */
export type UpcomingBooking = {
  id: string;
  /** The link's title when it was booked. */
  title: string;
  start: number;
  end: number;
  guestName: string;
  guestEmail: string;
  note: string | null;
};

/** The host API's answer (GET /api/me/booking-links and the changes to it). */
export type MyBookingLinks = {
  /** Whether they allowed booked meetings in their Google Calendar: without it, their links offer no times. */
  bookingAccess: boolean;
  links: MyBookingLink[];
  /** Bookings that haven't ended or been cancelled, soonest first. */
  upcoming: UpcomingBooking[];
};

/** What a visitor sees of a booking link (GET /api/book/[id]): nothing else about the host. */
export type BookingPageInfo = {
  title: string;
  description: string;
  durationMin: number;
  hostName: string;
  /** Whether a booking's event gets a Google Meet link: the meeting is a Meet call. */
  meet: boolean;
  /** The free times, ascending, in epoch ms. */
  slots: { start: number; end: number }[];
  /**
   * The days the link offers with no time free, each as the first time it
   * would have offered that day (epoch ms), ascending. Empty when there's no
   * free time at all.
   */
  fullDays: number[];
};

/** A booking just made (POST /api/book/[id]). */
export type BookingMade = {
  start: number;
  end: number;
  title: string;
  hostName: string;
  /** The booking's cancel link, /book/cancel/<token>: its confirmation's own address. */
  cancelUrl: string;
  /** Google is sending the visitor an invitation: always, outside the demo. */
  invited: boolean;
};

/** A booking as its cancel link shows it (/api/book/cancel/[token]). */
export type BookingToCancel = {
  title: string;
  start: number;
  end: number;
  hostName: string;
  cancelled: boolean;
  /** Whether its meeting has ended: it took place, and can't be cancelled. */
  ended: boolean;
  /**
   * Once it's cancelled or has ended: its link's page, "/book/<id>", to book
   * another time, while that link is on and its host is still here. Else null.
   */
  bookAgain: string | null;
};
