// node --test apps/helper/src/proxy/proxy.test.ts: the proxy (markets paper H2.1-H2.3, H7) with a fake vendor. Keys
// come only from the environment and never come back; only allowlisted paths are served; a vendor that fails, holds
// back (429) or answers anything but JSON answers 503 upstream; only public lists are cached, never a quote.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ANSWER_MAX, createProxy, PROXY_BODY_MAX, readKeys, resetMs, WAIT_MAX_MS } from "./proxy.ts";
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
  assert.deepEqual(a, { status: 200, headers: { "X-Helper-Source": "jupiter", "X-Fetched-At": new Date(c.now()).toISOString() }, body: '{"route":[]}' });
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

test("429: the vendor is left alone until its reset; a short wait is waited once, a long one answers 503 at once", async () => {
  const c = clock();
  const f = vendor((_, n) => (n === 1 ? json({ e: "slow down" }, 429, { "retry-after": "0.5" }) : json({ ok: n })));
  const p = createProxy(ENV, { fetch: f.fetch, now: c.now, sleep: c.sleep });
  const t0 = c.now();
  const a = await p.handle("relay", "/intents/status/v3", "requestId=1", "");
  assert.deepEqual([a.status, a.body], [200, '{"ok":2}']);
  assert.equal(c.now() - t0, 500, "waited the vendor's Retry-After");

  const c2 = clock();
  const g = vendor(() => json({ e: "slow down" }, 429, { "x-ratelimit-reset": "30" }));
  const q = createProxy(ENV, { fetch: g.fetch, now: c2.now, sleep: c2.sleep });
  assert.equal((await q.handle("lifi", "/v1/status", "", "")).status, 503);
  assert.equal((await q.handle("lifi", "/v1/quote", "", "")).status, 503);
  assert.equal(g.seen.length, 1, "no call while the vendor's reset is ahead");
  assert.equal((await q.handle("relay", "/intents/status/v3", "", "")).status, 503, "relay's own (429ing fake) call");
  c2.add(30_001);
  g.seen.length = 0;
  assert.equal((await q.handle("lifi", "/v1/status", "", "")).status, 503);
  assert.equal(g.seen.length, 1, "after the reset the vendor is called again (and 429s again here)");
  assert.ok(WAIT_MAX_MS < 30_000);
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
  const p = createProxy(ENV, { fetch: f.fetch, now: c.now });
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

  const g = vendor((_, n) => (n === 1 ? json({}, 500) : json(["ok"])));
  const q = createProxy(ENV, { fetch: g.fetch });
  assert.equal((await q.handle("oneclick", "/v0/tokens", "", "")).status, 503);
  assert.equal((await q.handle("oneclick", "/v0/tokens", "", "")).status, 200);
  assert.equal(g.seen.length, 2);
});
