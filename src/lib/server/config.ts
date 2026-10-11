import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { WorkingHours } from "@/lib/types";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

const WorkingHoursSchema = z
  .object({
    /** Defaults to the team timezone. */
    timezone: z.string().optional(),
    start: z.number().min(0).max(23.75).default(9),
    end: z.number().min(0.25).max(24).default(17),
    days: z.array(z.enum(WEEKDAYS)).min(1).default(["mon", "tue", "wed", "thu", "fri"]),
  })
  .refine((h) => h.end > h.start, "end must be after start");

const ZoneSchema = z.object({
  label: z.string().trim().min(1).max(20),
  zone: z.string(),
});

const ConfigSchema = z.object({
  /** Defaults to the server's zone (TZ), which is UTC in a plain container. */
  timezone: z.string().optional(),
  refresh_minutes: z.number().int().min(1).max(1440).default(10),
  horizon_days: z.number().int().min(7).max(366).default(60),
  display_hours: z
    .object({
      start: z.number().int().min(0).max(23),
      end: z.number().int().min(1).max(24),
    })
    .refine((h) => h.end > h.start, "end must be after start")
    .default({ start: 8, end: 22 }),
  week_starts_on: z.enum(["monday", "sunday"]).default("monday"),
  working_hours: WorkingHoursSchema.default({ start: 9, end: 17, days: ["mon", "tue", "wed", "thu", "fri"] }),
  /** Defaults to just the team timezone. */
  timezones: z.array(ZoneSchema).min(1).max(6).optional(),
  /** Teams people can pick for themselves in their settings. */
  teams: z.array(z.string().trim().min(1).max(40)).default([]),
  /** Only Google accounts on this domain may sign in, e.g. example.com. */
  google_domain: z.string().trim().toLowerCase().optional(),
});

export type AppConfig = {
  timezone: string;
  refreshMinutes: number;
  horizonDays: number;
  displayHours: { start: number; end: number };
  weekStartsOn: 0 | 1;
  workingHours: WorkingHours;
  /** Zones shown side by side in the UI, e.g. London, Berlin, Istanbul. */
  timezones: { label: string; zone: string }[];
  teams: string[];
  googleDomain: string | null;
};

export class ConfigError extends Error {}

const TURKISH: Record<string, string> = {
  ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u",
};

export function slugify(name: string): string {
  return name
    .toLocaleLowerCase("tr")
    .replace(/[çğıöşü]/g, (c) => TURKISH[c])
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The server's own zone: TZ if it's set, else the system's (UTC in a plain container). */
function serverTimezone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz && validTimezone(tz) ? tz : "UTC";
}

/** "Europe/Istanbul" → "Istanbul", "America/New_York" → "New York". */
function zoneLabel(zone: string): string {
  return (zone.split("/").pop() ?? zone).replace(/_/g, " ").slice(0, 20);
}

/** Validate a parsed YAML document. */
export function buildConfig(doc: unknown): AppConfig {
  if (doc && typeof doc === "object" && "people" in doc) {
    throw new ConfigError(
      "Invalid config — people aren't listed in the config any more: everyone signs in with Google and picks their team. Remove people: and list the team names under teams:",
    );
  }
  const result = ConfigSchema.safeParse(doc ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`Invalid config — ${issues}`);
  }
  const raw = result.data;
  const timezone = raw.timezone ?? serverTimezone();
  const timezones = raw.timezones ?? [{ label: zoneLabel(timezone), zone: timezone }];
  const problems: string[] = [];
  const checkZone = (zone: string | undefined, where: string) => {
    if (zone !== undefined && !validTimezone(zone)) problems.push(`${where}: unknown timezone "${zone}"`);
  };
  checkZone(raw.timezone, "timezone");
  checkZone(raw.working_hours.timezone, "working_hours");
  timezones.forEach((z, i) => checkZone(z.zone, `timezones.${i}`));
  if (new Set(raw.teams).size !== raw.teams.length) problems.push("teams: a team is listed twice");
  if (problems.length > 0) {
    throw new ConfigError(`Invalid config — ${problems.join("; ")}`);
  }

  return {
    timezone,
    refreshMinutes: raw.refresh_minutes,
    horizonDays: raw.horizon_days,
    displayHours: raw.display_hours,
    weekStartsOn: raw.week_starts_on === "sunday" ? 0 : 1,
    workingHours: {
      timezone: raw.working_hours.timezone ?? timezone,
      start: raw.working_hours.start,
      end: raw.working_hours.end,
      days: WEEKDAYS.flatMap((d, i) => (raw.working_hours.days.includes(d) ? [i] : [])),
    },
    timezones,
    teams: raw.teams,
    googleDomain: raw.google_domain ?? null,
  };
}

export function configPath(): string {
  // Runtime-only path: keep the bundler from tracing (and shipping) the whole
  // project, which would include a local config/app.yaml.
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.CONFIG_PATH || "config/app.yaml");
}

/** Cheap change detector so the sync loop can hot-reload the file. */
export function configVersion(): string {
  if (process.env.CONFIG_YAML) return `inline:${process.env.CONFIG_YAML.length}`;
  try {
    const s = statSync(configPath());
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}

/** Where the config comes from, for the start-up log. */
export function configSource(): string {
  if (process.env.CONFIG_YAML) return "CONFIG_YAML";
  return existsSync(configPath()) ? configPath() : "defaults (no config file)";
}

export function loadConfig(): AppConfig {
  const inline = process.env.CONFIG_YAML;
  if (inline) return parseConfig(inline);
  return loadConfigFile(configPath(), Boolean(process.env.CONFIG_PATH));
}

/**
 * The file is optional: without it the defaults apply. A file that CONFIG_PATH
 * names has to exist, though, since a typo there would quietly drop the settings.
 */
export function loadConfigFile(file: string, required: boolean): AppConfig {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    if (missing && !required) return buildConfig({});
    throw new ConfigError(missing ? `No config file at ${file} (set by CONFIG_PATH)` : `Couldn't read the config file ${file}`);
  }
  return parseConfig(text);
}

function parseConfig(text: string): AppConfig {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    // Keep the message short; yaml's own quotes the offending line.
    const line = (err as { linePos?: { line: number }[] }).linePos?.[0]?.line;
    throw new ConfigError(`Config is not valid YAML${line ? ` (line ${line})` : ""}`);
  }
  return buildConfig(doc);
}
