import { redirect } from "next/navigation";
import { SettingsView } from "@/components/settings-view";
import { mySettings } from "@/lib/server/me";
import { isDemo } from "@/lib/server/secrets";
import { sessionUserId } from "@/lib/server/viewer";
import { getConfig } from "@/lib/server/sync";
import { serverTime } from "@/lib/time";

export const dynamic = "force-dynamic";

export const metadata = { title: "My settings · Ekip Takvim" };

export default async function SettingsPage() {
  const id = await sessionUserId();
  const me = id ? mySettings(id) : null;
  if (!me) redirect("/");
  const config = getConfig();
  const zones = config?.timezones ?? [];
  // Configured zones first, then every zone the runtime knows.
  const all = Intl.supportedValuesOf("timeZone");
  return (
    <SettingsView
      initial={me}
      teams={config?.teams ?? []}
      zones={zones}
      allZones={all.includes(me.timezone) ? all : [me.timezone, ...all]}
      demo={isDemo()}
      serverNow={serverTime()}
    />
  );
}
