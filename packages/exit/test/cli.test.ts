// Card exit-with-only-the-words: the exit command (src/cli.ts, src/bin.ts) takes the 12 words from a hidden prompt only,
// never from argv or the environment; runs each chain asked for through its ExitChain (src/chain.ts) with seed64, the
// typed address and the chain's RPC pair; and zeroes seed64 after. The fee wallet's wait (src/fund.ts) says the
// address and the shortfall, then waits for the money. The NEAR chain (src/near-out.ts) refuses a pair that is not a
// release's and a typed account the vault would never pay, before any read of the words' notes.
//   node --test test/cli.test.ts      (from packages/exit)
// Test words are the published all-zero BIP-39 vector (packages/wallet/test/vectors/a8.json), never money.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { VaultSyncRpc } from "@blindfill/kit";
import { wordsToSeed64, type MoveOutRpc } from "@blindfill/kit/core";
import type { ExitChain, ExitCtx } from "../src/chain.ts";
import { parseArgs, runCli, CliRefused, type CliIo } from "../src/cli.ts";
import { FUND_POLL_MS, fundedOrWait, units } from "../src/fund.ts";
import { nearExitWith, nearNeed } from "../src/near-out.ts";
import { EXIT_NETWORKS, ExitRpcRefused } from "../src/rpc.ts";

const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/bin.ts");

function io(over: Partial<CliIo> & { typed?: string[] } = {}): CliIo & { said: string[]; asked: string[] } {
  const said: string[] = [];
  const asked: string[] = [];
  const typed = [...(over.typed ?? [])];
  return {
    argv: [],
    hidden: async (p) => (asked.push(`hidden:${p}`), WORDS),
    line: async (p) => (asked.push(`line:${p}`), typed.shift() ?? ""),
    say: (l) => said.push(l),
    chains: {},
    ...over,
    said,
    asked,
  };
}

test("argv: anything but --chains is refused before any prompt, and never echoed", async () => {
  const runs: ExitCtx[] = [];
  const chain: ExitChain = async (ctx) => (runs.push(ctx), { chain: "near", txs: [], sent: "0", left: "0" });
  for (const argv of [WORDS.split(" "), [WORDS], ["--words", WORDS], ["--chains", "near", "abandon"]]) {
    const x = io({ argv, chains: { near: { run: chain, rpcs: ["a", "b"], asks: "x" } } });
    assert.equal(await runCli(x), 2);
    assert.deepEqual(x.asked, []);
    assert.equal(runs.length, 0);
    assert.ok(!x.said.join("\n").includes("abandon"), "an argument is never echoed: it may be the words");
  }
  assert.throws(() => parseArgs(["--chains", "solana"], ["near"]), CliRefused);
  assert.throws(() => parseArgs(["--chains", "dogechain"], ["near"]), CliRefused);
  assert.deepEqual(parseArgs([], ["near", "solana"]), { chains: ["near", "solana"] });
  assert.deepEqual(parseArgs(["--chains=solana,near,solana"], ["near", "solana"]), { chains: ["solana", "near"] });
});

test("the bin: words on argv are refused (exit 2), and words in the environment are never read", () => {
  const argv = spawnSync(process.execPath, [BIN, ...WORDS.split(" ")], { input: "", encoding: "utf8", timeout: 60_000 });
  assert.equal(argv.status, 2, argv.stderr);
  assert.ok(!argv.stderr.includes("abandon"));
  // the environment holds the words under every name a tool might read; stdin gives an empty answer: the words refused
  const env = { ...process.env, WORDS, MNEMONIC: WORDS, BLINDFILL_WORDS: WORDS, SEED_PHRASE: WORDS };
  const envRun = spawnSync(process.execPath, [BIN, "--chains", "near"], { input: "alice.near\n\n", env, encoding: "utf8", timeout: 60_000 });
  assert.equal(envRun.status, 2, envRun.stderr);
  assert.match(envRun.stderr, /The 12 words \(hidden\)/);
  assert.match(envRun.stderr, /the words are refused/);
  assert.ok(!envRun.stderr.includes("abandon"));
});

test("each chain asked for runs once, in order, with seed64, its own typed address and its RPC pair; seed64 is zeroed after", async () => {
  const runs: { chain: string; seed: Uint8Array; copy: Uint8Array; to: string; rpcs: [string, string] }[] = [];
  const mk = (chain: "near" | "solana"): ExitChain => async (ctx) => {
    runs.push({ chain, seed: ctx.seed, copy: new Uint8Array(ctx.seed), to: ctx.to, rpcs: ctx.rpcs });
    ctx.say("hello");
    return { chain, txs: [`${chain}-tx`], sent: "5", left: "0" };
  };
  const x = io({ typed: [" alice.near ", "So1anaAddr"], chains: { near: { run: mk("near"), rpcs: ["n1", "n2"], asks: "a NEAR account" }, solana: { run: mk("solana"), rpcs: ["s1", "s2"], asks: "a Solana address" } } });
  assert.equal(await runCli(x), 0);
  // every address asked before the words, the words at the hidden prompt only
  assert.deepEqual(x.asked.map((a) => a.split(":")[0]), ["line", "line", "hidden"]);
  assert.deepEqual(runs.map((r) => [r.chain, r.to, r.rpcs]), [["near", "alice.near", ["n1", "n2"]], ["solana", "So1anaAddr", ["s1", "s2"]]]);
  const want = wordsToSeed64(WORDS);
  for (const r of runs) {
    assert.deepEqual(r.copy, want);
    assert.ok(r.seed.every((b) => b === 0), "seed64 zeroed once every chain ran");
  }
  assert.ok(x.said.includes("near: hello") && x.said.some((l) => l.startsWith("solana: done: sent 5")));
});

test("a chain that stops is said, the next still runs, and the exit code is 1", async () => {
  const ran: string[] = [];
  const x = io({
    typed: ["a.near", "b"],
    chains: {
      near: { run: async () => { ran.push("near"); throw new Error("the vault read stopped"); }, rpcs: ["a", "b"], asks: "" },
      solana: { run: async () => (ran.push("solana"), { chain: "solana", txs: [], sent: "0", left: "0" }), rpcs: ["a", "b"], asks: "" },
    },
  });
  assert.equal(await runCli(x), 1);
  assert.deepEqual(ran, ["near", "solana"]);
  assert.ok(x.said.includes("near: stopped: the vault read stopped"));
});

test("words that are not 12 BIP-39 words are refused before any chain runs, and never echoed", async () => {
  let ran = 0;
  const x = io({ hidden: async () => "abandon abandon secretword", typed: ["a.near"], chains: { near: { run: async () => (ran++, { chain: "near", txs: [], sent: "0", left: "0" }), rpcs: ["a", "b"], asks: "" } } });
  assert.equal(await runCli(x), 2);
  assert.equal(ran, 0);
  assert.ok(!x.said.join("\n").includes("secretword"));
});

test("the fee wallet's wait: says its address and the shortfall once per shortfall, reads again, returns once funded", async () => {
  const reads = [0n, 0n, 4n, new Error("busy") as unknown as bigint, 10n];
  const said: string[] = [];
  const slept: number[] = [];
  const got = await fundedOrWait({
    address: "feewallet111",
    need: 10n,
    unit: { symbol: "SOL", decimals: 1 },
    balance: async () => {
      const r = reads.shift()!;
      if (r instanceof Error) throw r;
      return r;
    },
    say: (l) => said.push(l),
    sleep: async (ms) => void slept.push(ms),
  });
  assert.equal(got, 10n);
  assert.equal(said.filter((l) => l.startsWith("Send")).length, 2);
  assert.match(said[0]!, /^Send 1 SOL to feewallet111 to pay the fees \(it holds 0, needs 1\)/);
  assert.match(said[1]!, /^Send 0\.6 SOL to feewallet111/);
  assert.match(said[2]!, /could not read feewallet111/);
  assert.deepEqual(slept, [FUND_POLL_MS, FUND_POLL_MS, FUND_POLL_MS, FUND_POLL_MS]);
  assert.equal(units(1_500_000n, 6), "1.5");
  assert.equal(units(10n ** 24n, 24), "1");
});

test("nearNeed: the withdraw's gas at the margin, its attachment, a refund settle and the account's keep", () => {
  const p = 100_000_000n; // 1e8 yocto a gas, NEAR's minimum price
  const n = nearNeed(p, 0n);
  assert.ok(n > 300n * 10n ** 12n * p * 12n, "at least the withdraw's 300 Tgas at 12x");
  assert.ok(n < 10n ** 24n, "under 1 NEAR at the minimum price");
  assert.equal(nearNeed(p, 1_250_000_000_000_000_000_000n) - n, 1_250_000_000_000_000_000_000n, "an unregistered typed account adds its registration");
});

test("the NEAR chain refuses a pair that is not a release's, and a typed account the vault never pays, before reading the notes", async () => {
  const seed = wordsToSeed64(WORDS);
  const fake = (names: readonly string[]) => names.map((name) => ({ name, query: async () => { throw new Error("no read expected"); }, block: async () => null, tx: async () => null, call: async () => null }));
  const say = () => {};
  await assert.rejects(nearExitWith({ rpcs: fake(["https://a.example/", "https://b.example/"]) as unknown as [VaultSyncRpc, VaultSyncRpc], moveRpcs: fake(["https://a.example/", "https://b.example/"]) as unknown as [MoveOutRpc, MoveOutRpc] })({ seed, to: "alice.near", rpcs: ["https://a.example/", "https://b.example/"], say }), ExitRpcRefused);
  const pair = EXIT_NETWORKS.mainnet.rpcs;
  for (const to of [EXIT_NETWORKS.mainnet.vault, "intents.near", "NOT AN ACCOUNT"]) {
    await assert.rejects(nearExitWith({ rpcs: fake(pair) as unknown as [VaultSyncRpc, VaultSyncRpc], moveRpcs: fake(pair) as unknown as [MoveOutRpc, MoveOutRpc] })({ seed, to, rpcs: [...pair] as [string, string], say }), /refused/);
  }
});
