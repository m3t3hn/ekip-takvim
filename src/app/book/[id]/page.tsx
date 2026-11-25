import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { bookingAllowed } from "@/lib/server/booking-setting";
import { openLink } from "@/lib/server/bookings";
import { BookingPage } from "./booking-page";

// A booking link's page, for anyone who has the link: no sign-in. Everything
// on it comes from /api/book/[id], but its title.
export const dynamic = "force-dynamic";

/**
 * A link that can be booked is titled "<its title> with <its host's name>",
 * which is what a chat app shows when it previews the link: such previewers
 * get it in the page's <head>, as Next waits for it for HTML-limited bots
 * (htmlLimitedBots). Every other link keeps the same general title, so the
 * title can't tell a missing link, one that's off and one whose host left
 * apart. No search engine lists the page, and no request from it carries its
 * address as the Referer.
 */
export async function generateMetadata({ params }: PageProps<"/book/[id]">): Promise<Metadata> {
  const open = openLink((await params).id);
  return {
    title: open ? `${open.link.title} with ${open.host.name}` : "Book a time · Ekip Takvim",
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default async function Page({ params }: PageProps<"/book/[id]">) {
  // While booking links are off, 404, as /api/book/ answers.
  if (!bookingAllowed()) notFound();
  return <BookingPage id={(await params).id} />;
}
