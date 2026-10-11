import { cookies } from "next/headers";
import { App } from "@/components/app";
import { getSettings } from "@/lib/server/sync";
import { currentViewer } from "@/lib/server/viewer";
import { currentDayKey, isTimeZone, serverTime } from "@/lib/time";

// Reads config at request time; never prerender.
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: PageProps<"/">) {
  const settings = getSettings(await currentViewer());
  // The browser remembers the viewer's zone in a cookie, so the first render
  // already shows their times; on a first visit it's the team's zone.
  const saved = (await cookies()).get("tz")?.value;
  const zone = saved && isTimeZone(decodeURIComponent(saved)) ? decodeURIComponent(saved) : settings.timezone;
  const query = await searchParams;
  const initialQuery = Object.fromEntries(
    Object.entries(query).flatMap(([k, v]) =>
      typeof v === "string" ? [[k, v]] : [],
    ),
  );
  return (
    <App
      settings={settings}
      today={currentDayKey(zone)}
      serverZone={zone}
      serverNow={serverTime()}
      initialQuery={initialQuery}
    />
  );
}
