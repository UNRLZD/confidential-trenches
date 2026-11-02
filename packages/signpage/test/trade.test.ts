// The `buy` kind on Solana (src/trade.ts), card signpage-solana-trade.
//   node --test test/trade.test.ts      (from packages/signpage)
// runSolanaTrade is a stand-in here that signs each leg through the handler's signer and reports the kit's stages;
// the kit's own tests cover the trade itself. The seed is the §A.8 test seed (16 zero bytes), whose keys are
// published; the store is a Map with the store's get, put and keys.
import assert from "node:assert/strict";
import { test } from "node:test";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { entropyToWords, freshWallet, wordsToSeed64 } from "@blindfill/wallet/derive";
import { armKey, type ArmRecord } from "@blindfill/wallet/arming/records";
import { SOLANA_TOKEN_PROGRAM, solanaAta } from "../../kit/src/checks/solana/index.ts";
import type { SolanaTradeDeps, SolanaTradeRecord, SolanaTradeRequest } from "../../kit/src/trade/solana/flow.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import type { Stage } from "../../kit/src/signpage/messages.ts";
import { RELEASE_HELPER } from "../../wallet/src/withdraw/relay.ts";
import { TRADE_HELPER, buyLegs, ladderSizes, refusalCode, sellSplit, tradeKind } from "../src/trade.ts";

const L = 0x223ba5af661ac5b8dfb52a527bf1c7aaf7853d423364c2b7d347febe93436b32n;
const seed = () => wordsToSeed64(entropyToWords(new Uint8Array(16)));
const W = [0, 1, 2, 3].map((j) => {
  const w = freshWallet(seed(), "sol", L, j);
  w.secretKey.fill(0);
  return w;
});
const MINT = "7G36iB8rmCjtik3X68siSPxXXnsypXqzxdbJoajQpump";
const STRANGER = "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS";
const rec = (j: number, size: bigint, over: Partial<ArmRecord> = {}): ArmRecord => ({
  v: 1, chain: "sol", l: L, j, address: W[j]!.address, role: "fresh", size_cents: size, state: "READY", own: { context: "cd".repeat(32) }, spend: 10_000_000n * BigInt(j + 1), ...over,
});

function store(wallets: Record<string, unknown> = {}) {
  const m = { wallets: new Map(Object.entries(wallets)), ops: new Map<string, unknown>() } as Record<string, Map<string, unknown>>;
  return {
    m,
    async get(s: string, k: string) { return m[s]!.get(k); },
    async put(s: string, k: string, v: unknown) { m[s]!.set(k, structuredClone(v)); },
    async keys(s: string) { return [...m[s]!.keys()]; },
  };
}

type Script = { final?: Stage; legState?: (i: number) => "filled" | "failed" | "unknown"; refuse?: string; signAs?: string; hold?: Promise<void> };
/** runSolanaTrade's stand-in: signs each leg (or `signAs`) through deps.sign, then signed, sent and the final stage. */
function standIn(script: Script, calls: SolanaTradeRequest[]) {
  return async (req: SolanaTradeRequest, deps: SolanaTradeDeps): Promise<SolanaTradeRecord> => {
    calls.push(req);
    const legs: SolanaTradeRecord["legs"] = req.legs.map((l) => ({ wallet: l.wallet, amount: l.amount, expectedOut: 1n, minOut: 1n }));
    if (script.refuse) {
      legs.forEach((l) => (l.refused = script.refuse));
      deps.onProgress?.("refused");
      return { side: req.side, token: req.token, reference: 1n, blockhash: null, legs };
    }
    const msg = new TextEncoder().encode(`message of ${req.side}`);
    for (const l of legs) {
      const sig = await deps.sign!(script.signAs ?? l.wallet, msg);
      assert.ok(ed25519.verify(sig, msg, base58.decode(script.signAs ?? l.wallet)));
      l.signature = base58.encode(sig);
    }
    deps.onProgress?.("signed");
    deps.onProgress?.("sent");
    await script.hold;
    legs.forEach((l, i) => (l.outcome = { signature: l.signature!, state: script.legState?.(i) ?? "filled" } as never));
    if (script.final) deps.onProgress?.(script.final as never);
    return { side: req.side, token: req.token, reference: 1n, blockhash: null, legs };
  };
}

const noRpc: SolanaRpc = async () => { throw new Error("no read expected"); };
function page(s: ReturnType<typeof store>, script: Script, providers: readonly [SolanaRpc, SolanaRpc] = [noRpc, noRpc]) {
  const calls: SolanaTradeRequest[] = [];
  let opened = 0;
  const handler = tradeKind({
    store: async () => s,
    seed64: async () => (opened++, seed()),
    deps: { helper: "https://api.confidential.unrealized.trade", providers, reference: async () => 1n, paths: [] },
    run: standIn(script, calls) as never,
    now: () => 1_700_000_000_000,
  });
  const progress: Stage[] = [];
  const ask = async (params: Record<string, unknown>, id: string = crypto.randomUUID()) => {
    const d = handler(params, { id, progress: (st) => void progress.push(st) });
    if (!d) return { id, answer: null };
    await d.after;
    const answer = d.answer();
    await new Promise((r) => setTimeout(r, 10));
    return { id, answer };
  };
  return { ask, calls, progress, opened: () => opened };
}
const buy = (amount: string) => ({ chain: "solana", token: MINT, side: "buy", amount, slippage_bps: 500 });
const sell = (amount: string) => ({ chain: "solana", token: MINT, side: "sell", amount, slippage_bps: 500 });

test("a chain other than solana, or an amount that is not USD cents or token units, is refused not_allowed", async () => {
  const p = page(store(), {});
  for (const params of [{ ...buy("10"), chain: "base" }, buy("10.001"), buy("0"), buy("-1"), sell("1.5"), sell("0"), sell("18446744073709551616")]) {
    assert.equal((await p.ask(params)).answer, null, JSON.stringify(params));
  }
  assert.equal(p.calls.length, 0);
});

test("a buy: the ladder split's READY wallets from the arm records, answered at sent with the txs, the fill as progress, the records moved IN_POSITION", async () => {
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n), [armKey("sol", L, 1)]: rec(1, 500n), [armKey("sol", L, 2)]: rec(2, 200n), [armKey("sol", L, 3)]: rec(3, 200n) });
  const p = page(s, { final: "filled" });
  const { id, answer } = await p.ask(buy("17"));
  assert.deepEqual(p.calls[0]!.legs, [
    { wallet: W[0]!.address, amount: 10_000_000n, arm: { own: true } },
    { wallet: W[1]!.address, amount: 20_000_000n, arm: { own: true } },
    { wallet: W[2]!.address, amount: 30_000_000n, arm: { own: true } },
  ]);
  assert.equal(p.calls[0]!.slippageBps, 500);
  const txs = (answer as { result: { stage: string; txs: { chain: string; hash: string }[] } }).result;
  assert.equal(txs.stage, "sent");
  assert.equal(txs.txs.length, 3);
  assert.ok(txs.txs.every((t) => t.chain === "solana" && base58.decode(t.hash).length === 64));
  assert.deepEqual(p.progress, ["filled"]);
  assert.deepEqual(s.m.ops!.get(id), { kind: "buy", stage: "filled", txs: txs.txs, created_ms: 1_700_000_000_000 });
  assert.deepEqual([0, 1, 2, 3].map((j) => (s.m.wallets!.get(armKey("sol", L, j)) as ArmRecord).state), ["IN_POSITION", "IN_POSITION", "IN_POSITION", "READY"]);
  assert.equal((s.m.wallets!.get(armKey("sol", L, 0)) as ArmRecord).token, MINT);
  assert.equal(p.opened(), 1, "the seed opened once for the trade");
});

test("a wallet without this device's own arm record is refused before any signature, whatever the legs say", async () => {
  // a bug or a hostile run hands the signer a stranger's wallet with arm.own true: the wallet's signer refuses it
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n) });
  const p = page(s, { final: "filled", signAs: STRANGER });
  const { id, answer } = await p.ask(buy("10"));
  assert.deepEqual(answer, { error: "not_armed" });
  assert.equal(p.opened(), 0, "the seed was never opened, so nothing was signed");
  assert.deepEqual(s.m.ops!.get(id), { kind: "buy", stage: "refused", txs: [], code: "not_armed", created_ms: 1_700_000_000_000 });
  // and a record that lacks the own-withdrawal mark gives no leg at all
  const t = store({ [armKey("sol", L, 0)]: { ...rec(0, 1_000n), own: undefined } });
  const q = page(t, { final: "filled" });
  assert.deepEqual((await q.ask(buy("10"))).answer, { error: "no_ready_set" });
  assert.equal(q.calls.length, 0);
});

test("a price check refusal is quote_check_failed (Price check failed); other refusals keep their own code (Failed)", async () => {
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n) });
  const p = page(s, { refuse: "checks: S12 the simulated out is under the bar" });
  const { id, answer } = await p.ask(buy("10"));
  assert.deepEqual(answer, { error: "quote_check_failed" });
  assert.equal((s.m.ops!.get(id) as { code: string }).code, "quote_check_failed");
  const leg = (refused: string) => ({ side: "buy" as const, token: MINT, reference: 1n, blockhash: null, legs: [{ wallet: W[0]!.address, amount: 1n, expectedOut: 1n, minOut: 1n, refused }] });
  assert.equal(refusalCode(leg("no reference pool")), "quote_check_failed");
  assert.equal(refusalCode(leg("the route's floor stays under 5")), "quote_check_failed");
  assert.equal(refusalCode(leg("the wallet was not armed by this device's own withdrawal")), "not_armed");
  assert.equal(refusalCode(leg("build no_route: No routes found")), "no_route");
  assert.equal(refusalCode(leg("error: boom")), "failed");
  assert.deepEqual((await page(store(), {}).ask(buy("10"))).answer, { error: "no_ready_set" }, "no arm record at all");
  assert.deepEqual((await page(store({ [armKey("sol", L, 0)]: rec(0, 1_000n) }), {}).ask(buy("3"))).answer, { error: "no_ready_set" }, "$3 is no ladder sum");
});

test("a repeated id is never run again: answered from its ops record, or id_reused while it is pending", async () => {
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n), [armKey("sol", L, 1)]: rec(1, 1_000n) });
  const p = page(s, { final: "filled" });
  const first = await p.ask(buy("10"));
  const again = await p.ask(buy("10"), first.id);
  assert.equal(p.calls.length, 1, "one run");
  assert.deepEqual(again.answer, { result: { stage: "filled", txs: (s.m.ops!.get(first.id) as { txs: unknown[] }).txs } });
  s.m.ops!.set("pending-id", { kind: "buy", stage: "pending", txs: [], created_ms: 1 });
  assert.deepEqual((await p.ask(buy("10"), "pending-id")).answer, { error: "id_reused" });
  assert.equal(p.calls.length, 1);
});

test("not landed: answered at sent, then not_landed as progress; the wallets stay READY", async () => {
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n) });
  const p = page(s, { final: "not_landed", legState: () => "failed" });
  const { answer } = await p.ask(buy("10"));
  assert.equal((answer as { result: { stage: string } }).result.stage, "sent");
  assert.deepEqual(p.progress, ["not_landed"]);
  assert.equal((s.m.wallets!.get(armKey("sol", L, 0)) as ArmRecord).state, "READY");
});

/** A provider answering getMultipleAccounts with the mint and each wallet's token account holding `held[w]`. */
function provider(held: Record<string, bigint>): SolanaRpc {
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  const byAta = new Map(Object.entries(held).map(([w, n]) => [solanaAta(w, MINT, SOLANA_TOKEN_PROGRAM), [w, n] as const]));
  return async (method, params) => {
    assert.equal(method, "getMultipleAccounts");
    const keys = params[0] as string[];
    return {
      value: keys.map((k) => {
        if (k === MINT) return { owner: SOLANA_TOKEN_PROGRAM, lamports: 1, data: [b64(new Uint8Array(82)), "base64"] };
        const x = byAta.get(k);
        if (!x) return null;
        const d = new Uint8Array(165);
        d.set(base58.decode(MINT), 0);
        d.set(base58.decode(x[0]), 32);
        new DataView(d.buffer).setBigUint64(64, x[1], true);
        return { owner: SOLANA_TOKEN_PROGRAM, lamports: 1, data: [b64(d), "base64"] };
      }),
    };
  };
}

test("a sell: the token's IN_POSITION wallets, the amount split by the lower of the two providers' balances; over the held total is refused", async () => {
  const pos = { state: "IN_POSITION" as const, token: MINT };
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n, pos), [armKey("sol", L, 1)]: rec(1, 500n, pos), [armKey("sol", L, 2)]: rec(2, 200n, { ...pos, token: STRANGER }), [armKey("sol", L, 3)]: rec(3, 200n) });
  const a = provider({ [W[0]!.address]: 3_000n, [W[1]!.address]: 1_000n });
  const b = provider({ [W[0]!.address]: 3_000n, [W[1]!.address]: 999n });
  const p = page(s, { final: "filled" }, [a, b]);
  await p.ask(sell("3999"));
  assert.deepEqual(p.calls[0]!.legs.map((l) => [l.wallet, l.amount]), [[W[0]!.address, 3_000n], [W[1]!.address, 999n]], "all of it: each sells its whole balance");
  await p.ask(sell("2000"));
  assert.deepEqual(p.calls[1]!.legs.map((l) => l.amount), [1_501n, 499n]);
  assert.deepEqual((await p.ask(sell("4000"))).answer, { error: "over_held" });
  assert.deepEqual((await page(store(), {}).ask(sell("1"))).answer, { error: "no_position" });
});

test("ladderSizes, buyLegs and sellSplit", () => {
  assert.deepEqual(ladderSizes(13_700n), [10_000n, 2_000n, 1_000n, 500n, 200n]);
  assert.deepEqual(ladderSizes(2_500n), [2_000n, 500n]);
  assert.equal(ladderSizes(300n), null);
  assert.equal(ladderSizes(100n), null);
  assert.equal(buyLegs([{ key: armKey("sol", L, 0), rec: rec(0, 1_000n) }], 2_000n), null, "two $10 do not make the ladder's $20");
  assert.deepEqual(sellSplit(10n, [3n, 3n, 4n]), [3n, 3n, 4n]);
  assert.deepEqual(sellSplit(5n, [3n, 3n, 4n]), [1n, 1n, 3n], "floors 1, 1, 2 and the one left over to the largest");
  assert.equal(sellSplit(11n, [3n, 3n, 4n]), null);
  assert.equal(sellSplit(0n, [3n]), null);
});

test("the trade's helper is the wallet's release helper", () => {
  assert.equal(TRADE_HELPER, RELEASE_HELPER);
});

test("a running trade's wallets are not picked by a second trade; one whose tx is still unknown stays out after it ends", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n), [armKey("sol", L, 1)]: rec(1, 1_000n) });
  const p = page(s, { legState: () => "unknown", hold });
  await p.ask(buy("10"));
  await p.ask(buy("10"));
  assert.deepEqual(p.calls.map((c) => c.legs[0]!.wallet), [W[0]!.address, W[1]!.address], "two trades, two wallets");
  assert.deepEqual((await p.ask(buy("10"))).answer, { error: "no_ready_set" }, "both in use");
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual((await p.ask(buy("10"))).answer, { error: "no_ready_set" }, "their txs are unknown: still out");
  assert.equal(p.calls.length, 2);
});

test("a read that fails before the answer refuses the trade as failed, and the op says so", async () => {
  const pos = { state: "IN_POSITION" as const, token: MINT };
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n, pos) });
  const down: SolanaRpc = async () => { throw new Error("HTTP 503"); };
  const p = page(s, {}, [down, down]);
  const { id, answer } = await p.ask(sell("1"));
  assert.deepEqual(answer, { error: "failed" });
  assert.deepEqual(s.m.ops!.get(id), { kind: "sell", stage: "refused", txs: [], code: "failed", created_ms: 1_700_000_000_000 });
});
