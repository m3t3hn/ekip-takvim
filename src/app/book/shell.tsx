"use client";

import { Copy } from "lucide-react";
import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { Button, Input, LogoMark, cn, useCopy } from "@/components/ui";
import { prefersHour12, type VisitorClock } from "./clock";

// What the booking pages share: the page around them, their cards, the box
// with a booking's cancel link, and the visitor's own clock, which every time
// on them is shown on.

const noChange = () => () => {};

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** The browser's 12- or 24-hour preference, read once: it doesn't change while the page is open. */
let browserHour12: boolean | undefined;
const readHour12 = () => (browserHour12 ??= prefersHour12());

/** The visitor's clock (see VisitorClock); null while the page is rendered on the server, which doesn't know it. */
export function useVisitorClock(): VisitorClock | null {
  const zone = useSyncExternalStore(noChange, browserZone, () => null);
  const hour12 = useSyncExternalStore(noChange, readHour12, () => null);
  return useMemo(() => (zone === null || hour12 === null ? null : { zone, hour12 }), [zone, hour12]);
}

/** The page's own address, without a query or a fragment; null while it's rendered on the server. */
export function usePageAddress(): string | null {
  return useSyncExternalStore(noChange, () => window.location.origin + window.location.pathname, () => null);
}

export function BookShell({ children }: { children: ReactNode }) {
  return (
    <main className="scrollbar-thin h-full overflow-y-auto bg-chrome">
      <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-8 sm:py-12">
        {children}
        <p className="mt-2 flex items-center justify-center gap-1.5 font-body text-xs text-fg-3">
          <LogoMark className="size-4" /> Ekip Takvim
        </p>
      </div>
    </main>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("rounded-2xl bg-surface p-5 shadow-[var(--shadow-raised)] sm:p-6", className)}>{children}</section>;
}

/** A page with one short message, such as a link that doesn't work. `status` has it announced, as for "Loading…". */
export function Message({ children, status = false }: { children: ReactNode; status?: boolean }) {
  return (
    <BookShell>
      <Card>
        <p role={status ? "status" : undefined} className="font-body text-sm text-fg">
          {children}
        </p>
      </Card>
    </BookShell>
  );
}

/**
 * A booking's cancel link, `url`, which is the address of the page it's shown
 * on: the visitor keeps it to cancel later, and Copy copies it.
 */
export function KeepLink({ url }: { url: string }) {
  const copy = useCopy();
  return (
    <div className="mt-5 rounded-xl bg-surface-2 p-4">
      <h2 className="text-sm font-semibold text-fg">Keep this link to cancel</h2>
      <p className="mt-1 font-body text-xs text-fg-2">
        This page&apos;s address is your cancel link: keep it, or bookmark this page. Anyone who has it can cancel the booking.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Input
          readOnly
          aria-label="Cancel link"
          value={url}
          onFocus={(e) => e.target.select()}
          className="min-w-0 flex-1 basis-60 max-sm:h-11"
        />
        <Button variant="tonal" onClick={() => copy(url, "Cancel link copied")} className="max-sm:h-11">
          <Copy className="size-4" aria-hidden /> Copy
        </Button>
      </div>
    </div>
  );
}
