// node --test apps/helper/src/proxy/proxy.test.ts: the proxy (markets paper H2.1-H2.3, H7) with a fake vendor. Keys
// come only from the environment and never come back; only allowlisted paths are served; a vendor that fails, holds
// back past a short wait answers 429 with its reset, one that answers anything but JSON answers 503 upstream; only public lists are cached, never a quote.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LEND_NEW_SHARES } from "../limits/limits.ts";
import * as proxyModule from "./proxy.ts";
import { ANSWER_MAX, createProxy, PROXY_BODY_MAX, readKeys, resetMs, WAIT_MAX_MS } from "./proxy.ts";
// read off the module, so this file still loads at a base without it
const QUEUE_POLL_MS = (proxyModule as unknown as { QUEUE_POLL_MS?: number }).QUEUE_POLL_MS ?? 250;
// read off the module, so this file still loads at a base without them and its tests fail on the behaviour (red runs)
const { checkVendorPlans } = proxyModule as unknown as { checkVendorPlans: (env: Record<string, string | undefined>) => void };
const { PROXY_BUDGETS, proxyBudgetEnv } = proxyModule as unknown as { PROXY_BUDGETS: Record<string, { total: number; perClient: number; reserve?: number }>; proxyBudgetEnv: (v: string) => string };
// the mechanism tests run on an explicit budget, so they read the same whatever the defaults are
const PROXY_VENDOR_MAX = 300;
const PROXY_CLIENT_MAX = 60;
const WIDE = { PROXY_BUDGET_JUPITER: `${PROXY_VENDOR_MAX},${PROXY_CLIENT_MAX}` };
import { VENDOR_NAMES, VENDORS } from "./vendors.ts";

const ENV = {
  JUPITER_API_KEY: "fake-jupiter-key-" + "j".repeat(16),
  RELAY_API_KEY: "fake-relay-key-" + "r".repeat(16),
  LIFI_API_KEY: "fake-lifi-key-" + "l".repeat(16),
  ONECLICK_JWT: "fake.oneclick.jwt-" + "o".repeat(16),
};
type Seen = { url: string; method: string; headers: Record<string, string>; body: string | undefined };

/** A fake vendor: records each call and answers with `answer(call, n)`. */
function vendor(answer: (c: Seen, n: number) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const c: Seen = { url, method: String(init.method), headers: { ...(init.headers as Record<string, string>) }, body: init.body as string | undefined };
    seen.push(c);
    return answer(c, seen.length);
  };
  return { seen, fetch };
}
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
const clock = (t0 = 1_800_000_000_000) => {
  let t = t0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), add: (ms: number) => void (t += ms) };
};

test("the vendor list is the kit's HELPER_PROXY_VENDORS, each on a fixed https base with a header key", () => {
  assert.deepEqual([...VENDOR_NAMES], ["jupiter", "relay", "lifi", "oneclick"]);
  for (const n of VENDOR_NAMES) {
    const v = VENDORS[n];
    assert.match(v.base, /^https:\/\/[a-z0-9.-]+$/, n);
    for (const p of Object.keys(v.paths)) assert.match(p, /^(\/[a-z0-9]+)+$/, `${n} ${p}`);
  }
  // never a quote, a build or a status in the cache (H2.1 "Cached")
  const cached = VENDOR_NAMES.flatMap((n) => Object.entries(VENDORS[n].paths).filter(([, u]) => u.cacheMs).map(([p]) => `${n}${p}`));
  assert.deepEqual(cached.sort(), [
    "jupiter/tokens/v2/recent",
    "jupiter/tokens/v2/toptrending/1h",
    "jupiter/tokens/v2/toptrending/24h",
    "jupiter/tokens/v2/toptrending/5m",
    "jupiter/tokens/v2/toptrending/6h",
    "oneclick/v0/tokens",
  ]);
});

test("keys come from the environment only, each on its vendor's header, and the caller's body goes byte for byte", async () => {
  const f = vendor(() => json({ ok: 1 }));
  const p = createProxy(ENV, { fetch: f.fetch });
  const body = '{"user":"0xabc","includeProtocolData":true,  "amount":"1"}';
  await p.handle("relay", "/quote/v2", "", body);
  await p.handle("jupiter", "/swap/v2/build", "inputMint=So11&amount=5&taker=W", "ignored");
  await p.handle("lifi", "/v1/quote", "fromChain=8453", "");
  await p.handle("oneclick", "/v0/status", "depositAddress=abc", "");
  assert.deepEqual(
    f.seen.map((c) => [c.method, c.url]),
    [
      ["POST", "https://api.relay.link/quote/v2"],
      ["GET", "https://api.jup.ag/swap/v2/build?inputMint=So11&amount=5&taker=W"],
      ["GET", "https://li.quest/v1/quote?fromChain=8453"],
      ["GET", "https://1click.chaindefuser.com/v0/status?depositAddress=abc"],
    ],
  );
  assert.equal(f.seen[0]!.body, body, "relay quote/v2 body unchanged");
  assert.equal(f.seen[1]!.body, undefined, "a GET entry sends no body");
  assert.deepEqual(f.seen[0]!.headers, { accept: "application/json", "x-api-key": ENV.RELAY_API_KEY, "content-type": "application/json" });
  assert.deepEqual(f.seen[1]!.headers, { accept: "application/json", "x-api-key": ENV.JUPITER_API_KEY });
  assert.deepEqual(f.seen[2]!.headers, { accept: "application/json", "x-lifi-api-key": ENV.LIFI_API_KEY });
  assert.deepEqual(f.seen[3]!.headers, { accept: "application/json", "x-api-key": ENV.ONECLICK_JWT });
});

test("a vendor with no key in the environment is called with no key header", async () => {
  const f = vendor(() => json([]));
  await createProxy({}, { fetch: f.fetch }).handle("oneclick", "/v0/tokens", "", "");
  assert.deepEqual(f.seen[0]!.headers, { accept: "application/json" });
});

test("a key of the wrong shape stops the start, and the message names the variable, never the value", () => {
  for (const bad of ["short", "has space in-it-0123", "line\r\nX-Injected: 1", "é-not-ascii-0123456"]) {
    assert.throws(() => readKeys({ RELAY_API_KEY: bad }), (e: Error) => e.message.startsWith("RELAY_API_KEY ") && !e.message.includes(bad));
  }
});

test("the answer: the vendor's status and JSON body, X-Helper-Source and X-Fetched-At, and no vendor header", async () => {
  const c = clock();
  const f = vendor(() => json({ route: [] }, 200, { "set-cookie": "a=b", "x-ratelimit-remaining": "3", server: "up" }));
  const a = await createProxy(ENV, { fetch: f.fetch, now: c.now }).handle("jupiter", "/swap/v2/build", "", "");
  const { timing, ...answer } = a;
  assert.deepEqual(answer, { status: 200, headers: { "X-Helper-Source": "jupiter", "X-Fetched-At": new Date(c.now()).toISOString() }, body: '{"route":[]}' });
  // the call's own waits for the helper's Server-Timing (card helper-ready-page-warm): a field of the answer, never a header
  assert.deepEqual(timing?.map((e) => e.split(";")[0]), ["budget", "turn", "send"]);
  const b = await createProxy(ENV, { fetch: vendor(() => json({ error: "no route" }, 400)).fetch }).handle("jupiter", "/swap/v2/build", "", "");
  assert.equal(b.status, 400, "a vendor's own 4xx passes as data");
  assert.equal(b.body, '{"error":"no route"}');
});

test("only allowlisted paths, written exactly: anything else never reaches a vendor", async () => {
  const f = vendor(() => json({}));
  const p = createProxy(ENV, { fetch: f.fetch });
  const refused: [string, string, number, string][] = [
    ["evil", "/v0/tokens", 404, "not_found"],
    ["__proto__", "/v0/tokens", 404, "not_found"],
    ["Jupiter", "/swap/v2/build", 404, "not_found"],
    ["jupiter", "/swap/v2/execute", 400, "path_not_allowed"],
    ["jupiter", "/swap/v2/build/", 400, "path_not_allowed"],
    ["jupiter", "/swap/v2/../v2/build", 400, "path_not_allowed"],
    ["jupiter", "/swap/v2/%62uild", 400, "path_not_allowed"],
    ["jupiter", "//evil.example/swap/v2/build", 400, "path_not_allowed"],
    ["jupiter", "@evil.example/swap/v2/build", 400, "path_not_allowed"],
    ["relay", "/constructor", 400, "path_not_allowed"],
    ["oneclick", "/v0/deposit/submit", 400, "path_not_allowed"],
  ];
  for (const [v, path, status, code] of refused) {
    const a = await p.handle(v, path, "", "");
    assert.equal(a.status, status, `${v} ${path}`);
    assert.deepEqual(JSON.parse(a.body), { error: { code } }, `${v} ${path}`);
  }
  assert.equal(f.seen.length, 0);
});

test("the query is re-encoded, so it cannot add a path, a host or a fragment", async () => {
  const f = vendor(() => json({}));
  await createProxy(ENV, { fetch: f.fetch }).handle("lifi", "/v1/status", "txHash=0x1#frag&x=a b&y=%2F..%2F&@=h", "");
  const u = new URL(f.seen[0]!.url);
  assert.equal(u.origin + u.pathname, "https://li.quest/v1/status");
  assert.equal(u.hash, "");
  assert.deepEqual([...u.searchParams], [["txHash", "0x1#frag"], ["x", "a b"], ["y", "/../"], ["@", "h"]]);
});

test("bodies over 64 KB and queries over 4 KB answer 413 too_large and reach no vendor", async () => {
  const f = vendor(() => json({}));
  const p = createProxy(ENV, { fetch: f.fetch });
  assert.equal((await p.handle("relay", "/quote/v2", "", "x".repeat(PROXY_BODY_MAX + 1))).status, 413);
  assert.equal((await p.handle("lifi", "/v1/quote", "a=" + "b".repeat(4096), "")).status, 413);
  assert.equal((await p.handle("relay", "/quote/v2", "", "x".repeat(PROXY_BODY_MAX))).status, 200, "exactly 64 KB passes");
  assert.equal(f.seen.length, 1);
});

test("a vendor down, slow, refusing our key, redirecting or answering non-JSON answers 503 upstream", async () => {
  const cases: [string, () => Response | Promise<Response>][] = [
    ["500", () => json({ e: 1 }, 500)],
    ["502 html", () => new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } })],
    ["401 our key refused", () => json({ message: "invalid key" }, 401)],
    ["403", () => json({ message: "forbidden" }, 403)],
    ["200 text/html", () => new Response("<script>x</script>", { headers: { "content-type": "text/html" } })],
    ["200 bad json", () => new Response("{not json", { headers: { "content-type": "application/json" } })],
    ["200 no type", () => new Response("{}", { headers: {} })],
    ["302", () => new Response(null, { status: 302, headers: { location: "https://evil.example" } })],
    ["network error", () => Promise.reject(new TypeError("fetch failed"))],
    ["over the answer cap", () => new Response("[" + "0,".repeat(ANSWER_MAX / 2) + "0]", { headers: { "content-type": "application/json" } })],
  ];
  for (const [name, answer] of cases) {
    const a = await createProxy(ENV, { fetch: vendor(answer).fetch }).handle("jupiter", "/swap/v2/build", "", "");
    assert.deepEqual([a.status, JSON.parse(a.body)], [503, { error: { code: "upstream" } }], name);
    assert.equal(a.headers["X-Helper-Source"], "jupiter", name);
  }
});

test("an answer that holds one of our keys in any form is refused, never passed on", async () => {
  const k = ENV.ONECLICK_JWT;
  const forms = [k, Buffer.from(k).toString("base64"), Buffer.from(k).toString("base64url"), encodeURIComponent(k), `Bearer ${k}`];
  for (const form of forms) {
    for (const status of [200, 400]) {
      // a vendor that echoes the request's headers back, as a debug endpoint or a broken build would
      const a = await createProxy(ENV, { fetch: vendor(() => json({ echo: { authorization: form } }, status)).fetch }).handle("jupiter", "/swap/v2/build", "", "");
      assert.deepEqual([a.status, JSON.parse(a.body)], [503, { error: { code: "upstream" } }], `${status} ${form.slice(0, 12)}`);
      assert.ok(!a.body.includes(form));
    }
  }
  // another vendor's key counts too
  const b = await createProxy(ENV, { fetch: vendor(() => json({ leaked: ENV.LIFI_API_KEY })).fetch }).handle("relay", "/intents/status/v3", "", "");
  assert.equal(b.status, 503);
});

// card helper-abuse-limits (review finding 3): the helper is the vendor's one client, so a vendor's 429 holds the
// vendor until its reset (at 06a656f the next caller still reached the vendor). Card helper-crowd-429 fold 6: the hold
// is never the caller's 429 (a 429 of ours says the caller is past its own limit, live run 41943005189): a reset inside
// the call's wait is waited out, one past it is the not-ready 503 upstream, code only
test("429: the vendor is held until its reset (at most a minute); a reset inside the call's wait is waited out and read; a long one answers every caller 503 upstream, code only, and nothing reaches the vendor inside it", async () => {
  const c = clock();
  const f = vendor((_, n) => (n === 1 ? json({ e: "slow down" }, 429, { "retry-after": "0.5" }) : json({ ok: n })));
  const p = createProxy(ENV, { fetch: f.fetch, now: c.now, sleep: c.sleep });
  const t0 = c.now();
  const a = await p.handle("relay", "/intents/status/v3", "requestId=1", "");
  assert.deepEqual([a.status, a.body], [200, '{"ok":2}']);
  assert.equal(c.now() - t0, 500, "waited the vendor's Retry-After");

  const c2 = clock();
  let throttle = true;
  const g = vendor(() => (throttle ? json({ e: "slow down, key fake" }, 429, { "x-ratelimit-reset": "30" }) : json({ ok: 1 })));
  const q = createProxy(ENV, { fetch: g.fetch, now: c2.now, sleep: c2.sleep });
  const t = await q.handle("lifi", "/v1/status", "", "", "heavy");
  // card solana-legs-share-wait: with the seconds to the vendor's reset, so a device waits it out and asks again
  assert.deepEqual([t.status, t.headers["Retry-After"], JSON.parse(t.body)], [503, "30", { error: { code: "upstream" } }], "the code only: no vendor text, never our 429");
  assert.equal(g.seen.length, 1, "a long reset is not waited by the request");
  throttle = false;
  c2.add(10_000);
  const h = await q.handle("lifi", "/v1/quote", "", "", "honest");
  assert.deepEqual([h.status, h.headers["Retry-After"]], [503, "20"], "another caller meets the vendor's reset as not ready too, 20 s from its end");
  assert.equal((await q.handle("lifi", "/v1/status", "", "")).status, 503, "and so does the helper's own read");
  assert.equal(g.seen.length, 1, "nothing reached the vendor inside its reset");
  assert.equal((await q.handle("relay", "/quote/v2", "", "{}", "honest")).status, 200, "another vendor is not held");
  const t1 = c2.now();
  const w = await q.handle("lifi", "/v1/status", "", "", "patient", false, 25_000);
  assert.deepEqual([w.status, c2.now() - t1], [200, 20_000], "a call whose wait covers the reset waits it out, then reads");
  assert.equal(g.seen.length, 3, "one read at the reset, beside the relay call");
  assert.equal((await q.handle("lifi", "/v1/quote", "", "", "honest")).status, 200, "at the reset the vendor is open");
  assert.ok(WAIT_MAX_MS < 30_000);
});

test("each vendor is one budget callers draw from fairly: a heavy caller is lent past its share while a share stays free, then throttled while an honest one still goes; a cache hit counts in the caller's share only", async () => {
  const c = clock();
  const f = vendor(() => json({ ok: 1 }));
  // a refused caller's wait (card helper-crowd-429) passes no time here
  const p = createProxy({ ...ENV, ...WIDE }, { burstMs: 0, fetch: f.fetch, now: () => (c.add(1), c.now()), sleep: async () => {} });
  // past its share the heavy caller is lent from the idle total (lend) while a share stays free for the next caller
  const part = PROXY_VENDOR_MAX - PROXY_BUDGETS.jupiter!.reserve!;
  const lent = part - LEND_NEW_SHARES * PROXY_CLIENT_MAX; // fold 4: three shares stay free for callers not seen yet
  for (let i = 0; i < lent; i++) assert.equal((await p.handle("jupiter", "/swap/v2/build", `n=${i}`, "", "heavy")).status, 200, `build ${i}`);
  const h = await p.handle("jupiter", "/swap/v2/build", "n=x", "", "heavy");
  assert.equal(h.status, 429);
  assert.deepEqual(JSON.parse(h.body), { error: { code: "rate_limited" } });
  const wait = Number(h.headers["Retry-After"]);
  assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= 61, `Retry-After ${wait}: the vendor's minute, as the total turns`);
  assert.equal(f.seen.length, lent, "the throttled draw never reached the vendor");
  assert.equal((await p.handle("jupiter", "/swap/v2/build", "n=y", "", "honest")).status, 200, "an honest caller in the same window");
  assert.equal((await p.handle("relay", "/quote/v2", "", "{}", "heavy")).status, 200, "another vendor is its own budget");
  // a cached list: the first read draws; a hit reaches no vendor but counts in the reader's share, so a heavy reader
  // of a hit is throttled at its share while the vendor sees one call
  const before = f.seen.length;
  for (let i = 0; i < PROXY_CLIENT_MAX; i++) assert.equal((await p.handle("jupiter", "/tokens/v2/recent", "", "", "reader")).status, 200, `read ${i}`);
  assert.equal((await p.handle("jupiter", "/tokens/v2/recent", "", "", "reader")).status, 429, "past its share, a hit too");
  assert.equal(f.seen.length, before + 1, "one vendor call for every read");
  // readers enough that their hits, were they drawn from the vendor's total, would spend all of it
  for (let r = 0; r < PROXY_VENDOR_MAX / PROXY_CLIENT_MAX; r++) for (let i = 0; i < PROXY_CLIENT_MAX; i++) await p.handle("jupiter", "/tokens/v2/recent", "", "", `reader-${r}`);
  assert.equal(f.seen.length, before + 1, "still one vendor call");
  assert.equal((await p.handle("jupiter", "/swap/v2/build", "n=w", "", "honest")).status, 200, "the hits took nothing from the vendor's total");
  c.add(wait * 1000);
  assert.equal((await p.handle("jupiter", "/swap/v2/build", "n=z", "", "heavy")).status, 200, "after the named wait the heavy caller goes again");
  assert.ok(PROXY_CLIENT_MAX * 5 <= PROXY_VENDOR_MAX);
});

test("review F-C2: one address reading a cached proxy list 1000 times in one window meets a 429", async () => {
  let t = 1_800_000_000_000;
  let up = 0;
  const big = JSON.stringify({ tokens: "x".repeat(250_000) });
  const p = createProxy(WIDE, { now: () => (t += 1), fetch: async () => (up++, new Response(big, { status: 200, headers: { "content-type": "application/json" } })) });
  let throttled = 0;
  for (let i = 0; i < 1000; i++) if ((await p.handle("jupiter", "/tokens/v2/toptrending/1h", "", "", "203.0.113.67")).status === 429) throttled++;
  assert.ok(throttled >= 1000 - PROXY_CLIENT_MAX, `${throttled} of 1000 cached reads throttled`);
  assert.equal(up, 1, "one vendor call");
});

test("each vendor's budget is PROXY_BUDGET_<VENDOR> when set (\"<total>,<per client>\"), else its published limit's; a bad value stops the start naming the variable", async () => {
  const M = 60_000; // every vendor's limit is a minute's
  assert.deepEqual(PROXY_BUDGETS, { jupiter: { total: 60, perClient: 4, windowMs: M, reserve: 34, lend: true }, relay: { total: 50, perClient: 2, windowMs: M, reserve: 0, lend: true }, lifi: { total: 100, perClient: 2, windowMs: M, reserve: 0, lend: true }, oneclick: { total: 50, perClient: 2, windowMs: M, reserve: 0, lend: true } });
  for (const v of VENDOR_NAMES) assert.ok(PROXY_BUDGETS[v]!.perClient < PROXY_BUDGETS[v]!.total, v);
  assert.equal(proxyBudgetEnv("oneclick"), "PROXY_BUDGET_ONECLICK");
  assert.throws(() => createProxy({ PROXY_BUDGET_RELAY: "8,8" }), /^Error: PROXY_BUDGET_RELAY must be/);
  assert.throws(() => createProxy({ PROXY_BUDGET_LIFI: "secret-ish" }), (e: Error) => !e.message.includes("secret-ish"));
  let t = 1_800_000_000_000;
  const f = vendor(() => json({ ok: 1 }));
  const p = createProxy({ PROXY_BUDGET_RELAY: "3,2" }, { burstMs: 0, fetch: f.fetch, now: () => (t += 1), sleep: async () => {} });
  for (let i = 0; i < 3; i++) await p.handle("relay", "/quote/v2", "", "{}", "a");
  assert.equal(f.seen.length, 2, "the share from the environment");
  for (let i = 0; i < 3; i++) await p.handle("relay", "/quote/v2", "", "{}", "b");
  assert.equal(f.seen.length, 3, "the total from the environment");
  // card helper-crowd-429: past its share of Jupiter's default, "a" is lent from the idle total (lend)
  for (let i = 0; i < 5; i++) await p.handle("jupiter", "/swap/v2/build", "", "", "a");
  assert.equal(f.seen.length, 3 + 5, "another vendor keeps its default, its share lent while the total sits idle");
});

// review F-D on the proxy: a vendor that keeps its published per-minute limit on a 60-second sliding window (the
// helper's own Jupiter reads drawn too), and addresses at their full share until an honest first-time caller is
// refused. At 06a656f's design budget (300 a window, 60 a caller) one or two addresses make the vendor throttle, which
// holds the vendor for everyone; at the published defaults the vendor never throttles and it takes total / share.
test("review F-D (proxy): at each vendor's published limit, no set of callers can make the vendor throttle; the callers' part is served in full and at least two addresses are needed to refuse an honest caller", async () => {
  const PER_MIN = { jupiter: 60, relay: 50, lifi: 100, oneclick: 50 } as const;
  const run = async (v: keyof typeof PER_MIN, env: Record<string, string>) => {
    let t = 1_800_000_000_000;
    const calls: number[] = [];
    let throttledByVendor = 0;
    const f = async () => {
      while (calls.length > 0 && t - calls[0]! >= 60_000) calls.shift();
      if (calls.length >= PER_MIN[v]) return (throttledByVendor++, json({ e: "slow" }, 429, { "retry-after": "60" }));
      calls.push(t);
      return json({ ok: 1 });
    };
    const p = createProxy(env, { burstMs: 0, fetch: f, now: () => (t += 1), sleep: async () => {} });
    const path = { jupiter: "/swap/v2/build", relay: "/quote/v2", lifi: "/v1/quote", oneclick: "/v0/quote" }[v];
    const body = v === "relay" || v === "oneclick" ? "{}" : "";
    // the helper's own Jupiter reads (search at most 15 a minute, Discover's lists 15), here 5, drawn from its reserve
    const own = v === "jupiter" ? 5 : 0;
    for (let i = 0; i < own; i++) await p.handle(v, "/tokens/v2/search", `query=${i}`, "", undefined, true);
    let n = 0;
    let served = 0;
    for (; n < 50; n++) {
      for (let i = 0; i < 200; i++) if ((await p.handle(v, path, `a=${i}`, body, `198.51.100.${n}`)).status !== 200) break; else served++;
      if ((await p.handle(v, path, "h=1", body, `192.0.2.${n}`)).status !== 200) break; // a first-time caller each round
      served++;
    }
    return { addresses: n + 1, throttledByVendor, own, served };
  };
  for (const v of VENDOR_NAMES) {
    const today = await run(v, { [proxyBudgetEnv(v)]: "300,60" });
    const now = await run(v, {});
    assert.ok(today.throttledByVendor > 0, `${v} at 06a656f's budget: the vendor throttled, so it was held for everyone`);
    assert.equal(now.throttledByVendor, 0, `${v}: the vendor never throttled`);
    // card helper-crowd-429 (lend): the first address is lent past its share while a share stays free, the next takes
    // its share and the honest caller one; the honest caller is refused only once the whole callers' part (the total
    // less the helper's own reserve) is served, never by the vendor, and never by fewer than two addresses
    const part = PROXY_BUDGETS[v]!.total - (PROXY_BUDGETS[v]!.reserve ?? 0);
    assert.equal(now.served, part, `${v}: the callers' part served in full, never past it`);
    console.log(`  [F-D proxy] ${v}: ${now.addresses} addresses at the published default, ${today.addresses} at 06a656f's budget`);
    assert.ok(now.addresses >= 2, `${v}: ${now.addresses} addresses`);
  }
});

// re-check F-D (sustained): Jupiter Free (60 a sliding minute) for three minutes, addresses drawing the whole budget
// at the last ms of each 10 s window and the first of the next (the most a sliding minute can hold under fixed windows),
// with the helper's own Jupiter reads as deployed: Discover's three lists every 12 s through the 10 s cache
// (data/solana/lists.ts) and one token search every 4 s (data/solana/token.ts JUP_GAP_MS).
// card helper-page-jup-429: on the real default window (BURST_MS) and a moving clock, the minute budget still holds
test("re-check F-D (sustained): at Jupiter Free's 60 a sliding minute, the helper's own reads and every caller together never make Jupiter throttle", async () => {
  let t = 1_800_000_000_000;
  const T0 = t;
  const calls: number[] = [];
  let refused = 0;
  let peak = 0;
  const f = async () => {
    while (calls.length > 0 && t - calls[0]! >= 60_000) calls.shift();
    if (calls.length >= 60) return (refused++, new Response("slow", { status: 429 }));
    calls.push(t);
    peak = Math.max(peak, calls.length);
    return json({ ok: 1 });
  };
  const p = createProxy({}, { now: () => t, fetch: f, sleep: async (ms) => void (t += ms) });
  let q = 0;
  let own = 0;
  let asked = 0;
  // each event at its own time; a wait the proxy takes (Jupiter's turn, card helper-page-jup-429) moves the clock on,
  // and it never goes back, so an event due meanwhile runs as soon as the wait ends
  const events: [number, () => Promise<void>][] = [];
  for (let ms = 0; ms < 180_000; ms += 1) {
    if (ms === 9_999 || (ms >= 10_000 && ms % 10_000 === 0))
      events.push([ms, async () => { for (let a = 0; a < 20; a++) for (let i = 0; i < 4; i++) await p.handle("jupiter", "/swap/v2/build", `q=${q++}`, "", `198.51.100.${a}`); }]);
    if (ms % 12_000 === 0) events.push([ms, async () => { for (const l of ["/tokens/v2/recent", "/tokens/v2/toptrending/5m", "/tokens/v2/toptrending/1h"]) (asked++, (await p.handle("jupiter", l, "limit=100", "", undefined, true)).status === 200 && own++); }]);
    if (ms % 4_000 === 0) events.push([ms, async () => void (asked++, (await p.handle("jupiter", "/tokens/v2/search", `query=m${ms}`, "", undefined, true)).status === 200 && own++)]);
  }
  for (const [ms, run] of events) {
    t = Math.max(t, T0 + ms);
    await run();
  }
  console.log(`  [F-D sustained] jupiter Free 3 min, 20 addresses at full draw + own reads: vendor peak ${peak}/60 s, vendor 429s ${refused}, own reads served ${own}/${asked}`);
  assert.equal(refused, 0, "Jupiter never answered 429");
  assert.equal(own, asked, "every own read was served: no caller can make Discover or the token page stale (fold 5)");
  assert.ok(peak <= 60, `the plan is never passed: peak ${peak}`);
});

test("fold 5: the own-read reserve holds at any plan: a Developer key's 600 leaves callers 566 and the helper's own reads their 34; at Free 26 and 34", async () => {
  for (const [env, total] of [[{ PROXY_BUDGET_JUPITER: "600,4" }, 600], [{}, 60]] as const) {
    const f = vendor(() => json({ ok: 1 }));
    const p = createProxy(env, { burstMs: 0, fetch: f.fetch, now: () => 1_800_000_000_000, sleep: async () => {} });
    let callers = 0;
    for (let a = 0; a < 200; a++) for (let i = 0; i < 4; i++) if ((await p.handle("jupiter", "/swap/v2/build", `q=${a}-${i}`, "", `198.51.100.${a}`)).status === 200) callers++;
    assert.equal(callers, total - 34, `callers' part at ${total}`);
    // the vendor's room, not the reader's own limit: not ready (card helper-crowd-429 fold 6), never our 429
    assert.equal((await p.handle("jupiter", "/tokens/v2/search", "query=x", "")).status, 503, "an own read not marked reserved stops with the callers");
    let own = 0;
    for (let i = 0; i < 40; i++) if ((await p.handle("jupiter", "/tokens/v2/search", `query=${i}`, "", undefined, true)).status === 200) own++;
    assert.equal(own, 34, `the reserve at ${total}`);
    assert.equal(f.seen.length, total, "the vendor's limit, never past it");
  }
});

test("re-check F-D: a retry after a vendor's short reset reaches the vendor again, so it draws from the total too", async () => {
  const c = clock();
  const f = vendor((_c, n) => (n === 1 ? json({ e: "slow" }, 429, { "retry-after": "0" }) : json({ ok: 1 })));
  const p = createProxy({ PROXY_BUDGET_RELAY: "2,1" }, { fetch: f.fetch, now: c.now, sleep: c.sleep });
  assert.equal((await p.handle("relay", "/quote/v2", "", "{}", "a")).status, 200, "served by the retry");
  assert.equal(f.seen.length, 2);
  assert.equal((await p.handle("relay", "/quote/v2", "", "{}", "b")).status, 503, "the call and its retry spent the total of 2: the vendor's room, not b's limit, so not ready (fold 6)");
  assert.equal(f.seen.length, 2, "nothing past the total reached the vendor");
});

test("re-check F-D: a call joining one in flight reaches no vendor, so it draws only the caller's share", async () => {
  const c = clock();
  let release!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  const f = vendor(async () => (await gate, json({ list: [] })));
  const p = createProxy({ PROXY_BUDGET_JUPITER: "36,1" }, { burstMs: 0, fetch: f.fetch, now: c.now, sleep: c.sleep }); // callers' part: 36 - 34 = 2
  const a = p.handle("jupiter", "/tokens/v2/recent", "limit=100", "", "a");
  const b = p.handle("jupiter", "/tokens/v2/recent", "limit=100", "", "b");
  release();
  assert.deepEqual([(await a).status, (await b).status], [200, 200]);
  assert.equal(f.seen.length, 1, "one vendor call for both");
  assert.equal((await p.handle("jupiter", "/tokens/v2/toptrending/1h", "limit=100", "", "c")).status, 200, "the total's second draw is still there");
  assert.equal(f.seen.length, 2);
});

test("fold 6 (R5h): a reserved own read's retry after a vendor's short reset still draws on the reserve, with the callers' part full", async () => {
  const c = clock();
  const f = vendor((_c, n) => (n === 27 ? json({ e: "slow" }, 429, { "retry-after": "0" }) : json({ ok: 1 })));
  // a refused caller's wait (card helper-crowd-429) passes no time here, so the callers' part stays full
  const p = createProxy({}, { burstMs: 0, fetch: f.fetch, now: c.now, sleep: async (ms) => (ms === QUEUE_POLL_MS ? undefined : c.sleep(ms)) });
  let callers = 0;
  for (let a = 0; a < 20; a++) for (let i = 0; i < 4; i++) if ((await p.handle("jupiter", "/swap/v2/build", `q=${a}-${i}`, "", `198.51.100.${a}`)).status === 200) callers++;
  assert.equal(callers, 60 - 34, "the callers' part is full");
  assert.equal((await p.handle("jupiter", "/tokens/v2/search", "query=x", "", undefined, true)).status, 200, "the own read is served by its retry");
  assert.equal(f.seen.length, 28, "the call and its retry both reached the vendor");
});

test("fold 6 (re-check 4 finding 4): a vendor with no key needs its keyless plan named: the start stops, naming the variables only", () => {
  const keys = { JUPITER_API_KEY: "test-jupiter-0001", RELAY_API_KEY: "test-relay-0001", LIFI_API_KEY: "test-lifi-0001", ONECLICK_JWT: "test-oneclick-0001" };
  assert.doesNotThrow(() => checkVendorPlans(keys));
  for (const [key, budget] of [["JUPITER_API_KEY", "PROXY_BUDGET_JUPITER"], ["RELAY_API_KEY", "PROXY_BUDGET_RELAY"], ["LIFI_API_KEY", "PROXY_BUDGET_LIFI"], ["ONECLICK_JWT", "PROXY_BUDGET_ONECLICK"]] as const) {
    for (const env of [{ ...keys, [key]: undefined }, { ...keys, [key]: "" }])
      assert.throws(() => checkVendorPlans(env), (e: Error) => e.message === `${key} is unset: set it, or ${budget} to the plan without a key` && !Object.values(keys).some((k) => e.message.includes(k)), key);
    assert.doesNotThrow(() => checkVendorPlans({ ...keys, [key]: "", [budget]: "100,2" }), `${key}: the keyless plan named`);
  }
});

test("reset headers: seconds, an epoch in s or ms, an HTTP date; none means 1 s", () => {
  const now = 1_800_000_000_000;
  const h = (o: Record<string, string>) => new Headers(o);
  assert.equal(resetMs(h({ "retry-after": "2" }), now), 2000);
  assert.equal(resetMs(h({ "retry-after": new Date(now + 3000).toUTCString() }), now), 3000);
  assert.equal(resetMs(h({ "x-ratelimit-reset-unauth": "58" }), now), 58_000);
  assert.equal(resetMs(h({ "x-ratelimit-reset": String(now / 1000 + 4) }), now), 4000);
  assert.equal(resetMs(h({ "x-ratelimit-reset": String(now + 5000) }), now), 5000);
  assert.equal(resetMs(h({}), now), 1000);
});

test("cache: a public list is read once per TTL and shared, with its first X-Fetched-At; a quote never", async () => {
  const c = clock();
  const f = vendor((_, n) => json([{ n }]));
  const p = createProxy(ENV, { burstMs: 0, fetch: f.fetch, now: c.now });
  const a = await p.handle("oneclick", "/v0/tokens", "", "");
  c.add(4_000);
  const b = await p.handle("oneclick", "/v0/tokens", "", "");
  assert.equal(f.seen.length, 1);
  assert.equal(b.body, a.body);
  assert.equal(b.headers["X-Fetched-At"], a.headers["X-Fetched-At"]);
  c.add(1_001);
  const d = await p.handle("oneclick", "/v0/tokens", "", "");
  assert.equal(f.seen.length, 2, "re-read after 5 s");
  assert.equal(d.body, '[{"n":2}]');
  // same list, params in another order: one entry
  await p.handle("jupiter", "/tokens/v2/toptrending/5m", "limit=100&x=1", "");
  await p.handle("jupiter", "/tokens/v2/toptrending/5m", "x=1&limit=100", "");
  assert.equal(f.seen.length, 3);
  // never cached: quotes, builds, statuses and a per-user search
  for (const [v, path, body] of [["oneclick", "/v0/quote", "{}"], ["jupiter", "/swap/v2/build", ""], ["jupiter", "/tokens/v2/search", ""], ["relay", "/quote/v2", "{}"]] as const) {
    const n: number = f.seen.length;
    await p.handle(v, path, "query=x", body);
    await p.handle(v, path, "query=x", body);
    assert.equal(f.seen.length, n + 2, `${v}${path} is never cached`);
  }
});

test("cache: concurrent misses make one vendor call; a failed read is not cached", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((ok) => (release = ok));
  const f = vendor(async (_, n) => (n === 1 ? (await gate, json(["list"])) : json(["again"])));
  const p = createProxy(ENV, { fetch: f.fetch });
  const all = Promise.all([1, 2, 3].map(() => p.handle("jupiter", "/tokens/v2/recent", "limit=100", "")));
  release();
  const answers = await all;
  assert.equal(f.seen.length, 1);
  assert.ok(answers.every((a) => a.status === 200 && a.body === '["list"]'));

  // card helper-page-jup-429: a GET the vendor fails is read once more, so a read that failed is its two sends
  const g = vendor((_, n) => (n <= 2 ? json({}, 500) : json(["ok"])));
  const q = createProxy(ENV, { fetch: g.fetch });
  assert.equal((await q.handle("oneclick", "/v0/tokens", "", "")).status, 503);
  assert.equal((await q.handle("oneclick", "/v0/tokens", "", "")).status, 200);
  assert.equal(g.seen.length, 3);
});

test("card helper-crowd-429 fold 6: identical GETs in flight share one vendor call (a build's GET too); a different query is its own", async () => {
  let release!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  const f = vendor(async () => (await gate, json({ tx: "x" })));
  const p = createProxy(ENV, { fetch: f.fetch });
  const a = p.handle("jupiter", "/swap/v2/build", "taker=A&amount=1", "", "198.51.100.1");
  const b = p.handle("jupiter", "/swap/v2/build", "amount=1&taker=A", "", "198.51.100.2");
  const c = p.handle("jupiter", "/swap/v2/build", "taker=B&amount=1", "", "198.51.100.3");
  await new Promise((ok) => setImmediate(ok));
  release();
  const got = await Promise.all([a, b, c]);
  assert.deepEqual(got.map((g) => g.status), [200, 200, 200]);
  assert.equal(f.seen.length, 2, "one call for the two identical builds, one for the other");
  assert.equal((await p.handle("jupiter", "/swap/v2/build", "taker=A&amount=1", "", "198.51.100.1")).status, 200);
  assert.equal(f.seen.length, 3, "a build is never cached: the next one is read again");
});

// Card solana-legs-share-wait: a caller inside its share whom the vendor's total has no room for is answered the
// not-ready 503 upstream, as before, and now with the seconds until the total has its room (Retry-After), so a device
// waits it out and asks again instead of refusing a leg.
test("a caller inside its share meets a vendor's total with no room: 503 upstream with a Retry-After of the seconds to its room", async () => {
  const c = clock();
  const f = vendor(() => json({ ok: 1 }));
  const p = createProxy({ ...ENV, PROXY_BUDGET_JUPITER: "40,4" }, { burstMs: 0, fetch: f.fetch, now: c.now, sleep: async (ms: number) => c.add(ms) });
  // the callers' part is 40 - 34 = 6: three callers draw two each, inside their shares
  for (const who of ["a", "b", "c"]) for (let i = 0; i < 2; i++) assert.equal((await p.handle("jupiter", "/swap/v2/build", `n=${who}${i}`, "", who)).status, 200, `${who} ${i}`);
  const d = await p.handle("jupiter", "/swap/v2/build", "n=d", "", "d");
  assert.deepEqual([d.status, JSON.parse(d.body)], [503, { error: { code: "upstream" } }], "the not-ready form, never our 429");
  const wait = Number(d.headers["Retry-After"]);
  assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= 61, `Retry-After ${d.headers["Retry-After"]}: the seconds to the total's room`);
  assert.equal(f.seen.length, 6, "the refused draw reached no vendor");
  // at that time the total has its room again
  c.add(wait * 1000);
  assert.equal((await p.handle("jupiter", "/swap/v2/build", "n=d2", "", "d")).status, 200, "asked again after Retry-After, it goes");
});

// card helper-page-jup-429: every Jupiter route (the swap build the device asks for, the page's search) waits out a
// Jupiter 429 inside its wait, Retry-After honoured, up to SENDS_429 sends (at c1525df5 one retry, so a second 429 was a
// bare 503: live run 42143211092, solana-jupiter-build "upstream: HTTP 503" at 01:21Z); every 503 names its cause in
// `timing`, which server.ts sends as Server-Timing
const causeIn = (a: { timing?: string[] }): string | undefined => a.timing?.find((e) => e.startsWith("cause;"))?.match(/desc="([^"]+)"/)?.[1];
test("card helper-page-jup-429: a Jupiter 429, then a 429, then a 200 is the build's 200, each reset waited out inside its wait", async () => {
  for (const [path, query, waitMs] of [["/swap/v2/build", "inputMint=a&outputMint=b&amount=1", undefined], ["/tokens/v2/search", "query=a", 5_000]] as const) {
    const c = clock();
    const f = vendor((_, n) => (n <= 2 ? json({ e: "slow" }, 429, { "retry-after": "1" }) : json({ ok: n })));
    const p = createProxy(ENV, { fetch: f.fetch, now: c.now, sleep: c.sleep });
    const t0 = c.now();
    const a = await p.handle("jupiter", path, query, "", waitMs === undefined ? "device" : undefined, waitMs !== undefined, waitMs);
    assert.deepEqual([a.status, a.body], [200, '{"ok":3}'], path);
    assert.ok(c.now() - t0 >= 2_000 && c.now() - t0 <= 3_000, `${path}: the two resets waited out (${c.now() - t0} ms)`);
    assert.ok(a.timing?.includes('429;desc="2"'), `${path}: the 429s named in its timing: ${a.timing}`);
  }
});
test("card helper-page-jup-429: a reset past the call's wait is a 503 with Retry-After and cause 429, never a bare 503", async () => {
  const c = clock();
  const f = vendor(() => json({ e: "slow" }, 429, { "retry-after": "4" }));
  const p = createProxy(ENV, { fetch: f.fetch, now: c.now, sleep: c.sleep });
  const a = await p.handle("jupiter", "/swap/v2/build", "inputMint=a", "", "device");
  assert.deepEqual([a.status, a.headers["Retry-After"], causeIn(a)], [503, "4", "429"]);
  const b = await p.handle("jupiter", "/swap/v2/build", "inputMint=b", "", "device2");
  assert.deepEqual([b.status, causeIn(b)], [503, "held"], "another call inside the hold names the hold");
  const g = vendor(() => json({ e: "slow" }, 429, { "retry-after": "1" }));
  const k = clock();
  const q = createProxy(ENV, { fetch: g.fetch, now: k.now, sleep: k.sleep });
  const d = await q.handle("jupiter", "/swap/v2/build", "inputMint=c", "", "device", false, 10_000);
  assert.deepEqual([d.status, causeIn(d), g.seen.length], [503, "429", 3], "a 429 on every send stops at SENDS_429 sends");
});
test("card helper-page-jup-429: a GET the vendor fails (5xx) or never gets is read once more; a second failure, a timeout, our key refused or a bad answer each name their cause", async () => {
  const c = clock();
  const once = vendor((_, n) => (n === 1 ? json({ e: 1 }, 502) : json({ ok: n })));
  const a = await createProxy(ENV, { fetch: once.fetch, now: c.now, sleep: c.sleep }).handle("jupiter", "/swap/v2/build", "x=1", "", "device");
  assert.deepEqual([a.status, a.body, once.seen.length], [200, '{"ok":2}', 2], "a 5xx then a 200 is the 200");
  const cases: [string, () => Response | Promise<Response>, string][] = [
    ["5xx twice", () => json({ e: 1 }, 500), "5xx"],
    ["no answer twice", () => Promise.reject(new TypeError("fetch failed")), "send"],
    ["timeout", () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })), "timeout"],
    ["401", () => json({ e: 1 }, 401), "key"],
    ["html", () => new Response("<html>", { headers: { "content-type": "text/html" } }), "answer"],
  ];
  for (const [name, answer, cause] of cases) {
    const k = clock();
    const r = await createProxy(ENV, { fetch: vendor(answer).fetch, now: k.now, sleep: k.sleep }).handle("jupiter", "/swap/v2/build", "x=1", "", "device");
    assert.deepEqual([r.status, JSON.parse(r.body), causeIn(r)], [503, { error: { code: "upstream" } }, cause], name);
  }
  const post = vendor(() => json({ e: 1 }, 500));
  const pk = clock();
  const r = await createProxy(ENV, { fetch: post.fetch, now: pk.now, sleep: pk.sleep }).handle("relay", "/quote/v2", "", "{}", "device");
  assert.deepEqual([r.status, causeIn(r), post.seen.length], [503, "5xx", 1], "a POST is never sent twice");
});
test("card helper-page-jup-429: a draw the vendor's total refuses past the wait names budget", async () => {
  const c = clock();
  const f = vendor(() => json({ ok: 1 }));
  const p = createProxy({ PROXY_BUDGET_RELAY: "2,1" }, { fetch: f.fetch, now: c.now, sleep: c.sleep });
  assert.equal((await p.handle("relay", "/quote/v2", "", "{}", "a")).status, 200);
  assert.equal((await p.handle("relay", "/quote/v2", "", "{}", "c")).status, 200);
  const b = await p.handle("relay", "/quote/v2", "", "{}", "b");
  assert.deepEqual([b.status, causeIn(b)], [503, "budget"]);
});

// card helper-page-jup-429 (window): Jupiter's limiter counts a 10 s window that takes a burst (keyless: 5 at once, its
// reset 10 s after them; Free's resets 1 and 4 s ahead, live run 41943005189), so Free is 10 in any 10 s. At da57ecaa
// every call went one a second, and a crowd's burst queued a cold page behind it (live run 42155164828: jup-turn 1915 ms
// behind six legs' builds). A burst now goes at once while the window has room; devices keep to their part of it.
/** Virtual time (as legs-wait.test.ts): sleep parks until the clock reaches it; run() moves the clock to the next timer
 *  whenever every task is parked, so a call granted a turn sends before the next turn's wait begins. */
function virtualTime(t0 = 1_800_000_000_000) {
  let t = t0;
  const timers: { at: number; go: () => void }[] = [];
  const sleep = (ms: number) => new Promise<void>((go) => void timers.push({ at: t + Math.max(ms, 0), go }));
  const idle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };
  async function run<T>(done: Promise<T>): Promise<T> {
    let settled = false;
    done.then(() => (settled = true), () => (settled = true));
    for (;;) {
      await idle();
      if (settled) return done;
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      if (!next) throw new Error("stuck: no timer and not done");
      t = Math.max(t, next.at);
      next.go();
    }
  }
  return { now: () => t, sleep, run };
}
/** A fake Jupiter with the limiter read live: at most `cap` calls in any `ms`, a 429 past it naming x-ratelimit-reset
 *  (epoch seconds, the oldest call's age-out), the 429 not counted; it keeps each call's time and path. */
function windowJupiter(c: { now: () => number }, cap = 10, ms = 10_000) {
  const sent: { at: number; path: string; q: string }[] = [];
  let refused = 0;
  const fetch = async (url: string) => {
    const u = new URL(url);
    const inside = sent.filter((x) => x.at > c.now() - ms);
    if (inside.length >= cap) return (refused++, json({ e: "slow" }, 429, { "x-ratelimit-reset": String(Math.ceil((inside[0]!.at + ms) / 1000)) }));
    sent.push({ at: c.now(), path: u.pathname, q: u.search });
    return json([]);
  };
  return { fetch, sent, refused: () => refused };
}
const search = (p: ReturnType<typeof createProxy>, q: string, waitMs = 5_000) => p.handle("jupiter", "/tokens/v2/search", `query=${q}`, "", undefined, true, waitMs, true);
const listRead = (p: ReturnType<typeof createProxy>, path: string, waitMs?: number) => p.handle("jupiter", path, "limit=100", "", undefined, true, waitMs);
test("card helper-page-jup-429 (a): a list refresh and a page search asked at once both go at once while the window has room; with the own reads' part of the window full (card jupiter-build-budget-503: BUILD_ROOM left to builds), the search goes first", async () => {
  const c = virtualTime();
  const j = windowJupiter(c);
  const p = createProxy(ENV, { fetch: j.fetch, now: c.now, sleep: c.sleep, log: () => {} });
  const t0 = c.now();
  const [list, page] = await c.run(Promise.all([listRead(p, "/tokens/v2/recent"), search(p, "a")]));
  assert.deepEqual([list.status, page.status, j.refused()], [200, 200, 0]);
  assert.deepEqual(j.sent.map((s) => s.at - t0), [0, 0], "both at once: no turn to wait");
  // the own reads' part of the window (Free's 10 less BUILD_ROOM 4) full of pages' searches: the page's search and a
  // list both wait for it, the search first
  const c2 = virtualTime();
  const k = windowJupiter(c2);
  const q = createProxy(ENV, { fetch: k.fetch, now: c2.now, sleep: c2.sleep, log: () => {} });
  const t1 = c2.now();
  await c2.run(Promise.all(Array.from({ length: 6 }, (_, n) => search(q, `fill${n}`, 15_000).then(() => undefined, () => undefined)).concat([])));
  assert.deepEqual(k.sent.map((s) => s.at - t1), Array(6).fill(0), "six at once: the window less the builds' BUILD_ROOM");
  const [l2, s2] = await c2.run(Promise.all([listRead(q, "/tokens/v2/recent", 15_000), search(q, "b", 15_000)]));
  assert.deepEqual([l2.status, s2.status, k.refused()], [200, 200, 0]);
  assert.deepEqual(k.sent.slice(6).map((s) => [s.path, s.q, s.at - t1]), [["/tokens/v2/search", "?query=b", 10_000], ["/tokens/v2/recent", "?limit=100", 10_000]], "the page's search first, as the window frees");
});
test("card helper-page-jup-429 (b): nine builds at once (one device's legs) go in order with no 429: 7 at once (the window less a page's 1 and the other devices' 2), the rest as the window frees; past the wait refused before any draw", async () => {
  const c = virtualTime();
  const j = windowJupiter(c);
  const p = createProxy(ENV, { fetch: j.fetch, now: c.now, sleep: c.sleep, log: () => {} });
  const t0 = c.now();
  const all = await c.run(Promise.all(Array.from({ length: 9 }, (_, i) => p.handle("jupiter", "/swap/v2/build", `n=${i}`, "", "198.51.100.1", false, 15_000))));
  assert.deepEqual(all.map((a) => a.status), Array(9).fill(200));
  assert.equal(j.refused(), 0, "Jupiter never answered 429");
  assert.deepEqual(j.sent.map((s) => s.q), Array.from({ length: 9 }, (_, i) => `?n=${i}`), "in order");
  assert.deepEqual(j.sent.map((s) => s.at - t0), [0, 0, 0, 0, 0, 0, 0, 10_000, 10_000], "Free's 10 in 10 s: a device leaves a page 1 and the other devices 2");
  // the device route's own wait (QUEUE_WAIT_MS 3 s): the builds past it answer 503 naming the wait, and send nothing
  const c2 = virtualTime();
  const k = windowJupiter(c2);
  const q = createProxy(ENV, { fetch: k.fetch, now: c2.now, sleep: c2.sleep, log: () => {} });
  const some = await c2.run(Promise.all(Array.from({ length: 9 }, (_, i) => q.handle("jupiter", "/swap/v2/build", `n=${i}`, "", "198.51.100.1"))));
  assert.deepEqual(some.map((a) => a.status), [...Array(7).fill(200), 503, 503]);
  for (const late of some.slice(7)) assert.ok(causeIn(late) === "budget" && Number(late.headers["Retry-After"]) >= 1, `${late.timing} ${JSON.stringify(late.headers)}`);
  assert.equal(k.sent.length, 7, "a refused turn sent nothing");
});
test("card helper-page-jup-429 (c): a crowd of builds never holds a page, and the background reads still go (fold 5)", async () => {
  const c = virtualTime();
  const j = windowJupiter(c);
  const p = createProxy(ENV, { fetch: j.fetch, now: c.now, sleep: c.sleep, log: () => {} });
  const t0 = c.now();
  const builds = Array.from({ length: 12 }, (_, i) => p.handle("jupiter", "/swap/v2/build", `n=${i}`, "", `198.51.100.${i}`, false, 30_000));
  const lists = ["/tokens/v2/recent", "/tokens/v2/toptrending/5m", "/tokens/v2/toptrending/1h"].map((l) => listRead(p, l));
  const page = search(p, "cold");
  const answers = await c.run(Promise.all([...builds, ...lists, page]));
  assert.ok(answers.every((a) => a.status === 200), answers.map((a) => `${a.status} ${a.why ?? ""} ${a.timing ?? ""}`).join(" | "));
  assert.equal(j.refused(), 0);
  const at = (q: string) => j.sent.find((s) => s.q === q)!.at - t0;
  assert.equal(at("?query=cold"), 0, "the page's search at once, past the builds queued");
  for (const l of ["/tokens/v2/recent", "/tokens/v2/toptrending/5m", "/tokens/v2/toptrending/1h"]) assert.ok(j.sent.find((s) => s.path === l)!.at - t0 <= 10_000, `${l} inside its wait`);
  assert.deepEqual(j.sent.filter((s) => s.path === "/swap/v2/build").map((s) => s.q), Array.from({ length: 12 }, (_, i) => `?n=${i}`), "the builds in order");
  assert.ok(j.sent.filter((s) => s.path === "/swap/v2/build" && s.at === t0).length <= 9, "the builds leave the window's last send to a page");
});
// live run 42155164828 (03:13Z, da57ecaa), the seconds the cold page waited: six legs' builds at once
// (solana-legs-share-wait), a build of solana-jupiter-build, helper-token-page-cold's pair of cold searches, a list
// refresh, then helper-page-jup-429's build, then its cold page: at da57ecaa the page's jup-turn was 1915 ms
// card jupiter-build-budget-503: the builds go first, so the cold page asked into a window the builds filled waits for
// the next window (its page is answered within JUP_PAGE_WAIT_MS, named on chain, token.ts), never a build behind it
test("card helper-page-jup-429 (d): the live run's crowd (six legs, two builds, two cold pages, a list): every build is served, the late one at once, a cold page within one window, Jupiter never 429s, and each send logs its turn", async () => {
  const c = virtualTime();
  const j = windowJupiter(c);
  const lines: string[] = [];
  const p = createProxy(ENV, { fetch: j.fetch, now: c.now, sleep: c.sleep, log: (l) => lines.push(l) });
  const t0 = c.now();
  const at = (ms: number) => c.sleep(ms);
  const legs = [0, 1, 2, 3, 4, 5].map((i) => p.handle("jupiter", "/swap/v2/build", `leg=${i}`, "", "198.51.100.1"));
  const other = p.handle("jupiter", "/swap/v2/build", "check=build", "", "198.51.100.2");
  const pair = [search(p, "pairA"), search(p, "pairB")];
  const list = listRead(p, "/tokens/v2/recent");
  let builtAsk = 0;
  const later = at(1_200).then(() => ((builtAsk = c.now()), p.handle("jupiter", "/swap/v2/build", "check=page", "", "198.51.100.3")));
  let asked = 0;
  // the search's own wait, token.ts SEARCH_HOLD_WAIT_MS (one window)
  const page = at(2_400).then(() => ((asked = c.now()), search(p, "thepage", 10_000)));
  const answers = await c.run(Promise.all([...legs, other, ...pair, list, later, page]));
  assert.equal(j.refused(), 0, "Jupiter never answered 429");
  for (const a of answers) assert.ok(a.status === 200 || (a.status === 503 && causeIn(a) === "budget" && Number(a.headers["Retry-After"]) >= 1), `${a.status} ${a.timing}`);
  for (const a of answers.slice(0, 7)) assert.equal(a.status, 200, `a build: ${a.status} ${a.timing}`);
  assert.equal((await later).status, 200);
  assert.equal(j.sent.find((s) => s.q === "?check=page")!.at - builtAsk, 0, "the late build at once, ahead of the pages waiting");
  const sentAt = j.sent.find((s) => s.q === "?query=thepage")!.at;
  assert.ok(sentAt - asked <= 10_000, `the cold page's search waited ${sentAt - asked} ms (at most one window)`);
  assert.equal((await page).status, 200);
  assert.ok(j.sent.filter((s) => s.at > sentAt - 10_000 && s.at <= sentAt).length <= 10, "the window held");
  // one line a send: the lane, the wait, the window, the answer; never a path, query or client
  assert.equal(lines.length, j.sent.length);
  assert.ok(lines.every((l) => /^jupiter turn: (caller|background), waited \d+ ms, \d+ of 10 sent in 10 s, answered 200 in \d+ ms$/.test(l)), lines.join("\n"));
  assert.ok(lines.every((l) => !/198\.51|query|leg=|\/swap|\/tokens/.test(l)));
  void t0;
});
test("card helper-page-jup-429: a turn's log line keeps only whole numbers of the vendor's own count (hostile headers)", async () => {
  const lines: string[] = [];
  const t = 1_800_000_000_000;
  const f = async () => json([], 200, { "x-ratelimit-remaining": "7", "x-ratelimit-reset": String(t / 1000 + 4) });
  const p = createProxy(ENV, { fetch: f, now: () => t, sleep: async () => {}, log: (l) => lines.push(l) });
  await search(p, "x");
  const g = async () => json([], 200, { "x-ratelimit-remaining": "7; drop", "x-ratelimit-reset": "soon helper: forged" });
  const q = createProxy(ENV, { fetch: g, now: () => t, sleep: async () => {}, log: (l) => lines.push(l) });
  await search(q, "y");
  assert.deepEqual(lines, ["jupiter turn: caller, waited 0 ms, 1 of 10 sent in 10 s, answered 200 in 0 ms, vendor remaining 7, reset in 4 s", "jupiter turn: caller, waited 0 ms, 1 of 10 sent in 10 s, answered 200 in 0 ms"]);
});
