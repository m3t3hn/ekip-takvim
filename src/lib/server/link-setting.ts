import { isDemo } from "./secrets";

// Calendar links, from CALENDAR_LINKS. People paste the secret ICS address of a
// calendar that isn't on Google, and the server reads it like their Google
// calendars. That makes the server fetch an address someone typed, so:
// - on (the default): only addresses on the public internet;
// - private: private and local addresses too, for a calendar server on your own
//   network, such as a self-hosted Nextcloud;
// - off: no new links, and the ones already added are neither read nor counted.
// Any other value acts as off, and the start-up log says so. The demo takes
// links only when CALENDAR_LINKS is set.

export type LinksSetting = "on" | "private" | "off";

/** The CALENDAR_LINKS setting; anything but the three values is "invalid", which acts as off. */
export function linksSetting(): LinksSetting | "invalid" {
  const value = (process.env.CALENDAR_LINKS ?? "").trim().toLowerCase();
  if (value === "" || value === "on") return "on";
  if (value === "private" || value === "off") return value;
  return "invalid";
}

/** Whether this server takes calendar links, and reads and counts the ones people added. */
export function linksAllowed(): boolean {
  const setting = linksSetting();
  if (setting !== "on" && setting !== "private") return false;
  // The demo's made-up people get links only when they're asked for.
  return !isDemo() || (process.env.CALENDAR_LINKS ?? "").trim() !== "";
}

/** Whether a calendar link may reach private and local addresses. */
export function privateLinksAllowed(): boolean {
  return linksSetting() === "private";
}

/** The setting in words, for the start-up log. */
export function linksCheck(): string {
  const setting = linksSetting();
  if (setting === "invalid") return "calendar links off: CALENDAR_LINKS must be on, private or off";
  if (setting === "off") return "calendar links off (CALENDAR_LINKS=off)";
  if (!linksAllowed()) return "calendar links off in the demo (set CALENDAR_LINKS to try them)";
  return setting === "private"
    ? "calendar links to any address, private ones too (CALENDAR_LINKS=private)"
    : "calendar links to public addresses only";
}
