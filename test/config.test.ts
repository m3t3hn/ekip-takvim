import { describe, expect, it } from "vitest";
import { buildConfig, loadConfig, loadConfigFile, slugify } from "@/lib/server/config";

describe("config", () => {
  it("applies defaults: the server's zone, 9 to 5 on weekdays", () => {
    const config = buildConfig({});
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(config.timezone).toBe(zone);
    expect(config.displayHours).toEqual({ start: 8, end: 22 });
    expect(config.weekStartsOn).toBe(1);
    expect(config.workingHours).toEqual({ timezone: zone, start: 9, end: 17, days: [1, 2, 3, 4, 5] });
    expect(config.timezones).toEqual([{ label: zone.split("/").pop()!.replace(/_/g, " "), zone }]);
    expect(config.teams).toEqual([]);
    expect(config.googleDomain).toBeNull();
  });

  it("shows the team's own zone when no clocks are listed", () => {
    expect(buildConfig({ timezone: "America/New_York" }).timezones).toEqual([{ label: "New York", zone: "America/New_York" }]);
  });

  it("reads teams, the sign-in domain and working hours", () => {
    const config = buildConfig({
      teams: ["Design", "Engineering"],
      google_domain: "Example.COM",
      working_hours: { start: 9.5, end: 17, days: ["mon", "sun"] },
    });
    expect(config.teams).toEqual(["Design", "Engineering"]);
    expect(config.googleDomain).toBe("example.com");
    expect(config.workingHours).toMatchObject({ start: 9.5, end: 17, days: [0, 1] });
  });

  it("rejects unknown zones, duplicate teams and reversed hours", () => {
    expect(() => buildConfig({ timezone: "Mars/Olympus" })).toThrow(/unknown timezone "Mars\/Olympus"/);
    expect(() => buildConfig({ timezones: [{ label: "X", zone: "Mars/Base" }] })).toThrow(/timezones\.0/);
    expect(() => buildConfig({ teams: ["A", "A"] })).toThrow(/listed twice/);
    expect(() => buildConfig({ working_hours: { start: 18, end: 10 } })).toThrow(/end must be after start/);
  });

  it("explains that people are no longer listed in the config", () => {
    expect(() => buildConfig({ people: [] })).toThrow(/signs in with Google/);
  });

  it("runs on the defaults without a config file", () => {
    expect(loadConfigFile("does/not/exist.yaml", false)).toEqual(buildConfig({}));
  });

  it("insists on a file CONFIG_PATH names", () => {
    const saved = { path: process.env.CONFIG_PATH, yaml: process.env.CONFIG_YAML };
    process.env.CONFIG_PATH = "does/not/exist.yaml";
    delete process.env.CONFIG_YAML;
    try {
      expect(() => loadConfig()).toThrow(/No config file at .*CONFIG_PATH/);
    } finally {
      if (saved.path === undefined) delete process.env.CONFIG_PATH;
      else process.env.CONFIG_PATH = saved.path;
      if (saved.yaml !== undefined) process.env.CONFIG_YAML = saved.yaml;
    }
  });

  it("slugifies Turkish names", () => {
    expect(slugify("İrem Güneş")).toBe("irem-gunes");
    expect(slugify("Ozan Öztürk")).toBe("ozan-ozturk");
  });
});
