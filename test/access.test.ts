import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { accessCheck, validAccessToken, type AccessCheck } from "@/lib/server/access";

const issuer = "https://your-team.cloudflareaccess.com";
const audience = "aud-of-ekip-takvim";

describe("Cloudflare Access tokens", () => {
  let check: AccessCheck;
  let accessKey: CryptoKey;
  let otherKey: CryptoKey;
  const sign = (claims: { iss?: string; aud?: string; exp?: number | string } = {}, key = accessKey) =>
    new SignJWT({ email: "ahmet@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(claims.iss ?? issuer)
      .setAudience(claims.aud ?? audience)
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? "1h")
      .sign(key);

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    accessKey = privateKey;
    otherKey = (await generateKeyPair("RS256")).privateKey;
    check = { issuer, audience, keys: createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] }) };
  });

  it("lets through a token Access issued for this app", async () => {
    expect(await validAccessToken(await sign(), check)).toBe(true);
  });

  it("turns away missing, foreign, expired and forged tokens", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await validAccessToken(null, check)).toBe(false);
    expect(await validAccessToken("not.a.token", check)).toBe(false);
    expect(await validAccessToken(await sign({ aud: "another-app" }), check)).toBe(false);
    expect(await validAccessToken(await sign({ iss: "https://someone-else.cloudflareaccess.com" }), check)).toBe(false);
    expect(await validAccessToken(await sign({ exp: Math.floor(Date.now() / 1000) - 60 }), check)).toBe(false);
    expect(await validAccessToken(await sign({}, otherKey), check)).toBe(false);
  });
});

describe("Cloudflare Access settings", () => {
  afterEach(() => {
    delete process.env.CF_ACCESS_TEAM_DOMAIN;
    delete process.env.CF_ACCESS_AUD;
  });

  it("is off unless set, and refuses half a setup", () => {
    expect(accessCheck()).toBeNull();
    process.env.CF_ACCESS_AUD = audience;
    expect(accessCheck()).toBe("incomplete");
  });

  it("takes the team domain with or without https://", () => {
    process.env.CF_ACCESS_AUD = audience;
    process.env.CF_ACCESS_TEAM_DOMAIN = "https://your-team.cloudflareaccess.com/";
    expect(accessCheck()).toMatchObject({ issuer, audience });
    process.env.CF_ACCESS_TEAM_DOMAIN = "your-team.cloudflareaccess.com";
    expect(accessCheck()).toMatchObject({ issuer, audience });
  });
});
