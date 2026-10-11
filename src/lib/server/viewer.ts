import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import type { Viewer } from "@/lib/types";
import { getUser, newCalendarCount, type UserRow } from "./db";
import { SESSION_COOKIE, identityTag, verifySession } from "./secrets";

/**
 * The person a session cookie belongs to, if it's still valid: signed,
 * unexpired, not ended by a sign-out (session_version) and made for this very
 * Google account (identity tag).
 */
export function userForSession(value: string | undefined): UserRow | null {
  const claims = verifySession(value);
  if (!claims) return null;
  const user = getUser(claims.userId);
  if (!user) return null;
  if (user.session_version !== claims.version) return null;
  if (identityTag(user.google_sub ?? user.email) !== claims.tag) return null;
  return user;
}

/** The signed-in user from the request cookie, if any. */
export async function sessionUser(): Promise<UserRow | null> {
  return userForSession((await cookies()).get(SESSION_COOKIE)?.value);
}

export async function sessionUserId(): Promise<string | null> {
  return (await sessionUser())?.id ?? null;
}

/** The signed-in person, if the session cookie is valid and they still exist. */
export async function currentViewer(): Promise<Viewer | null> {
  const user = await sessionUser();
  return user
    ? { id: user.id, name: user.name, email: user.email, newCalendars: newCalendarCount(user.id) }
    : null;
}

/** An absolute URL on this app. APP_URL wins, since behind a proxy the request's own host is internal. */
export function appUrl(request: NextRequest, path: string): URL {
  return new URL(path, process.env.APP_URL || request.nextUrl.origin);
}
