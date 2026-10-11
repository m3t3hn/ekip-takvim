import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// One SESSION_SECRET signs the session cookie and encrypts the Google
// refresh tokens at rest. Changing it signs everyone out and makes stored
// tokens unreadable, so people have to sign in again.

const DEMO_SECRET = "ekip-takvim-demo-only-not-secret";
export const SESSION_COOKIE = "ekip_session";
/** Ties Google's redirect back to the browser that started the sign-in. */
export const STATE_COOKIE = "ekip_oauth_state";
const SESSION_DAYS = 30;

/**
 * Demo mode: made-up people, and anyone can sign in as any of them. It never
 * runs next to real Google sign-in, so a DEMO_MODE=true left on a real
 * deployment can't reset its database or let people sign in as each other.
 */
export function isDemo(): boolean {
  return process.env.DEMO_MODE === "true" && !process.env.GOOGLE_CLIENT_ID && !process.env.GOOGLE_CLIENT_SECRET;
}

function secret(): string | null {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  return isDemo() ? DEMO_SECRET : null;
}

function key(purpose: "enc" | "mac"): Buffer {
  const s = secret();
  if (!s) throw new Error("SESSION_SECRET is not set (32+ characters)");
  return createHash("sha256").update(`${purpose}:${s}`).digest();
}

/** Whether "Sign in with Google" can work: client and secret are all set. */
export function googleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && secret());
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key("enc"), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(sealed: string): string {
  const [iv, tag, data] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key("enc"), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function sign(value: string): string {
  return createHmac("sha256", key("mac")).update(value).digest("base64url");
}

/**
 * Ties a session to one Google account, so a cookie can't outlive the person
 * it was made for: if they leave and someone with the same name (and so the
 * same id) joins later, the old cookie doesn't work for the newcomer.
 */
export function identityTag(googleSubOrEmail: string): string {
  return createHash("sha256").update(`who:${googleSubOrEmail}`).digest("base64url").slice(0, 16);
}

export type SessionClaims = { userId: string; version: number; tag: string };

/**
 * Cookie value for a signed-in user: `<id>.<version>.<tag>.<expiry>.<signature>`.
 * `version` is the user's session_version: bumping it ends every session.
 */
export function sessionValue(user: {
  id: string;
  session_version: number;
  google_sub: string | null;
  email: string;
}): { value: string; maxAge: number } {
  const maxAge = SESSION_DAYS * 86_400;
  const tag = identityTag(user.google_sub ?? user.email);
  const payload = `${user.id}.${user.session_version}.${tag}.${Date.now() + maxAge * 1000}`;
  return { value: `${payload}.${sign(payload)}`, maxAge };
}

/** Checks signature and expiry only; viewer.ts checks the claims against the database. */
export function verifySession(value: string | undefined): SessionClaims | null {
  if (!value || !secret()) return null;
  const at = value.lastIndexOf(".");
  if (at < 0) return null;
  const payload = value.slice(0, at);
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(value.slice(at + 1));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  // Ids are slugs (no dots); take the other fields from the right to be safe.
  const parts = payload.split(".");
  if (parts.length < 4) return null;
  const expires = Number(parts.pop());
  const tag = parts.pop()!;
  const version = Number(parts.pop());
  const userId = parts.join(".");
  if (!userId || !Number.isInteger(version) || !(expires > Date.now())) return null;
  return { userId, version, tag };
}

export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: secureCookies(),
    path: "/",
    maxAge,
  };
}

/**
 * https-only cookies, unless the app is plainly served over http: APP_URL
 * says http://, or it's unset on a dev server (`npm run dev`, the demo).
 */
function secureCookies(): boolean {
  const url = process.env.APP_URL ?? "";
  if (url.startsWith("https://")) return true;
  if (url.startsWith("http://")) return false;
  return process.env.NODE_ENV === "production";
}
