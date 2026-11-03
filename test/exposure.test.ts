import { afterEach, describe, expect, it } from "vitest";
import { exposureProblem, exposureSetting, gate } from "@/lib/server/exposure";

describe("EXPOSURE", () => {
  afterEach(() => {
    delete process.env.EXPOSURE;
  });

  it("is internal unless set to exposed, and refuses anything else", () => {
    expect(exposureSetting()).toBe("internal");
    process.env.EXPOSURE = " Exposed ";
    expect(exposureSetting()).toBe("exposed");
    process.env.EXPOSURE = "public";
    expect(exposureSetting()).toBe("invalid");
  });
});

describe("the sign-in gate", () => {
  it("lets everything through when internal, or once signed in", () => {
    expect(gate("/", "internal", false)).toBe("pass");
    expect(gate("/api/availability", "internal", false)).toBe("pass");
    expect(gate("/", "exposed", true)).toBe("pass");
    expect(gate("/api/availability", "exposed", true)).toBe("pass");
  });

  it("sends pages to sign in and refuses APIs when exposed", () => {
    for (const page of ["/", "/settings", "/healthzz", "/auth/google/elsewhere"]) expect(gate(page, "exposed", false)).toBe("sign-in");
    for (const api of ["/api/availability", "/api/status", "/api/me", "/api/events/x"]) expect(gate(api, "exposed", false)).toBe("unauthorized");
  });

  it("keeps signing in, signing out and the health check open", () => {
    for (const open of ["/sign-in", "/healthz", "/auth/google", "/auth/google/callback", "/auth/demo", "/auth/logout"]) {
      expect(gate(open, "exposed", false)).toBe("pass");
    }
  });
});

describe("an exposed setup", () => {
  it("needs a sign-in domain and https", () => {
    expect(exposureProblem(null, "https://calendar.example.com")).toMatch(/google_domain/);
    expect(exposureProblem("example.com", "http://calendar.example.com")).toMatch(/https/);
    expect(exposureProblem("example.com", undefined)).toMatch(/https/);
    expect(exposureProblem("example.com", "https://calendar.example.com")).toBeNull();
  });

  it("can be tried out on this machine over http", () => {
    expect(exposureProblem("example.com", "http://localhost:3000")).toBeNull();
    expect(exposureProblem("example.com", "http://127.0.0.1:3000/")).toBeNull();
    expect(exposureProblem("example.com", "http://localhost.example.net")).toMatch(/https/);
  });

  it("serves nothing when it isn't safe", async () => {
    process.env.EXPOSURE = "exposed";
    process.env.CONFIG_YAML = "timezone: UTC";
    process.env.APP_URL = "https://calendar.example.com";
    process.env.DATABASE_PATH = ":memory:";
    const { getSettings } = await import("@/lib/server/sync");
    const settings = getSettings(null);
    expect(settings.configError).toMatch(/google_domain/);
    expect(settings.people).toEqual([]);
  });
});
