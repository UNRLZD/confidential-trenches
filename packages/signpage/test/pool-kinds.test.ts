// The pool kinds' wiring (src/pool-kinds.ts): no pool pinned, every kind refused with no read; Base and Robinhood
// refuse a deposit and a withdraw whatever the pins; a sell's decimals come from the device's two reads of the token,
// never from the app; a request that passed is handed to its flow, and with no flow it is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { throughApi } from "./api-ends.ts";
import { ERC20_DECIMALS, poolKinds, readTokenDecimals, type PoolKindsDeps, type PoolRpc } from "../src/pool-kinds.ts";
import { SOLANA_TOKEN_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import type { PoolAsk, PoolChain } from "../src/rules/pool.ts";
import { SolanaRpcTransportError } from "../../kit/src/trade/solana/send.ts";
import { EvmNotFinalError } from "../../wallet/src/pool/evm-restore.ts";

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
});

// card precommit-taken-recover: an EVM pool deposit or sell signs on a precommitment anyone who sees it pending can take
// first with MIN_DEPOSIT. Every device file that builds or signs one (the kit's evmPoolBuildSell or the rule's
// signEvmSell called, or the pool's deposit(uint256,uint256) encoded) must pick its note through the wallet's
// evmNextNote, which restores a taken note and names the next one to sign. Today none does: EVM pool.deposit is refused
// (EVM_REFUSED) and the flow answers only Solana, so the list below is empty; the first flow that lands is held to it.
// the deposit's signature, its selector keccak256("deposit(uint256,uint256)")[0..4] = e2bbb158, or an ABI call by name
// every EVM sell builder and signer, read from the files that define them (the kit's and the rule's, and quoted.ts,
// whose evmQuotedSell builds the sell a signer signs on the precommitment its fields name), so one added later is
// guarded too; and every way to encode a pool deposit
const ROOT = new URL("../../../", import.meta.url).pathname;
const SIGNER_DEFS = ["packages/kit/src/trade/evm/sell.ts", "packages/kit/src/trade/evm/sell-unpinned.ts", "packages/kit/src/trade/evm/quoted.ts", "packages/signpage/src/rules/pool.ts"];
// a name defined by `export function` or by `export const NAME =` an arrow or a function expression; a predicate (`Is`
// before a capital, as evmIsQuotedSell, which only reads quoted.ts's record) builds and signs nothing and is not one
const SIGNER_NAME = /^(?:\w*(?:Build|Sign|Quoted)\w*Sell\w*|signEvmSell\w*)$/;
const PREDICATE = /(?:^is|[a-z0-9]Is)[A-Z]/;
const signerNames = (text: string): string[] =>
  [...text.matchAll(/export (?:async )?function\*? ?(\w+)\s*[<(]|export const (\w+)\s*(?::[^=]*)?=\s*(?:async\b|function\b|\(|<|\w+\s*=>)/g)]
    .map((m) => (m[1] ?? m[2])!)
    .filter((name) => SIGNER_NAME.test(name) && !PREDICATE.test(name));
const SIGNERS = [...new Set(SIGNER_DEFS.flatMap((f) => signerNames(readFileSync(join(ROOT, f), "utf8"))))];
const EVM_SIGNS = new RegExp(`(?<!function )\\b(?:${SIGNERS.join("|")})\\(|deposit\\(uint256,uint256\\)|e2bbb158|functionName:\\s*["']deposit["']`, "i");
// a call of evmNextNote, outside comments: a word in a comment guards nothing
const calls = (text: string): boolean => /\bevmNextNote\(/.test(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"));
const unguarded = (files: readonly { path: string; text: string }[]): string[] =>
  files.filter((f) => EVM_SIGNS.test(f.text) && !calls(f.text)).map((f) => f.path);
const sources = (dir: string): { path: string; text: string }[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [{ path, text: readFileSync(path, "utf8") }] : [];
  });

test("precommit-taken-recover: no device file signs an EVM pool deposit or sell without picking its note through evmNextNote", () => {
  const root = ROOT;
  // the signers' own files and the kit's quote.ts (a quote's simulation, signed by its caller on the note the caller
  // names) define what is called; every caller is in these trees
  const own = new Set([...SIGNER_DEFS, "packages/kit/src/checks/evm/quote.ts"].map((f) => join(root, f)));
  for (const name of ["evmPoolBuildSell", "evmPoolSignSell", "evmPoolSignSimSell", "evmPoolBuildSellUnpinned", "evmPoolSignSellUnpinned", "pinnedSignSell", "signEvmSell", "signEvmSellSim", "evmQuotedSell"]) assert.ok(SIGNERS.includes(name), `${name} is guarded`);
  assert.equal(SIGNERS.includes("evmIsQuotedSell"), false, "a predicate signs nothing");
  // planted: a signer defined as an arrow or a function expression is read; a predicate is not
  assert.deepEqual(signerNames("export const fooSignSell = (k) => k;\nexport const barBuildSell = function (q) {};\nexport function evmQuotedSell(v) {}"), ["fooSignSell", "barBuildSell", "evmQuotedSell"]);
  assert.deepEqual(signerNames("export const evmIsQuotedSell = (s) => true;\nexport function isSignedSell(s) {}"), []);
  const files = ["packages/signpage/src", "apps/terminal/src", "packages/wallet/src", "packages/kit/src", "apps/helper/src"].flatMap((d) => sources(join(root, d))).filter((f) => !own.has(f.path) && !/\.test\.(ts|mjs)$/.test(f.path));
  assert.ok(files.length > 50, "the trees were read");
  // planted: a call of each signer without evmNextNote is caught, and with it is not
  assert.deepEqual(unguarded(SIGNERS.map((name) => ({ path: `${name}.ts`, text: `const s = ${name}(key, ctx, built);` }))), SIGNERS.map((name) => `${name}.ts`));
  assert.deepEqual(unguarded(SIGNERS.map((name) => ({ path: `${name}.ts`, text: `const { next } = evmNextNote(seed, scope, events, first); const s = ${name}(key, ctx, built);` }))), []);
  assert.deepEqual(unguarded(files), []);
  // planted: a flow that signs a sell, or encodes a deposit, without evmNextNote is caught; one that uses it is not
  assert.deepEqual(unguarded([{ path: "a.ts", text: "const s = signEvmSell(key, ctx, built);" }, { path: "b.ts", text: 'const sel = "deposit(uint256,uint256)";' }, { path: "c.ts", text: "const b = evmPoolBuildSell(q, f);" }, { path: "f.ts", text: 'const data = "0xE2BBB158" + args;' }, { path: "g.ts", text: 'encodeFunctionData({ abi, functionName: "deposit", args });' }, { path: "h.ts", text: "// evmNextNote(seed, scope, events, first) would go here\nconst s = signEvmSell(key, ctx, built);" }]), ["a.ts", "b.ts", "c.ts", "f.ts", "g.ts", "h.ts"]);
  assert.deepEqual(unguarded([{ path: "d.ts", text: "const { next } = evmNextNote(seed, scope, events, first); const s = signEvmSell(key, ctx, built);" }, { path: "e.ts", text: "export function signEvmSell(k) {}" }]), []);
});
