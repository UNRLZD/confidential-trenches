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
import { buildEntry, EXEMPT, NON_SIGNERS, ROOT, SIGNER_DEFS, signerGuard } from "./signer-guard.ts";

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

test("Base and Robinhood hand a pinned pool's pool.deposit (its check, rules/pool.ts checkEvmDeposit, card pool-deposits) and pool.withdraw (checkEvmOnwardSend) to the flow; Solana's go to the flow", async () => {
  const flows: PoolAsk[] = [];
  const deps: PoolKindsDeps = { pinned: () => true, rpcs: () => null, flow: (ask) => (flows.push(ask), { error: "busy" }) };
  const k = poolKinds(deps);
  for (const chain of ["base", "robinhood"] as const) assert.deepEqual(k["pool.deposit"]({ chain, amount: "0.001" }, ctx), { error: "busy" });
  assert.deepEqual(flows.map((a) => [a.kind, a.chain, a.amount, a.decimals]), [["pool.deposit", "base", 10n ** 15n, 18], ["pool.deposit", "robinhood", 10n ** 15n, 18]]);
  flows.length = 0;
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
// evmNextNote, which restores a taken note and names the next one to sign. The first that does is the EVM deposit
// runner (src/pool-deposit-evm.ts, card pool-deposits), whose signEvmDeposit call follows its own evmNextNote pick.
// card signer-guard-parser (reviewer L3 of pool-restore-wired, the review of 1a8a42f0 and the re-review of 40115c3d): the
// guard reads code, not names (test/signer-guard.ts has the rules, and what they do not prove): every name is bound to
// its declaration by the TypeScript compiler; a signer is only called, after an evmNextNote that runs first, or
// re-exported; a namespace, an import() or a glob that could reach one only as a plain member read; noble's curve and
// bip32's HD keys sign only in the functions that do today; no code from text, no helper import on the device. It reads
// every module the page's build reaches from the build's own entry (scripts/build-app.mjs `input:`), held to the Vite
// bundle's one chunk and its npm packages on both networks, and the device trees besides. The planted cases are files
// in test/fixtures/signer-guard/.
const FIXTURES = join(ROOT, "packages/signpage/test/fixtures/signer-guard");
const FIXTURE_DEFS = ["packages/signpage/test/fixtures/signer-guard/defs.ts", "packages/signpage/test/fixtures/signer-guard/d01-defs.ts", "packages/signpage/test/fixtures/signer-guard/bad/m1-define-leak.ts"];
const TREES = ["packages/signpage/src", "apps/terminal/src", "packages/wallet/src", "packages/kit/src", "apps/helper/src"];
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|js|mjs)$/.test(name) && !/\.d\.ts$/.test(name) ? [path] : [];
  });
// every signer, as its file defines it: a new export of a signer file is a signer until NON_SIGNERS names it
const SIGNER_LIST = [
  ...["evmPoolBuildSell", "evmPoolSignSell", "evmPoolSignSellAuthorization", "evmPoolSignSimSell"].map((n) => `packages/kit/src/trade/evm/sell.ts#${n}`),
  ...["evmPoolBuildSellUnpinned", "evmPoolSignSellUnpinned", "evmPoolSignSellAuthorizationUnpinned", "evmPoolBuildSimSellUnpinned", "evmPoolSignSimSellUnpinned", "evmSellCallData", "pinnedBuildSell", "pinnedSignSell", "pinnedSignSimSell", "pinnedSignSellAuthorization"].map((n) => `packages/kit/src/trade/evm/sell-unpinned.ts#${n}`),
  "packages/kit/src/trade/evm/quoted.ts#evmQuotedSell",
  ...["signEvmSell", "signEvmSellSim", "signEvmAuthorization", "signEvmDeposit"].map((n) => `packages/signpage/src/rules/pool.ts#${n}`),
];
const FIXTURE_SIGNERS = ["packages/signpage/test/fixtures/signer-guard/defs.ts#fixtureSignSell", "packages/signpage/test/fixtures/signer-guard/defs.ts#fixtureBuildSell", "packages/signpage/test/fixtures/signer-guard/d01-defs.ts#fastPath", "packages/signpage/test/fixtures/signer-guard/bad/m1-define-leak.ts#leakSign"];
// carried from precommit-taken-recover: each signer called with no evmNextNote is refused, and with it (by its own
// name, in the same function) passes; files the program reads as if on disk
const LOOP = join(FIXTURES, "loop");
const NEXT_NOTE_FILE = join(ROOT, "packages/wallet/src/pool/evm-restore.ts");
const loopFile = (s: string, guarded: boolean) => {
  const [file, name] = s.split("#") as [string, string];
  const pick = guarded ? `import { evmNextNote } from "${NEXT_NOTE_FILE}";\n` : "";
  return `import { ${name} } from "${join(ROOT, file)}";\n${pick}export const f = (a: never) => {\n  ${guarded ? "evmNextNote(a, a, a, a, a);\n  " : ""}return (${name} as (...x: never[]) => unknown)(a);\n};\n`;
};
const VIRTUAL = new Map(SIGNER_LIST.flatMap((s) => [[join(LOOP, `${s.split("#")[1]}.ts`), loopFile(s, false)], [join(LOOP, `${s.split("#")[1]}.guarded.ts`), loopFile(s, true)]] as const));
const ENTRY = buildEntry();
const TREE_FILES = TREES.flatMap((d) => sources(join(ROOT, d))).filter((f) => !/\.test\.(ts|mjs)$/.test(f));
const FIXTURE_FILES = sources(FIXTURES);
// one program for all of them (built once: every test reads this one); the fixtures' signer files only add signers no
// real file reaches, and the planted leak is a signer file, `define` as the real four are
// the planted L3 case: the test exempts signDigest in it, as EXEMPT does in sell-unpinned.ts
const L3_FIXTURE = "packages/signpage/test/fixtures/signer-guard/bad/l3-nested-exempt-name.ts";
const GUARD_MS = Date.now();
const GUARD = signerGuard(ENTRY, [...TREE_FILES, ...FIXTURE_FILES], [...SIGNER_DEFS, ...FIXTURE_DEFS], VIRTUAL, { ...NON_SIGNERS, [FIXTURE_DEFS[0]!]: ["fixtureIsQuotedSell", "isSignedSell"], [FIXTURE_DEFS[2]!]: ["own"] }, { ...EXEMPT, [FIXTURE_DEFS[2]!]: { define: true }, [L3_FIXTURE]: { curve: ["signDigest"] } });
const GUARD_BUILT_MS = Date.now() - GUARD_MS;
const names = (files: readonly string[]) => files.map((f) => f.slice(ROOT.length));
/** The npm packages the page bundles, by name and version: a new one (a signing library) is read here first. */
const BUNDLED_PACKAGES = ["@noble+curves@2.4.0", "@noble+hashes@2.4.0", "@scure+base@2.4.0", "@scure+bip32@2.4.0", "@scure+bip39@2.4.0", "@zk-kit+lean-imt@2.2.4", "@zk-kit+utils@1.4.1", "base64-js@1.5.1", "buffer@6.0.3", "ieee754@1.2.1", "poseidon-lite@0.3.0"];

test("signer-guard-parser: the guard reads every module the page bundles, from the build's own entry", async () => {
  assert.equal(ENTRY, join(ROOT, "packages/signpage/src/main.ts"), "build-app.mjs input: join(pkg, \"src/main.ts\")");
  assert.ok(GUARD.graph.length > 50 && GUARD.graph.includes(ENTRY), "the build's graph was read");
  assert.deepEqual(GUARD.unresolved, [], "every module of ours binds");
  const BUILD: string = "../scripts/build-app.mjs"; // plain JavaScript, with no types
  const { bundle } = (await import(BUILD)) as { bundle: (pkg: undefined, o: { network: string }) => Promise<{ modules: string[]; chunks: number }> };
  for (const network of ["mainnet", "testnet"]) {
    const { modules, chunks } = await bundle(undefined, { network });
    assert.equal(chunks, 1, `${network}: one chunk, so its module list is the whole page`);
    const own = modules.filter((m) => !/[\\/]node_modules[\\/]/.test(m) && !m.startsWith("\0")).map((m) => m.split("?")[0]!);
    assert.ok(own.length > 50, `${network}: the bundle's modules were listed`);
    assert.deepEqual(own.filter((m) => !GUARD.graph.includes(m)), [], `${network}: every module the bundle holds is read`);
    assert.deepEqual(modules.filter((m) => m.startsWith("\0")), ["\0rolldown/runtime.js"], `${network}: the bundler's runtime is its only virtual module`);
    const packages = [...new Set(modules.filter((m) => /[\\/]node_modules[\\/]/.test(m)).map((m) => m.match(/[\\/]\.pnpm[\\/]([^\\/]+)[\\/]/)?.[1] ?? `unread: ${m}`))].sort();
    assert.deepEqual(packages, BUNDLED_PACKAGES, `${network}: the npm packages the page bundles`);
  }
  // planted: a re-export or a type is not a reach; the kit index (export * from sell.ts) has none
  assert.deepEqual(GUARD.sites(join(ROOT, "packages/kit/src/index.ts")), []);
});

test("precommit-taken-recover: no device file signs an EVM pool deposit or sell without picking its note through evmNextNote", () => {
  assert.deepEqual([...GUARD.signers].sort(), [...SIGNER_LIST, ...FIXTURE_SIGNERS].sort(), "every export of a signer file but NON_SIGNERS is a signer");
  for (const name of ["evmIsQuotedSell", "fixtureIsQuotedSell", "isSignedSell"]) assert.ok(!GUARD.signers.some((s) => s.endsWith(`#${name}`)), `${name}: a predicate signs nothing`);
  // carried from main: each signer called with no evmNextNote is refused, and with it passes
  const loop = [...VIRTUAL.keys()];
  assert.deepEqual(names(GUARD.unguarded(loop)), names(loop.filter((f) => !f.endsWith(".guarded.ts"))));
  for (const f of loop.filter((f) => f.endsWith(".guarded.ts"))) assert.ok(GUARD.sites(f).some((s) => s.ok && s.what.startsWith("calls ")), `${f}: its signer call is read`);
  // every file the page bundles, and every file of the device trees, signer files and quote.ts included (EXEMPT lets
  // each only what it needs)
  const files = [...new Set([...GUARD.graph, ...TREE_FILES])].filter((f) => !f.startsWith(FIXTURES));
  assert.ok(files.length > 50, "the trees were read");
  for (const f of SIGNER_DEFS) assert.ok(GUARD.sites(join(ROOT, f)).length > 0, `${f}: the reader sees the signers in their own files`);
  assert.deepEqual(names(GUARD.unguarded(files)), [], JSON.stringify(GUARD.unguarded(files).flatMap(GUARD.sites).filter((s) => !s.ok)));
  // each exemption is used where it is named: a function renamed or gone takes its exemption with it
  for (const [path, ex] of Object.entries(EXEMPT)) {
    const read = GUARD.sites(join(ROOT, path));
    for (const fn of ex.curve ?? []) assert.ok(read.some((s) => s.ok && s.what === `signs with a pinned package in ${fn} (exempt)`), `${path}#${fn}: a curve exemption with no signing in it`);
    for (const fn of ex.sellType ?? []) assert.ok(read.some((s) => s.ok && s.what === `holds the EIP-712 Sell type in ${fn} (exempt)`), `${path}#${fn}: a Sell type exemption with no Sell type in it`);
  }
  console.log(`signer guard: program ${GUARD_BUILT_MS} ms; sites of ${files.length} files read in this test`);
});

test("signer-guard-parser: every planted signer and encoder in fixtures/signer-guard/bad is caught, and none in good/", () => {
  const pool = /signpage\/src\/rules\/pool\.ts#signEvmSell\b/.source;
  const sell = /kit\/src\/trade\/evm\/sell\.ts#evmPoolSignSell\b/.source;
  const no = ", with no evmNextNote run before it";
  const r = (...parts: string[]) => new RegExp(parts.join("[\\s\\S]*"));
  // each bad file, and what the guard reads in it; "carried" ones main's name guard caught already, b* and d01 are the
  // review's variants of 1a8a42f0 (red there)
  const BAD: Record<string, RegExp> = {
    "alias.ts": r(`calls .*${pool}${no}`),
    "namespace.ts": r(`calls .*${sell}${no}`),
    "namespace-whole.ts": r("uses whole, or by a computed key, a module that exports"),
    "call.ts": r(`calls .*${pool}${no}`),
    "apply.ts": r(`calls .*${sell}${no}`),
    "arrow-const.ts": r(`calls .*defs\\.ts#fixtureSignSell${no}`),
    "reassign.ts": r(`holds or hands on .*${pool}`),
    "reassign-export.ts": r(`holds or hands on .*${pool}`),
    "reassign-import.ts": r(`calls .*${pool}${no}`),
    "encoder-ethers.ts": r(`encodes the deposit with encodeFunctionData${no}`),
    "encoder-abi.ts": r("holds the deposit's ABI entry", 'encodes the deposit: "deposit\\(uint256, uint256\\)"'),
    "fake-guard.ts": r(`calls .*${pool}${no}`),
    "plain.ts": r("evmPoolBuildSell", pool, "defs\\.ts#fixtureBuildSell"), // carried
    "encoder-viem.ts": r('encodes functionName "deposit"', 'encodes the deposit: "deposit\\(uint256,uint256\\)"', 'encodes the deposit: "0xE2BBB158"'), // carried
    "selector-number.ts": r(`encodes the deposit selector${no}`), // carried: main caught it as 0xe2bbb158 too
    "b01-dynimport-computed.ts": r("imports at run time a module that exports", "uses whole, or by a computed key"),
    "b02-dynimport-any.ts": r("imports at run time a module that exports"),
    "b03-dynimport-then-any.ts": r("imports at run time a module that exports"),
    "b04b-computed-destructure-typed.ts": r("uses whole, or by a computed key", `calls a value of the type of .*${sell}`),
    "b04c-computed-destructure-literal.ts": r("uses whole, or by a computed key"),
    "b05c-destructure-json-plain.ts": r("uses whole, or by a computed key"),
    "b06a-guarded-holder.ts": r(`holds or hands on .*${pool}`, `holds or hands on .*${pool}`),
    "b06b-array-user.ts": r(`calls a value of the type of .*${pool}${no}`),
    "b07-return-user.ts": r(`calls a value of the type of .*${pool}${no}`),
    "b08-dead-guard.ts": r(`calls .*${pool}${no}`),
    "b09b-glob-literal.ts": r("import\\.meta\\.glob"),
    "b11-deposit-decimal.ts": r(`encodes the deposit selector${no}`),
    "b10-handrolled-sell.ts": r(`holds the EIP-712 Sell type${no}`, "uses @noble/curves: \\.sign"),
    "b16-globalthis.ts": r(`holds or hands on .*${pool}`),
    "b18-dynimport-destructure-computed.ts": r("imports at run time a module that exports"),
    "b19-dynimport-default.ts": r("imports at run time a module that exports .*#signEvmSell", "uses whole, or by a computed key"),
    "d01-user.ts": r(`calls .*d01-defs\\.ts#fastPath${no}`),
    // the re-review of 40115c3d: each passes at 40115c3d, and is refused here
    "b08b-dead-pick-same-body.ts": r(`calls .*${pool}${no}`), // L1
    "b08c-pick-after.ts": r(`calls .*${pool}${no}`, `calls .*${pool}${no}`, `calls .*${pool}${no}`), // L1
    "b12-deposit-runtime-signed.ts": r("uses @scure/bip32: \\.sign"), // H1
    "b13-deposit-template-signed.ts": r("uses @scure/bip32: \\.sign"), // H1
    "b14-encoder-nonliteral-signed.ts": r("imports the helper \\(a server file\\) on the device"), // M1
    "b15-viem-nonliteral-signed.ts": r("calls a value read off globalThis through a cast"), // M1
    "b16b-globalthis-caller.ts": r("calls a value read off globalThis through a cast", "calls a value read off globalThis through a cast"), // M1
    "m1-define-leak.ts": r("holds or hands on .*m1-define-leak\\.ts#leakSign"), // M1
    "b21-hdkey-sell.ts": r("constructs @scure/bip32"), // H1
    "b21b-hdkey-deposit.ts": r("uses @scure/bip32: \\.sign"), // H1
    "b21c-hdkey-escapes.ts": r("casts a value of @scure/bip32", "destructures @scure/bip32 .* past the members it may use", "uses @scure/bip32 by a key it computes", "hands a value of @scure/bip32 .* on as another type", "imports HARDENED_OFFSET of @scure/bip32"), // H1
    "b21d-typehash-bytes.ts": r(`encodes the Sell type hash: "0x7964e18e.*${no}`, `encodes the Sell type hash as a number${no}`, `encodes the Sell type hash as bytes${no}`, `encodes the deposit as bytes${no}`), // H1
    "b30-eval.ts": r("imports node:vm", "runs code from text: eval", "runs code from text: Function", "runs code from text: a callee of the type Function", "runs code from text: eval", "runs code from text: setTimeout given a string"), // L2
    "b31-helper-signer.ts": r("imports the helper \\(a server file\\) on the device"), // M1
    "b40-selector-held.ts": r(`encodes the deposit: "0xe2bbb158"${no}`), // the selector held, then compared: still an encoding
    "b41-selector-joined.ts": r(`encodes the deposit: "0xe2bbb158"${no}`), // joined to arguments inside a ===
    "b42-selector-narrowed.ts": r(`encodes the deposit: "0xe2bbb158"${no}`), // compared to a name the compare narrows, then joined (review L1)
    // the re-review of c00a169d: each passes at c00a169d, and is refused here (k4, k6 and p9 were refused there too)
    "p1-point-ecdsa.ts": r("uses @noble/curves: \\.Fn of its WeierstrassPointCons", "uses @noble/curves: \\.multiply of its WeierstrassPoint", "uses @noble/curves: \\.BASE of its WeierstrassPointCons", "uses @noble/curves: \\.multiply of its WeierstrassPoint"), // H1b
    "p2-dynimport-pinned.ts": r("imports at run time a module that exports @scure/bip32", "uses whole, or by a computed key, a module that exports @scure/bip32", "imports at run time a module that exports @noble/curves", "uses whole, or by a computed key, a module that exports @noble/curves"), // H1
    "p3b-reexport-user.ts": r("uses whole, or by a computed key, a module that exports @scure/bip32", "uses whole, or by a computed key, a module that exports @scure/bip32", "imports at run time a module that exports @scure/bip32"), // H1
    "l3-nested-exempt-name.ts": r("uses @noble/curves: \\.sign of its ECDSA"), // L3: the nested signDigest; the top-level one is exempt (below)
    "k1-toplevel-pick.ts": r(`calls .*${pool}${no}`), // L1
    "k4-hoisted.ts": r(`calls .*${pool}${no}`),
    "k6-closure-before-pick.ts": r(`calls .*${pool}${no}`),
    "p9-subclass.ts": r("hands a value of @scure/bip32 \\(HDKey\\) on as another type", "casts a value of @scure/bip32"),
    // the review of 1a367f1e: H1c's exact case was refused there by the root-name rule (nc itself); its read off our
    // re-export (line 12 of h1c-namespace-nonroot.ts) and L1b's field, decorator and static block passed there
    "h1c-namespace-exact.ts": r("reads schnorr of @noble/curves off a namespace"), // H1c
    "h1c-namespace-nonroot.ts": r(...Array(4).fill("reads schnorr of @noble/curves off a namespace")), // H1c
    "l1b-class-field.ts": r(...Array(4).fill(`calls .*${pool}${no}`)), // L1b
  };
  const bad = FIXTURE_FILES.filter((f) => f.startsWith(join(FIXTURES, "bad")));
  assert.deepEqual(bad.map((f) => f.slice(FIXTURES.length + 5)).sort(), Object.keys(BAD).sort(), "the planted cases were read");
  assert.deepEqual(names(GUARD.unguarded(bad)), names(bad));
  assert.deepEqual(GUARD.sites(join(ROOT, L3_FIXTURE)).map((s) => [s.line, s.ok]), [[5, true], [9, false]], "L3: only the top-level signDigest is exempt");
  assert.ok(GUARD.sites(join(FIXTURES, "bad/h1c-namespace-nonroot.ts")).some((s) => s.line === 12 && !s.ok && /reads schnorr/.test(s.what)), "H1c: schnorr read off our own re-export");
  for (const f of bad) assert.match(GUARD.sites(f).filter((s) => !s.ok).map((s) => s.what).join("\n"), BAD[f.slice(FIXTURES.length + 5)]!, f);
  // no false refusal: the rule's signer by an alias, with the wallet's evmNextNote by an alias in the same function, is
  // read and passes; a re-export (named, `export *`, a default), types, a predicate, a comment, a local that shares a
  // signer's name, and names destructured one by one from a namespace are no refusal
  const good = FIXTURE_FILES.filter((f) => f.startsWith(join(FIXTURES, "good")));
  assert.equal(good.length, 7);
  // a rule comparing a call's selector to the deposit's (rules/pool.ts checkEvmDeposit): a check, read and passed
  assert.deepEqual(GUARD.sites(join(FIXTURES, "good/g-selector-compare.ts")).map((s) => [s.line, s.ok]), [[3, true], [4, true]], "a selector compared is a check");
  assert.deepEqual(names(GUARD.unguarded(good)), []);
  assert.ok(GUARD.sites(join(FIXTURES, "good/guarded-alias.ts")).some((s) => s.ok && /^calls .*#signEvmSell$/.test(s.what)), "the aliased signer is read");
  // M2 (the re-review of 40115c3d): a pick before a callback that signs, as pool-sell.ts's Solana flow signs in a .map
  // and under locks.request, passes; refused at 40115c3d
  for (const f of ["f01-nested-map.ts", "f03-lock-callback.ts"]) assert.ok(GUARD.sites(join(FIXTURES, "good", f)).some((s) => s.ok && /^calls .*#signEvmSell$/.test(s.what)), `${f}: the signer call in its callback is read and passes`);
  for (const f of ["reexports.ts", "shadow.ts", "default-reexport.ts"]) assert.deepEqual(GUARD.sites(join(FIXTURES, "good", f)), [], f);
});
