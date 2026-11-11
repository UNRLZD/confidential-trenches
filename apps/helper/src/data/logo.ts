// GET /v1/logo/{chain}/{token} (the kit's packages/kit/src/helper/v1.ts contract): a token's logo, read by the helper
// from the URL its list source gives (Jupiter's `icon` on Solana, GeckoTerminal's base token `image_url` on Base and
// Robinhood), so the browser never tells a third party which token its user looks at.
//
// The caller names a chain and a token, never a URL: a URL is taken only from a list row this helper built
// (`remember`, called where the rows are made), so every fetch is to a URL a list source gave for a token on our
// lists, at most one at a time per token, and one per token per LOGO_OK_MS (LOGO_NONE_MS after a refusal).
//
// The URL is a stranger's (a token's creator writes it), so the fetch is an SSRF surface and every rule is a refusal:
// - https only, port 443, no user or password, a host name (never an IP literal), at most URL_MAX characters;
// - the host's every address is resolved first and refused if any is private, loopback, link-local, shared, reserved
//   or multicast (net.BlockList, both families, IPv4-mapped and NAT64 IPv6 read as their IPv4); the connection then
//   goes to the address that was checked (the request's `lookup` is pinned to it), so a second DNS answer cannot
//   point it elsewhere;
// - a redirect is followed at most REDIRECTS_MAX times, each hop checked by the same rules;
// - only a 200 whose declared type is png, jpeg, webp or gif and whose first bytes are that format's (the type served
//   is the one the bytes show); SVG is refused (a stranger's SVG served from our origin is script);
// - at most HELPER_LOGO_MAX_BYTES read, at most FETCH_MS for the whole fetch, at most PARALLEL fetches at once.
// Answers are cached in memory (CACHE_BYTES and CACHE_ENTRIES bound), the registry of URLs too (URLS_MAX).
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { request } from "node:https";
import { HELPER_LOGO_MAX_BYTES, HELPER_LOGO_TYPES, type HelperLogoType } from "@blindfill/kit";

export const LOGO_CHAINS = ["solana", "base", "robinhood"] as const;
export type LogoChain = (typeof LOGO_CHAINS)[number];
export const URL_MAX = 2_048;
export const REDIRECTS_MAX = 3;
export const FETCH_MS = 5_000;
export const PARALLEL = 8;
export const QUEUE_MAX = 400;
export const LOGO_OK_MS = 24 * 3_600_000;
export const LOGO_NONE_MS = 10 * 60_000;
export const CACHE_BYTES = 64 * 1024 * 1024;
export const CACHE_ENTRIES = 5_000;
export const URLS_MAX = 20_000;

/** Every range a server-side fetch must never reach (IANA special-purpose registries, both families). */
const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) BLOCKED.addSubnet(net, bits, "ipv6");

/** Whether an address is one no fetch may reach (an IPv6 that carries an IPv4, mapped or NAT64, is read as that IPv4). */
export function blockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return BLOCKED.check(ip, "ipv4");
  if (family !== 6) return true;
  const low = ip.toLowerCase();
  const v4 = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(low)?.[1];
  if (v4 !== undefined) return blockedAddress(v4);
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(low);
  if (hex !== null) {
    const a = parseInt(hex[1]!, 16);
    const b = parseInt(hex[2]!, 16);
    return blockedAddress(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
  }
  return BLOCKED.check(ip, "ipv6");
}

/** A URL a logo may be fetched from, as a URL, or null: https, port 443, no credentials, a DNS name, bounded. */
export function logoUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > URL_MAX) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || (u.port !== "" && u.port !== "443") || u.username !== "" || u.password !== "") return null;
  const host = u.hostname.toLowerCase();
  // an IP literal in any form the URL parser keeps (dotted, bracketed IPv6; it already folds hex and octal IPv4)
  if (host.startsWith("[") || isIP(host) !== 0 || !host.includes(".") || host.endsWith(".")) return null;
  if (host === "localhost" || /\.(localhost|local|internal|lan|home|arpa)$/.test(host)) return null;
  return u;
}

/** The image format the first bytes show, or null (SVG and every other format: null). */
export function sniff(b: Uint8Array): HelperLogoType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "image/webp";
  if (b.length >= 6 && /^GIF8[79]a$/.test(String.fromCharCode(...b.subarray(0, 6)))) return "image/gif";
  return null;
}

/** One HTTP response as the fetcher reads it. */
export type Got = { status: number; headers: Record<string, string | string[] | undefined>; body: AsyncIterable<Uint8Array>; destroy(): void };
/** One GET of `url` over a connection to one of `addrs` (every one already checked), bounded by `signal`. */
export type Get = (url: URL, addrs: { address: string; family: number }[], signal: AbortSignal) => Promise<Got>;
export type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;

const resolveAll: Resolve = (host) => dnsLookup(host, { all: true, verbatim: true });

/** node:https with its lookup pinned to the checked addresses (both families, so the standard happy-eyeballs connect
 *  picks one that answers; SNI and the certificate still the URL's host). */
const httpsGet: Get = (url, addrs, signal) =>
  new Promise((ok, fail) => {
    const req = request(
      url,
      {
        method: "GET",
        signal,
        headers: { accept: HELPER_LOGO_TYPES.join(","), "user-agent": "helper-logo/1" },
        lookup: (_host, opts, cb) => {
          const o = opts as { all?: boolean };
          const first = addrs.find((a) => a.family === 4) ?? addrs[0]!;
          if (o.all === true) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, addrs);
          else (cb as (e: null, a: string, f: number) => void)(null, first.address, first.family);
        },
      },
      (res) => ok({ status: res.statusCode ?? 0, headers: res.headers, body: res, destroy: () => res.destroy() }),
    );
    req.on("error", fail);
    req.end();
  });

export type Logo = { type: HelperLogoType; bytes: Buffer };
/** Why a fetch gave no logo (logged by count, never with the URL). */
export class Refused extends Error {}

/** Fetches one logo under every rule in the header; throws Refused naming the rule that refused it. */
export async function fetchLogo(start: URL, deps: { resolve?: Resolve; get?: Get; timeoutMs?: number } = {}): Promise<Logo> {
  const resolve = deps.resolve ?? resolveAll;
  const get = deps.get ?? httpsGet;
  const signal = AbortSignal.timeout(deps.timeoutMs ?? FETCH_MS);
  let url = start;
  for (let hop = 0; ; hop++) {
    let addrs: { address: string; family: number }[];
    try {
      addrs = await resolve(url.hostname);
    } catch {
      throw new Refused("dns");
    }
    if (addrs.length === 0 || addrs.some((a) => blockedAddress(a.address))) throw new Refused("address");
    const r = await get(url, addrs, signal).catch((e: unknown) => {
      throw new Refused(signal.aborted ? "timeout" : `connect ${(e as Error).name}`);
    });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      r.destroy();
      const loc = r.headers.location;
      if (hop >= REDIRECTS_MAX || typeof loc !== "string") throw new Refused("redirect");
      let next: URL | null;
      try {
        next = logoUrl(new URL(loc, url).href);
      } catch {
        next = null;
      }
      if (next === null) throw new Refused("redirect target");
      url = next;
      continue;
    }
    if (r.status !== 200) {
      r.destroy();
      throw new Refused(`status ${r.status}`);
    }
    const declared = String(r.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (!(HELPER_LOGO_TYPES as readonly string[]).includes(declared)) {
      r.destroy();
      throw new Refused("type");
    }
    const length = Number(r.headers["content-length"] ?? "0");
    if (length > HELPER_LOGO_MAX_BYTES) {
      r.destroy();
      throw new Refused("size");
    }
    const chunks: Buffer[] = [];
    let n = 0;
    try {
      for await (const c of r.body) {
        n += c.byteLength;
        if (n > HELPER_LOGO_MAX_BYTES) {
          r.destroy();
          throw new Refused("size");
        }
        chunks.push(Buffer.from(c));
      }
    } catch (e) {
      r.destroy();
      if (e instanceof Refused) throw e;
      throw new Refused(signal.aborted ? "timeout" : "body");
    }
    const bytes = Buffer.concat(chunks);
    const type = sniff(bytes);
    if (type === null || type !== declared) throw new Refused("bytes");
    return { type, bytes };
  }
}

/** The logo route: the URL registry the lists fill, and the bounded, shared fetch and cache behind the route. */
export function createLogos(deps: { resolve?: Resolve; get?: Get; now?: () => number; log?: (line: string) => void; timeoutMs?: number } = {}) {
  const now = deps.now ?? Date.now;
  const urls = new Map<string, string>();
  const cache = new Map<string, { logo: Logo | null; at: number }>();
  let cacheBytes = 0;
  const inflight = new Map<string, Promise<Logo | null>>();
  let running = 0;
  const queue: (() => void)[] = [];
  const refused = new Map<string, number>();
  const key = (chain: string, token: string) => `${chain}:${token}`;

  function keep(k: string, logo: Logo | null): void {
    const old = cache.get(k);
    if (old !== undefined) {
      cacheBytes -= old.logo?.bytes.length ?? 0;
      cache.delete(k);
    }
    cache.set(k, { logo, at: now() });
    cacheBytes += logo?.bytes.length ?? 0;
    while (cache.size > CACHE_ENTRIES || cacheBytes > CACHE_BYTES) {
      const [first, v] = cache.entries().next().value!;
      cacheBytes -= v.logo?.bytes.length ?? 0;
      cache.delete(first);
    }
  }

  async function turn<T>(f: () => Promise<T>): Promise<T> {
    if (running >= PARALLEL) {
      if (queue.length >= QUEUE_MAX) throw new Refused("busy");
      await new Promise<void>((go) => queue.push(go));
    }
    running++;
    try {
      return await f();
    } finally {
      running--;
      queue.shift()?.();
    }
  }

  return {
    /** A list row's logo URL from its source: kept when it passes logoUrl; the row's `icon` is the answer. */
    remember(chain: LogoChain, token: string, raw: unknown): boolean {
      const u = logoUrl(raw);
      const k = key(chain, token);
      if (u === null) return urls.has(k);
      if (urls.get(k) !== u.href) {
        urls.delete(k);
        if (urls.size >= URLS_MAX) urls.delete(urls.keys().next().value!);
        urls.set(k, u.href);
        if (cache.get(k)?.logo === null) cache.delete(k); // a new URL is tried again at once
      }
      return true;
    },
    /** Whether a token has a logo URL (a page's row built before its list row sets `icon` from this). */
    has(chain: LogoChain, token: string): boolean {
      return urls.has(key(chain, token));
    },
    /** The token's logo, or null (no URL, or the fetch was refused): cached, one fetch in flight per token. */
    async read(chain: LogoChain, token: string): Promise<Logo | null> {
      const k = key(chain, token);
      const hit = cache.get(k);
      if (hit !== undefined && now() - hit.at < (hit.logo === null ? LOGO_NONE_MS : LOGO_OK_MS)) return hit.logo;
      const href = urls.get(k);
      if (href === undefined) return null;
      const running_ = inflight.get(k);
      if (running_ !== undefined) return running_;
      const p = turn(() => fetchLogo(new URL(href), deps))
        .then(
          (logo) => (keep(k, logo), logo),
          (e: unknown) => {
            const why = e instanceof Refused ? e.message : "internal";
            if (why === "busy") return null; // nothing kept: the next read tries again
            refused.set(why, (refused.get(why) ?? 0) + 1);
            keep(k, null);
            return null;
          },
        )
        .finally(() => inflight.delete(k));
      inflight.set(k, p);
      return p;
    },
    /** The refusals since the last call, by rule (the host log's line; never a URL or a token). */
    refusals(): string {
      const s = [...refused].map(([w, n]) => `${w} ${n}`).join(", ");
      refused.clear();
      return s;
    },
  };
}
export type Logos = ReturnType<typeof createLogos>;

/** The helper's one registry and cache: the list builders remember each row's URL, the route reads it. */
export const LOGOS: Logos = createLogos();
