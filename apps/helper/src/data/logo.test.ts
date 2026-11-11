// GET /v1/logo/{chain}/{token} (logo.ts): each rule of the fetch is a refusal tested here, then the route as served.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { HELPER_LOGO_MAX_BYTES } from "@blindfill/kit";
import { blockedAddress, createLogos, fetchLogo, logoUrl, Refused, REDIRECTS_MAX, sniff, type Get, type Got, type Resolve } from "./logo.ts";
import { handler } from "../server.ts";
import { toRow } from "./solana/lists.ts";
import { readFileSync } from "node:fs";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const PUBLIC: Resolve = async () => [{ address: "93.184.216.34", family: 4 }];

function got(status: number, headers: Record<string, string>, body: Buffer | AsyncIterable<Uint8Array> = Buffer.alloc(0)): Got {
  const it = Buffer.isBuffer(body) ? (async function* () { if (body.length > 0) yield body; })() : body;
  return { status, headers, body: it, destroy() {} };
}
/** A fake GET by URL; records every connection it was asked to make. */
function fakeGet(by: Record<string, () => Got>, seen: { url: string; address: string }[] = []): Get {
  return async (url, addrs) => {
    seen.push({ url: url.href, address: addrs.map((a) => a.address).join(",") });
    const f = by[url.href];
    if (f === undefined) throw new Error(`unexpected fetch ${url.href}`);
    return f();
  };
}
const refusedAs = (why: string) => (e: unknown) => e instanceof Refused && e.message === why;

test("logoUrl takes only https on 443 to a DNS name, with no credentials", () => {
  assert.equal(logoUrl("https://ipfs.io/ipfs/bafy123")?.href, "https://ipfs.io/ipfs/bafy123");
  assert.equal(logoUrl("https://arweave.net:443/x")?.hostname, "arweave.net");
  for (const bad of [
    "http://ipfs.io/x", "ipfs://bafy", "data:image/png;base64,AAAA", "file:///etc/passwd", "ftp://a.b/c",
    "https://127.0.0.1/x", "https://10.0.0.1/x", "https://0x7f000001/x", "https://2130706433/x", "https://[::1]/x", "https://[::ffff:127.0.0.1]/x",
    "https://169.254.169.254/latest/meta-data", "https://a.b:8443/x", "https://user:pw@a.b/x", "https://localhost/x", "https://metadata.google.internal/x",
    "https://printer.local/x", "https://intranet/x", "https://a.b./x", `https://a.b/${"x".repeat(2100)}`, "", 42, null,
  ]) assert.equal(logoUrl(bad), null, String(bad).slice(0, 60));
});

test("blockedAddress refuses every private, loopback, link-local, shared, reserved and multicast address, in both families", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::", "::1", "fd00::1", "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::10.0.0.1", "2001:db8::1", "not-an-ip"])
    assert.equal(blockedAddress(ip), true, ip);
  for (const ip of ["93.184.216.34", "104.16.1.1", "2606:4700::6810:1", "::ffff:93.184.216.34"]) assert.equal(blockedAddress(ip), false, ip);
});

test("sniff reads png, jpeg, webp and gif from their first bytes, and never SVG or HTML", () => {
  assert.equal(sniff(PNG), "image/png");
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniff(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniff(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(sniff(SVG), null);
  assert.equal(sniff(Buffer.from("<html>")), null);
});

test("fetchLogo connects only to the address it checked, and serves the type the bytes show", async () => {
  const seen: { url: string; address: string }[] = [];
  const logo = await fetchLogo(new URL("https://ipfs.io/a.png"), { resolve: PUBLIC, get: fakeGet({ "https://ipfs.io/a.png": () => got(200, { "content-type": "image/png" }, PNG) }, seen) });
  assert.equal(logo.type, "image/png");
  assert.deepEqual(logo.bytes, PNG);
  assert.deepEqual(seen, [{ url: "https://ipfs.io/a.png", address: "93.184.216.34" }]);
});

test("fetchLogo refuses a host with any private address before it connects (DNS pointing at the box itself)", async () => {
  for (const addrs of [[{ address: "127.0.0.1", family: 4 }], [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }], [{ address: "::ffff:169.254.169.254", family: 6 }], []]) {
    const seen: { url: string; address: string }[] = [];
    await assert.rejects(fetchLogo(new URL("https://evil.example/a.png"), { resolve: async () => addrs, get: fakeGet({}, seen) }), refusedAs("address"));
    assert.equal(seen.length, 0, "no connection made");
  }
  await assert.rejects(fetchLogo(new URL("https://nx.example/a.png"), { resolve: async () => { throw new Error("ENOTFOUND"); }, get: fakeGet({}) }), refusedAs("dns"));
});

test("fetchLogo checks every redirect hop by the same rules, and follows at most REDIRECTS_MAX", async () => {
  const start = new URL("https://a.example/x");
  const to = (location: string) => () => got(302, { location });
  // to plain http, to an IP literal, to the cloud metadata address, to a relative path that is fine
  await assert.rejects(fetchLogo(start, { resolve: PUBLIC, get: fakeGet({ [start.href]: to("http://a.example/y") }) }), refusedAs("redirect target"));
  await assert.rejects(fetchLogo(start, { resolve: PUBLIC, get: fakeGet({ [start.href]: to("https://169.254.169.254/latest") }) }), refusedAs("redirect target"));
  const toPrivate: Resolve = async (h, sig) => (h === "inner.example" ? [{ address: "192.168.0.10", family: 4 }] : PUBLIC(h, sig));
  const seen: { url: string; address: string }[] = [];
  await assert.rejects(fetchLogo(start, { resolve: toPrivate, get: fakeGet({ [start.href]: to("https://inner.example/y") }, seen) }), refusedAs("address"));
  assert.deepEqual(seen.map((s) => s.url), [start.href], "the private hop is never connected to");
  const ok = await fetchLogo(start, { resolve: PUBLIC, get: fakeGet({ [start.href]: to("/y.png"), "https://a.example/y.png": () => got(200, { "content-type": "image/png" }, PNG) }) });
  assert.equal(ok.type, "image/png");
  const loop: Record<string, () => Got> = {};
  for (let i = 0; i <= REDIRECTS_MAX + 1; i++) loop[`https://a.example/${i}`] = to(`/${i + 1}`);
  await assert.rejects(fetchLogo(new URL("https://a.example/0"), { resolve: PUBLIC, get: fakeGet(loop) }), refusedAs("redirect"));
});

test("fetchLogo refuses SVG, a type its bytes do not show, a non-200, and anything past the size cap", async () => {
  const u = new URL("https://a.example/l");
  const one = (g: () => Got) => fetchLogo(u, { resolve: PUBLIC, get: fakeGet({ [u.href]: g }) });
  await assert.rejects(one(() => got(200, { "content-type": "image/svg+xml" }, SVG)), refusedAs("type"));
  await assert.rejects(one(() => got(200, { "content-type": "text/html" }, PNG)), refusedAs("type"));
  await assert.rejects(one(() => got(200, {}, PNG)), refusedAs("type"));
  await assert.rejects(one(() => got(200, { "content-type": "image/png" }, SVG)), refusedAs("bytes"), "an SVG called a PNG");
  await assert.rejects(one(() => got(200, { "content-type": "image/jpeg" }, PNG)), refusedAs("bytes"));
  await assert.rejects(one(() => got(404, { "content-type": "image/png" }, PNG)), refusedAs("status 404"));
  await assert.rejects(one(() => got(200, { "content-type": "image/png", "content-length": String(HELPER_LOGO_MAX_BYTES + 1) }, PNG)), refusedAs("size"));
  const big = (async function* () { yield PNG; for (let i = 0; i < 40; i++) yield Buffer.alloc(16_384); })();
  await assert.rejects(one(() => got(200, { "content-type": "image/png" }, big)), refusedAs("size"), "a body with no length that runs past the cap");
});

test("fetchLogo gives up after its time, a body that never ends included", async () => {
  const u = new URL("https://slow.example/l");
  const get: Get = async (_u, _a, signal) => got(200, { "content-type": "image/png" }, (async function* () {
    yield PNG;
    await new Promise((_, no) => signal.addEventListener("abort", () => no(new Error("aborted"))));
  })());
  const t0 = Date.now();
  await assert.rejects(fetchLogo(u, { resolve: PUBLIC, get, timeoutMs: 100 }), refusedAs("timeout"));
  assert.ok(Date.now() - t0 < 2_000);
});

test("createLogos fetches only URLs the lists gave, once in flight per token, and keeps a refusal", async () => {
  let calls = 0;
  const get: Get = async () => (calls++, await new Promise((r) => setTimeout(r, 20)), got(200, { "content-type": "image/png" }, PNG));
  const logos = createLogos({ resolve: PUBLIC, get });
  assert.equal(await logos.read("solana", "Mint111"), null, "no URL: no fetch");
  assert.equal(calls, 0);
  assert.equal(logos.remember("solana", "Mint111", "http://ipfs.io/x.png"), false, "a URL that fails the rules is not kept");
  assert.equal(logos.remember("solana", "Mint111", "https://ipfs.io/x.png"), true);
  const [a, b, c] = await Promise.all([logos.read("solana", "Mint111"), logos.read("solana", "Mint111"), logos.read("solana", "Mint111")]);
  assert.equal(calls, 1, "one fetch for three reads at once");
  assert.ok(a !== null && a === b && b === c);
  await logos.read("solana", "Mint111");
  assert.equal(calls, 1, "cached");
  let bad = 0;
  const lines: string[] = [];
  const refusing = createLogos({ resolve: async () => [{ address: "127.0.0.1", family: 4 }], get: async () => (bad++, got(200, {}, PNG)), log: (l) => lines.push(l) });
  refusing.remember("base", "0xabc", "https://evil.example/x.png");
  assert.equal(await refusing.read("base", "0xabc"), null);
  assert.equal(await refusing.read("base", "0xabc"), null);
  assert.equal(bad, 0);
  assert.deepEqual(lines, ["logo refusals: address 1"], "one refusal logged by rule, the second read served from the cache");
});

test("a Solana list row has icon true exactly when Jupiter gave it an icon URL that passes the rules", () => {
  const raw = JSON.parse(readFileSync(new URL("./solana/fixtures/jupiter-toptrending-1h.json", import.meta.url), "utf8"))[0];
  assert.equal(toRow(raw, Date.now())?.icon, true, "Jupiter's https icon");
  assert.equal(toRow({ ...raw, id: "So11111111111111111111111111111111111111112", icon: "http://x.y/z.png" }, Date.now())?.icon, false);
  assert.equal(toRow({ ...raw, id: "So11111111111111111111111111111111111111112", icon: undefined }, Date.now())?.icon, false);
});

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
function call(port: number, path: string, method = "GET"): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, path, method }, (res) => {
      const c: Buffer[] = [];
      res.on("data", (d: Buffer) => c.push(d));
      res.on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(c) }));
    });
    r.on("error", fail);
    r.end();
  });
}

test("GET /v1/logo/{chain}/{token} serves a listed token's logo with the kit's headers, and 404 with no body otherwise", async () => {
  const MINT = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";
  const EVM = "0x" + "ab".repeat(20);
  const seen: { url: string; address: string }[] = [];
  const logos = createLogos({ resolve: PUBLIC, get: fakeGet({ "https://arweave.net/logo": () => got(200, { "content-type": "image/png" }, PNG), "https://assets.example/e.png": () => got(200, { "content-type": "image/svg+xml" }, SVG) }, seen) });
  logos.remember("solana", MINT, "https://arweave.net/logo");
  logos.remember("base", EVM, "https://assets.example/e.png");
  const h = handler(COMMIT, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, logos);
  const s = createServer(h);
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as { port: number }).port;
  try {
    const r = await call(port, `/v1/logo/solana/${MINT}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "image/png");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["content-security-policy"], "default-src 'none'; sandbox");
    assert.equal(r.headers["cache-control"], "public, max-age=86400");
    assert.deepEqual(r.body, PNG);
    for (const p of [`/v1/logo/base/${EVM}`, "/v1/logo/solana/So11111111111111111111111111111111111111112", `/v1/logo/near/${MINT}`, `/v1/logo/solana/${MINT}/x`, `/v1/logo/base/${EVM.toUpperCase().replace("0X", "0x")}`, "/v1/logo/solana/https%3A%2F%2Fevil.example", "/v1/logo/"]) {
      const n = await call(port, p);
      assert.equal(n.status, 404, p);
      assert.equal(n.body.length, 0, `${p}: no body`);
    }
    assert.equal((await call(port, `/v1/logo/solana/${MINT}`, "POST")).status, 405);
    assert.deepEqual(seen.map((x) => x.url), ["https://arweave.net/logo", "https://assets.example/e.png"], "the caller's path never named a URL fetched");
  } finally {
    s.closeAllConnections();
    await new Promise<void>((ok) => s.close(() => ok()));
  }
});

// The security read of 815b0078: DNS with no deadline on libuv's pool, the real request's pin and signal untested, three
// address forms, the env proxy, a full queue cached as a 404, and the refusal line never written.
import * as L from "./logo.ts";
import { createServer as tcpServer, type Server as TcpServer, type Socket } from "node:net";
import { createSocket } from "node:dgram";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const within = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`${what}: still running after ${ms} ms`)), ms).unref())]);

test("a lookup that never answers ends at the fetch's deadline, and logo lookups in flight never pass DNS_PARALLEL", async () => {
  let open = 0;
  let most = 0;
  const hang: Resolve = (_h, signal) => {
    open++;
    most = Math.max(most, open);
    signal?.addEventListener("abort", () => open--, { once: true });
    return new Promise(() => {});
  };
  const t0 = Date.now();
  const runs = Array.from({ length: 6 }, () => fetchLogo(new URL("https://never.example/x.png"), { resolve: hang, timeoutMs: 300 }).then(() => "ok", (e: unknown) => (e as Error).message));
  const why = await within(Promise.all(runs), 1_500, "six hanging lookups");
  assert.ok(Date.now() - t0 < 1_000, `ended in ${Date.now() - t0} ms`);
  assert.deepEqual([...new Set(why)], ["timeout"]);
  assert.ok(most <= 2, `${most} lookups in flight at once`);
  assert.equal(L.DNS_PARALLEL, 2);
  // the slots are free again: a lookup that answers runs at once
  const seen: { url: string; address: string }[] = [];
  const logo = await fetchLogo(new URL("https://arweave.net/a"), { resolve: PUBLIC, get: fakeGet({ "https://arweave.net/a": () => got(200, { "content-type": "image/png" }, PNG) }, seen) });
  assert.equal(logo.type, "image/png");
});

test("the helper's own lookup goes through c-ares with a deadline: a name server that never answers is cut by the signal", async () => {
  const silent = createSocket("udp4");
  let asked = 0;
  silent.on("message", () => asked++);
  await new Promise<void>((ok) => silent.bind(0, "127.0.0.1", ok));
  try {
    assert.equal(typeof L.systemResolve, "function", "logo.ts exports systemResolve");
    const t0 = Date.now();
    const r = await within(L.systemResolve("never.example", AbortSignal.timeout(300), [`127.0.0.1:${silent.address().port}`]).then(() => "answered", (e: unknown) => String((e as { code?: string }).code ?? (e as Error).name)), 1_500, "a silent name server");
    assert.notEqual(r, "answered");
    assert.ok(Date.now() - t0 < 1_000, `ended in ${Date.now() - t0} ms`);
    assert.ok(asked >= 1, "the lookup asked the given name server");
  } finally {
    silent.close();
  }
});

/** A TCP server standing in for a TLS host: it reads the ClientHello and never answers it. */
async function helloServer(): Promise<{ s: TcpServer; port: number; hellos: Buffer[]; socks: Socket[] }> {
  const hellos: Buffer[] = [];
  const socks: Socket[] = [];
  const s = tcpServer((c) => {
    socks.push(c);
    c.once("data", (d) => hellos.push(d));
    c.on("error", () => {});
  });
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  return { s, port: (s.address() as { port: number }).port, hellos, socks };
}
const closeAll = async (x: { s: TcpServer; socks: Socket[] }) => {
  for (const c of x.socks) c.destroy();
  await new Promise<void>((ok) => x.s.close(() => ok()));
};

test("the real request connects to the checked address for a name DNS cannot resolve, with that name in SNI, and its signal cuts a stalled host", async () => {
  const srv = await helloServer();
  try {
    assert.equal(typeof L.httpsGet, "function", "logo.ts exports httpsGet");
    const t0 = Date.now();
    const why = await within(L.httpsGet(new URL(`https://pinned.invalid:${srv.port}/x.png`), [{ address: "127.0.0.1", family: 4 }], AbortSignal.timeout(400)).then(() => "ok", (e: unknown) => (e as Error).name), 2_000, "a stalled host");
    assert.equal(srv.hellos.length, 1, "the pinned address got the connection (an unresolvable name: no pin, no connection)");
    assert.ok(srv.hellos[0]!.includes(Buffer.from("pinned.invalid")), "SNI is the URL's name");
    assert.equal(why, "AbortError");
    assert.ok(Date.now() - t0 < 1_500, `cut in ${Date.now() - t0} ms`);
  } finally {
    await closeAll(srv);
  }
});

test("the logo request never takes the environment's proxy (NODE_USE_ENV_PROXY with HTTPS_PROXY set)", async () => {
  const srv = await helloServer();
  const proxy = await helloServer();
  try {
    const mod = new URL("./logo.ts", import.meta.url).href;
    const code = `const L = await import(${JSON.stringify(mod)}); await L.httpsGet(new URL("https://pinned.invalid:${srv.port}/x.png"), [{ address: "127.0.0.1", family: 4 }], AbortSignal.timeout(600)).catch(() => {}); process.exit(0);`;
    const env = { ...process.env, NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, NO_PROXY: "" };
    const status = await within(new Promise<number | null>((ok) => spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: fileURLToPath(new URL(".", import.meta.url)), env, stdio: "ignore" }).on("exit", ok)), 10_000, "the child");
    assert.equal(status, 0);
    assert.equal(proxy.hellos.length, 0, "nothing went to the proxy");
    assert.equal(srv.hellos.length, 1, "the pinned address got the connection");
  } finally {
    await closeAll(srv);
    await closeAll(proxy);
  }
});

test("blockedAddress refuses the IPv4-compatible, IPv4-translated and NAT64 forms of a private address", () => {
  for (const ip of ["::7f00:1", "::127.0.0.1", "::ffff:0:7f00:1", "::ffff:0:127.0.0.1", "64:ff9b::1", "64:ff9b::7f00:1", "64:ff9b::a00:1"]) assert.equal(blockedAddress(ip), true, ip);
  for (const ip of ["2606:4700::6810:84e5", "93.184.216.34", "::ffff:93.184.216.34"]) assert.equal(blockedAddress(ip), false, ip);
});

test("a full fetch queue answers 503 with no-store, never a cached 404; a refusal is logged by rule with no URL", async () => {
  const lines: string[] = [];
  const logos = createLogos({ resolve: async () => [{ address: "10.0.0.1", family: 4 }], log: (l) => lines.push(l) });
  logos.remember("solana", "MintA", "https://evil.example/a.png");
  logos.remember("solana", "MintB", "https://evil.example/b.png");
  assert.equal(await logos.read("solana", "MintA"), null);
  assert.equal(await logos.read("solana", "MintB"), null);
  assert.equal(lines.length, 1, "one line per window");
  assert.match(lines[0]!, /^logo refusals: address 1$/);
  assert.ok(!lines.join("").includes("evil") && !lines.join("").includes("Mint"));
  // the route: a busy registry answers 503 no-store
  const busy = { ...createLogos(), read: async () => "busy" as const } as unknown as Parameters<typeof handler>[22];
  const h = handler(COMMIT, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, busy);
  const s = createServer(h);
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  try {
    const r = await call((s.address() as { port: number }).port, "/v1/logo/solana/6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN");
    assert.equal(r.status, 503);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.body.length, 0);
  } finally {
    s.closeAllConnections();
    await new Promise<void>((ok) => s.close(() => ok()));
  }
});
