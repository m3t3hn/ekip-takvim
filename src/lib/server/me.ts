import type { MySettings } from "@/lib/types";
import { getUser, listCalendars, takenColors } from "./db";

/** The settings page's view of one person. Calendar ids and names only ever go to their owner. */
export function mySettings(userId: string): MySettings | null {
  const u = getUser(userId);
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    team: u.team,
    timezone: u.timezone,
    color: u.color,
    takenColors: takenColors(u.id),
    missingCalendarAccess: !u.calendar_access,
    tokenError: u.token_error,
    syncError: u.sync_error,
    calendars: listCalendars(userId).map((c) => ({
      id: c.calendar_id,
      summary: c.summary,
      label: c.label,
      included: !!c.included,
      primary: !!c.is_primary,
      access: c.access,
      state: c.error ? "error" : c.last_success ? "ok" : "pending",
      error: c.error,
      lastSuccess: c.last_success,
      isNew: !c.seen,
    })),
  };
}
