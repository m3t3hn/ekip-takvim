import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

// Behind Cloudflare Access, Access adds a signed token (Cf-Access-Jwt-Assertion)
// to every request it lets through. Requiring it means nobody can get around
// Access by reaching the server some other way. Off unless
// CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are set.

export type AccessCheck = { issuer: string; audience: string; keys: JWTVerifyGetKey };

let cached: { from: string; check: AccessCheck } | null = null;

/** The check to run: null when it's off, "incomplete" when only one of the two is set. */
export function accessCheck(): AccessCheck | "incomplete" | null {
  const team = (process.env.CF_ACCESS_TEAM_DOMAIN ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const audience = (process.env.CF_ACCESS_AUD ?? "").trim();
  if (!team && !audience) return null;
  if (!team || !audience) return "incomplete";
  const from = `${team} ${audience}`;
  if (cached?.from !== from) {
    const issuer = `https://${team}`;
    // Cloudflare rotates its signing keys; jose fetches them again when a token uses a new one.
    const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    cached = { from, check: { issuer, audience, keys } };
  }
  return cached.check;
}

/** Whether the token is one Access issued for this app, and still valid. */
export async function validAccessToken(token: string | null, check: AccessCheck): Promise<boolean> {
  if (!token) return false;
  try {
    await jwtVerify(token, check.keys, { issuer: check.issuer, audience: check.audience, algorithms: ["RS256"] });
    return true;
  } catch (err) {
    const reason = (err as { code?: string }).code ?? String(err);
    console.warn(JSON.stringify({ level: "warn", msg: "Cloudflare Access token rejected", scope: "access", reason }));
    return false;
  }
}
