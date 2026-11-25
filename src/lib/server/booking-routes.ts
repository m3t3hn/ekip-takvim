import { NextResponse } from "next/server";
import { z } from "zod";
import { BUFFERS, DURATIONS, MAX_PER_DAY, NOTICES } from "@/lib/booking";
import type { BookingLinkFields } from "@/lib/types";
import { bookingAllowed } from "./booking-setting";
import { myBookingLinks } from "./bookings";
import { buildConfig } from "./config";
import { getUser, type UserRow } from "./db";
import { getConfig } from "./sync";
import { sessionUserId } from "./viewer";

// What the booking routes share: the host API's guard, answer and input
// rules, and the headers of every answer to a visitor.

const NO_STORE = { "Cache-Control": "no-store" };

export const problem = (status: number, error: string, headers?: HeadersInit) => NextResponse.json({ error }, { status, headers });

/** The signed-in host, or the answer to give instead: 401 without a session, 403 while booking links are off. */
export async function signedInHost(): Promise<UserRow | NextResponse> {
  const id = await sessionUserId();
  const user = id ? getUser(id) : null;
  if (!user) return problem(401, "Sign in first");
  if (!bookingAllowed()) return problem(403, "Booking links are off on this server.");
  return user;
}

/** When Google couldn't delete a booking's event, so the booking wasn't cancelled: the same for the visitor and the host. */
export const CANT_CANCEL = "Couldn't cancel right now. Try again in a few minutes.";

/** When a booking's event is still being made, so the booking wasn't cancelled (see cancelBooking): the same for both. */
export const BEING_MADE = "This booking is still being made. Try again in a minute.";

/** When a booking's meeting has ended, so it wasn't cancelled (see cancelBooking): the same for both. */
export const ENDED = "This meeting has ended, so it can't be cancelled.";

/** The host API's answer: their booking links and upcoming bookings, and whether they allowed booked meetings in Google Calendar. */
export function hostAnswer(userId: string): NextResponse {
  return NextResponse.json(myBookingLinks(userId), { headers: NO_STORE });
}

/** An answer to a visitor: never cached, and kept out of search engines. */
export function visitorAnswer(body: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...headers, ...NO_STORE, "X-Robots-Tag": "noindex" } });
}

/**
 * A visitor's JSON body, read no further than `limit` bytes: null when it's
 * longer, or isn't JSON. Anyone can send one, so it's never held whole first.
 */
export async function smallJson(request: Request, limit = 8_192): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > limit) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

const Minutes = z.int().min(0).max(1440).multipleOf(15);

function linkSchema(horizonDays: number) {
  return z
    .object({
      title: z.string().trim().min(1).max(80),
      description: z
        .string()
        .trim()
        .max(500)
        .nullish()
        .transform((d) => d ?? ""),
      durationMin: z.literal(DURATIONS),
      days: z
        .array(z.int().min(0).max(6))
        .min(1)
        .refine((days) => new Set(days).size === days.length),
      startMin: Minutes,
      endMin: Minutes,
      bufferMin: z.literal(BUFFERS),
      noticeMin: z.literal(NOTICES),
      aheadDays: z.int().min(1).max(horizonDays),
      maxPerDay: z.int().min(1).max(MAX_PER_DAY).nullable().default(null),
      meet: z.boolean().default(false),
      active: z.boolean().default(true),
    })
    .refine((l) => l.endMin - l.startMin >= l.durationMin, { path: ["window"] });
}

/** "15, 30 or 45" */
const oneOf = (values: number[]) => `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`;

function problemWith(field: PropertyKey | undefined, horizonDays: number): string {
  switch (field) {
    case "title":
      return "Give the link a title, up to 80 characters.";
    case "description":
      return "Keep the description to 500 characters.";
    case "durationMin":
      return `Pick a length of ${oneOf(DURATIONS)} minutes.`;
    case "days":
      return "Pick at least one day, each once.";
    case "startMin":
    case "endMin":
      return "Pick hours on the quarter hour, from 00:00 to 24:00.";
    case "window":
      return "The hours must be at least as long as a meeting.";
    case "bufferMin":
      return `Pick a break of ${oneOf(BUFFERS)} minutes.`;
    case "noticeMin":
      return "Pick one of the notice times.";
    case "aheadDays":
      return `Offer times 1 to ${horizonDays} days ahead.`;
    case "maxPerDay":
      return `A daily limit is 1 to ${MAX_PER_DAY} bookings, or none.`;
    default:
      return "Couldn't read that booking link.";
  }
}

/**
 * A booking link's fields from a request body, or what's wrong with them.
 * `current`, for a change, fills in what the body leaves out.
 */
export function parseLink(body: unknown, current?: BookingLinkFields & { active: boolean }): (BookingLinkFields & { active: boolean }) | string {
  const horizonDays = (getConfig() ?? buildConfig({})).horizonDays;
  if (!body || typeof body !== "object" || Array.isArray(body)) return problemWith(undefined, horizonDays);
  const parsed = linkSchema(horizonDays).safeParse({ ...current, ...body });
  if (!parsed.success) return problemWith(parsed.error.issues[0]?.path[0], horizonDays);
  return parsed.data;
}
