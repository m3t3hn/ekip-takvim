// Shared by the calendar link tests: a calendar server on 127.0.0.1, iCalendar
// text, a fence that routes one public address to that server, and a record of
// every console line. No test reaches the network.
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { inspect } from "node:util";
import { vi } from "vitest";

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** The UTC day `days` from today, as YYYYMMDD. */
export function utcDay(days: number, from = Date.now()): string {
  return new Date(from + days * DAY_MS).toISOString().slice(0, 10).replace(/-/g, "");
}

/** Midnight UTC of a YYYYMMDD day, in ms. */
export function utcMidnight(day: string): number {
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)));
}

export function vevent(uid: string, summary: string, start: string, end: string, extra: string[] = []): string[] {
  return ["BEGIN:VEVENT", `UID:${uid}`, `SUMMARY:${summary}`, start, end, ...extra, "END:VEVENT"];
}

export function calendarText(...events: string[][]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ekip-takvim//link tests//EN", ...events.flat(), "END:VCALENDAR", ""].join("\r\n");
}

export type Hit = { url: string; headers: IncomingHttpHeaders };
export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export type CalendarServer = {
  port: number;
  /** http://127.0.0.1:<port> */
  origin: string;
  /** Every request, in order. */
  hits: Hit[];
  /** What the server does with the next requests. */
  handle: (handler: Handler) => void;
  close: () => Promise<void>;
};

export async function calendarServer(): Promise<CalendarServer> {
  const hits: Hit[] = [];
  let handler: Handler = (_req, res) => {
    res.statusCode = 404;
    res.end("nothing here");
  };
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url ?? "", headers: req.headers });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    hits,
    handle: (next) => {
      handler = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A port nothing listens on. */
export async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Connections to `publicIp` go to 127.0.0.1:`port` instead; a connection to any
 * other address that isn't loopback throws. Returns the undo.
 */
export function routePublicAddress(publicIp: string, port: number): () => void {
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const options = (Array.isArray(args[0]) ? args[0][0] : args[0]) as { host?: string; port?: number; path?: string | null } | undefined;
    if (!options || typeof options !== "object") throw new Error("test fence: unexpected connect call");
    if (options.path == null) {
      const host = options.host ?? "localhost";
      if (host === publicIp) {
        options.host = "127.0.0.1";
        options.port = port;
      } else if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
        throw new Error(`test fence: no connection to ${host}`);
      }
    }
    return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  return () => {
    net.Socket.prototype.connect = realConnect;
  };
}

/** Every console line from now on, as text; nothing is printed. */
export function captureConsole(): string[] {
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 5 }))).join(" "));
    });
  }
  return lines;
}

/** Google, as the sync sees it through fetch: every refresh token is refused (access revoked). Records each call. */
export function googleRefusesEveryToken(): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    throw new TypeError(`test: no network (${new URL(url).host})`);
  });
  return calls;
}
