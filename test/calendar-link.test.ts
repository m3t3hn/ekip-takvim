import { execFileSync } from "node:child_process";
import dns from "node:dns";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fetchCalendar, isPublicAddress, LinkError, normalizeLink } from "@/lib/server/calendar-link";

const CAL = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//ekip-takvim//tests//EN\r\nEND:VCALENDAR\r\n";

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LinkError);
    return (e as LinkError).reason;
  }
  return undefined;
}

async function failure(promise: Promise<unknown>): Promise<LinkError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(LinkError);
    return e as LinkError;
  }
  throw new Error("expected a LinkError, but the fetch succeeded");
}

// ---------------------------------------------------------------- normalizeLink

describe("normalizeLink (criterion 10)", () => {
  it("accepts http and https links, trimmed and without the fragment", () => {
    const url = normalizeLink("  https://calendar.example.com/feed/abc.ics?token=xyz#week \n");
    expect(url).toBeInstanceOf(URL);
    expect(url.href).toBe("https://calendar.example.com/feed/abc.ics?token=xyz");
    expect(normalizeLink("http://example.com/a.ics").href).toBe("http://example.com/a.ics");
    expect(normalizeLink("HTTPS://Example.COM/A.ics").href).toBe("https://example.com/A.ics");
    expect(normalizeLink("https://cal.example.com:8443/x.ics").href).toBe("https://cal.example.com:8443/x.ics");
  });

  it("turns webcal and webcals into https", () => {
    expect(normalizeLink("webcal://p52-caldav.icloud.com/published/2/MTIzNDU2Nzg5").href).toBe("https://p52-caldav.icloud.com/published/2/MTIzNDU2Nzg5");
    expect(normalizeLink("webcals://calendar.example.com/x.ics?k=1#f").href).toBe("https://calendar.example.com/x.ics?k=1");
    expect(normalizeLink(" WEBCAL://calendar.example.com/x.ics").href).toBe("https://calendar.example.com/x.ics");
  });

  it("refuses other schemes, credentials and what isn't a URL", () => {
    for (const raw of [
      "ftp://example.com/cal.ics",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/calendar,BEGIN:VCALENDAR",
      "mailto:someone@example.com",
      "ws://example.com/cal.ics",
      "https://user:secret@example.com/cal.ics",
      "https://user@example.com/cal.ics",
      "https://:secret@example.com/cal.ics",
      "webcal://user:secret@example.com/cal.ics",
      "not a link",
      "",
      "   ",
      "https://",
      "http://exa mple.com/cal.ics",
    ]) {
      expect(reasonOf(() => normalizeLink(raw)), JSON.stringify(raw)).toBe("invalid");
    }
  });

  it("draws the length line at 2048 characters", () => {
    const base = "https://example.com/";
    const exact = base + "a".repeat(2048 - base.length);
    expect(normalizeLink(exact).href).toBe(exact);
    expect(reasonOf(() => normalizeLink(exact + "a"))).toBe("invalid");
    expect(reasonOf(() => normalizeLink(base + "a".repeat(5000)))).toBe("invalid");
  });
});

// ---------------------------------------------------------------- isPublicAddress

describe("isPublicAddress (criterion 11)", () => {
  const notPublic = [
    ["0.0.0.0/8", "0.0.0.0", "0.255.255.255"],
    ["10.0.0.0/8", "10.0.0.0", "10.255.255.255"],
    ["100.64.0.0/10", "100.64.0.0", "100.127.255.255"],
    ["127.0.0.0/8", "127.0.0.1", "127.255.255.255"],
    ["169.254.0.0/16", "169.254.0.0", "169.254.169.254", "169.254.255.255"],
    ["172.16.0.0/12", "172.16.0.0", "172.31.255.255"],
    ["192.0.0.0/24", "192.0.0.0", "192.0.0.255"],
    ["192.0.2.0/24", "192.0.2.0", "192.0.2.255"],
    ["192.168.0.0/16", "192.168.0.0", "192.168.255.255"],
    ["198.18.0.0/15", "198.18.0.0", "198.19.255.255"],
    ["198.51.100.0/24", "198.51.100.0", "198.51.100.255"],
    ["203.0.113.0/24", "203.0.113.0", "203.0.113.255"],
    ["224.0.0.0 and above", "224.0.0.0", "239.255.255.255", "240.0.0.1", "255.255.255.255"],
    ["::", "::", "0:0:0:0:0:0:0:0"],
    ["::1", "::1", "0000:0000:0000:0000:0000:0000:0000:0001"],
    ["fc00::/7", "fc00::", "fc00::1", "fd12:3456:789a::1", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["fe80::/10", "fe80::", "fe80::1", "FE80::ABCD", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["fec0::/10", "fec0::", "fec0::1", "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["ff00::/8", "ff00::", "ff02::1", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["64:ff9b::/96", "64:ff9b::", "64:ff9b::808:808", "64:ff9b::8.8.8.8", "64:ff9b::ffff:ffff"],
    ["100::/64", "100::", "100::1", "100::ffff:ffff:ffff:ffff"],
    ["2001:db8::/32", "2001:db8::", "2001:db8::1", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["2002::/16", "2002::", "2002:c000:204::1", "2002:808:808::1", "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["IPv4-mapped, dotted", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:192.168.1.1", "::ffff:100.64.0.1", "::ffff:0.0.0.0", "::ffff:224.0.0.1", "0:0:0:0:0:ffff:10.0.0.1"],
    ["IPv4-mapped, hex", "::ffff:a00:1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:c0a8:101", "::ffff:6440:1", "::ffff:0:0", "::ffff:e000:1", "::FFFF:A00:1", "0000:0000:0000:0000:0000:ffff:0a00:0001"],
    ["IPv4-compatible", "::10.0.0.1", "::a00:1", "::127.0.0.1", "::7f00:1", "::192.168.0.1", "::c0a8:1", "0:0:0:0:0:0:10.0.0.1"],
  ];

  it.each(notPublic)("is false for %s", (_, ...addresses) => {
    for (const address of addresses) expect(isPublicAddress(address), address).toBe(false);
  });

  it("is true for public addresses, including those just outside the ranges", () => {
    for (const address of [
      "8.8.8.8",
      "1.1.1.1",
      "9.9.9.9",
      "142.250.185.78",
      "172.217.16.142",
      "223.5.5.5",
      "9.255.255.255",
      "11.0.0.0",
      "100.63.255.255",
      "100.128.0.0",
      "126.255.255.255",
      "169.253.255.255",
      "169.255.0.0",
      "172.15.255.255",
      "172.32.0.0",
      "192.167.255.255",
      "192.169.0.0",
      "198.17.255.255",
      "198.20.0.0",
      "198.51.99.255",
      "198.51.101.0",
      "203.0.112.255",
      "203.0.114.0",
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "2a00:1450:4001:80b::200e",
      "2620:fe::fe",
    ]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it("allows IPv6 only in global unicast, outside its special blocks", () => {
    // IPv4-translated, NAT64 for local use, Teredo, IETF protocol assignments,
    // benchmarking, documentation (3fff::/20), SRv6 SIDs and unassigned space.
    for (const address of [
      "::ffff:0:7f00:1",
      "::ffff:0:808:808",
      "64:ff9b:1::7f00:1",
      "2001:0:7f00:1::1",
      "2001::1",
      "2001:2::1",
      "2001:1ff:ffff::1",
      "3fff::1",
      "3fff:fff:ffff::1",
      "5f00::1",
      "4000::1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    for (const address of ["::ffff:8.8.8.8", "2001:200::1", "2001:4860:4860::8888", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "2620:fe::fe", "3fff:1000::1"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it("draws the IPv6 lines at 2000::/3, 2001::/23, 2001:db8::/32, 2002::/16 and 3fff::/20, for every first group", () => {
    const special = (g0: number, g1: number) => (g0 === 0x2001 && g1 < 0x200) || (g0 === 0x2001 && g1 === 0xdb8) || g0 === 0x2002 || (g0 === 0x3fff && g1 < 0x1000);
    const expected = (g0: number, g1: number) => g0 >= 0x2000 && g0 <= 0x3fff && !special(g0, g1);
    const SECOND = [0, 1, 0x1ff, 0x200, 0xdb7, 0xdb8, 0xdb9, 0xfff, 0x1000, 0xffff];
    const wrong: string[] = [];
    for (let g0 = 0; g0 <= 0xffff; g0++) {
      for (const g1 of SECOND) {
        // Written out in full, so that no group is left to "::".
        const address = `${g0.toString(16)}:${g1.toString(16)}:0:0:0:0:0:1`;
        if (isPublicAddress(address) !== expected(g0, g1)) wrong.push(address);
      }
    }
    expect(wrong.slice(0, 20), `${wrong.length} wrong`).toEqual([]);
    // IPv4-mapped and IPv4-compatible addresses follow their IPv4 part, in every spelling.
    for (const v4 of ["8.8.8.8", "1.1.1.1", "223.5.5.5", "10.0.0.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "192.0.2.1", "224.0.0.1", "0.0.0.1"]) {
      const [a, b, c, d] = v4.split(".").map(Number);
      const hex = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
      for (const form of [`::ffff:${v4}`, `::ffff:${hex}`, `::FFFF:${hex.toUpperCase()}`, `0:0:0:0:0:ffff:${hex}`, `::${v4}`, `::${hex}`, `0:0:0:0:0:0:${v4}`]) {
        expect(isPublicAddress(form), form).toBe(isPublicAddress(v4));
      }
    }
  });
});

// ---------------------------------------------------------------- fetchCalendar

// No test reaches the network, whatever the code under test does. The system
// resolver is replaced by one that records the name and fails, and every socket
// is checked just before it connects: loopback passes, a PUBLIC stand-in is sent
// to the local test server (the code sees a public address, the bytes stay on
// this machine), and any other address is refused.
const PUBLIC_STANDINS = new Set(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]);
let systemLookups: string[] = [];
let connectTargets: string[] = [];
let refusedPort = 0;

type LookupCallback = (err: Error | null, address?: string | { address: string; family: number }[], family?: number) => void;
type LookupHook = (hostname: string, options: object, callback: LookupCallback) => void;
type ConnectOptions = { host?: string; port?: number; path?: string; lookup?: LookupHook };

const realLookup = dns.lookup;
const realConnect = net.Socket.prototype.connect;

function route(address: string): string | null {
  connectTargets.push(address);
  if (address === "127.0.0.1" || address === "::1") return address;
  if (PUBLIC_STANDINS.has(address)) return "127.0.0.1";
  return null;
}
const fenced = () => Object.assign(new Error("connect EHOSTUNREACH (no network in tests)"), { code: "EHOSTUNREACH" });

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

beforeAll(async () => {
  refusedPort = await closedPort();
  (dns as { lookup: unknown }).lookup = (hostname: string, options: unknown, callback?: LookupCallback) => {
    const cb = (typeof options === "function" ? options : callback) as LookupCallback;
    const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
    // An address needs no lookup, as in dns.lookup itself (server.listen relies on that).
    const family = net.isIP(hostname);
    if (family) return void process.nextTick(() => (all ? cb(null, [{ address: hostname, family }]) : cb(null, hostname, family)));
    systemLookups.push(hostname);
    process.nextTick(() => cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND", hostname })));
  };
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const options = (Array.isArray(args[0]) ? args[0][0] : args[0]) as ConnectOptions | undefined;
    // Fail closed on a call this fence doesn't understand. A path is a local pipe; http passes path: null.
    if (!options || typeof options !== "object") throw new Error("test fence: unexpected connect call");
    if (options.path == null) {
      const host = options.host ?? "localhost";
      if (net.isIP(host)) {
        const to = route(host);
        options.host = to ?? "127.0.0.1";
        if (!to) options.port = refusedPort;
      } else if (typeof options.lookup === "function") {
        const inner = options.lookup;
        options.lookup = (hostname, opts, callback) =>
          inner(hostname, opts, (err, address, family) => {
            if (err || address === undefined) return callback(err, address, family);
            if (Array.isArray(address)) {
              const routed = address.map((a) => route(a.address));
              if (routed.some((a) => a === null)) return callback(fenced());
              return callback(null, routed.map((a) => ({ address: a as string, family: net.isIP(a as string) })));
            }
            const to = route(address);
            return to ? callback(null, to, net.isIP(to)) : callback(fenced());
          });
      }
      // Anything else resolves through dns.lookup, replaced above.
    }
    return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
});

afterAll(() => {
  (dns as { lookup: unknown }).lookup = realLookup;
  net.Socket.prototype.connect = realConnect;
});

beforeEach(() => {
  systemLookups = [];
  connectTargets = [];
});

type Hit = { method?: string; url?: string; headers: http.IncomingHttpHeaders; servername?: string };
type TestServer = { port: number; hits: Hit[]; connections: () => number };
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void, tlsOptions?: { key: string; cert: string }): Promise<TestServer> {
  const hits: Hit[] = [];
  const sockets = new Set<net.Socket>();
  let connections = 0;
  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    hits.push({ method: req.method, url: req.url, headers: req.headers, servername: (req.socket as tls.TLSSocket).servername || undefined });
    handler(req, res);
  };
  const server = tlsOptions ? https.createServer(tlsOptions, onRequest) : http.createServer(onRequest);
  server.on("connection", (socket: net.Socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as net.AddressInfo).port, hits, connections: () => connections };
}

/** A lookup like dns.promises.lookup with { all: true }, answering from a table and recording each name. */
function dnsTable(table: Record<string, string[] | (() => string[])>) {
  const calls: string[] = [];
  const lookup = async (hostname: string) => {
    calls.push(hostname);
    const entry = table[hostname];
    const answer = typeof entry === "function" ? entry() : entry;
    if (!answer) throw Object.assign(new Error(`queryA ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return answer.map((address) => ({ address, family: net.isIP(address) }));
  };
  return { lookup, calls };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await sleep(10);
  return check();
}

describe("fetchCalendar: looking up and connecting (criterion 12)", () => {
  it("runs behind a fence that keeps every connection on this machine", async () => {
    const server = await serve((_, res) => res.end("local"));
    const get = (url: string, lookup?: LookupHook) =>
      new Promise<string>((resolve) => {
        const req = http.get(url, { agent: false, ...(lookup ? { lookup: lookup as unknown as net.LookupFunction } : {}) }, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(body));
        });
        req.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
      });
    expect(await get(`http://8.8.8.8:${server.port}/`)).toBe("local");
    expect(await get(`http://10.9.9.9:${server.port}/`)).toBe("ECONNREFUSED");
    expect(await get(`http://calendar.test:${server.port}/`)).toBe("ENOTFOUND");
    expect(await get(`http://calendar.test:${server.port}/`, (_name, _options, cb) => cb(null, [{ address: "1.1.1.1", family: 4 }]))).toBe("local");
    expect(await get(`http://calendar.test:${server.port}/`, (_name, _options, cb) => cb(null, [{ address: "9.9.9.9", family: 4 }]))).toBe("EHOSTUNREACH");
    expect(connectTargets).toEqual(["8.8.8.8", "10.9.9.9", "1.1.1.1", "9.9.9.9"]);
    expect(systemLookups).toEqual(["calendar.test"]);
  });

  it("looks the host up once through options.lookup and connects to that answer, with private addresses refused", async () => {
    const server = await serve((_, res) => res.end(CAL));
    const { lookup, calls } = dnsTable({ "calendar.test": ["8.8.8.8"] });
    const result = await fetchCalendar(`http://calendar.test:${server.port}/calendars/abc/basic.ics?k=1`, { lookup });
    expect(result).toEqual({ notModified: false, text: CAL, etag: null, lastModified: null });
    expect(calls).toEqual(["calendar.test"]);
    expect(systemLookups).toEqual([]);
    expect(connectTargets).toEqual(["8.8.8.8"]);
    expect(server.hits.map((h) => [h.method, h.url, h.headers.host])).toEqual([["GET", "/calendars/abc/basic.ics?k=1", `calendar.test:${server.port}`]]);
  });

  it("takes a URL object too", async () => {
    const server = await serve((_, res) => res.end(CAL));
    const { lookup } = dnsTable({ "calendar.test": ["1.1.1.1"] });
    const result = await fetchCalendar(new URL(`http://calendar.test:${server.port}/basic.ics`), { lookup });
    expect(result).toMatchObject({ notModified: false, text: CAL });
  });

  it("never asks again, so a second answer can't change where it connects", async () => {
    const server = await serve((_, res) => res.end(CAL));
    // The first answer is public; any later one points inside (a rebinding name).
    for (const later of ["10.0.0.5", "127.0.0.1"]) {
      connectTargets = [];
      let n = 0;
      const { lookup, calls } = dnsTable({ "calendar.test": () => (n++ === 0 ? ["8.8.8.8"] : [later]) });
      await expect(fetchCalendar(`http://calendar.test:${server.port}/basic.ics`, { lookup })).resolves.toMatchObject({ text: CAL });
      expect(calls).toEqual(["calendar.test"]);
      expect(connectTargets).toEqual(["8.8.8.8"]);
    }
    expect(systemLookups).toEqual([]);
  });

  it("looks each host up once across redirects, back to the same host included", async () => {
    let port = 0;
    const server = await serve((req, res) => {
      const next: Record<string, string> = {
        "/a": "/b",
        "/b": `http://other.test:${port}/c`,
        "/c": `http://calendar.test:${port}/d`,
      };
      if (req.url && next[req.url]) res.writeHead(302, { location: next[req.url] }).end();
      else res.end(CAL);
    });
    port = server.port;
    const { lookup, calls } = dnsTable({ "calendar.test": ["8.8.8.8"], "other.test": ["1.1.1.1"] });
    await expect(fetchCalendar(`http://calendar.test:${port}/a`, { lookup })).resolves.toMatchObject({ text: CAL });
    expect(server.hits.map((h) => h.url)).toEqual(["/a", "/b", "/c", "/d"]);
    expect(calls.sort()).toEqual(["calendar.test", "other.test"]);
    expect(systemLookups).toEqual([]);
    expect(connectTargets.every((a) => a === "8.8.8.8" || a === "1.1.1.1")).toBe(true);
  });

  it("checks a host that is an IP literal without looking it up", async () => {
    const server = await serve((_, res) => res.end(CAL));
    const { lookup, calls } = dnsTable({});
    await expect(fetchCalendar(`http://8.8.8.8:${server.port}/basic.ics`, { lookup })).resolves.toMatchObject({ text: CAL });
    await expect(fetchCalendar(`http://127.0.0.1:${server.port}/basic.ics`, { lookup, allowPrivate: true })).resolves.toMatchObject({ text: CAL });
    expect(calls).toEqual([]);
    expect(systemLookups).toEqual([]);
    connectTargets = [];
    const before = server.connections();
    for (const host of ["127.0.0.1", "[::1]", "10.1.2.3", "169.254.169.254", "[::ffff:7f00:1]"]) {
      expect((await failure(fetchCalendar(`http://${host}:${server.port}/basic.ics`, { lookup }))).reason, host).toBe("blocked");
    }
    expect(connectTargets).toEqual([]);
    expect(server.connections()).toBe(before);
  });

  it("refuses before connecting when any address in the answer isn't public", async () => {
    const server = await serve((_, res) => res.end(CAL));
    for (const answer of [["127.0.0.1"], ["8.8.8.8", "10.0.0.7"], ["1.1.1.1", "::1"], ["::ffff:a00:1"], ["2606:4700:4700::1111", "fd00::1"]]) {
      const { lookup } = dnsTable({ "calendar.test": answer });
      expect((await failure(fetchCalendar(`http://calendar.test:${server.port}/basic.ics`, { lookup }))).reason, answer.join(",")).toBe("blocked");
    }
    expect(connectTargets).toEqual([]);
    expect(server.connections()).toBe(0);
  });

  it("reaches private addresses with allowPrivate", async () => {
    const server = await serve((_, res) => res.end(CAL));
    const { lookup } = dnsTable({ "nextcloud.lan": ["127.0.0.1"] });
    await expect(fetchCalendar(`http://nextcloud.lan:${server.port}/remote.php/dav/x.ics`, { lookup, allowPrivate: true })).resolves.toMatchObject({ text: CAL });
    expect(connectTargets).toEqual(["127.0.0.1"]);
  });

  it("fails as unreachable when the lookup fails or finds nothing, or the connection is refused", async () => {
    const { lookup } = dnsTable({ "empty.test": [], "closed.test": ["127.0.0.1"] });
    expect((await failure(fetchCalendar("http://missing.test/basic.ics", { lookup }))).reason).toBe("unreachable");
    expect((await failure(fetchCalendar("http://empty.test/basic.ics", { lookup }))).reason).toBe("unreachable");
    expect((await failure(fetchCalendar(`http://closed.test:${refusedPort}/basic.ics`, { lookup, allowPrivate: true }))).reason).toBe("unreachable");
    expect((await failure(fetchCalendar(`http://127.0.0.1:${refusedPort}/basic.ics`, { allowPrivate: true }))).reason).toBe("unreachable");
    expect(systemLookups).toEqual([]);
  });

  describe("without options.lookup", () => {
    const promises = dns.promises as { lookup: unknown };
    const realPromisesLookup = promises.lookup;
    let calls: string[] = [];
    beforeEach(() => {
      calls = [];
      promises.lookup = async (hostname: string) => {
        calls.push(hostname);
        return hostname === "calendar.test" ? [{ address: "8.8.8.8", family: 4 }] : [{ address: "192.168.1.20", family: 4 }];
      };
      syncBuiltinESMExports();
    });
    afterEach(() => {
      promises.lookup = realPromisesLookup;
      syncBuiltinESMExports();
    });

    it("uses dns.promises.lookup once, and nothing else resolves the host", async () => {
      const server = await serve((_, res) => res.end(CAL));
      await expect(fetchCalendar(`http://calendar.test:${server.port}/basic.ics`)).resolves.toMatchObject({ text: CAL });
      expect(calls).toEqual(["calendar.test"]);
      expect(systemLookups).toEqual([]);
      expect(connectTargets).toEqual(["8.8.8.8"]);
      expect((await failure(fetchCalendar(`http://printer.test:${server.port}/basic.ics`))).reason).toBe("blocked");
    });
  });
});

describe("fetchCalendar over https", () => {
  let key = "";
  let cert = "";
  let defaults: string[] = [];
  // Needs openssl to make the certificate, and Node 22.19 or 24.5+ to trust it for a while.
  const canTrust = typeof tls.setDefaultCACertificates === "function" && (() => {
    try {
      execFileSync("openssl", ["version"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();

  beforeAll(() => {
    if (!canTrust) return;
    // A throwaway certificate for calendar.test, made for this run and trusted only while it lasts.
    const dir = mkdtempSync(join(tmpdir(), "ekip-ics-tls-"));
    try {
      writeFileSync(
        join(dir, "openssl.cnf"),
        "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=calendar.test\n[ext]\nsubjectAltName=DNS:calendar.test\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\nextendedKeyUsage=serverAuth\n",
      );
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", join(dir, "openssl.cnf"), "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "pipe" });
      key = readFileSync(join(dir, "key.pem"), "utf8");
      cert = readFileSync(join(dir, "cert.pem"), "utf8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    defaults = tls.getCACertificates("default");
    tls.setDefaultCACertificates([...defaults, cert]);
  });
  afterAll(() => {
    if (canTrust) tls.setDefaultCACertificates(defaults);
  });

  it.skipIf(!canTrust)("connects to the checked address and verifies the certificate for the link's host (webcal link)", async () => {
    const server = await serve((_, res) => res.end(CAL), { key, cert });
    const { lookup, calls } = dnsTable({ "calendar.test": ["8.8.8.8"] });
    await expect(fetchCalendar(`webcal://calendar.test:${server.port}/published/2/abc`, { lookup })).resolves.toMatchObject({ text: CAL });
    expect(calls).toEqual(["calendar.test"]);
    expect(connectTargets).toEqual(["8.8.8.8"]);
    expect(server.hits[0].servername).toBe("calendar.test");
    expect(systemLookups).toEqual([]);
  });
});

describe("fetchCalendar: redirects (criterion 13)", () => {
  /** A server where /rN redirects with the given status to the next step, and /final answers the calendar. */
  async function chain(steps: { status: number; to: (port: number) => string }[]) {
    let port = 0;
    const server = await serve((req, res) => {
      const i = Number(/^\/r(\d+)$/.exec(req.url ?? "")?.[1]);
      if (Number.isInteger(i) && steps[i - 1]) res.writeHead(steps[i - 1].status, { location: steps[i - 1].to(port) }).end();
      else if (req.url === "/final") res.end(CAL);
      else res.writeHead(404).end();
    });
    port = server.port;
    return server;
  }

  it("follows five redirects of every kind, relative and absolute", async () => {
    const server = await chain([
      { status: 301, to: () => "/r2" },
      { status: 302, to: (p) => `http://other.test:${p}/r3` },
      { status: 303, to: () => "r4" },
      { status: 307, to: (p) => `http://calendar.test:${p}/r5` },
      { status: 308, to: () => "/final" },
    ]);
    const { lookup } = dnsTable({ "calendar.test": ["8.8.8.8"], "other.test": ["1.1.1.1"] });
    await expect(fetchCalendar(`http://calendar.test:${server.port}/r1`, { lookup })).resolves.toMatchObject({ text: CAL });
    expect(server.hits.map((h) => h.url)).toEqual(["/r1", "/r2", "/r3", "/r4", "/r5", "/final"]);
  });

  it("fails on the sixth redirect without following it", async () => {
    const server = await chain(Array.from({ length: 6 }, (_, i) => ({ status: 302, to: () => (i === 5 ? "/final" : `/r${i + 2}`) })));
    const { lookup } = dnsTable({ "calendar.test": ["8.8.8.8"] });
    expect((await failure(fetchCalendar(`http://calendar.test:${server.port}/r1`, { lookup }))).reason).toBe("tooManyRedirects");
    expect(server.hits.map((h) => h.url)).toEqual(["/r1", "/r2", "/r3", "/r4", "/r5", "/r6"]);
  });

  it("refuses a redirect to another scheme or with credentials", async () => {
    for (const target of ["ftp://calendar.test/cal.ics", "file:///etc/passwd", "webcal://calendar.test/cal.ics", "javascript:alert(1)", "data:text/calendar,BEGIN:VCALENDAR", "http://user:pw@calendar.test/cal.ics"]) {
      const server = await chain([{ status: 302, to: () => target }]);
      const { lookup } = dnsTable({ "calendar.test": ["8.8.8.8"] });
      expect((await failure(fetchCalendar(`http://calendar.test:${server.port}/r1`, { lookup }))).reason, target).toBe("invalid");
      expect(server.hits).toHaveLength(1);
    }
  });

  it("checks every redirect target's addresses before connecting", async () => {
    for (const target of [
      (p: number) => `http://intranet.test:${p}/admin`,
      (p: number) => `http://127.0.0.1:${p}/final`,
      (p: number) => `http://[::ffff:7f00:1]:${p}/final`,
      () => "http://169.254.169.254/latest/meta-data/",
    ]) {
      connectTargets = [];
      const server = await chain([{ status: 302, to: target }]);
      const { lookup } = dnsTable({ "calendar.test": ["8.8.8.8"], "intranet.test": ["10.0.0.5"] });
      expect((await failure(fetchCalendar(`http://calendar.test:${server.port}/r1`, { lookup }))).reason, target(server.port)).toBe("blocked");
      expect(connectTargets).toEqual(["8.8.8.8"]);
      expect(server.hits.map((h) => h.url)).toEqual(["/r1"]);
    }
  });
});

describe("fetchCalendar: time and size limits (criterion 14)", () => {
  const { lookup } = dnsTable({ "calendar.test": ["8.8.8.8"] });

  it("times out when the server never answers", async () => {
    const server = await serve(() => {});
    const t0 = performance.now();
    expect((await failure(fetchCalendar(`http://calendar.test:${server.port}/basic.ics`, { lookup, timeoutMs: 300 }))).reason).toBe("timeout");
    const took = performance.now() - t0;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(2500);
  });

  it("times out when the lookup never answers", async () => {
    const t0 = performance.now();
    const hanging = () => new Promise<{ address: string; family: number }[]>(() => {});
    expect((await failure(fetchCalendar("http://calendar.test/basic.ics", { lookup: hanging, timeoutMs: 300 }))).reason).toBe("timeout");
    expect(performance.now() - t0).toBeLessThan(2500);
  });

  it("times out when the body stops coming", async () => {
    const server = await serve((_, res) => {
      res.writeHead(200, { "content-type": "text/calendar" });
      res.write("BEGIN:VCALENDAR\r\n");
    });
    expect((await failure(fetchCalendar(`http://calendar.test:${server.port}/basic.ics`, { lookup, timeoutMs: 300 }))).reason).toBe("timeout");
  });

  it("counts the time over the whole redirect chain, not per request", async () => {
    // Each answer takes 150 ms, well inside the limit; the five of them together don't.
    const server = await serve((req, res) => {
      const i = Number(/^\/r(\d)$/.exec(req.url ?? "")?.[1]);
      setTimeout(() => (i < 5 ? res.writeHead(302, { location: `/r${i + 1}` }).end() : res.end(CAL)), 150);
    });
    expect((await failure(fetchCalendar(`http://calendar.test:${server.port}/r1`, { lookup, timeoutMs: 450 }))).reason).toBe("timeout");
  });

  it("takes its time by default", async () => {
    const server = await serve((_, res) => setTimeout(() => res.end(CAL), 1200));
    await expect(fetchCalendar(`http://calendar.test:${server.port}/basic.ics`, { lookup })).resolves.toMatchObject({ text: CAL });
  });

  it("stops reading and closes the connection as soon as the body passes maxBytes", async () => {
    const TOTAL = 64 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, "X");
    const state = { sent: 0, closedAt: 0, finished: false };
    const server = await serve((_, res) => {
      res.writeHead(200, { "content-type": "text/calendar" }); // chunked: no Content-Length to go by
      res.write("BEGIN:VCALENDAR\r\n");
      res.on("close", () => (state.closedAt = performance.now()));
      res.on("finish", () => (state.finished = true));
      const pump = () => {
        while (!res.destroyed && state.sent < TOTAL) {
          state.sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        if (!res.destroyed) res.end();
      };
      pump();
    });
    const err = await failure(fetchCalendar(`http://calendar.test:${server.port}/big.ics`, { lookup, maxBytes: 256 * 1024, timeoutMs: 10_000 }));
    const failedAt = performance.now();
    expect(err.reason).toBe("tooLarge");
    expect(await until(() => state.closedAt > 0, 1000)).toBe(true);
    expect(state.closedAt - failedAt).toBeLessThan(1000);
    expect(state.finished).toBe(false);
    expect(state.sent).toBeLessThan(TOTAL / 2);
  });

  it("fails at once when Content-Length is over maxBytes", async () => {
    const server = await serve((_, res) => {
      res.writeHead(200, { "content-type": "text/calendar", "content-length": String(50_000_000) });
      res.write("BEGIN:VCALENDAR\r\n");
    });
    const t0 = performance.now();
    expect((await failure(fetchCalendar(`http://calendar.test:${server.port}/big.ics`, { lookup, maxBytes: 1024 * 1024, timeoutMs: 3000 }))).reason).toBe("tooLarge");
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it("allows exactly maxBytes, counted in bytes, with or without Content-Length", async () => {
    const exact = "BEGIN:VCALENDAR\r\n".padEnd(4096, "X");
    // 617 characters, 1217 bytes.
    const bodies: Record<string, string> = { exact, over: exact + "X", wide: "BEGIN:VCALENDAR\r\n" + "ğ".repeat(600) };
    const server = await serve((req, res) => {
      const [, mode, name] = (req.url ?? "").split("/");
      const body = Buffer.from(bodies[name]);
      if (mode === "length") return void res.writeHead(200, { "content-length": String(body.length) }).end(body);
      res.writeHead(200);
      res.write(body);
      res.end();
    });
    for (const mode of ["length", "chunked"]) {
      const at = (name: string, maxBytes: number) => fetchCalendar(`http://calendar.test:${server.port}/${mode}/${name}`, { lookup, maxBytes });
      await expect(at("exact", 4096), mode).resolves.toMatchObject({ text: exact });
      expect((await failure(at("over", 4096))).reason, mode).toBe("tooLarge");
      expect((await failure(at("wide", 1000))).reason, mode).toBe("tooLarge");
    }
  });

  it("allows about 10 MB by default", async () => {
    const small = Buffer.alloc(9_500_000, "X");
    const big = Buffer.alloc(11_000_000, "X");
    Buffer.from("BEGIN:VCALENDAR\r\n").copy(small);
    Buffer.from("BEGIN:VCALENDAR\r\n").copy(big);
    const server = await serve((req, res) => {
      res.writeHead(200, { "content-type": "text/calendar" });
      res.end(req.url === "/small" ? small : big);
    });
    const ok = await fetchCalendar(`http://calendar.test:${server.port}/small`, { lookup });
    expect(ok.notModified === false && ok.text.length).toBe(9_500_000);
    expect((await failure(fetchCalendar(`http://calendar.test:${server.port}/big`, { lookup }))).reason).toBe("tooLarge");
  });
});

describe("fetchCalendar: conditional requests and the body (criterion 15)", () => {
  const { lookup } = dnsTable({ "calendar.test": ["8.8.8.8"] });

  it("sends If-None-Match and If-Modified-Since when given, and reads 304 as not modified", async () => {
    const server = await serve((req, res) => {
      if (req.headers["if-none-match"] || req.headers["if-modified-since"]) res.writeHead(304).end();
      else res.writeHead(200, { etag: 'W/"v2"', "last-modified": "Thu, 12 Nov 2026 08:00:00 GMT" }).end(CAL);
    });
    const url = `http://calendar.test:${server.port}/basic.ics`;
    await expect(fetchCalendar(url, { lookup, etag: '"v1"' })).resolves.toEqual({ notModified: true });
    await expect(fetchCalendar(url, { lookup, lastModified: "Wed, 11 Nov 2026 08:00:00 GMT" })).resolves.toEqual({ notModified: true });
    await expect(fetchCalendar(url, { lookup, etag: '"v1"', lastModified: "Wed, 11 Nov 2026 08:00:00 GMT" })).resolves.toEqual({ notModified: true });
    await expect(fetchCalendar(url, { lookup, etag: null, lastModified: null })).resolves.toEqual({
      notModified: false,
      text: CAL,
      etag: 'W/"v2"',
      lastModified: "Thu, 12 Nov 2026 08:00:00 GMT",
    });
    expect(server.hits.map((h) => [h.headers["if-none-match"], h.headers["if-modified-since"]])).toEqual([
      ['"v1"', undefined],
      [undefined, "Wed, 11 Nov 2026 08:00:00 GMT"],
      ['"v1"', "Wed, 11 Nov 2026 08:00:00 GMT"],
      [undefined, undefined],
    ]);
  });

  it("decodes the body as UTF-8, a character split across packets included", async () => {
    const body = "BEGIN:VCALENDAR\r\nSUMMARY:Toplantı – Çarşamba 📅 Ğ\r\nEND:VCALENDAR\r\n";
    const bytes = Buffer.from(body);
    const cut = bytes.indexOf(Buffer.from("📅")) + 2;
    const server = await serve((_, res) => {
      res.writeHead(200, { "content-type": "text/calendar; charset=utf-8" });
      res.write(bytes.subarray(0, cut));
      setTimeout(() => res.end(bytes.subarray(cut)), 50);
    });
    await expect(fetchCalendar(`http://calendar.test:${server.port}/basic.ics`, { lookup })).resolves.toEqual({ notModified: false, text: body, etag: null, lastModified: null });
  });
});

describe("fetchCalendar: errors (criterion 16)", () => {
  const { lookup } = dnsTable({ "calendar.test": ["8.8.8.8"] });

  it("fails with the status for any other answer", async () => {
    const server = await serve((req, res) => res.writeHead(Number(req.url?.slice(1))).end("nope"));
    for (const status of [204, 206, 400, 401, 403, 404, 410, 429, 500, 502, 503]) {
      const err = await failure(fetchCalendar(`http://calendar.test:${server.port}/${status}`, { lookup }));
      expect([err.reason, err.status], String(status)).toEqual(["http", status]);
    }
  });

  it("fails with notCalendar unless the body starts with BEGIN:VCALENDAR", async () => {
    const bodies: Record<string, string> = {
      "/html": "<!DOCTYPE html><html><body>Sign in</body></html>",
      "/empty": "",
      "/event": "BEGIN:VEVENT\r\nEND:VEVENT\r\n",
      "/json": '{"error":"not found"}',
      "/late": "Calendar:\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
      "/bom": "﻿\r\n \tBEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
      "/space": "\r\n\r\n  BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
    };
    const server = await serve((req, res) => res.writeHead(200, { "content-type": "text/calendar" }).end(bodies[req.url ?? ""]));
    for (const path of ["/html", "/empty", "/event", "/json", "/late"]) {
      expect((await failure(fetchCalendar(`http://calendar.test:${server.port}${path}`, { lookup }))).reason, path).toBe("notCalendar");
    }
    for (const path of ["/bom", "/space"]) {
      const result = await fetchCalendar(`http://calendar.test:${server.port}${path}`, { lookup });
      expect(result.notModified === false && result.text.replace(/^﻿/, ""), path).toBe(bodies[path].replace(/^﻿/, ""));
    }
  });

  it("never puts the link's path, query or password in an error message", async () => {
    let port = 0;
    const server = await serve((req, res) => {
      const path = req.url ?? "";
      if (path.includes("hang")) return;
      if (path.includes("loop")) return void res.writeHead(302, { location: `/loop-5ecr3t-${Math.random()}?token=5ecr3t` }).end();
      if (path.includes("to-ftp")) return void res.writeHead(302, { location: "ftp://calendar.test/5ecr3t-target?token=5ecr3t" }).end();
      if (path.includes("to-private")) return void res.writeHead(302, { location: `http://intranet.test:${port}/5ecr3t-target?token=5ecr3t` }).end();
      if (path.includes("huge")) return void res.writeHead(200).end("BEGIN:VCALENDAR\r\n" + "X".repeat(5000));
      if (path.includes("html")) return void res.writeHead(200).end("<html>5ecr3t</html>");
      res.writeHead(404).end();
    });
    port = server.port;
    const secretLookup = dnsTable({ "calendar.test": ["8.8.8.8"], "intranet.test": ["10.0.0.5"], "private.test": ["192.168.1.1"] }).lookup;
    const p = "/u/5ecr3t-path/basic.ics?token=5ecr3t-query";
    const attempts: [string, () => Promise<unknown>][] = [
      ["scheme", () => fetchCalendar(`ftp://calendar.test${p}`)],
      ["password", () => fetchCalendar(`https://me:5ecr3t-pass@calendar.test${p}`)],
      ["length", () => fetchCalendar(`https://calendar.test${p}&pad=${"5ecr3t".repeat(400)}`)],
      ["blocked", () => fetchCalendar(`http://private.test:${port}${p}`, { lookup: secretLookup })],
      ["lookup", () => fetchCalendar(`http://missing.test${p}`, { lookup: secretLookup })],
      ["refused", () => fetchCalendar(`http://127.0.0.1:${refusedPort}${p}`, { allowPrivate: true })],
      ["timeout", () => fetchCalendar(`http://calendar.test:${port}/hang${p}`, { lookup: secretLookup, timeoutMs: 200 })],
      ["tooLarge", () => fetchCalendar(`http://calendar.test:${port}/huge${p}`, { lookup: secretLookup, maxBytes: 1000 })],
      ["redirects", () => fetchCalendar(`http://calendar.test:${port}/loop${p}`, { lookup: secretLookup })],
      ["redirect scheme", () => fetchCalendar(`http://calendar.test:${port}/to-ftp${p}`, { lookup: secretLookup })],
      ["redirect blocked", () => fetchCalendar(`http://calendar.test:${port}/to-private${p}`, { lookup: secretLookup })],
      ["http", () => fetchCalendar(`http://calendar.test:${port}/missing${p}`, { lookup: secretLookup })],
      ["notCalendar", () => fetchCalendar(`http://calendar.test:${port}/html${p}`, { lookup: secretLookup })],
    ];
    const reasons: string[] = [];
    for (const [name, attempt] of attempts) {
      const err = await failure(attempt());
      reasons.push(err.reason);
      expect(err.message, name).not.toMatch(/5ecr3t/);
      expect(String(err), name).not.toMatch(/5ecr3t/);
    }
    expect(reasons).toEqual(["invalid", "invalid", "invalid", "blocked", "unreachable", "unreachable", "timeout", "tooLarge", "tooManyRedirects", "invalid", "blocked", "http", "notCalendar"]);
  });
});
