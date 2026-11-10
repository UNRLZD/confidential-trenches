// node --test scripts/live-checks/signpage-pool-price.test.mjs: the live check's verdict replays recorded runs
// (signpage-pool-price.answers.json), each read on 4 Nov by signpage-pool-price.mjs collect() in headless Chrome on the
// test box: Pyth's SOL/USD on the signing page's own Solana pair, then the terminal in the stand-in shell sent the
// devnet Solana pool with that price fresh, stale and absent:
//   good (4 Nov; the 10 Nov record below replaces it): the harness, this card's terminal build (entry /assets/index-C4hTE6bh.js) at APP_HOST's name and this checkout's
//         signing page bundle as SIGN_HOST's, read at 15:36:52Z: the pair agreed on 9663681652 x 10^-8 published 3 s
//         before, SIGN_HOST's connect-src names both; at 1440 and 390 a fresh price shows Bal $0.96, Buy on, and the tap
//         asks for one pool.buy of 0.000517401 SOL
//         ($0.05 rounded down); stale and none show no USD, Buy off, nothing asked: PASS;
//   bad:  the deployed APP_HOST before this card (entry /assets/index-BqB1l2a4.js), read at 15:37:09Z, SIGN_HOST serving the bundle from before this card (its sha384 is not the
//         checkout's); its kit's exact
//         state schema refuses a pool entry carrying a price, so with a fresh or stale price the box reads signed out
//         on the vault path and asks for nothing: FAIL.
// Recorded again on 10 Nov (card live-check-pool-price-own-token), on the token's own page /token/solana/<DJT>, which
// also reads the token and chain the page drew, and with the price read again until it is at most 20 s old (youngRead,
// since replaced by the page's own schedule, pageFeed, card pool-usd-price-never-stale):
//   good: the deployed APP_HOST (entry /assets/index-XvbkxnaR.js) and SIGN_HOST: DJT on Solana at both widths, a fresh
//         price priced and tapped, a stale and no price shut: PASS;
//   wrongChain: the same check opening / (its old path), when the live Trending column's top was "Anthropic"
//         (0xecc4...1627) on Robinhood: the box is on the vault path, and the verdict names the token and chain: FAIL.
// Planted from the good run: a wrong amount, a vault buy, Buy on or USD drawn with a stale price, a disagreeing or
// stale read, the page's pair changed, a missing run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { POOL_USD_FEEDS } from "../../packages/kit/src/index.ts";
import { MINT } from "./app-sell-mount.mjs";
import { CHAIN, expectedSol, judge, PAGE_PAIR, pageFeed, poolWith } from "./signpage-pool-price.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-pool-price.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const run = (rec, w, p) => rec.runs.find((r) => r.width === w && r.price === p);
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};

test("the amount: $0.05 in SOL at the read's price, rounded down; the states the stand-in sends", () => {
  assert.equal(expectedSol({ price: "9388311299", expo: -8 }), "0.000532577");
  assert.equal(expectedSol({ price: "5000000000", expo: -8 }), "0.001");
  const p = { price: "9388311299", expo: -8, published_s: 1_793_803_309, read_ms: 1_793_803_311_000 };
  assert.deepEqual(poolWith("fresh", p, 1_793_803_312_000).price, p);
  assert.equal(poolWith("stale", p, 1_793_803_312_000).price.published_s, 1_793_803_312 - POOL_USD_FEEDS.solana.maxAgeS - 30, "30 s past the kit's bound");
  assert.equal(Object.hasOwn(poolWith("none", p, 0), "price"), false);
});

test("recorded good answer: the page's pair agrees, a fresh price turns Buy on with a priced pool.buy, a stale or no price keeps it off: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.runs.length, 6);
});

test("recorded bad answer: the deployed app before this card reads a priced state as signed out: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /^BAD desktop fresh: .*the box is on the vault path.*the tap asked for nothing, not one pool\.buy/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /^BAD phone stale: .*Buy is on with a stale price/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /^BAD SIGN_HOST's \/app\.js is this checkout's signing page bundle: served sha384-/.test(l)), r.lines.join("\n"));
});

test("planted: a pool.buy of another amount or chain, a vault buy, two asks, or none with a fresh price fail", () => {
  fails(mut((rec) => (run(rec, "desktop", "fresh").asked[0].params.amount = "0.000517402")), /^BAD desktop fresh: its pool\.buy is 0\.000517402 SOL on solana, not 0\.000583828/);
  fails(mut((rec) => (run(rec, "phone", "fresh").asked[0].params.chain = "base")), /^BAD phone fresh: its pool\.buy is .* on base/);
  fails(mut((rec) => (run(rec, "desktop", "fresh").asked = [{ type: "buy", params: {} }])), /^BAD desktop fresh: the tap asked for buy, not one pool\.buy/);
  fails(mut((rec) => run(rec, "phone", "fresh").asked.push(run(rec, "phone", "fresh").asked[0])), /^BAD phone fresh: the tap asked for pool\.buy, pool\.buy/);
  fails(mut((rec) => (run(rec, "desktop", "fresh").asked = [])), /^BAD desktop fresh: the tap asked for nothing/);
  fails(mut((rec) => (run(rec, "desktop", "fresh").box.ctaOn = false)), /^BAD desktop fresh: Buy is off with a fresh price/);
  fails(mut((rec) => (run(rec, "phone", "fresh").box.bal = "Bal —")), /^BAD phone fresh: Bal shows Bal —, not USD/);
});

test("planted: USD, Buy on or an ask with a stale or no price fail", () => {
  fails(mut((rec) => (run(rec, "desktop", "stale").box.bal = "Bal $0.93")), /^BAD desktop stale: Bal shows Bal \$0\.93 with a stale price/);
  fails(mut((rec) => (run(rec, "phone", "none").box.ctaOn = true)), /^BAD phone none: Buy is on with no price/);
  fails(mut((rec) => (run(rec, "desktop", "none").asked = [{ type: "pool.buy", params: {} }])), /^BAD desktop none: the tap asked for pool\.buy/);
  fails(mut((rec) => (run(rec, "phone", "stale").box.path = "vault")), /^BAD phone stale: the box is on the vault path/);
});

test("planted: the page's read disagreeing, stale, on another pair or one host; a missing run, outside the shell, no shot fail", () => {
  fails(mut((rec) => { delete rec.read.price; rec.read.error = "the two RPCs disagree on the Pyth account"; }), /^BAD the two agree on Pyth's SOL\/USD: the two RPCs disagree/);
  fails(mut((rec) => (rec.read.published_s -= POOL_USD_FEEDS.solana.maxAgeS + 1)), /^BAD the price is fresh: published \d+ s before the run/);
  fails(mut((rec) => (rec.read.rpcs = ["https://api.mainnet-beta.solana.com", PAGE_PAIR[1]])), /^BAD the page's Solana pair read/);
  fails(mut((rec) => (rec.read.rpcs = [PAGE_PAIR[0], PAGE_PAIR[0]])), /^BAD the page's Solana pair read/);
  fails(mut((rec) => rec.runs.pop()), /^BAD 5 run\(s\) of 6/);
  fails(mut((rec) => (run(rec, "desktop", "fresh").framed = false)), /^BAD desktop fresh: not inside SIGN_HOST's shell/);
  fails(mut((rec) => (run(rec, "phone", "stale").shot = null)), /^BAD phone stale: no screenshot/);
  fails(mut((rec) => (rec.entry = null)), /^BAD the served \/ names its entry script none/);
  fails(mut((rec) => (rec.signCsp = rec.signCsp.replace(" https://solana-rpc.publicnode.com", ""))), /^BAD SIGN_HOST's connect-src names both: not https:\/\/solana-rpc\.publicnode\.com/);
  fails(mut((rec) => (rec.signCsp = null)), /^BAD SIGN_HOST's connect-src names both/);
});

test("planted (review M1): a SIGN_HOST bundle that is not this checkout's fails, so a page without pool-price.ts cannot pass; an app deploy does not judge it", () => {
  fails(mut((rec) => (rec.signBundle.sha384 = "sha384-" + "A".repeat(64))), /^BAD SIGN_HOST's \/app\.js is this checkout's signing page bundle: served sha384-A+/);
  fails(mut((rec) => (rec.signBundle = { status: 404, sha384: rec.treeBundle })), /^BAD SIGN_HOST's \/app\.js .*HTTP 404/);
  fails(mut((rec) => delete rec.signBundle), /^BAD SIGN_HOST's \/app\.js/);
  const app = mut((rec) => { rec.host = "app"; rec.signBundle.sha384 = "sha384-" + "A".repeat(64); });
  assert.equal(app.ok, true, app.lines.join("\n"));
});

test("recorded good answer: the check drew the Solana token it opened (DJT), on solana, in every run", () => {
  assert.ok(ANSWERS.good.runs.every((r) => r.mint === MINT && r.chain === CHAIN), JSON.stringify(ANSWERS.good.runs.map((r) => [r.mint, r.chain])));
});

test("recorded wrong-chain answer: the old open path drew the live Trending top on Robinhood, and the verdict names the token and chain: FAIL", () => {
  const r = judge(ANSWERS.wrongChain);
  assert.equal(r.ok, false);
  const named = bad(r).filter((l) => /the token page drew 0x\w+ on robinhood, not the Solana token DJT\w+ on solana/.test(l));
  assert.equal(named.length, ANSWERS.wrongChain.runs.length, r.lines.join("\n"));
});

test("planted: a page of another token or chain, or one that names neither, fails with a line that says so", () => {
  fails(mut((rec) => (run(rec, "desktop", "fresh").chain = "base")), /^BAD desktop fresh: the token page drew DJT\w+ on base, not the Solana token DJT\w+ on solana/);
  fails(mut((rec) => (run(rec, "phone", "stale").mint = "So11111111111111111111111111111111111111112")), /^BAD phone stale: the token page drew So1\w+ on solana, not the Solana token DJT/);
  fails(mut((rec) => (run(rec, "desktop", "none").chain = null)), /^BAD desktop none: the token page drew DJT\w+ on no chain/);
  fails(mut((rec) => (run(rec, "phone", "fresh").mint = null)), /^BAD phone fresh: the token page drew no token on solana/);
});

test("pageFeed (card pool-usd-price-never-stale): part 1 follows the feed on the page's schedule; a run sends the price held at its start, a newer one once its write is read; a failed first read answers its error", async () => {
  let t = 1_794_281_200_000;
  const now = () => t;
  const sleep = async (ms) => void (t += ms);
  // the account: written at 54 s of its price's age, landing 1 s later; the first read 40 s after its publish
  const pub0 = Math.floor(t / 1000) - 40;
  const read = async () => {
    const s = Math.floor(t / 1000);
    const publishedS = s >= pub0 + 55 ? pub0 + 54 : pub0;
    return { chain: "solana", asset: "SOL", decimals: 9, price: BigInt(publishedS), expo: -8, publishedS, source: "pyth", at: 1n };
  };
  const feed = pageFeed({ read, now, sleep });
  const first = await feed.first();
  assert.equal(first.published_s, pub0);
  assert.deepEqual(first.rpcs, PAGE_PAIR);
  while (Math.floor(t / 1000) < pub0 + 58) await sleep(100);
  assert.equal(feed.now().published_s, pub0 + 54, "the write that landed at 55 s is held by 58 s");
  assert.equal(feed.now().price, String(pub0 + 54));
  await feed.stop();
  const down = pageFeed({ read: async () => Promise.reject(new Error("the two RPCs disagree")), now, sleep });
  assert.equal((await down.first()).error, "the two RPCs disagree");
  await down.stop();
});

test("a run's own price (card pool-usd-price-never-stale): a fresh run is judged on the price it sent, not the first read", () => {
  const rec = structuredClone(ANSWERS.good);
  const f = rec.runs.find((x) => x.price === "fresh");
  f.read = { price: String(BigInt(rec.read.price) * 2n), expo: rec.read.expo, published_s: rec.read.published_s };
  const v = judge(rec);
  assert.equal(v.ok, false);
  assert.ok(v.lines.some((l) => new RegExp(`^BAD ${f.width} fresh: its pool\\.buy is ${f.asked.find((m) => m.type === "pool.buy").params.amount} SOL on solana, not ${expectedSol(f.read).replace(".", "\\.")} SOL`).test(l)), v.lines.join("\n"));
});
