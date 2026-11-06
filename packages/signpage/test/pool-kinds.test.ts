// The pool kinds' wiring (src/pool-kinds.ts): no pool pinned, every kind refused with no read; Base and Robinhood
// refuse a deposit and a withdraw whatever the pins; a sell's decimals come from the device's two reads of the token,
// never from the app; a request that passed is handed to its flow, and with no flow it is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { throughApi } from "./api-ends.ts";
import { ERC20_DECIMALS, poolKinds, readTokenDecimals, type PoolKindsDeps, type PoolRpc } from "../src/pool-kinds.ts";
import { SOLANA_TOKEN_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import type { PoolAsk, PoolChain } from "../src/rules/pool.ts";
import { SolanaRpcTransportError } from "../../kit/src/trade/solana/send.ts";
import { EvmNotFinalError } from "../../wallet/src/pool/evm-restore.ts";
import { buildEntry, ROOT, SIGNER_DEFS, signerGuard } from "./signer-guard.ts";

const SOL_TOKEN = "So11111111111111111111111111111111111111112";
const EVM_TOKEN = "0xF111111111111111111111111111111111111111";
const ctx = { id: "r1", sha: "00", progress: () => {} };
const mint = (dec: number) => {
  const d = new Uint8Array(82);
  d[44] = dec;
  d[45] = 1;
  return { context: { slot: 1 }, value: { owner: SOLANA_TOKEN_PROGRAM, data: [Buffer.from(d).toString("base64"), "base64"] } };
};
const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");

/** Providers that answer as given and log every call. */
function providers(answer: (method: string, params: readonly unknown[]) => unknown) {
  const calls: [string, readonly unknown[]][] = [];
  const rpc: PoolRpc = async (method, params) => {
    calls.push([method, params]);
    return answer(method, params);
  };
  return { calls, pair: [rpc, rpc] as const };
}
const settle = async (a: unknown) => {
  const d = a as { after?: Promise<unknown>; answer?: () => unknown };
  if (d.after) {
    await d.after;
    return d.answer!();
  }
  return a;
};

test("no pool pinned (the page's mainnet today): every pool kind is refused not_allowed and no provider is asked", async () => {
  const { calls, pair } = providers(() => mint(6));
  const flows: PoolAsk[] = [];
  const k = poolKinds({ pinned: () => false, rpcs: () => pair, flow: (ask) => (flows.push(ask), { error: "not_allowed" }) });
  for (const chain of ["solana", "base", "robinhood"] as const) {
    assert.deepEqual(k["pool.deposit"]({ chain, amount: "1" }, ctx), { error: "not_allowed" });
    assert.deepEqual(k["pool.buy"]({ chain, token: chain === "solana" ? SOL_TOKEN : EVM_TOKEN, amount: "1", slippage_bps: 100 }, ctx), { error: "not_allowed" });
    assert.deepEqual(await settle(k["pool.sell"]({ chain, token: chain === "solana" ? SOL_TOKEN : EVM_TOKEN, amount: "1", slippage_bps: 100 }, ctx)), { error: "not_allowed" });
    assert.deepEqual(k["pool.withdraw"]({ chain }, ctx), { error: "not_allowed" });
  }
  assert.deepEqual(calls, []);
  assert.equal(flows.length, 0);
});

test("Base and Robinhood refuse a pool.deposit even with their pool pinned, and hand a pool.withdraw to the flow (its onward send has its check, rules/pool.ts checkEvmOnwardSend); Solana's go to the flow", async () => {
  const flows: PoolAsk[] = [];
  const deps: PoolKindsDeps = { pinned: () => true, rpcs: () => null, flow: (ask) => (flows.push(ask), { error: "busy" }) };
  const k = poolKinds(deps);
  for (const chain of ["base", "robinhood"] as const) assert.deepEqual(k["pool.deposit"]({ chain, amount: "1" }, ctx), { error: "not_allowed" });
  assert.equal(flows.length, 0);
  for (const chain of ["base", "robinhood"] as const) assert.deepEqual(k["pool.withdraw"]({ chain }, ctx), { error: "busy" });
  assert.deepEqual(k["pool.deposit"]({ chain: "solana", amount: "1.5" }, ctx), { error: "busy" });
  assert.deepEqual(k["pool.withdraw"]({ chain: "solana" }, ctx), { error: "busy" });
  assert.deepEqual(k["pool.buy"]({ chain: "base", token: EVM_TOKEN, amount: "19", slippage_bps: 100 }, ctx), { error: "busy" });
  assert.deepEqual(flows.map((a) => [a.kind, a.chain, a.amount, a.decimals]), [
    ["pool.withdraw", "base", 0n, 18],
    ["pool.withdraw", "robinhood", 0n, 18],
    ["pool.deposit", "solana", 1_500_000_000n, 9],
    ["pool.withdraw", "solana", 0n, 9],
    ["pool.buy", "base", 19n * 10n ** 18n, 18],
  ]);
  // a bad request never reaches a flow
  assert.deepEqual(k["pool.buy"]({ chain: "solana", token: EVM_TOKEN, amount: "1", slippage_bps: 100 }, ctx), { error: "not_allowed" });
  assert.equal(flows.length, 5);
});

test("a pinned pool with no flow yet refuses a request that passed its checks: never half run", () => {
  const k = poolKinds({ pinned: () => true, rpcs: () => null });
  assert.deepEqual(k["pool.deposit"]({ chain: "solana", amount: "1" }, ctx), { error: "not_allowed" });
});

test("a sell's decimals are the token's, read on two providers by the device: the mint on Solana, decimals() on EVM", async () => {
  const flows: PoolAsk[] = [];
  const sol = providers(() => mint(6));
  const evm = providers(() => word(18));
  const deps: PoolKindsDeps = { pinned: () => true, rpcs: (c: PoolChain) => (c === "solana" ? sol.pair : evm.pair), flow: (ask) => (flows.push(ask), { error: "busy" }) };
  const k = poolKinds(deps);
  assert.deepEqual(await settle(k["pool.sell"]({ chain: "solana", token: SOL_TOKEN, amount: "2.5", slippage_bps: 100 }, ctx)), { error: "busy" });
  assert.deepEqual(await settle(k["pool.sell"]({ chain: "base", token: EVM_TOKEN, amount: "100", slippage_bps: 100 }, ctx)), { error: "busy" });
  assert.deepEqual(flows.map((a) => [a.chain, a.amount, a.decimals]), [["solana", 2_500_000n, 6], ["base", 100n * 10n ** 18n, 18]]);
  assert.deepEqual(sol.calls, [
    ["getAccountInfo", [SOL_TOKEN, { encoding: "base64", commitment: "confirmed" }]],
    ["getAccountInfo", [SOL_TOKEN, { encoding: "base64", commitment: "confirmed" }]],
  ]);
  assert.deepEqual(evm.calls, [
    ["eth_call", [{ to: EVM_TOKEN, data: ERC20_DECIMALS }, "latest"]],
    ["eth_call", [{ to: EVM_TOKEN, data: ERC20_DECIMALS }, "latest"]],
  ]);
  // an amount finer than the token's decimals, two providers that disagree, or no providers: refused; a provider that
  // fails: down (card pool-read-down), which the app may ask again
  assert.deepEqual(await settle(k["pool.sell"]({ chain: "solana", token: SOL_TOKEN, amount: "0.0000001", slippage_bps: 100 }, ctx)), { error: "not_allowed" });
  let n = 0;
  const split = providers(() => mint(n++ === 0 ? 6 : 9));
  assert.deepEqual(await settle(poolKinds({ ...deps, rpcs: () => split.pair })["pool.sell"]({ chain: "solana", token: SOL_TOKEN, amount: "1", slippage_bps: 100 }, ctx)), { error: "not_allowed" });
  const down: PoolRpc = async () => {
    throw new Error("down");
  };
  assert.deepEqual(await settle(poolKinds({ ...deps, rpcs: () => [down, down] })["pool.sell"]({ chain: "base", token: EVM_TOKEN, amount: "1", slippage_bps: 100 }, ctx)), { error: "down" });
  assert.deepEqual(await settle(poolKinds({ ...deps, rpcs: () => null })["pool.sell"]({ chain: "base", token: EVM_TOKEN, amount: "1", slippage_bps: 100 }, ctx)), { error: "not_allowed" });
  assert.equal(flows.length, 2);
});

test("readTokenDecimals asks each provider once, for the token's address only", async () => {
  const p = providers(() => word(6));
  assert.deepEqual(await readTokenDecimals("robinhood", EVM_TOKEN, p.pair), [word(6), word(6)]);
  assert.equal(p.calls.length, 2);
  assert.ok(p.calls.every(([, params]) => JSON.stringify(params) === JSON.stringify([{ to: EVM_TOKEN, data: "0x313ce567" }, "latest"])));
});

test("a sell whose token is not an address of its chain makes no provider read and is refused", async () => {
  const p = providers(() => mint(6));
  const k = poolKinds({ pinned: () => true, rpcs: () => p.pair, flow: () => ({ error: "busy" }) });
  for (const [chain, token] of [
    ["solana", "any string the app picks"],
    ["solana", EVM_TOKEN],
    ["base", SOL_TOKEN],
    ["robinhood", "0x12"],
  ] as const) {
    assert.deepEqual(await settle(k["pool.sell"]({ chain, token, amount: "1", slippage_bps: 100 }, ctx)), { error: "not_allowed" }, `${chain} ${token}`);
  }
  assert.equal(p.calls.length, 0);
});

test("card signpage-pool-sell: a sell's flow that runs (a trade) is answered with its run's answer, and the api's queue never waits on it", async () => {
  const sol = providers(() => mint(6));
  let finish!: () => void;
  const ran = new Promise<void>((r) => (finish = r));
  const result = { result: { stage: "sent", txs: [{ chain: "solana", hash: "s" }] } };
  const k = poolKinds({ pinned: () => true, rpcs: () => sol.pair, flow: () => ({ running: true, after: ran, answer: () => result }) as never });
  const r = k["pool.sell"]({ chain: "solana", token: SOL_TOKEN, amount: "1", slippage_bps: 100 }, ctx) as { running?: true; after: Promise<unknown>; answer: () => unknown };
  assert.equal(r.running, true, "a sell is a trade: the api answers it without holding its queue");
  let settled = false;
  void r.after.then(() => (settled = true));
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(settled, false, "answered once the run's own wait settles");
  finish();
  await r.after;
  assert.deepEqual(r.answer(), result);
  // a refusal before any run is still a refusal, answered the same way
  const no = poolKinds({ pinned: () => true, rpcs: () => sol.pair, flow: () => ({ error: "busy" }) })["pool.sell"]({ chain: "solana", token: SOL_TOKEN, amount: "1", slippage_bps: 100 }, ctx);
  assert.deepEqual(await settle(no), { error: "busy" });
});

// Card signpage-error-after-timeout: a sell whose decimals read fails is refused only once the reads end, which may be
// past the client's 10 s window: the app's button still ends on progress refused. A pool.withdraw is an open, answered
// pending at once (its run's stages go to its op record): nothing of it waits past the window, and no end is posted.
test("a pool.sell refused after its decimals reads (both providers down) reaches the app as progress refused after its answer", async () => {
  const down: PoolRpc = async () => {
    throw new Error("down");
  };
  const k = poolKinds({ pinned: () => true, rpcs: () => [down, down], flow: () => ({ error: "busy" }) });
  const r = await throughApi("pool.sell", k["pool.sell"] as never, { chain: "solana", token: SOL_TOKEN, amount: "1", slippage_bps: 100 });
  assert.deepEqual((r.answer as { error: unknown }).error, { code: "down" });
  assert.deepEqual(r.stages, ["refused"]);
});

// Card pool-read-down: the devnet run at 967c52d6, where OnFinality's getAccountInfo of the mint still failed after the
// page's four tries and the sell was refused not_allowed. One provider's read that fails is "down" (api.ts RETRY_CODES:
// not kept, so the same request again runs again), never not_allowed, on either provider and on every chain; the two
// reads are still both required, so the flow is never asked on one provider's word.
for (const p of [0, 1] as const) {
  test(`card pool-read-down: a sell whose decimals read fails on provider ${p} after the page's retry answers down, and its flow is never asked`, async () => {
    const flows: PoolAsk[] = [];
    const throttled = (ok: unknown): readonly [PoolRpc, PoolRpc] => {
      const good: PoolRpc = async () => ok;
      const bad: PoolRpc = async () => {
        throw new SolanaRpcTransportError("http_429", "HTTP 429", 4, `provider-${p}`);
      };
      return p === 0 ? [bad, good] : [good, bad];
    };
    for (const [chain, token, ok] of [["solana", SOL_TOKEN, mint(6)], ["base", EVM_TOKEN, word(18)], ["robinhood", EVM_TOKEN, word(18)]] as const) {
      const k = poolKinds({ pinned: () => true, rpcs: () => throttled(ok), flow: (ask) => (flows.push(ask), { error: "busy" }) });
      assert.deepEqual(await settle(k["pool.sell"]({ chain, token, amount: "1", slippage_bps: 100 }, ctx)), { error: "down" }, chain);
    }
    assert.equal(flows.length, 0);
    // through the api: answered down (not kept for its id: test/api.test.ts holds RETRY_CODES), ended as progress refused
    const k = poolKinds({ pinned: () => true, rpcs: () => throttled(mint(6)), flow: () => ({ error: "busy" }) });
    const r = await throughApi("pool.sell", k["pool.sell"] as never, { chain: "solana", token: SOL_TOKEN, amount: "1", slippage_bps: 100 });
    assert.deepEqual((r.answer as { error: unknown }).error, { code: "down" });
    assert.deepEqual(r.stages, ["refused"]);
  });
}

test("a pool.withdraw is an open: answered pending at once, with no progress after it", async () => {
  const k = poolKinds({ pinned: () => true, rpcs: () => null, flow: (ask) => (ask.kind === "pool.withdraw" ? { result: { pending: true } } : { error: "not_allowed" }) as never });
  const r = await throughApi("pool.withdraw", k["pool.withdraw"] as never, { return_key: "portfolio", chain: "solana" });
  assert.deepEqual((r.answer as { result: unknown }).result, { pending: true });
  assert.deepEqual(r.stages, []);
});

// card pool-restore-wired: evmNextNote's wait for finality (a take in a block not final yet) is a "not now": a flow that
// fails with EvmNotFinalError is answered busy (api.ts RETRY_CODES: not kept, so the same request runs again), never
// failed or not_allowed, however the flow fails with it: thrown at once, or its run's wait rejecting; a sell's flow runs
// inside its decimals read's then. Any other error is answered as before.
test("card pool-restore-wired: a flow that fails with EvmNotFinalError is answered busy on every path; any other error as before", async () => {
  const sol = providers(() => mint(6));
  const notFinal = () => new EvmNotFinalError("taken in a block not final yet");
  const failed = { error: "failed" };
  const rejects = (e: Error, deferred = false) => {
    const after = Promise.reject(e);
    after.catch(() => {});
    return (deferred ? { after, answer: () => failed } : { running: true, after, answer: () => failed }) as never;
  };
  const ways: [string, () => never][] = [
    ["thrown at once", () => { throw notFinal(); }],
    ["a Running whose wait rejects", () => rejects(notFinal())],
    ["a Deferred whose wait rejects", () => rejects(notFinal(), true)],
  ];
  const BUY = { chain: "base", token: EVM_TOKEN, amount: "1", slippage_bps: 100 };
  const SELL = { chain: "solana", token: SOL_TOKEN, amount: "1", slippage_bps: 100 };
  for (const [way, flow] of ways) {
    const k = poolKinds({ pinned: () => true, rpcs: () => sol.pair, flow });
    for (const [kind, params] of [["pool.buy", BUY], ["pool.deposit", { chain: "solana", amount: "1" }], ["pool.withdraw", { return_key: "portfolio", chain: "solana" }], ["pool.sell", SELL]] as const) {
      const r = await throughApi(kind, k[kind] as never, params);
      assert.deepEqual((r.answer as { error?: unknown }).error, { code: "busy" }, `${kind}, ${way}`);
    }
  }
  // any other error: as before. Thrown at once: the throw itself, and a sell not_allowed; a wait that rejects: the
  // run's own answer
  const plain = () => new Error("the call failed");
  const thrown = poolKinds({ pinned: () => true, rpcs: () => sol.pair, flow: () => { throw plain(); } });
  assert.throws(() => thrown["pool.buy"](BUY, ctx), /the call failed/);
  const code = async (kind: "pool.buy" | "pool.sell", k: ReturnType<typeof poolKinds>, params: Record<string, unknown>) => ((await throughApi(kind, k[kind] as never, params)).answer as { error?: unknown }).error;
  assert.deepEqual(await code("pool.sell", thrown, SELL), { code: "not_allowed" });
  const ran = poolKinds({ pinned: () => true, rpcs: () => sol.pair, flow: () => rejects(plain()) });
  assert.deepEqual(await code("pool.buy", ran, BUY), { code: "failed" });
  assert.deepEqual(await code("pool.sell", ran, SELL), { code: "failed" });
  // review I1: a run that sent something before its wait rejected answers with what it sent, never busy (busy is not
  // kept, so the same id would run again)
  const sent = { result: { stage: "sent", txs: [{ chain: "base", hash: "0xab" }] } };
  const after = Promise.reject(notFinal());
  after.catch(() => {});
  const part = poolKinds({ pinned: () => true, rpcs: () => sol.pair, flow: () => ({ running: true, after, answer: () => sent }) as never });
  const got = (await throughApi("pool.buy", part["pool.buy"] as never, BUY)).answer as { ok?: boolean; result?: unknown };
  assert.equal(got.ok, true);
  assert.deepEqual(got.result, sent.result);
});

// card precommit-taken-recover: an EVM pool deposit or sell signs on a precommitment anyone who sees it pending can take
// first with MIN_DEPOSIT. Every device file that builds or signs one (the kit's evmPoolBuildSell or the rule's
// signEvmSell called, or the pool's deposit(uint256,uint256) encoded) must pick its note through the wallet's
// evmNextNote, which restores a taken note and names the next one to sign. Today none does: EVM pool.deposit is refused
// (EVM_REFUSED) and the flow answers only Solana, so the list below is empty; the first flow that lands is held to it.
// card signer-guard-parser (reviewer L3 of pool-restore-wired): the guard reads code, not names (test/signer-guard.ts):
// every name is bound to its declaration by the TypeScript compiler, so an alias, a namespace, `.call`/`.apply`, a
// typed-arrow signer, a const or let that holds one, and an ethers- or viem-style deposit encoder are all caught, and the
// kit index's re-exports are told apart from a call by their binding. It reads every module the page's build reaches
// from the build's own entry (scripts/build-app.mjs `input:`), held to the Vite bundle's own module list on both
// networks, and the device trees besides. The planted cases are files in test/fixtures/signer-guard/.
const FIXTURES = join(ROOT, "packages/signpage/test/fixtures/signer-guard");
const FIXTURE_DEFS = "packages/signpage/test/fixtures/signer-guard/defs.ts";
const TREES = ["packages/signpage/src", "apps/terminal/src", "packages/wallet/src", "packages/kit/src", "apps/helper/src"];
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|js|mjs)$/.test(name) && !/\.d\.ts$/.test(name) ? [path] : [];
  });
const ENTRY = buildEntry();
const TREE_FILES = TREES.flatMap((d) => sources(join(ROOT, d))).filter((f) => !/\.test\.(ts|mjs)$/.test(f));
const FIXTURE_FILES = sources(FIXTURES);
// one program for all of them; the fixtures' own signer file (defs.ts) only adds a signer no real file reaches
const GUARD = signerGuard(ENTRY, [...TREE_FILES, ...FIXTURE_FILES], [...SIGNER_DEFS, FIXTURE_DEFS]);
const names = (files: readonly string[]) => files.map((f) => f.slice(ROOT.length));

test("signer-guard-parser: the guard reads every module the page bundles, from the build's own entry", async () => {
  assert.equal(ENTRY, join(ROOT, "packages/signpage/src/main.ts"), "build-app.mjs input: join(pkg, \"src/main.ts\")");
  assert.ok(GUARD.graph.length > 50 && GUARD.graph.includes(ENTRY), "the build's graph was read");
  assert.deepEqual(GUARD.unresolved, [], "every module of ours binds");
  const BUILD: string = "../scripts/build-app.mjs"; // plain JavaScript, with no types
  const { bundle } = (await import(BUILD)) as { bundle: (pkg: undefined, o: { network: string }) => Promise<{ modules: string[] }> };
  for (const network of ["mainnet", "testnet"]) {
    const { modules } = await bundle(undefined, { network });
    const own = modules.filter((m) => !/[\\/]node_modules[\\/]/.test(m) && !m.startsWith("\0")).map((m) => m.split("?")[0]!);
    assert.ok(own.length > 50, `${network}: the bundle's modules were listed`);
    assert.deepEqual(own.filter((m) => !GUARD.graph.includes(m)), [], `${network}: every module the bundle holds is read`);
  }
  // planted: a name like a signer, a re-export or a type is not a reach; the kit index (export * from sell.ts) has none
  assert.deepEqual(GUARD.sites(join(ROOT, "packages/kit/src/index.ts")), []);
});

test("precommit-taken-recover: no device file signs an EVM pool deposit or sell without picking its note through evmNextNote", () => {
  const signers = GUARD.signers.map((s) => s.slice(s.indexOf("#") + 1));
  for (const name of ["evmPoolBuildSell", "evmPoolSignSell", "evmPoolSignSimSell", "evmPoolBuildSellUnpinned", "evmPoolSignSellUnpinned", "pinnedSignSell", "signEvmSell", "signEvmSellSim", "evmQuotedSell", "fixtureSignSell"]) assert.ok(signers.includes(name), `${name} is guarded`);
  assert.ok(signers.includes("fixtureBuildSell"), "a builder defined as a function expression is guarded");
  for (const name of ["evmIsQuotedSell", "fixtureIsQuotedSell", "isSignedSell"]) assert.equal(signers.includes(name), false, `${name}: a predicate signs nothing`);
  assert.equal(signers.includes("EvmSignedSellCall"), false, "a type signs nothing");
  // the signers' own files and the kit's quote.ts (a quote's simulation, signed by its caller on the note the caller
  // names) define what is called; every other file the page bundles, and every file of the device trees, is held
  const own = new Set([...SIGNER_DEFS, "packages/kit/src/checks/evm/quote.ts"].map((f) => join(ROOT, f)));
  for (const f of own) assert.ok(GUARD.sites(f).length > 0, `${f}: the reader sees the signers in their own files`);
  const files = [...new Set([...GUARD.graph, ...TREE_FILES])].filter((f) => !own.has(f) && !f.startsWith(FIXTURES));
  assert.ok(files.length > 50, "the trees were read");
  assert.deepEqual(names(GUARD.unguarded(files)), [], JSON.stringify(GUARD.unguarded(files).flatMap(GUARD.sites)));
});

test("signer-guard-parser: every planted signer and encoder in fixtures/signer-guard/bad is caught, and none in good/", () => {
  // each bad file, and what the guard reads in it
  const BAD: Record<string, RegExp> = {
    "alias.ts": /names packages\/signpage\/src\/rules\/pool\.ts#signEvmSell/,
    "namespace.ts": /names packages\/kit\/src\/trade\/evm\/sell\.ts#evmPoolSignSell/,
    "namespace-whole.ts": /passes a namespace that exports packages\/kit\/src\/trade\/evm\/sell\.ts#/,
    "call.ts": /names packages\/signpage\/src\/rules\/pool\.ts#signEvmSell/,
    "apply.ts": /names packages\/kit\/src\/trade\/evm\/sell\.ts#evmPoolSignSell/,
    "arrow-const.ts": /names packages\/signpage\/test\/fixtures\/signer-guard\/defs\.ts#fixtureSignSell/,
    "reassign.ts": /names packages\/signpage\/src\/rules\/pool\.ts#signEvmSell/,
    "reassign-export.ts": /names packages\/signpage\/src\/rules\/pool\.ts#signEvmSell/,
    "reassign-import.ts": /names packages\/signpage\/src\/rules\/pool\.ts#signEvmSell/,
    "encoder-ethers.ts": /encodes the deposit with encodeFunctionData/,
    "encoder-abi.ts": /holds the deposit's ABI entry[\s\S]*encodes the deposit: "deposit\(uint256, uint256\)"/,
    "fake-guard.ts": /names packages\/signpage\/src\/rules\/pool\.ts#signEvmSell/,
    "plain.ts": /evmPoolBuildSell[\s\S]*rules\/pool\.ts#signEvmSell[\s\S]*defs\.ts#fixtureBuildSell/,
    "encoder-viem.ts": /encodes functionName "deposit"[\s\S]*encodes the deposit: "deposit\(uint256,uint256\)"[\s\S]*encodes the deposit: "0xE2BBB158"/,
    "selector-number.ts": /encodes the deposit selector/,
  };
  const bad = FIXTURE_FILES.filter((f) => f.startsWith(join(FIXTURES, "bad")));
  assert.deepEqual(bad.map((f) => f.slice(FIXTURES.length + 5)).sort(), Object.keys(BAD).sort(), "the planted cases were read");
  assert.deepEqual(names(GUARD.unguarded(bad)), names(bad));
  for (const f of bad) assert.match(GUARD.sites(f).map((s) => s.what).join("\n"), BAD[f.slice(FIXTURES.length + 5)]!, f);
  // reassign-import.ts reaches the signer only through another file's const: its own call is what is read
  assert.ok(GUARD.sites(join(FIXTURES, "bad/reassign-import.ts")).some((s) => s.line === 5));
  // no false refusal: the rule's signer by an alias, with the wallet's evmNextNote by an alias, is read and passes;
  // re-exports, types, a predicate and a comment, and a local that shares a signer's name, are no reach at all
  const good = FIXTURE_FILES.filter((f) => f.startsWith(join(FIXTURES, "good")));
  assert.equal(good.length, 3);
  assert.deepEqual(names(GUARD.unguarded(good)), []);
  assert.ok(GUARD.sites(join(FIXTURES, "good/guarded-alias.ts")).length > 0, "the aliased signer is read");
  assert.deepEqual(GUARD.sites(join(FIXTURES, "good/reexports.ts")), []);
  assert.deepEqual(GUARD.sites(join(FIXTURES, "good/shadow.ts")), []);
});
