// Turn a chosen slot into something a calendar app can send as an invite.
// Nothing is sent from here: the organiser's own calendar does that, so
// invitations come from a real person and replies go back to them.

export type InviteDraft = {
  title: string;
  start: number;
  end: number;
  note: string;
  location: string;
  attendees: { name: string; email: string }[];
};

/** 20261007T150000Z */
function utcStamp(epoch: number): string {
  return new Date(epoch).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** 2026-10-07T15:00:00Z */
function utcIso(epoch: number): string {
  return new Date(epoch).toISOString().replace(/\.\d{3}/, "");
}

/**
 * `authuser` (the organiser's address) opens the right Google account when
 * several are signed in, instead of whichever is first in the browser.
 */
export function googleCalendarUrl(d: InviteDraft, authuser?: string): string {
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: d.title,
    dates: `${utcStamp(d.start)}/${utcStamp(d.end)}`,
  });
  if (d.note) q.set("details", d.note);
  if (d.location) q.set("location", d.location);
  // Google adds these as guests; it asks to email them when you save.
  if (d.attendees.length) q.set("add", d.attendees.map((a) => a.email).join(","));
  if (authuser) q.set("authuser", authuser);
  return `https://calendar.google.com/calendar/render?${q}`;
}

/** Outlook's compose link has no attendee field; emails are copied instead. */
export function outlookUrl(d: InviteDraft, account: "work" | "personal"): string {
  const host = account === "work" ? "outlook.office.com" : "outlook.live.com";
  const q = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: d.title,
    startdt: utcIso(d.start),
    enddt: utcIso(d.end),
  });
  if (d.note) q.set("body", d.note);
  if (d.location) q.set("location", d.location);
  return `https://${host}/calendar/0/deeplink/compose?${q}`;
}

function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function paramValue(value: string): string {
  const clean = value.replace(/"/g, "");
  return /[:;,]/.test(clean) ? `"${clean}"` : clean;
}

/** RFC 5545 lines are at most 75 octets; longer ones continue after CRLF + space. */
function fold(line: string): string {
  const bytes = new TextEncoder();
  const out: string[] = [];
  let current = "";
  for (const ch of line) {
    const limit = out.length === 0 ? 75 : 74;
    if (bytes.encode(current + ch).length > limit) {
      out.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.join("\r\n ");
}

export function buildIcs(d: InviteDraft, uid: string, now = Date.now()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Ekip Takvim//Invite//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}@ekip-takvim`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${utcStamp(d.start)}`,
    `DTEND:${utcStamp(d.end)}`,
    `SUMMARY:${escapeText(d.title)}`,
    ...(d.note ? [`DESCRIPTION:${escapeText(d.note)}`] : []),
    ...(d.location ? [`LOCATION:${escapeText(d.location)}`] : []),
    ...d.attendees.map(
      (a) => `ATTENDEE;CN=${paramValue(a.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`,
    ),
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
