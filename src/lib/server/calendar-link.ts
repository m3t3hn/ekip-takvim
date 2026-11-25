import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";

// Reading a calendar link: the secret ICS address Outlook, iCloud, Proton,
// Nextcloud and others hand out. Anyone who can add a link can make the server
// fetch an address, so every host is looked up once, every address in the answer
// must be public, and the connection goes to an address from that same answer: a
// second lookup (the global fetch makes its own) could answer differently. The
// path and query of a link are its secret, so no error message carries them.

export type LinkFailure =
  | "invalid"
  | "blocked"
  | "unreachable"
  | "timeout"
  | "tooLarge"
  | "tooManyRedirects"
  | "http"
  | "notCalendar";

export class LinkError extends Error {
  readonly reason: LinkFailure;
  /** The HTTP status, when the reason is "http". */
  readonly status?: number;

  constructor(reason: LinkFailure, message: string, status?: number) {
    super(message);
    this.name = "LinkError";
    this.reason = reason;
    if (status !== undefined) this.status = status;
  }
}

export type LookupAddress = { address: string; family: number };

export type FetchCalendarOptions = {
  /** Resolves a host name, like dns.promises.lookup with { all: true }. */
  lookup?: (hostname: string, options: { all: true }) => LookupAddress[] | Promise<LookupAddress[]>;
  /** Let the link reach private and local addresses (tests, a self-hosted Nextcloud). */
  allowPrivate?: boolean;
  /** For the whole request, redirects included (default 20 s). */
  timeoutMs?: number;
  /** Largest body read (default 10 MB). */
  maxBytes?: number;
  /** From the last answer, to be told when nothing changed. */
  etag?: string | null;
  lastModified?: string | null;
};

export type CalendarFetch =
  | { notModified: true }
  | { notModified: false; text: string; etag: string | null; lastModified: string | null };

const MAX_LINK_LENGTH = 2048;
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const CALENDAR_START = /^\s*BEGIN:VCALENDAR/i;

/** A link as pasted, as a URL to fetch: webcal(s) becomes https, the #fragment goes. */
export function normalizeLink(raw: string): URL {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length > MAX_LINK_LENGTH) throw new LinkError("invalid", "That calendar link is too long");
  let url: URL;
  try {
    url = new URL(text.replace(/^webcals?:\/\//i, "https://"));
  } catch {
    throw new LinkError("invalid", "That isn't a calendar link");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LinkError("invalid", "A calendar link starts with https://, http:// or webcal://");
  }
  if (url.username || url.password) {
    throw new LinkError("invalid", "Calendar links with a user name or password aren't supported");
  }
  url.hash = "";
  if (url.href.length > MAX_LINK_LENGTH) throw new LinkError("invalid", "That calendar link is too long");
  return url;
}

/**
 * Whether an IP address is on the public internet: an IPv4 address outside
 * private, loopback, link-local, shared, documentation, benchmarking, multicast
 * and reserved space; an IPv6 address in global unicast space (2000::/3) outside
 * its special-purpose blocks, or an IPv4-mapped or IPv4-compatible form of a
 * public IPv4 address.
 */
export function isPublicAddress(ip: string): boolean {
  if (typeof ip !== "string") return false;
  const address = ip.trim().replace(/^\[(.*)\]$/, "$1").split("%")[0];
  const version = isIP(address);
  if (version === 4) return publicV4(address.split(".").map(Number));
  if (version === 6) {
    const groups = ipv6Groups(address);
    return groups !== null && publicV6(groups);
  }
  return false;
}

function publicV4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this network, private, loopback, multicast and reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // shared address space (carrier-grade NAT)
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol assignments, TEST-NET-1
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

function publicV6(g: number[]): boolean {
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) {
    // IPv4-compatible (::a.b.c.d, also :: and ::1) and IPv4-mapped (::ffff:a.b.c.d)
    return publicV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  }
  // Outside global unicast: unique local, link-local, multicast, NAT64 (64:ff9b::/96,
  // 64:ff9b:1::/48), discard, IPv4-translated (::ffff:0:a.b.c.d) and what is unassigned.
  if ((g[0] & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1] < 0x200) return false; // 2001::/23 IETF protocol assignments: Teredo, benchmarking, ORCHID
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false; // 2001:db8::/32 documentation
  if (g[0] === 0x2002) return false; // 2002::/16 6to4
  if (g[0] === 0x3fff && g[1] < 0x1000) return false; // 3fff::/20 documentation
  return true;
}

/** The eight 16-bit groups of an IPv6 address that isIP() accepted. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const gap = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (gap < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(gap).fill("0"), ...tail].map((h) => Number.parseInt(h, 16));
  return groups.length === 8 && groups.every((x) => x >= 0 && x <= 0xffff) ? groups : null;
}

/** Fetch a calendar link: GET it, follow up to five redirects, and check the body is a calendar. */
export async function fetchCalendar(link: URL | string, options: FetchCalendarOptions = {}): Promise<CalendarFetch> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let url = normalizeLink(typeof link === "string" ? link : link.href);
  const headers: Record<string, string> = {
    "User-Agent": "ekip-takvim (calendar link)",
    Accept: "text/calendar, */*;q=0.5",
    "Accept-Encoding": "identity",
  };
  if (options.etag) headers["If-None-Match"] = options.etag;
  if (options.lastModified) headers["If-Modified-Since"] = options.lastModified;
  const conditional = Boolean(options.etag || options.lastModified);

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  // Each host is looked up once per fetch, also when a redirect returns to it.
  const answers = new Map<string, LookupAddress[]>();
  try {
    for (let redirects = 0; ; redirects++) {
      const addresses = await checkedAddresses(url, answers, options, deadline.signal);
      const reply = await get(url, addresses, headers, maxBytes, conditional, deadline.signal);
      if ("result" in reply) return reply.result;
      if (redirects === MAX_REDIRECTS) throw new LinkError("tooManyRedirects", "The calendar link redirected too many times");
      url = redirectTarget(reply.location, url);
    }
  } catch (error) {
    if (deadline.signal.aborted) throw new LinkError("timeout", `${hostOf(url)} took too long to answer`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1");
}

function redirectTarget(location: string, from: URL): URL {
  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    throw new LinkError("invalid", "The calendar link redirected to an address that isn't valid");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new LinkError("invalid", "The calendar link redirected to an address that isn't http or https");
  }
  return normalizeLink(target.href);
}

/** The answer to connect to, after checking it; null for a host that is an IP address. */
async function checkedAddresses(
  url: URL,
  answers: Map<string, LookupAddress[]>,
  options: FetchCalendarOptions,
  signal: AbortSignal,
): Promise<LookupAddress[] | null> {
  const host = hostOf(url);
  const blocked = () => new LinkError("blocked", `${host} is a private or local address, which calendar links can't use`);
  if (isIP(host)) {
    if (!options.allowPrivate && !isPublicAddress(host)) throw blocked();
    return null;
  }
  let answer = answers.get(host);
  if (!answer) {
    answer = await resolve(host, options, signal);
    answers.set(host, answer);
  }
  if (!options.allowPrivate && answer.some((a) => !isPublicAddress(a.address))) throw blocked();
  return answer;
}

async function resolve(host: string, options: FetchCalendarOptions, signal: AbortSignal): Promise<LookupAddress[]> {
  let answer: unknown;
  try {
    const pending = Promise.resolve(options.lookup ? options.lookup(host, { all: true }) : dnsLookup(host, { all: true }));
    answer = await new Promise((done, fail) => {
      // A lookup that never answers still ends at the deadline.
      const stop = () => fail(new Error("aborted"));
      if (signal.aborted) return stop();
      signal.addEventListener("abort", stop, { once: true });
      pending.then(done, fail).finally(() => signal.removeEventListener("abort", stop));
    });
  } catch {
    throw new LinkError("unreachable", `Couldn't find ${host}`);
  }
  const entries = (Array.isArray(answer) ? answer : [answer]) as Partial<LookupAddress>[];
  const addresses = entries
    .map((a) => ({ address: String(a?.address ?? ""), family: isIP(String(a?.address ?? "")) }))
    .filter((a) => a.family !== 0);
  if (!addresses.length || addresses.length !== entries.length) {
    // Something that isn't an address can't be checked.
    if (!options.allowPrivate && entries.length) throw new LinkError("blocked", `${host} didn't resolve to a usable address`);
    if (!addresses.length) throw new LinkError("unreachable", `Couldn't find ${host}`);
  }
  return addresses;
}

/** Hands the connection the addresses already checked, instead of asking DNS again. */
function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = options.family === 4 || options.family === "IPv4" ? 4 : options.family === 6 || options.family === "IPv6" ? 6 : 0;
    const matching = family ? addresses.filter((a) => a.family === family) : addresses;
    const list = matching.length ? matching : addresses;
    if (options.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  };
}

type Reply = { result: CalendarFetch } | { location: string };

function get(
  url: URL,
  addresses: LookupAddress[] | null,
  headers: Record<string, string>,
  maxBytes: number,
  conditional: boolean,
  signal: AbortSignal,
): Promise<Reply> {
  return new Promise((done, fail) => {
    const host = hostOf(url);
    const secure = url.protocol === "https:";
    const request = (secure ? https : http).request({
      host,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers,
      // A connection of its own, so a pooled one can't skip the address check.
      agent: false,
      signal,
      ...(addresses ? { lookup: pinnedLookup(addresses) } : {}),
      ...(secure && !isIP(host) ? { servername: host } : {}),
    });
    const cap = maxBytes >= 1024 * 1024 ? `${Math.round(maxBytes / 1024 / 1024)} MB` : `${Math.max(1, Math.round(maxBytes / 1024))} KB`;
    const tooLarge = () => new LinkError("tooLarge", `The calendar is larger than ${cap}`);
    request.on("error", (error) => fail(error instanceof LinkError ? error : new LinkError("unreachable", `Couldn't connect to ${host}`)));
    request.on("response", (response) => {
      response.on("error", () => fail(new LinkError("unreachable", `${host} closed the connection`)));
      const status = response.statusCode ?? 0;
      if (REDIRECTS.has(status) && response.headers.location) {
        response.destroy();
        return done({ location: response.headers.location });
      }
      if (status === 304 && conditional) {
        response.destroy();
        return done({ result: { notModified: true } });
      }
      if (status !== 200) {
        response.destroy();
        return fail(new LinkError("http", `${host} answered ${status}`, status));
      }
      // Settled before the connection is closed, so the close isn't reported instead.
      const refuse = () => {
        fail(tooLarge());
        request.destroy();
      };
      if (Number(response.headers["content-length"]) > maxBytes) return refuse();
      const chunks: Buffer[] = [];
      let size = 0;
      let ended = false;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        // Stop at once: the rest of the body is never read.
        if (size > maxBytes) refuse();
        else chunks.push(chunk);
      });
      response.on("end", () => {
        ended = true;
        const text = new TextDecoder("utf-8").decode(Buffer.concat(chunks));
        if (!CALENDAR_START.test(text)) return fail(new LinkError("notCalendar", `${host} didn't send a calendar`));
        done({
          result: {
            notModified: false,
            text,
            etag: headerValue(response.headers.etag),
            lastModified: headerValue(response.headers["last-modified"]),
          },
        });
      });
      response.on("close", () => {
        if (!ended) fail(new LinkError("unreachable", `${host} closed the connection`));
      });
    });
    request.end();
  });
}

function headerValue(value: string | string[] | undefined): string | null {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}
