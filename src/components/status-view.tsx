"use client";

import { CircleAlert, CircleCheck, CircleDashed, RefreshCw } from "lucide-react";
import { docsUrl } from "@/lib/links";
import type { StatusResponse } from "@/lib/types";
import { Button, cn } from "./ui";

function ago(ts: number | null, now: number): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export function StatusView({
  status,
  now,
  onRefresh,
  syncing,
}: {
  status: { data: StatusResponse | null; error: string | null; loading: boolean };
  now: number;
  onRefresh: () => void;
  syncing: boolean;
}) {
  const data = status.data;
  const calendars = data?.calendars ?? [];
  const failing = calendars.filter((f) => f.state === "error").length;
  const ok = calendars.filter((f) => f.state === "ok").length;

  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-body text-sm text-fg-2">
            Calendars are read from Google with each person&apos;s own read-only access. Signed-in colleagues see the
            titles of company-calendar events (not private ones); personal calendars only show their label.
          </p>
          <Button variant="tonal" onClick={onRefresh} disabled={syncing}>
            <RefreshCw className={cn("size-4", syncing && "animate-spin")} aria-hidden />
            {syncing ? "Refreshing…" : "Refresh now"}
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Last sync" value={ago(data?.syncedAt ?? null, now)} />
          <Stat label="Calendars OK" value={`${ok} of ${calendars.length}`} />
          <Stat label="Failing" value={String(failing)} danger={failing > 0} />
        </div>

        {data?.configError && (
          <div className="flex gap-3 rounded-2xl bg-danger-container p-4 font-body text-sm text-fg">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
            {data.configError}
          </div>
        )}

        {data?.signInAgain.map((p) => (
          <div key={p.personId} className="flex gap-3 rounded-2xl bg-danger-container p-4 font-body text-sm text-fg">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
            <span>
              <span className="font-medium">{p.person}</span> needs to sign in again: {p.error}. Their calendars keep
              showing the last synced copy until then.
            </span>
          </div>
        ))}

        <div className="overflow-x-auto rounded-2xl border border-grid">
          <table className="w-full min-w-[720px] border-collapse text-left font-body text-sm">
            <thead>
              <tr className="border-b border-grid text-xs text-fg-3">
                <th className="px-5 py-3 font-medium">Person</th>
                <th className="px-3 py-3 font-medium">Calendar</th>
                <th className="px-3 py-3 font-medium">State</th>
                <th className="px-3 py-3 font-medium">Last good sync</th>
                <th className="px-3 py-3 font-medium">Read as</th>
                <th className="px-5 py-3 text-right font-medium">Busy blocks</th>
              </tr>
            </thead>
            <tbody>
              {calendars.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-fg-3">
                    {status.loading ? "Loading…" : status.error ?? "No one has signed in and picked their calendars yet."}
                  </td>
                </tr>
              )}
              {calendars.map((f, i) => (
                <tr key={`${f.personId}-${i}`} className="border-b border-grid last:border-b-0">
                  <td className="px-5 py-3 font-medium text-fg">
                    {i === 0 || calendars[i - 1].personId !== f.personId ? f.person : ""}
                  </td>
                  <td className="px-3 py-3 text-fg-2">
                    {f.label}
                  </td>
                  <td className="px-3 py-3">
                    {f.state === "ok" ? (
                      <span className="inline-flex items-center gap-1.5 text-on-free">
                        <CircleCheck className="size-4" aria-hidden /> OK
                      </span>
                    ) : f.state === "pending" ? (
                      <span className="inline-flex items-center gap-1.5 text-fg-3">
                        <CircleDashed className="size-4" aria-hidden /> Waiting
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-danger">
                        <CircleAlert className="size-4" aria-hidden /> {f.error}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-fg-2">{ago(f.lastSuccess, now)}</td>
                  <td
                    className="px-3 py-3 text-fg-2"
                    title={f.access === "freebusy" ? "Shared with their company account as “See only free/busy”" : undefined}
                  >
                    {f.access === "freebusy" ? "Free/busy only" : "Events"}
                  </td>
                  <td className="px-5 py-3 text-right text-fg-2">{f.events}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="font-body text-xs text-fg-3">
          A failing calendar keeps showing its last good copy. Usual causes: the calendar is no longer shared with the
          person&apos;s company account, or they removed this app&apos;s access in their Google account.
        </p>
        {data?.version && (
          <p className="font-body text-xs text-fg-3">
            Ekip Takvim {data.version} ·{" "}
            <a href={docsUrl()} target="_blank" rel="noreferrer" className="underline hover:text-fg-2">
              Documentation
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="rounded-2xl bg-surface-2 px-5 py-4">
      <div className="font-body text-xs text-fg-2">{label}</div>
      <div className={cn("mt-1 text-2xl text-fg", danger && "text-danger")}>{value}</div>
    </div>
  );
}
