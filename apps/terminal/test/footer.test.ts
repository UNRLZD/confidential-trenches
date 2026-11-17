// The desktop footer's data (card app-footer-bar): the connection and the block from one read of NEAR's final block
// on the release's pair (the RPCs Verify reads, in APP_HOST's connect-src), the first that answers; the prices only
// as the signing page read them (state.pools[].price, the device's two-provider Pyth and Chainlink reads), within
// their feed's bound; the page links only to routes the app has.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignpageState } from "@blindfill/kit";
import { ROUTES } from "../src/routes/routes.ts";
import { VERIFY_RELEASES } from "../src/screens/verify/release.ts";
import { BLOCK_EVERY_MS, FOOTER_LINKS, FOOTER_WORDS, fmtBlock, fmtUsd, footerRpcs, footerTicks, nextConn, readFinalBlock, type Conn } from "../src/shell/footer.ts";

const A = "https://rpc.mainnet.fastnear.com";
const B = "https://near.drpc.org";
const blockAnswer = (height: number) => ({ jsonrpc: "2.0", id: "ct-footer", result: { header: { height, hash: "x" }, chunks: [] } });

/** A test double: each URL's answer (a body, a status, or a throw); every call logged with its body. */
function rpc(by: Record<string, unknown | number | Error>, log: { url: string; body: unknown }[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    log.push({ url, body: JSON.parse(String(init?.body)) });
    assert.ok(url.endsWith("/?ct=footer"), url);
    const a = by[url.replace("/?ct=footer", "")];
    if (a instanceof Error || a === undefined) throw a ?? new TypeError("fetch failed");
    if (typeof a === "number") return new Response("{}", { status: a });
    return new Response(JSON.stringify(a), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("the read: NEAR's final block from the first RPC, with its round trip", async () => {
  const log: { url: string; body: unknown }[] = [];
  let t = 1000;
  const r = await readFinalBlock([A, B], rpc({ [A]: blockAnswer(223_500_123) }, log), () => (t += 142));
  assert.deepEqual(r, { height: 223_500_123, ms: 142 });
  assert.equal(log.length, 1);
  assert.deepEqual(log[0], { url: `${A}/?ct=footer`, body: { jsonrpc: "2.0", id: "ct-footer", method: "block", params: { finality: "final" } } });
});

test("the read: the second RPC when the first fails, refuses or answers no height; null when both do", async () => {
  for (const first of [new TypeError("fetch failed"), 503, { jsonrpc: "2.0", id: "ct-footer", error: { code: -32000 } }, blockAnswer(0), { result: { header: { height: "223500123" } } }]) {
    const log: { url: string; body: unknown }[] = [];
    const r = await readFinalBlock([A, B], rpc({ [A]: first, [B]: blockAnswer(223_500_120) }, log), () => 0);
    assert.equal(r?.height, 223_500_120, JSON.stringify(first));
    assert.deepEqual(log.map((l) => l.url), [`${A}/?ct=footer`, `${B}/?ct=footer`]);
  }
  assert.equal(await readFinalBlock([A, B], rpc({ [A]: 500, [B]: new TypeError("fetch failed") }), () => 0), null);
});

// Card signpage-footer-reads-inside-fastnear-limit: FastNEAR's keyless URL holds about 0.39 requests a second from one
// address (packages/wallet/src/pace.ts PACE, read 9 Nov) and answers past it 429 with no Retry-After (read 17 Nov
// 00:04Z: body code -429, "Rate limits exceeded"), while the signing page's money reads share that address's budget.
// Asked first every 3 s, the footer alone took 0.33 a second of it (the 34 footer 429s of release 167's prf run).
/** Each tick of the footer's cadence over `ms` on a test clock: what the footer draws and every URL it asked. */
async function ticks(ms: number, answer: (url: string, at: number) => unknown | number | Error) {
  const held = new Map<string, number>();
  const log: { url: string; at: number }[] = [];
  let now = 0;
  let c: Conn = { kind: "wait" };
  const seen: Conn["kind"][] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input).replace("/?ct=footer", "");
    log.push({ url, at: now });
    const a = answer(url, now);
    if (a instanceof Error) throw a;
    if (typeof a === "number") return new Response("{}", { status: a });
    return new Response(JSON.stringify(a), { status: 200 });
  }) as typeof fetch;
  for (; now < ms; now += BLOCK_EVERY_MS) {
    c = nextConn(c, await readFinalBlock(footerRpcs("mainnet"), fetchFn, () => now, held));
    seen.push(c.kind);
  }
  return { log, seen, at: (url: string) => log.filter((l) => l.url === url).map((l) => l.at) };
}

test("the footer's order is its own: dRPC first, FastNEAR its fallback, on either network; Verify's pair is untouched", () => {
  assert.deepEqual(footerRpcs("mainnet"), [B, A]);
  assert.deepEqual(footerRpcs("testnet"), ["https://near-testnet.drpc.org", "https://test.rpc.fastnear.com"]);
  assert.deepEqual(VERIFY_RELEASES.mainnet.rpcs, [A, B]);
  assert.deepEqual([...footerRpcs("mainnet")].sort(), [...VERIFY_RELEASES.mainnet.rpcs].sort());
  assert.deepEqual([...footerRpcs("testnet")].sort(), [...VERIFY_RELEASES.testnet.rpcs].sort());
});

test("over 60 s at the footer's 3 s cadence with dRPC answering, FastNEAR is asked 0 times (20 before) and the footer shows Stable", async () => {
  const r = await ticks(60_000, (url) => (url === B ? blockAnswer(223_500_000) : blockAnswer(223_500_001)));
  assert.equal(r.at(A).length, 0, `FastNEAR asked ${r.at(A).length} times in 60 s`);
  assert.equal(r.at(B).length, 20);
  assert.ok(r.seen.every((k) => k === "on"));
});

test("an RPC that answers 429 is not asked again for 60 s; the other one answers meanwhile, and none asked draws Offline", async () => {
  // dRPC down: FastNEAR answers 429 at 0 s, then would answer; it is asked again only at 60 s, and then shows Stable
  const down = await ticks(66_000, (url, at) => (url === B ? new TypeError("fetch failed") : at === 0 ? 429 : blockAnswer(223_500_002)));
  assert.deepEqual(down.at(A), [0, 60_000, 63_000], `FastNEAR asked at ${down.at(A).join(", ")}`);
  assert.equal(down.seen.filter((k) => k === "off").length, 20);
  assert.deepEqual(down.seen.slice(20), ["on", "on"]);
  // dRPC answers 429 at 0 s: FastNEAR answers that tick and every tick of dRPC's hold, Stable throughout; dRPC again at 60 s
  const busy = await ticks(63_000, (url, at) => (url === B ? (at === 0 ? 429 : blockAnswer(223_500_003)) : blockAnswer(223_500_004)));
  assert.deepEqual(busy.at(B), [0, 60_000]);
  assert.equal(busy.at(A).length, 20);
  assert.ok(busy.seen.every((k) => k === "on"));
  // a 503 or a failed fetch holds nothing: the next tick asks the same RPC first again
  const flaky = await ticks(6_000, (url, at) => (url === B ? (at === 0 ? 503 : blockAnswer(223_500_005)) : blockAnswer(223_500_006)));
  assert.deepEqual(flaky.at(B), [0, 3_000]);
});

test("the connection: waiting until the first read, Stable on an answer, Offline on none; the block never goes back", () => {
  let c: Conn = { kind: "wait" };
  c = nextConn(c, null);
  assert.deepEqual(c, { kind: "off", height: null });
  c = nextConn(c, { height: 100, ms: 180 });
  assert.deepEqual(c, { kind: "on", height: 100, ms: 180 });
  // the second RPC a block behind the first: the chain's final block is still 100
  c = nextConn(c, { height: 99, ms: 90 });
  assert.deepEqual(c, { kind: "on", height: 100, ms: 90 });
  c = nextConn(c, { height: 103, ms: 120 });
  assert.deepEqual(c, { kind: "on", height: 103, ms: 120 });
  // offline keeps the last block read, and draws no round trip
  c = nextConn(c, null);
  assert.deepEqual(c, { kind: "off", height: 103 });
});

const NOW = 1_762_600_000_000;
const pools = (over: Partial<Record<"solana" | "base" | "robinhood", { price: string; expo: number; published_s: number; read_ms: number } | null>>): SignpageState["pools"] => {
  const at = { published_s: Math.floor(NOW / 1000) - 2, read_ms: NOW - 1000 };
  const all = { solana: { price: "18512345678", expo: -8, ...at }, base: { price: "312345000000", expo: -8, ...at }, robinhood: { price: "312300000000", expo: -8, ...at }, ...over };
  return (Object.entries(all) as [keyof typeof all, (typeof all)["solana"] | null][]).map(([chain, price]) => ({ chain, asset: chain === "solana" ? "SOL" : "ETH", balance: "0", ...(price ? { price } : {}) })) as SignpageState["pools"];
};

test("the prices: SOL and ETH as the signing page read them, ETH from Base's feed and else Robinhood's", () => {
  assert.deepEqual(footerTicks(pools({}), NOW), [{ sym: "SOL", usd: 185.12345678 }, { sym: "ETH", usd: 3123.45 }]);
  assert.deepEqual(footerTicks(pools({ base: null }), NOW), [{ sym: "SOL", usd: 185.12345678 }, { sym: "ETH", usd: 3123 }]);
});

test("the prices: none signed out or with no pool read, none past its feed's bound: never a number not read", () => {
  assert.deepEqual(footerTicks(undefined, NOW), []);
  assert.deepEqual(footerTicks([], NOW), []);
  // read 120 s ago, past Pyth's bound (the kit's POOL_USD_FEEDS) and inside Chainlink's: Pyth's SOL is dropped, Chainlink's ETH stays
  const stale = { price: "18512345678", expo: -8, published_s: Math.floor(NOW / 1000) - 120, read_ms: NOW - 120_000 };
  assert.deepEqual(footerTicks(pools({ solana: stale }), NOW).map((t) => t.sym), ["ETH"]);
  assert.deepEqual(footerTicks(pools({ solana: null, base: null, robinhood: null }), NOW), []);
});

test("the numbers as R5 draws them: $2,467 and $106.83; the block with commas", () => {
  assert.equal(fmtUsd(2467.4), "$2,467");
  assert.equal(fmtUsd(3123.45), "$3,123");
  assert.equal(fmtUsd(106.834), "$106.83");
  assert.equal(fmtUsd(185.12345678), "$185.12");
  assert.equal(fmtBlock(220_948_200), "220,948,200");
});

test("the links: Terms, Privacy and Verify, each a route the app has", () => {
  assert.deepEqual(Object.values(FOOTER_LINKS), ["/terms", "/privacy", "/verify"]);
  const paths = new Set(ROUTES.map((r) => r.path));
  for (const to of Object.values(FOOTER_LINKS)) assert.ok(paths.has(to), to);
});

test("the words: only labels the design lock or the shipped app holds; an unpicked one is a draft", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(FOOTER_WORDS).map(([k, w]) => [k, [w.text, w.draft]])),
    { stable: ["Stable", true], offline: ["Offline", false], connection: ["Connection", true], block: ["Block", false], terms: ["Terms", false], privacy: ["Privacy", false], github: ["GitHub", false], x: ["X", false], docs: ["Docs", false], telegram: ["Telegram", false] },
  );
  for (const w of Object.values(FOOTER_WORDS)) assert.match(w.source, /design-lock-r5|owner|shipped/);
});
