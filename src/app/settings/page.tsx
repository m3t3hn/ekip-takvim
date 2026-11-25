import { redirect } from "next/navigation";
import { SettingsView } from "@/components/settings-view";
import { bookingAllowed } from "@/lib/server/booking-setting";
import { myBookingLinks } from "@/lib/server/bookings";
import { buildConfig } from "@/lib/server/config";
import { mySettings } from "@/lib/server/me";
import { isDemo } from "@/lib/server/secrets";
import { sessionUserId } from "@/lib/server/viewer";
import { getConfig } from "@/lib/server/sync";
import { serverTime } from "@/lib/time";

export const dynamic = "force-dynamic";

export const metadata = { title: "My settings · Ekip Takvim" };

/** Hours of the day as minutes, on the quarter hour. */
const quarterMinutes = (hours: number) => Math.min(1440, Math.max(0, Math.round(hours * 4) * 15));

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const id = await sessionUserId();
  const me = id ? mySettings(id) : null;
  if (!me) redirect("/");
  // How Allow access went, when it just sent them back here (see the sign-in callback).
  const { access } = await searchParams;
  const config = getConfig();
  const zones = config?.timezones ?? [];
  // Configured zones first, then every zone the runtime knows.
  const all = Intl.supportedValuesOf("timeZone");
  // A new booking link starts with the company's working hours.
  const { workingHours, horizonDays } = config ?? buildConfig({});
  return (
    <SettingsView
      initial={me}
      teams={config?.teams ?? []}
      zones={zones}
      allZones={all.includes(me.timezone) ? all : [me.timezone, ...all]}
      demo={isDemo()}
      serverNow={serverTime()}
      booking={
        bookingAllowed()
          ? {
              initial: myBookingLinks(me.id),
              hours: { startMin: quarterMinutes(workingHours.start), endMin: quarterMinutes(workingHours.end) },
              horizonDays,
              // Copied links start with APP_URL, as cancel links do; null: the page's own address.
              base: process.env.APP_URL?.trim().replace(/\/+$/, "") || null,
              access: typeof access === "string" ? access : null,
            }
          : null
      }
    />
  );
}
