import { LogIn } from "lucide-react";
import { redirect } from "next/navigation";
import { LogoMark } from "@/components/ui";
import { listPeople } from "@/lib/server/db";
import { googleConfigured, isDemo } from "@/lib/server/secrets";
import { getSettings } from "@/lib/server/sync";
import { currentViewer } from "@/lib/server/viewer";

// Where people land when the app is exposed and they aren't signed in.
export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in · Ekip Takvim" };

const REASONS: Record<string, string> = {
  unavailable: "Sign-in isn't available right now. Ask whoever runs this app.",
  cancelled: "Sign-in cancelled.",
  expired: "That sign-in took too long or came from another tab. Try again.",
  domain: "Only company Google accounts can sign in.",
  failed: "Google sign-in didn't work. Try again.",
};

export default async function SignIn({ searchParams }: PageProps<"/sign-in">) {
  if (await currentViewer()) redirect("/");
  const reason = (await searchParams).signin;
  const message = typeof reason === "string" ? REASONS[reason] : undefined;
  // Anyone can open this page, so a broken config is only named in the log.
  const broken = getSettings(null).configError !== null;

  return (
    <main className="grid min-h-full place-items-center overflow-y-auto px-4 py-10">
      <div className="flex w-full max-w-sm flex-col items-center rounded-3xl bg-surface px-8 py-10 text-center shadow-[var(--shadow-card)]">
        <LogoMark className="size-14" />
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-fg">Ekip Takvim</h1>
        <p className="mt-2 font-body text-sm text-fg-2">
          Who&apos;s free when, across everyone&apos;s calendars. Sign in with your company Google account to see the
          team&apos;s calendar and add your own.
        </p>

        {message && (
          <p role="alert" className="mt-5 w-full rounded-xl bg-danger-container px-3 py-2 font-body text-sm text-fg">
            {message}
          </p>
        )}

        {broken ? (
          <p className="mt-6 font-body text-sm text-fg-2">
            This app isn&apos;t set up correctly yet. Whoever runs it can see why in its log.
          </p>
        ) : isDemo() ? (
          <div className="mt-6 w-full text-left">
            <p className="font-body text-xs font-medium text-fg-3">Demo: sign in as one of the made-up people</p>
            <ul className="mt-2 flex flex-col gap-1">
              {listPeople().map((p) => (
                <li key={p.id}>
                  <a
                    href={`/auth/demo?as=${encodeURIComponent(p.id)}`}
                    className="block rounded-lg px-3 py-2 font-body text-sm text-fg hover:bg-hover"
                  >
                    {p.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : googleConfigured() ? (
          <a
            href="/auth/google"
            className="mt-6 inline-flex h-11 items-center gap-2 rounded-full bg-accent px-6 text-sm font-semibold text-on-accent hover:brightness-110"
          >
            <LogIn className="size-4" aria-hidden /> Sign in with Google
          </a>
        ) : (
          <p className="mt-6 font-body text-sm text-fg-2">Google sign-in isn&apos;t set up on this server yet.</p>
        )}

        <p className="mt-6 font-body text-xs text-fg-3">
          The app only reads your calendars. You choose which ones count on your settings page.
        </p>
      </div>
    </main>
  );
}
