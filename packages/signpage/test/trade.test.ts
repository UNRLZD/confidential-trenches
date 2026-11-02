// The `buy` kind on Solana (src/trade.ts), card signpage-solana-trade.
//   node --test test/trade.test.ts      (from packages/signpage)
// runSolanaTrade is a stand-in here that signs each leg through the handler's signer and reports the kit's stages;
// the kit's own tests cover the trade itself. The seed is the §A.8 test seed (16 zero bytes), whose keys are
// published; the store is a Map with the store's get, put and keys, async and cloned as IndexedDB is, shared by every
// "page" (a tab, or the page after a reload). Each page gets its own view of Node's Web Locks, whose locks go when the
// page dies (die()), as a closed or reloaded tab's do.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { entropyToWords, freshWallet, wordsToSeed64 } from "@blindfill/wallet/derive";
import { armKey, type ArmRecord } from "@blindfill/wallet/arming/records";
import { WALLET_SEED_LOCK } from "@blindfill/wallet/store";
import { SOLANA_TOKEN_PROGRAM, solanaAta } from "../../kit/src/checks/solana/index.ts";
import type { SolanaTradeDeps, SolanaTradeRecord, SolanaTradeRequest } from "../../kit/src/trade/solana/flow.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import type { Stage } from "../../kit/src/signpage/messages.ts";
import { RELEASE_HELPER } from "../../wallet/src/withdraw/relay.ts";
import { readFileSync } from "node:fs";
import { TRADE_HELPER, TRADE_PICK_LOCK, buyLegs, refusalCode, releaseTradeDeps, sellSplit, tradeKind } from "../src/trade.ts";

// the skeleton check's pinned policy (an .mjs with no types: imported by a plain string)
const SKELETON: string = "../../../scripts/live-checks/signpage-skeleton.mjs";
const { CSP } = (await import(SKELETON)) as { CSP: [string, string][] };

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

const tick = () => new Promise((r) => setTimeout(r, 1));
/** The wallet store's get, put and keys over Maps; `failPut(n, store)` fails the n-th put (1-based) when it answers true. */
function store(wallets: Record<string, unknown> = {}, opts: { failPut?: (n: number, s: string) => boolean; slowPut?: (s: string) => number } = {}) {
  const m = { wallets: new Map(Object.entries(wallets)), ops: new Map<string, unknown>() } as Record<string, Map<string, unknown>>;
  let puts = 0;
  return {
    m,
    async get(s: string, k: string) { await tick(); return structuredClone(m[s]!.get(k)); },
    async put(s: string, k: string, v: unknown) {
      await tick();
      const slow = opts.slowPut?.(s) ?? 0;
      if (slow) await new Promise((r) => setTimeout(r, slow));
      if (opts.failPut?.(++puts, s)) throw new Error("QuotaExceededError");
      m[s]!.set(k, structuredClone(v));
    },
    async keys(s: string) { await tick(); return [...m[s]!.keys()]; },
  };
}

/** One page's view of Node's Web Locks: die() lets go of every lock it holds, as a closed or reloaded tab does. */
function tabLocks() {
  let die!: () => void;
  const dead = new Promise<void>((r) => (die = r));
  const locks = {
    request: (name: string, opts: LockOptions, fn: (l: Lock | null) => Promise<unknown>) =>
      navigator.locks.request(name, opts, (l) => Promise.race([fn(l), dead.then(() => undefined)])),
  } as unknown as Pick<LockManager, "request">;
  return { locks, die };
}

type Script = {
  final?: Stage; legState?: (i: number) => "filled" | "failed" | "unknown" | "expired"; refuse?: string; signAs?: string; hold?: Promise<void>;
  /** awaited after the final stage, before run() resolves (a teardown) */
  tail?: Promise<void>;
  atStart?: () => void;
};
/** runSolanaTrade's stand-in: signs each leg (or `signAs`) through deps.sign, then signed, sent and the final stage. */
function standIn(script: Script, calls: SolanaTradeRequest[]) {
  return async (req: SolanaTradeRequest, deps: SolanaTradeDeps): Promise<SolanaTradeRecord> => {
    script.atStart?.();
    calls.push(req);
    const legs: SolanaTradeRecord["legs"] = req.legs.map((l) => ({ wallet: l.wallet, amount: l.amount, expectedOut: 1n, minOut: 1n }));
    if (script.refuse) {
      legs.forEach((l) => (l.refused = script.refuse));
      deps.onProgress?.("refused");
      return { side: req.side, token: req.token, reference: 1n, blockhash: null, legs };
    }
    const msg = new TextEncoder().encode(`message of ${req.side}`);
    for (const l of legs) {
      const sig = await deps.sign!(script.signAs ?? l.wallet, msg, { lastValidBlockHeight: LVBH });
      assert.ok(ed25519.verify(sig, msg, base58.decode(script.signAs ?? l.wallet)));
      l.signature = base58.encode(sig);
    }
    deps.onProgress?.("signed");
    deps.onProgress?.("sent");
    await script.hold;
    legs.forEach((l, i) => (l.outcome = { signature: l.signature!, state: script.legState?.(i) ?? "filled" } as never));
    if (script.final) deps.onProgress?.(script.final as never);
    await script.tail;
    return { side: req.side, token: req.token, reference: 1n, blockhash: null, legs };
  };
}

const LVBH = 1_000;
const noRpc: SolanaRpc = async () => { throw new Error("no read expected"); };
const shaOf = (params: Record<string, unknown>) => createHash("sha256").update(JSON.stringify(params)).digest("hex");
function page(s: ReturnType<typeof store>, script: Script, providers: readonly [SolanaRpc, SolanaRpc] = [noRpc, noRpc]) {
  const calls: SolanaTradeRequest[] = [];
  let opened = 0;
  const tab = tabLocks();
  const handler = tradeKind({
    store: async () => s,
    seed64: async () => (opened++, seed()),
    deps: { helper: "https://api.confidential.unrealized.trade", providers, reference: async () => 1n, paths: [] },
    run: standIn(script, calls) as never,
    now: () => 1_700_000_000_000,
    locks: tab.locks,
  });
  const progress: Stage[] = [];
  const ask = async (params: Record<string, unknown>, id: string = crypto.randomUUID()) => {
    const d = handler(params, { id, sha: shaOf(params), progress: (st) => void progress.push(st) });
    if (!d) return { id, answer: null };
    await d.after;
    const answer = d.answer();
    // a trade that ends: its end; one held open (a reload's tab, a fill never read) is past its answer by then
    await Promise.race([handler.idle(), new Promise((r) => setTimeout(r, 200))]);
    return { id, answer };
  };
  return { ask, calls, progress, opened: () => opened, die: tab.die, idle: () => handler.idle() };
}
const mark = (s: ReturnType<typeof store>, j: number) => (s.m.wallets!.get(armKey("sol", L, j)) as ArmRecord).inflight;
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
  assert.deepEqual(s.m.ops!.get(id), { kind: "buy", sha: shaOf(buy("17")), stage: "filled", txs: txs.txs, created_ms: 1_700_000_000_000 });
  assert.deepEqual((p.calls[0] as { wallets?: string[] }).wallets, [0, 1, 2, 3].map((j) => W[j]!.address), "the kit gets every one of the user's Solana wallets");
  assert.ok([0, 1, 2, 3].every((j) => mark(s, j) === undefined), "every mark is off once the fill is read");
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
  assert.deepEqual(s.m.ops!.get(id), { kind: "buy", sha: shaOf(buy("10")), stage: "refused", txs: [], code: "not_armed", created_ms: 1_700_000_000_000 });
  assert.equal(mark(s, 0), undefined, "nothing signed: the mark is off");
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
  assert.equal(mark(s, 0), undefined, "refused before any signature: the mark is off");
  const leg = (refused: string) => ({ side: "buy" as const, token: MINT, reference: 1n, blockhash: null, legs: [{ wallet: W[0]!.address, amount: 1n, expectedOut: 1n, minOut: 1n, refused }] });
  assert.equal(refusalCode(leg("no reference pool")), "quote_check_failed");
  assert.equal(refusalCode(leg("the route's floor stays under 5")), "quote_check_failed");
  assert.equal(refusalCode(leg("the wallet was not armed by this device's own withdrawal")), "not_armed");
  assert.equal(refusalCode(leg("build no_route: No routes found")), "no_route");
  assert.equal(refusalCode(leg("error: boom")), "failed");
  assert.deepEqual((await page(store(), {}).ask(buy("10"))).answer, { error: "no_ready_set" }, "no arm record at all");
  assert.deepEqual((await page(store({ [armKey("sol", L, 0)]: rec(0, 1_000n) }), {}).ask(buy("3"))).answer, { error: "no_ready_set" }, "$3 is no ladder sum");
});

test("a repeated id is never run again: answered from its ops record, or id_reused while it is pending or for another request", async () => {
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n), [armKey("sol", L, 1)]: rec(1, 1_000n) });
  const p = page(s, { final: "filled" });
  const first = await p.ask(buy("10"));
  const again = await p.ask(buy("10"), first.id);
  assert.equal(p.calls.length, 1, "one run");
  assert.deepEqual(again.answer, { result: { stage: "filled", txs: (s.m.ops!.get(first.id) as { txs: unknown[] }).txs } });
  assert.deepEqual((await p.ask(buy("10.5"), first.id)).answer, { error: "id_reused" }, "the same id with another request");
  const pending = crypto.randomUUID();
  s.m.ops!.set(pending, { kind: "buy", sha: shaOf(buy("10")), stage: "pending", txs: [], created_ms: 1 });
  assert.deepEqual((await p.ask(buy("10"), pending)).answer, { error: "id_reused" });
  assert.equal(p.calls.length, 1);
});

test("not landed: answered at sent, then not_landed as progress; the wallets stay READY, their marks off (failed or dead)", async () => {
  for (const legState of ["failed", "expired"] as const) {
    const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n) });
    const p = page(s, { final: "not_landed", legState: () => legState });
    const { answer } = await p.ask(buy("10"));
    assert.equal((answer as { result: { stage: string } }).result.stage, "sent");
    assert.deepEqual(p.progress, ["not_landed"]);
    assert.equal((s.m.wallets!.get(armKey("sol", L, 0)) as ArmRecord).state, "READY");
    assert.equal(mark(s, 0), undefined, legState);
  }
});

test("each fill stage reaches the frame as the kit reports it, before run() ends (a teardown follows the fill)", async () => {
  let end!: () => void;
  const tail = new Promise<void>((r) => (end = r));
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n) });
  const p = page(s, { final: "filled", tail });
  const { id } = await p.ask(buy("10"));
  assert.deepEqual(p.progress, ["filled"], "Filled is on the screen while the teardown runs");
  assert.equal((s.m.ops!.get(id) as { stage: string }).stage, "filled");
  end();
  await p.idle();
  assert.deepEqual(p.progress, ["filled"], "once");
});

/**
 * A provider answering getAccountInfo for one address (never a request over several of the user's wallets, wallet.md
 * §2.9 row 8): the mint, and each wallet's token account holding `held[w]`, its mint and owner bytes from `forge`.
 */
function provider(held: Record<string, bigint>, forge: { mint?: string; owner?: (w: string) => string } = {}): SolanaRpc & { asked: string[] } {
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  const byAta = new Map(Object.entries(held).map(([w, n]) => [solanaAta(w, MINT, SOLANA_TOKEN_PROGRAM), [w, n] as const]));
  const asked: string[] = [];
  const rpc = async (method: string, params: readonly unknown[]) => {
    assert.equal(method, "getAccountInfo");
    assert.equal(typeof params[0], "string", "one address per request");
    const k = params[0] as string;
    asked.push(k);
    if (k === MINT) return { value: { owner: SOLANA_TOKEN_PROGRAM, lamports: 1, data: [b64(new Uint8Array(82)), "base64"] } };
    const x = byAta.get(k);
    if (!x) return { value: null };
    const d = new Uint8Array(165);
    d.set(base58.decode(forge.mint ?? MINT), 0);
    d.set(base58.decode(forge.owner?.(x[0]) ?? x[0]), 32);
    new DataView(d.buffer).setBigUint64(64, x[1], true);
    return { value: { owner: SOLANA_TOKEN_PROGRAM, lamports: 1, data: [b64(d), "base64"] } };
  };
  return Object.assign(rpc, { asked });
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
  assert.ok(!a.asked.includes(solanaAta(W[2]!.address, MINT, SOLANA_TOKEN_PROGRAM)), "another token's position is not read");
  assert.equal(new Set(a.asked).size, 3, "the mint and the two positions' accounts, one per request");
  // the positions are all of another token: nothing to sell
  const other = store({ [armKey("sol", L, 2)]: rec(2, 200n, { ...pos, token: STRANGER }) });
  assert.deepEqual((await page(other, {}, [a, b]).ask(sell("1"))).answer, { error: "no_position" });
});

test("a sell's token account must be the wallet's own of that mint on both providers, else the trade is refused before any signature", async () => {
  const pos = { state: "IN_POSITION" as const, token: MINT };
  const held = { [W[0]!.address]: 3_000n };
  for (const forge of [{ mint: STRANGER }, { owner: () => STRANGER }]) {
    const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n, pos) });
    const p = page(s, { final: "filled" }, [provider(held), provider(held, forge)]);
    assert.deepEqual((await p.ask(sell("3000"))).answer, { error: "failed" }, JSON.stringify(forge));
    assert.equal(p.calls.length, 0);
  }
});

test("a buy takes READY wallets only: an IN_POSITION, RETURNING or marked wallet is never a buy's", async () => {
  for (const over of [{ state: "IN_POSITION" as const, token: MINT }, { state: "RETURNING" as const }, { inflight: { op: "0f9619ff-8b86-4011-b42d-00c04fc964ff", side: "buy" as const, token: MINT, txs: [{ sig: base58.encode(new Uint8Array(64).fill(1)), lvbh: LVBH }] } }]) {
    const p = page(store({ [armKey("sol", L, 0)]: rec(0, 1_000n, over) }), { final: "filled" });
    assert.deepEqual((await p.ask(buy("10"))).answer, { error: "no_ready_set" }, JSON.stringify(Object.keys(over)));
    assert.equal(p.calls.length, 0);
  }
});

test("the op is written, with the request's hash, before the trade runs", async () => {
  // a slow ops write: the trade still waits for it before anything is picked or run
  let slowOnce = 1;
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n) }, { slowPut: (st) => (st === "ops" && slowOnce-- > 0 ? 80 : 0) });
  const id = crypto.randomUUID();
  let atRun: unknown;
  const p = page(s, { final: "filled", atStart: () => (atRun = structuredClone(s.m.ops!.get(id))) });
  await p.ask(buy("10"), id);
  assert.deepEqual(atRun, { kind: "buy", sha: shaOf(buy("10")), stage: "pending", txs: [], created_ms: 1_700_000_000_000 });
  assert.deepEqual(mark(s, 0) ?? (s.m.wallets!.get(armKey("sol", L, 0)) as ArmRecord).state, "IN_POSITION");
});

test("buyLegs (the ladder split over the wallets on hand) and sellSplit", () => {
  const two = [{ key: armKey("sol", L, 0), rec: rec(0, 1_000n) }, { key: armKey("sol", L, 1), rec: rec(1, 1_000n) }];
  assert.deepEqual(buyLegs(two, 2_000n)?.keys, two.map((r) => r.key), "no $20 on hand: two $10");
  assert.equal(buyLegs(two.slice(0, 1), 2_000n), null);
  const sixes = [0, 1, 2, 3].map((j) => ({ key: armKey("sol", L, j), rec: rec(j, j === 0 ? 500n : 200n) }));
  assert.deepEqual(buyLegs(sixes, 600n)?.keys, sixes.slice(1).map((r) => r.key), "$6 is 2+2+2, which a greedy $5 first misses");
  assert.deepEqual(sellSplit(10n, [3n, 3n, 4n]), [3n, 3n, 4n]);
  assert.deepEqual(sellSplit(5n, [3n, 3n, 4n]), [1n, 1n, 3n], "floors 1, 1, 2 and the one left over to the largest");
  assert.equal(sellSplit(11n, [3n, 3n, 4n]), null);
  assert.equal(sellSplit(0n, [3n]), null);
});

test("the trade's helper is the wallet's release helper", () => {
  assert.equal(TRADE_HELPER, RELEASE_HELPER);
});

test("SIGN_HOST's CSP lets the page reach every host its release trade deps call, read from the deps themselves", async () => {
  const seen = new Set<string>();
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request) => {
    seen.add(new URL(u instanceof Request ? u.url : String(u)).origin);
    throw new Error("no network in this test");
  }) as typeof fetch;
  try {
    const d = releaseTradeDeps();
    for (const p of d.providers) await p("getLatestBlockhash", [{ commitment: "confirmed" }]).catch(() => {});
    for (const p of d.paths) await p.send("AA==").catch(() => {});
  } finally {
    globalThis.fetch = real;
  }
  const site = readFileSync(new URL("../public/_headers", import.meta.url), "utf8").split("\n").find((l) => l.trim().startsWith("Content-Security-Policy:"))!;
  const connect = (csp: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src "))!.split(/\s+/).slice(1);
  const pinned = CSP.find(([k]) => k === "connect-src")![1].split(/\s+/);
  assert.deepEqual(connect(site), pinned, "public/_headers and the skeleton check's pin are one policy");
  assert.ok(seen.size >= 5, [...seen].join(" "));
  for (const o of seen) assert.ok(pinned.includes(o), `${o} is reached by the trade and missing from connect-src`);
});

test("a running trade's wallets are not picked by a second trade; one whose tx is still unknown stays out after it ends", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n), [armKey("sol", L, 1)]: rec(1, 1_000n) });
  const p = page(s, { legState: () => "unknown", hold });
  await Promise.all([p.ask(buy("10")), p.ask(buy("10"))]);
  assert.deepEqual(p.calls.map((c) => c.legs[0]!.wallet).sort(), [W[0]!.address, W[1]!.address].sort(), "two trades at once, two wallets");
  assert.deepEqual((await p.ask(buy("10"))).answer, { error: "no_ready_set" }, "both in use");
  release();
  await p.idle();
  assert.deepEqual((await p.ask(buy("10"))).answer, { error: "no_ready_set" }, "their txs are unknown on both providers: still out");
  assert.equal(p.calls.length, 2);
  assert.equal(mark(s, 0)!.txs.length, 1, "the mark names the tx");
});

// the review's F1-F5 (Opus review of 974d724): each failed before the fold, as the reviewer's own test showed the fault
/** A provider with one status for every signature (null: none) and its finalized block height. */
const sigStatus = (state: "ok" | "err" | null, height = 0): SolanaRpc => async (method, params) => {
  if (method === "getBlockHeight") {
    assert.deepEqual(params, [{ commitment: "finalized" }]);
    return height;
  }
  assert.equal(method, "getSignatureStatuses");
  return { value: [state === null ? null : { confirmationStatus: "finalized", err: state === "ok" ? null : { InstructionError: [0, "Custom"] } }] };
};

test("F1 a reload mid-trade: the reloaded page never re-picks the wallet whose buy is sent and unresolved; it resolves it on both providers", async () => {
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n) });
  const never = new Promise<void>(() => {});
  const before = page(s, { hold: never });
  const a = await before.ask(buy("10"));
  assert.equal((a.answer as { result: { stage: string } }).result.stage, "sent");
  assert.equal(mark(s, 0)!.op, a.id, "the wallet's record names the trade before its tx can be sent");
  assert.equal(mark(s, 0)!.txs.length, 1);
  before.die(); // the tab reloads: its locks go, the trade's promise never settles
  // unknown on the providers: kept out
  const unknown = page(s, { final: "filled" }, [sigStatus(null), sigStatus("ok")]);
  assert.deepEqual((await unknown.ask(buy("10"))).answer, { error: "no_ready_set" });
  assert.equal(unknown.calls.length, 0, "the reloaded page ran no second buy from W0");
  // failed on both: the mark goes and the wallet is READY again
  const failed = store({ [armKey("sol", L, 0)]: structuredClone(s.m.wallets!.get(armKey("sol", L, 0))) });
  const f = page(failed, { final: "filled" }, [sigStatus("err"), sigStatus("err")]);
  await f.ask(buy("10"));
  assert.equal(f.calls.length, 1, "a buy whose first tx failed on both frees its wallet");
  // filled on both: IN_POSITION with the token, the mark off
  const after = page(s, { final: "filled" }, [sigStatus("ok"), sigStatus("ok")]);
  assert.deepEqual((await after.ask(buy("10"))).answer, { error: "no_ready_set" });
  const r = s.m.wallets!.get(armKey("sol", L, 0)) as ArmRecord;
  assert.deepEqual([r.state, r.token, r.inflight], ["IN_POSITION", MINT, undefined]);
});

test("a dead tab's tx that can never land frees its wallet: both providers' finalized height past its lastValidBlockHeight and no status on both", async () => {
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n) });
  const before = page(s, { hold: new Promise<void>(() => {}) });
  const first = await before.ask(buy("10"));
  assert.equal(mark(s, 0)!.txs[0]!.lvbh, LVBH, "the mark holds the tx's lastValidBlockHeight from the kit");
  before.die();
  // the height not yet past on both, or past on one only: it may still land, so the wallet stays out
  for (const heights of [[LVBH, LVBH], [LVBH + 1, LVBH], [LVBH, LVBH + 1]]) {
    const q = page(s, { final: "filled" }, [sigStatus(null, heights[0]), sigStatus(null, heights[1])]);
    assert.deepEqual((await q.ask(buy("10"))).answer, { error: "no_ready_set" }, JSON.stringify(heights));
    assert.ok(mark(s, 0), JSON.stringify(heights));
  }
  // past on both, no status on both: it can never land; the mark goes, the wallet is READY and buys again
  const after = page(s, { final: "filled" }, [sigStatus(null, LVBH + 1), sigStatus(null, LVBH + 1)]);
  await after.ask(buy("10"));
  assert.equal(after.calls.length, 1, "the freed wallet bought");
  const op = s.m.ops!.get(first.id) as { stage: string; txs: { hash: string; state?: string }[] };
  assert.equal(op.stage, "not_landed", "the dead trade's op reads not_landed");
  assert.deepEqual(op.txs.map((t) => t.state), ["not_landed"]);
});

test("F1 a mark of a trade still running in another tab is never resolved or taken, whatever the providers say", async () => {
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n) });
  const t1 = page(s, { hold: new Promise<void>(() => {}) });
  await t1.ask(buy("10"));
  const t2 = page(s, { final: "filled" }, [sigStatus("err"), sigStatus("err")]);
  assert.deepEqual((await t2.ask(buy("10"))).answer, { error: "no_ready_set" });
  assert.ok(mark(s, 0), "the live trade's mark stays");
  t1.die();
});

test("F2 two tabs: two buys at once never pick one wallet", async () => {
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n), [armKey("sol", L, 1)]: rec(1, 1_000n) });
  const never = new Promise<void>(() => {});
  const t1 = page(s, { hold: never });
  const t2 = page(s, { hold: never });
  await Promise.all([t1.ask(buy("10")), t2.ask(buy("10"))]);
  assert.notEqual(t1.calls[0]!.legs[0]!.wallet, t2.calls[0]!.legs[0]!.wallet);
  const t3 = page(s, { hold: never });
  assert.deepEqual((await t3.ask(buy("10"))).answer, { error: "no_ready_set" });
  for (const t of [t1, t2, t3]) t.die();
});

test("F3 after a reload, the same id with another request is id_reused, never the first trade's answer", async () => {
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n) });
  const id = crypto.randomUUID();
  await page(s, { final: "filled" }).ask(buy("10"), id);
  const reloaded = page(s, { final: "filled" });
  assert.deepEqual((await reloaded.ask(sell("5"), id)).answer, { error: "id_reused" });
  assert.deepEqual(((await reloaded.ask(buy("10"), id)).answer as { result: { stage: string } }).result.stage, "filled", "the same request: its first answer");
  assert.equal(reloaded.calls.length, 0);
});

test("F4 two tabs, one id at once: it runs once", async () => {
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n), [armKey("sol", L, 1)]: rec(1, 1_000n) });
  const id = crypto.randomUUID();
  const never = new Promise<void>(() => {});
  const t1 = page(s, { hold: never });
  const t2 = page(s, { hold: never });
  const [a, b] = await Promise.all([t1.ask(buy("10"), id), t2.ask(buy("10"), id)]);
  assert.equal(t1.calls.length + t2.calls.length, 1, "one id ran once");
  assert.deepEqual([a.answer, b.answer].filter((x) => x && "error" in x), [{ error: "id_reused" }]);
  t1.die();
  t2.die();
});

test("F4 the same id while it runs in another tab is answered id_reused at once, never waiting behind a pick", async () => {
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n) });
  const id = crypto.randomUUID();
  const t1 = page(s, { hold: new Promise<void>(() => {}) });
  await t1.ask(buy("10"), id);
  let free!: () => void;
  const busy = new Promise<void>((r) => (free = r));
  void navigator.locks.request(TRADE_PICK_LOCK, { mode: "exclusive" }, () => busy); // another tab's long pick
  const t2 = page(s, { final: "filled" });
  const answered = await Promise.race([t2.ask(buy("10"), id).then((a) => a.answer), new Promise((r) => setTimeout(() => r("waited"), 300))]);
  free();
  assert.deepEqual(answered, { error: "id_reused" });
  assert.equal(t2.calls.length, 0);
  t1.die();
});

test("F5 a failed store write: no tx is sent that the store does not name", async () => {
  // the mark write at the pick fails: nothing is signed
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n) }, { failPut: (_n, st) => st === "wallets" });
  const p = page(s, { final: "filled" });
  assert.deepEqual((await p.ask(buy("10"))).answer, { error: "failed" });
  assert.equal(p.calls.length, 0);
  assert.equal(p.opened(), 0, "the seed never opened");
  // the signature's mark write fails: the signature never reaches the kit, so nothing is sent
  let walletPuts = 0;
  const t = store({ [armKey("sol", L, 0)]: rec(0, 1_000n) }, { failPut: (_n, st) => st === "wallets" && ++walletPuts === 2 });
  const q = page(t, { final: "filled" });
  assert.deepEqual((await q.ask(buy("10"))).answer, { error: "failed" });
  assert.equal(q.calls.length, 1);
  assert.equal(mark(t, 0), undefined, "no tx was named or given out, so the mark is off");
});

test("a trade holds the seed lock shared: a sign out (exclusive, any tab) waits until it settles", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n) });
  const p = page(s, { hold, legState: () => "filled" });
  await p.ask(buy("10"));
  let out = false;
  const signOut = navigator.locks.request(WALLET_SEED_LOCK, { mode: "exclusive" }, async () => void (out = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(out, false, "the sign out waits for the running trade");
  release();
  await signOut;
  assert.equal(out, true);
});

test("a read that fails before the answer refuses the trade as failed, and the op says so", async () => {
  const pos = { state: "IN_POSITION" as const, token: MINT };
  const s = store({ [armKey("sol", L, 0)]: rec(0, 1_000n, pos) });
  const down: SolanaRpc = async () => { throw new Error("HTTP 503"); };
  const p = page(s, {}, [down, down]);
  const { id, answer } = await p.ask(sell("1"));
  assert.deepEqual(answer, { error: "failed" });
  assert.deepEqual(s.m.ops!.get(id), { kind: "sell", sha: shaOf(sell("1")), stage: "refused", txs: [], code: "failed", created_ms: 1_700_000_000_000 });
});
