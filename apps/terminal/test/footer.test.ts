// The desktop footer's data (card app-footer-bar): the connection and the block from one read of NEAR's final block
// on the release's pair (the RPCs Verify reads, in APP_HOST's connect-src), the first that answers; the prices only
// as the signing page read them (state.pools[].price, the device's two-provider Pyth and Chainlink reads), within
// their feed's bound; the page links only to routes the app has.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignpageState } from "@blindfill/kit";
import { ROUTES } from "../src/routes/routes.ts";
import { VERIFY_RELEASES } from "../src/screens/verify/release.ts";
import { FOOTER_LINKS, FOOTER_WORDS, fmtBlock, fmtUsd, footerRpcs, footerTicks, nextConn, readFinalBlock, type Conn } from "../src/shell/footer.ts";

const A = "https://rpc.mainnet.fastnear.com";
const B = "https://near.drpc.org";
const blockAnswer = (height: number) => ({ jsonrpc: "2.0", id: "ct-footer", result: { header: { height, hash: "x" }, chunks: [] } });

/** A test double: each URL's answer (a body, a status, or a throw); every call logged with its body. */
function rpc(by: Record<string, unknown | number | Error>, log: { url: string; body: unknown }[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    log.push({ url, body: JSON.parse(String(init?.body)) });
    const a = by[url];
    if (a instanceof Error || a === undefined) throw a ?? new TypeError("fetch failed");
    if (typeof a === "number") return new Response("{}", { status: a });
    return new Response(JSON.stringify(a), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("the pair read is the release's: the mainnet pair on a mainnet build, the testnet pair on a testnet build", () => {
  assert.deepEqual(footerRpcs("mainnet"), VERIFY_RELEASES.mainnet.rpcs);
  assert.deepEqual(footerRpcs("testnet"), VERIFY_RELEASES.testnet.rpcs);
});

test("the read: NEAR's final block from the first RPC, with its round trip", async () => {
  const log: { url: string; body: unknown }[] = [];
  let t = 1000;
  const r = await readFinalBlock([A, B], rpc({ [A]: blockAnswer(223_500_123) }, log), () => (t += 142));
  assert.deepEqual(r, { height: 223_500_123, ms: 142 });
  assert.equal(log.length, 1);
  assert.deepEqual(log[0], { url: A, body: { jsonrpc: "2.0", id: "ct-footer", method: "block", params: { finality: "final" } } });
});

test("the read: the second RPC when the first fails, refuses or answers no height; null when both do", async () => {
  for (const first of [new TypeError("fetch failed"), 503, { jsonrpc: "2.0", id: "ct-footer", error: { code: -32000 } }, blockAnswer(0), { result: { header: { height: "223500123" } } }]) {
    const log: { url: string; body: unknown }[] = [];
    const r = await readFinalBlock([A, B], rpc({ [A]: first, [B]: blockAnswer(223_500_120) }, log), () => 0);
    assert.equal(r?.height, 223_500_120, JSON.stringify(first));
    assert.deepEqual(log.map((l) => l.url), [A, B]);
  }
  assert.equal(await readFinalBlock([A, B], rpc({ [A]: 500, [B]: new TypeError("fetch failed") }), () => 0), null);
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
  // read 61 s before its feed's 60 s bound ends: Pyth's SOL is dropped, Chainlink's ETH stays
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
    { stable: ["Stable", true], offline: ["Offline", false], connection: ["Connection", true], block: ["Block", false], terms: ["Terms", false], privacy: ["Privacy", false] },
  );
  for (const w of Object.values(FOOTER_WORDS)) assert.match(w.source, /design-lock-r5|owner|shipped/);
});
