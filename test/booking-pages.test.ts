import { notFound } from "next/navigation";
import { isValidElement, type ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

// Booking links, run 2026-11-19-ekip-booking-1b, criterion 2: while
// BOOKING_LINKS isn't on, the pages /book/[id] and /book/cancel/[token] answer
// 404 as the API routes do: their server components call notFound(), so Next's
// not-found error is thrown. While it's on, they render as before: the booking
// page for the id, the cancel page for the token. The components are called as
// Next calls them, with their params as a promise.

const { default: BookRoute } = await import("@/app/book/[id]/page");
const { default: CancelRoute } = await import("@/app/book/cancel/[token]/page");
const { BookingPage } = await import("@/app/book/[id]/booking-page");
const { CancelPage } = await import("@/app/book/cancel/[token]/cancel-page");

/** What notFound() throws: Next's not-found error. */
const NOT_FOUND_ERROR = (() => {
  try {
    notFound();
  } catch (error) {
    return error as Error & { digest?: string };
  }
  throw new Error("notFound() didn't throw");
})();

const ID = "Ab3dE5gH7jK9mN1pQ3sT5v";
const TOKEN = "Zy8xW6vU4tS2rQ0pO8nM6lK4jI2hG0fE";
const book = () => BookRoute({ params: Promise.resolve({ id: ID }) } as never);
const cancel = () => CancelRoute({ params: Promise.resolve({ token: TOKEN }) } as never);

function set(value: string | undefined) {
  if (value === undefined) delete process.env.BOOKING_LINKS;
  else process.env.BOOKING_LINKS = value;
}
afterEach(() => {
  delete process.env.BOOKING_LINKS;
});

const NOT_ON = [undefined, "", "   ", "off", "OFF", " Off ", "maybe", "true", "1", "yes", "on off"];
const ON = ["on", "ON", " On ", "\ton\n"];

describe("while BOOKING_LINKS isn't on", () => {
  for (const value of NOT_ON) {
    it(`/book/[id] calls notFound() (BOOKING_LINKS=${JSON.stringify(value)})`, async () => {
      set(value);
      const error = await book().then(
        (rendered) => {
          throw new Error(`rendered ${String((rendered as ReactElement)?.type)} instead of calling notFound()`);
        },
        (e: unknown) => e as Error & { digest?: string },
      );
      expect(error).toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
      expect(error.digest).toBe(NOT_FOUND_ERROR.digest);
      expect(error.message).toBe(NOT_FOUND_ERROR.message);
    });

    it(`/book/cancel/[token] calls notFound() (BOOKING_LINKS=${JSON.stringify(value)})`, async () => {
      set(value);
      const error = await cancel().then(
        (rendered) => {
          throw new Error(`rendered ${String((rendered as ReactElement)?.type)} instead of calling notFound()`);
        },
        (e: unknown) => e as Error & { digest?: string },
      );
      expect(error).toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
      expect(error.digest).toBe(NOT_FOUND_ERROR.digest);
      expect(error.message).toBe(NOT_FOUND_ERROR.message);
    });
  }
});

describe("while BOOKING_LINKS is on", () => {
  for (const value of ON) {
    it(`/book/[id] renders the booking page for the id (BOOKING_LINKS=${JSON.stringify(value)})`, async () => {
      set(value);
      const rendered = (await book()) as ReactElement<{ id: string }>;
      expect(isValidElement(rendered)).toBe(true);
      expect(rendered.type).toBe(BookingPage);
      expect(rendered.props).toEqual({ id: ID });
    });

    it(`/book/cancel/[token] renders the cancel page for the token (BOOKING_LINKS=${JSON.stringify(value)})`, async () => {
      set(value);
      const rendered = (await cancel()) as ReactElement<{ token: string }>;
      expect(isValidElement(rendered)).toBe(true);
      expect(rendered.type).toBe(CancelPage);
      expect(rendered.props).toEqual({ token: TOKEN });
    });
  }
});
