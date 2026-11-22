// node --test --test-force-exit apps/helper/test/warm-start-coingecko.test.ts (card helper-warm-start-coingecko-bound).
// The claim: a helper that starts on a store holding the warm file the helper before it wrote at its stop (src/data/warm.ts,
// server.ts stop -> saveWarm, readWarm at the start) spends far fewer CoinGecko keyed calls on the same page reads than one
// that starts cold. On 22 Nov 13 helper deploys each spent about 70 to 330 keyed calls, mostly callers' reads of coins a cold
// helper did not hold yet, out of the key's 3,225 a day (coingecko.ts CG_DAY).
//
// The whole server runs as deployed (node src/server.ts, a real port, a real store directory, a real SIGTERM), with the key
// planted and COINGECKO_CALLS_PER_MIN set, under test/net-replay.mjs, which answers every outbound request from fixtures
// already in the repo (or 503) and writes each one's URL, no query and no header, to a file. No byte leaves the machine.
// The page reads are a Solana chart (1m and 15m bars) and tape for four coins, one of them the recorded tape's own.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { call } from "./servers.ts";

const HELPER = join(import.meta.dirname, "..", "src", "server.ts");
const PRELOAD = join(import.meta.dirname, "net-replay.mjs");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const APP = "https://ct-app.unrealized.trade";
/** Test values for the vendor keys a start requires (proxy.ts checkVendorPlans); no real key. */
const TEST_VENDOR_KEYS = { JUPITER_API_KEY: "test-jupiter-0001", RELAY_API_KEY: "test-relay-0001", LIFI_API_KEY: "test-lifi-0001", ONECLICK_JWT: "test-oneclick-0001" };
/** A planted key: never a real one (the log must not hold it). */
const KEY = ["CG", "planted", "test", "key", "only"].join("-");
const CG = "https://pro-api.coingecko.com/";

/** The most CoinGecko sends a cold start makes for PAGE_READS. [design: measured here, 19 sends: the start's own 3 (Base's
 *  quote tokens, swaps.ts QUOTE_SEEDS) and 16 for the four coins' top pools (4), bars (8, two timeframes) and tapes (4); to be set from helper-28's live run.] */
const COLD_MAX = 19;
/** The most a start on the warm file makes for the same reads. [design: measured here, 7 sends: the start's own 3 and one
 *  trades read a coin; no top pool and no bars read. The trades reads are the vendor tape's freshness rule, not a part the
 *  warm file lacks: a Solana vendor tape is served only inside SOL_VENDOR_REACH_MS of its read (solana/token.ts:81 and its
 *  cached reachMs), shorter than any helper swap, so rows handed over would be read again at the first page all the
 *  same. To be set from helper-28's live run.] */
const WARM_MAX = 7;

/** The coins read: BONK, JUP and WIF's mints and the recorded tape's (sol-pool-trades-nearkat.json), a Raydium coin. */
const MINTS = ["DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", "6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr"];
/** The page reads each coin's page makes of the chart and the tape. */
const PAGE_READS = MINTS.flatMap((m) => [`/v1/market/candles?chain=solana&token=${m}&tf=1m`, `/v1/market/candles?chain=solana&token=${m}&tf=15m`, `/v1/market/trades?chain=solana&token=${m}`]);

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as { port: number }).port;
  await new Promise((ok) => s.close(ok));
  return port;
}

/** One helper process on `store`: starts, answers `reads` (each 200), is stopped with SIGTERM, and returns the CoinGecko
 *  sends it made, each as the URL line the preload wrote. */
async function run(store: string, reads: readonly string[]): Promise<string[]> {
  const log = join(store, `net-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(log, "");
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", PRELOAD, HELPER], {
    env: { PATH: process.env.PATH, HELPER_COMMIT: COMMIT, PORT: String(port), ...TEST_VENDOR_KEYS, COINGECKO_API_KEY: KEY, COINGECKO_CALLS_PER_MIN: "300", HELPER_STORE_DIR: store, NET_REPLAY_LOG: log },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const exited = new Promise<number | null>((ok) => child.once("exit", ok));
  try {
    // the process's own start line ends the wait; its exit before that line fails it at once, naming the code
    await new Promise<void>((ok, fail) => {
      child.stdout!.on("data", (d) => {
        out += d;
        if (String(d).includes("listening")) ok();
      });
      child.stderr!.on("data", (d) => (out += d));
      child.once("exit", (code) => fail(new Error(`the helper exited ${code} before it was listening: ${out}`)));
    });
    for (const r of reads) {
      const a = await call(port, { path: r, headers: { origin: APP, "x-forwarded-for": "198.18.9.1" }, agent: false }, "the helper");
      assert.equal(a.status, 200, `${r}: ${a.body}`);
    }
  } finally {
    child.kill("SIGTERM"); // the stop writes the warm file (server.ts stop -> saveWarm) and exits
  }
  assert.equal(await exited, 0, out);
  const text = readFileSync(log, "utf8");
  assert.ok(!text.includes(KEY), "the key is never in the record of a request");
  return text.split("\n").filter((l) => l.startsWith(CG));
}

/** The sends as the paths' kinds: the Base quote seeds, and the Solana token, bars and trades reads. */
const kinds = (sends: string[]): string => {
  const n = (re: RegExp) => sends.filter((l) => re.test(l)).length;
  return `${sends.length} sends: base pools ${n(/\/networks\/base\//)}, solana token ${n(/\/networks\/solana\/tokens\//)}, bars ${n(/\/ohlcv\//)}, trades ${n(/\/trades$/)}`;
};

test("a start on the warm file spends far fewer CoinGecko calls than a cold one for the same page reads", { timeout: 120_000 }, async (t) => {
  const store = mkdtempSync(join(tmpdir(), "warm-start-cg-"));
  t.after(() => rmSync(store, { recursive: true, force: true }));
  const cold = await run(store, PAGE_READS);
  t.diagnostic(`cold: ${kinds(cold)}`);
  assert.ok(existsSync(join(store, "market", "warm.json")), "the stop wrote the warm file");
  const warm = await run(store, PAGE_READS);
  t.diagnostic(`warm: ${kinds(warm)}`);
  assert.ok(cold.length <= COLD_MAX, `a cold start: ${kinds(cold)}, at most ${COLD_MAX}`);
  assert.ok(warm.length <= WARM_MAX, `a warm start: ${kinds(warm)}, at most ${WARM_MAX}`);
  assert.ok(warm.length < cold.length, `warm ${warm.length} against cold ${cold.length}`);
});

test("the bound is not vacuous: a second start with the warm file gone spends past WARM_MAX", { timeout: 120_000 }, async (t) => {
  const store = mkdtempSync(join(tmpdir(), "warm-start-cg-"));
  t.after(() => rmSync(store, { recursive: true, force: true }));
  await run(store, PAGE_READS);
  rmSync(join(store, "market", "warm.json"));
  const second = await run(store, PAGE_READS);
  assert.ok(second.length > WARM_MAX, `a start with no warm file: ${kinds(second)}, past ${WARM_MAX}`);
});
