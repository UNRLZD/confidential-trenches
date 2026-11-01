// POST /v1/proxy/{vendor}/{path} (markets paper H2.1-H2.3, H7). The device reaches the keyed vendors only through
// here, and never sees a key: the key comes from the host's environment, rides only on the request to the vendor's
// fixed base URL, and an answer that holds a key in any form is refused. Nothing the vendor answers is trusted for
// anything signed (H2.4): the body is passed as data and the device checks it against its own request and reads.
//
// What reaches the vendor: the allowlisted path, the caller's query string re-encoded, for a POST entry the caller's
// body byte for byte as JSON, and the key header. No header of the caller (no cookie, origin, user agent or address).
// What reaches the caller: the vendor's status and JSON body, with X-Helper-Source and X-Fetched-At. A vendor that is
// down, slow, out of quota, refusing our key, or answering anything but JSON within the size cap answers
// 503 upstream, so the device falls back to its public path (H2.3). A 429 is honoured: the vendor is left alone until
// its reset, and a request that would wait more than WAIT_MAX_MS for it answers 503 at once.
import { VENDOR_NAMES, VENDORS, type Upstream, type Vendor, type VendorName } from "./vendors.ts";

export const PROXY_BODY_MAX = 65_536; // H7 "body 64 KB"
export const QUERY_MAX = 4_096;
export const ANSWER_MAX = 4 * 1024 * 1024; // a trending list is ~250 KB (D-S3); a build or quote a few KB
export const TIMEOUT_MS = 8_000;
export const WAIT_MAX_MS = 1_000;
export const PAUSE_MAX_MS = 60_000;
export const CACHE_ENTRIES = 256;
export const CACHE_BYTES = 32 * 1024 * 1024;
const KEY_SHAPE = /^[\x21-\x7e]{8,4096}$/; // printable ASCII, no space or line break, so it can never split a header

export type ProxyAnswer = { status: number; headers: Record<string, string>; body: string };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Read = { status: number; body: string; fetchedAt: string };
type Deps = { fetch?: Fetch; now?: () => number; sleep?: (ms: number) => Promise<void> };

const error = (status: number, code: string): ProxyAnswer => ({ status, headers: {}, body: JSON.stringify({ error: { code } }) });
const UPSTREAM = () => error(503, "upstream");

/** The keys this host holds, from its environment. A key of the wrong shape stops the start; the message names the variable, never the value. */
export function readKeys(env: Record<string, string | undefined>): Partial<Record<VendorName, string>> {
  const keys: Partial<Record<VendorName, string>> = {};
  for (const name of VENDOR_NAMES) {
    const v = env[VENDORS[name].env];
    if (v === undefined || v === "") continue;
    if (!KEY_SHAPE.test(v)) throw new Error(`${VENDORS[name].env} must be 8 to 4096 printable characters with no space`);
    keys[name] = v;
  }
  return keys;
}

/** Every form a key could leave in: as set, base64, base64url and URL-encoded. */
function keyForms(keys: Partial<Record<VendorName, string>>): Buffer[] {
  const forms = new Set<string>();
  for (const k of Object.values(keys)) {
    if (!k) continue;
    const b = Buffer.from(k, "utf8");
    for (const f of [k, b.toString("base64").replace(/=+$/, ""), b.toString("base64url"), encodeURIComponent(k)]) forms.add(f);
  }
  return [...forms].map((f) => Buffer.from(f, "utf8"));
}

/** A reset header in seconds from now, or an epoch in seconds or milliseconds; Retry-After also as an HTTP date. */
export function resetMs(h: Headers, now: number): number {
  const retry = h.get("retry-after");
  if (retry !== null) {
    const s = Number(retry);
    if (Number.isFinite(s) && s >= 0) return s * 1000;
    const at = Date.parse(retry);
    if (Number.isFinite(at)) return at - now;
  }
  for (const [name, value] of h) {
    if (!/^x-ratelimit-reset/i.test(name)) continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) continue;
    if (n > 1e12) return n - now;
    if (n > 1e9) return n * 1000 - now;
    return n * 1000;
  }
  return 1000;
}

export function createProxy(env: Record<string, string | undefined>, deps: Deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const keys = readKeys(env);
  const forms = keyForms(keys);
  const pausedUntil = new Map<VendorName, number>();
  const cache = new Map<string, Read & { expires: number }>();
  let cacheBytes = 0;
  const inflight = new Map<string, Promise<Read | ProxyAnswer>>();

  const holdsKey = (text: string) => {
    const b = Buffer.from(text, "utf8");
    return forms.some((f) => b.includes(f));
  };

  function remember(id: string, read: Read, ms: number) {
    const old = cache.get(id);
    if (old) cacheBytes -= Buffer.byteLength(old.body);
    cache.delete(id);
    const size = Buffer.byteLength(read.body);
    if (size > CACHE_BYTES) return;
    while (cache.size >= CACHE_ENTRIES || cacheBytes + size > CACHE_BYTES) {
      const [oldest, entry] = cache.entries().next().value!;
      cache.delete(oldest);
      cacheBytes -= Buffer.byteLength(entry.body);
    }
    cache.set(id, { ...read, expires: now() + ms });
    cacheBytes += size;
  }

  async function readBody(r: Response): Promise<string | undefined> {
    const declared = Number(r.headers.get("content-length") ?? "0");
    if (declared > ANSWER_MAX) return undefined;
    if (!r.body) return "";
    const chunks: Uint8Array[] = [];
    let n = 0;
    for await (const c of r.body) {
      n += c.byteLength;
      if (n > ANSWER_MAX) return undefined;
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function call(name: VendorName, v: Vendor, up: Upstream, path: string, query: string, body: string): Promise<Read | ProxyAnswer> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const wait = (pausedUntil.get(name) ?? 0) - now();
      if (wait > WAIT_MAX_MS) return UPSTREAM();
      if (wait > 0) await sleep(wait);
      const headers: Record<string, string> = { accept: "application/json" };
      const key = keys[name];
      if (key) headers[v.header] = key;
      if (up.method === "POST") headers["content-type"] = "application/json";
      let r: Response;
      let text: string | undefined;
      try {
        r = await doFetch(`${v.base}${path}${query}`, {
          method: up.method,
          headers,
          body: up.method === "POST" ? body : undefined,
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (r.status === 429) {
          pausedUntil.set(name, now() + Math.min(Math.max(resetMs(r.headers, now()), 0), PAUSE_MAX_MS));
          await r.body?.cancel();
          continue;
        }
        text = await readBody(r);
      } catch {
        return UPSTREAM();
      }
      const fetchedAt = new Date(now()).toISOString();
      // our key refused (401, 403), the vendor failing (5xx), or an answer we cannot pass as JSON data
      if (r.status === 401 || r.status === 403 || r.status >= 500 || r.status < 200 || (r.status >= 300 && r.status < 400)) return UPSTREAM();
      if (text === undefined || !/^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/i.test(r.headers.get("content-type") ?? "")) return UPSTREAM();
      try {
        JSON.parse(text);
      } catch {
        return UPSTREAM();
      }
      if (holdsKey(text)) return UPSTREAM();
      return { status: r.status, body: text, fetchedAt };
    }
    return UPSTREAM();
  }

  /** One proxied call: `vendor` and `path` as the caller wrote them, `rawQuery` the text after "?" (or ""), `body` the request body. */
  async function handle(vendor: string, path: string, rawQuery: string, body: string): Promise<ProxyAnswer> {
    if (!Object.hasOwn(VENDORS, vendor)) return error(404, "not_found");
    const name = vendor as VendorName;
    const v = VENDORS[name];
    const source = (a: ProxyAnswer): ProxyAnswer => ({ ...a, headers: { "X-Helper-Source": name, ...a.headers } });
    if (!Object.hasOwn(v.paths, path)) return source(error(400, "path_not_allowed"));
    const up = v.paths[path]!;
    if (Buffer.byteLength(body) > PROXY_BODY_MAX) return source(error(413, "too_large"));
    if (rawQuery.length > QUERY_MAX) return source(error(413, "too_large"));
    const params = new URLSearchParams(rawQuery);
    if (up.cacheMs) params.sort();
    const qs = params.size ? `?${params}` : "";
    let out: Read | ProxyAnswer;
    if (up.cacheMs) {
      const id = `${name} ${path}${qs}`;
      const hit = cache.get(id);
      if (hit && hit.expires > now()) out = hit;
      else {
        let p = inflight.get(id);
        if (!p) {
          p = call(name, v, up, path, qs, "").then((read) => {
            if ("fetchedAt" in read && read.status === 200) remember(id, read, up.cacheMs!);
            return read;
          });
          p.finally(() => inflight.delete(id)).catch(() => {});
          inflight.set(id, p);
        }
        out = await p;
      }
    } else out = await call(name, v, up, path, qs, up.method === "POST" ? body : "");
    if (!("fetchedAt" in out)) return source(out);
    return source({ status: out.status, headers: { "X-Fetched-At": out.fetchedAt }, body: out.body });
  }

  return { handle, keyCount: Object.keys(keys).length };
}
