import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { bookingAllowed } from "@/lib/server/booking-setting";
import { CancelPage } from "./cancel-page";

// A booking's cancel link, which is also its confirmation's address, for
// whoever has it: no sign-in. Everything on it comes from
// /api/book/cancel/[token].
export const dynamic = "force-dynamic";

// The title stays general: it never shows the booking. The address is a
// secret, so no request from the page carries it as the Referer.
export const metadata: Metadata = {
  title: "Cancel a booking · Ekip Takvim",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function Page({ params }: PageProps<"/book/cancel/[token]">) {
  // While booking links are off, 404, as /api/book/cancel/ answers.
  if (!bookingAllowed()) notFound();
  return <CancelPage token={(await params).token} />;
}
