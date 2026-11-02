/// <reference types="node" />
// The joined Solana trade replayed over recorded mainnet answers (test/solana-flow-dry.ts --record, 2026-11-02 about
// 09:52Z, PumpSwap token EQM29p2p…pump, provider A PublicNode, provider B the helper's /v1/rpc): a first PumpSwap buy
// from a wallet with no PumpSwap volume account, and a sell of three holders' whole balances. Every RPC answer, build
// and reference is the recorded one, keyed by what was asked (a simulation by the accounts it reads back), so nothing
// here reaches a network. The edits below change one recorded answer each and show what the flow does with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base58, base64 } from "@scure/base";
import {
  SOLANA_PUMP_AMM_PROGRAM,
  SOLANA_PUMP_PROGRAM,
  SOLANA_SOL_MINT,
  SOLANA_TOKEN_2022_PROGRAM,
  SOLANA_TOKEN_PROGRAM,
  runSolanaTrade,
  solanaAta,
  solanaRouteAmounts,
  solanaVolumeAccumulator,
  type SolanaRpc,
  type SolanaTradeDeps,
  type SolanaTradeRequest,
} from "../src/index.ts";

type Fixture = {
  requests: { side: "buy" | "sell"; mint: string; slippageBps: number; wallets: string[]; legs: { wallet: string; amount: string; arm: { own: boolean } }[] }[];
  references: { q: { side: string; mint: string; amount: string; amounts: string[] }; answer: { expectedOut: string; expectedOuts: string[] } | null }[];
  builds: { url: string; status: number; body: string }[];
  rpc: { at: "A" | "B"; ask: string; answer: unknown }[];
};
const fx = JSON.parse(readFileSync(new URL("./fixtures/solana-flow-replay.json", import.meta.url), "utf8")) as Fixture;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const askOf = (method: string, params: readonly unknown[]): string =>
  JSON.stringify(method === "simulateTransaction" ? [method, (params[1] as { accounts?: unknown })?.accounts] : [method, params]);

type Edit = (at: "A" | "B", method: string, n: number, answer: unknown, params: readonly unknown[]) => unknown;
/** A provider answering from the recording: the n-th ask of a key gets the n-th recorded answer (the last repeats). */
function replay(at: "A" | "B", edit: Edit = (_a, _m, _n, x) => x): SolanaRpc & { asks: string[] } {
  const by = new Map<string, unknown[]>();
  for (const r of fx.rpc) if (r.at === at) by.set(r.ask, [...(by.get(r.ask) ?? []), r.answer]);
  const seen = new Map<string, number>();
  const asks: string[] = [];
  const fn = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const k = askOf(method, params);
    asks.push(k);
    const list = by.get(k);
    if (!list) throw new Error(`not recorded on ${at}: ${k.slice(0, 160)}`);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return edit(at, method, n, clone(list[Math.min(n, list.length - 1)]), params);
  };
  return Object.assign(fn, { asks });
}
/** The helper's builds from the recording, by URL without slippageBps; a build asked at another slippage gets the
 * recorded route with that slippage written into it, as Jupiter answers. */
function builds(urls: string[] = [], keepSlippage = false) {
  const strip = (u: string) => { const x = new URL(u); const s = Number(x.searchParams.get("slippageBps")); x.searchParams.delete("slippageBps"); return { key: x.toString(), s }; };
  const by = new Map(fx.builds.map((b) => [strip(b.url).key, b]));
  return async (url: string): Promise<Response> => {
    urls.push(url);
    const { key, s } = strip(url);
    const b = by.get(key);
    if (!b) throw new Error(`build not recorded: ${url.slice(0, 160)}`);
    const body = JSON.parse(b.body) as { swapInstruction: { data: string } };
    const d = base64.decode(body.swapInstruction.data);
    const at = solanaRouteAmounts(d) && d.length >= 35 && new DataView(d.buffer, d.byteOffset).getUint16(25, true) !== 0 && new DataView(d.buffer, d.byteOffset).getUint16(24, true) === 0 ? 25 : 24;
    if (!keepSlippage) new DataView(d.buffer, d.byteOffset).setUint16(at, s, true);
    body.swapInstruction.data = base64.encode(d);
    return new Response(JSON.stringify(body), { status: b.status, headers: { "content-type": "application/json" } });
  };
}
const request = (i: number): SolanaTradeRequest & { legs: SolanaTradeRequest["legs"][number][] } => {
  const r = fx.requests[i]!;
  return { side: r.side, token: r.mint, slippageBps: r.slippageBps, wallets: r.wallets, legs: r.legs.map((l) => ({ wallet: l.wallet, amount: BigInt(l.amount), arm: l.arm })) };
};
function deps(i: number, o: { edit?: Edit; scale?: bigint; urls?: string[]; keepSlippage?: boolean } = {}): SolanaTradeDeps & { providers: readonly [SolanaRpc & { asks: string[] }, SolanaRpc & { asks: string[] }] } {
  const ref = fx.references[i]!.answer!;
  const k = o.scale ?? 10_000n;
  return {
    helper: "https://api.confidential.unrealized.trade",
    providers: [replay("A", o.edit), replay("B", o.edit)],
    reference: async () => ({ expectedOut: (BigInt(ref.expectedOut) * k) / 10_000n, expectedOuts: ref.expectedOuts.map((x) => (BigInt(x) * k) / 10_000n) }),
    fetch: builds(o.urls, o.keepSlippage),
    // A dry run never sends: this path fails the test if it is ever called.
    paths: [{ name: "never", send: async () => { throw new Error("a dry run sent"); } }],
    dry: true,
  };
}
const BUY = 0;
const SELL = 1;

test("the recorded buy and sell replay through every check, with S12's two references wired", async () => {
  for (const i of [BUY, SELL]) {
    const req = request(i);
    const ref = fx.references[i]!.answer!;
    const r = await runSolanaTrade(req, deps(i));
    const A = req.legs.reduce((n, l) => n + l.amount, 0n);
    for (const [k, l] of r.legs.entries()) {
      assert.equal(l.refused, undefined, `${req.side} leg ${k}: ${l.refused}`);
      assert.equal(l.dry?.state, "simulated");
      assert.ok((l.size ?? 9_999) <= 1_232);
      const ek = (BigInt(ref.expectedOut) * (l.amount)) / A;
      assert.equal(l.expectedOut, ek);
      assert.equal(l.minOut, (ek * BigInt(10_000 - req.slippageBps)) / 10_000n);
      assert.equal(l.legExpectedOut, BigInt(ref.expectedOuts[k]!));
      const s12 = l.verdict?.results.find((x) => x.id === "S12");
      assert.match(s12?.detail ?? "", new RegExp(`E ${ref.expectedOuts[k]}$`));
      assert.equal(l.buildCalls, 1);
    }
    if (req.side === "sell") for (const l of r.legs) assert.equal(l.teardown?.verdict.ok, true, l.teardown?.refused);
  }
});

test("the buy is the wallet's first on PumpSwap: its simulation creates the PumpSwap volume account, and S11 passes", async () => {
  const w = request(BUY).legs[0]!.wallet;
  const sva = solanaVolumeAccumulator(w, SOLANA_PUMP_AMM_PROGRAM);
  const sims = fx.rpc.filter((r) => r.ask.includes("simulateTransaction") && r.ask.includes(sva));
  assert.ok(sims.length >= 2);
  for (const s of sims) {
    const v = (s.answer as { value: { accounts: ({ lamports: number } | null)[] } }).value;
    assert.equal(v.accounts[3]?.lamports, 1_346_200);
  }
  const pre = fx.rpc.find((r) => r.ask.startsWith('["getMultipleAccounts"') && r.ask.includes(sva))!;
  assert.equal((pre.answer as { value: unknown[] }).value[3], null);
  const r = await runSolanaTrade(request(BUY), deps(BUY));
  assert.equal(r.legs[0]?.verdict?.results.find((x) => x.id === "S11")?.ok, true);
});

test("a route whose floor is under minOut is built once more at the slippage that meets it", async () => {
  const urls: string[] = [];
  // E 1% higher than recorded: minOut_k = E_k (1 - s) is now above the route's floor at s, below its quoted out.
  const r = await runSolanaTrade(request(BUY), deps(BUY, { scale: 10_100n, urls }));
  const l = r.legs[0]!;
  assert.equal(l.refused, undefined, l.refused);
  assert.equal(l.buildCalls, 2);
  const s2 = Number(new URL(urls[1]!).searchParams.get("slippageBps"));
  assert.ok(s2 > 0 && s2 < 500, String(s2));
});

test("a rebuild whose floor is still under minOut is refused, never sent", async () => {
  const urls: string[] = [];
  // the second build answers at the first one's slippage, so its floor stays where it was
  const r = await runSolanaTrade(request(BUY), deps(BUY, { scale: 10_100n, urls, keepSlippage: true }));
  assert.equal(urls.length, 2);
  assert.match(r.legs[0]?.refused ?? "", /the route's floor stays under/);
  assert.equal(r.legs[0]?.dry, undefined);
});

test("a floor that rounds to 0 is refused before any build", async () => {
  const urls: string[] = [];
  const r = await runSolanaTrade(request(BUY), { ...deps(BUY, { urls }), reference: async () => ({ expectedOut: 1n, expectedOuts: [1n] }) });
  assert.equal(r.legs[0]?.minOut, 0n);
  assert.equal(r.legs[0]?.refused, "the floor rounds to 0");
  assert.equal(urls.length, 0);
});

test("one wallet a request: every read and simulation of a buy and a three-wallet sell names one of the user's wallets", async () => {
  for (const i of [BUY, SELL]) {
    const req = request(i);
    const urls: string[] = [];
    const d = deps(i, { urls });
    const r = await runSolanaTrade(req, d);
    for (const l of r.legs) assert.equal(l.refused, undefined, l.refused);
    const asks = [...d.providers[0].asks, ...d.providers[1].asks, ...urls];
    const linked = req.wallets.map((w) => [w, solanaAta(w, req.token, SOLANA_TOKEN_PROGRAM), solanaAta(w, req.token, SOLANA_TOKEN_2022_PROGRAM), solanaAta(w, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM), solanaVolumeAccumulator(w, SOLANA_PUMP_PROGRAM), solanaVolumeAccumulator(w, SOLANA_PUMP_AMM_PROGRAM)]);
    assert.ok(req.wallets.length >= 3 && asks.length > 10);
    for (const a of asks) {
      const named = linked.filter((ks) => ks.some((k) => a.includes(k))).length;
      assert.ok(named <= 1, `${named} wallets in ${a.slice(0, 200)}`);
    }
  }
});

test("S11 refuses a leg whose tx names another of the user's wallets; the user's other wallets elsewhere change nothing", async () => {
  // the recorded buy names the token's mint read-only; as one of the user's "wallets", the buy is refused statically
  const req = request(BUY);
  const named = await runSolanaTrade({ ...req, wallets: [...req.wallets, req.token] }, deps(BUY));
  assert.match(named.legs[0]?.refused ?? "", /S11 the tx names another wallet of this user/);
  const clean = await runSolanaTrade({ ...req, wallets: [...req.wallets, base58.encode(new Uint8Array(32).fill(5))] }, deps(BUY));
  assert.equal(clean.legs[0]?.refused, undefined, clean.legs[0]?.refused);
});

test("a token transfer into a wallet's token account between the read and the read after the simulation refuses that leg", async () => {
  const req = request(SELL);
  const w0 = req.legs[0]!.wallet;
  const edit: Edit = (_at, method, n, x, params) => {
    if (method === "getMultipleAccounts" && (params[0] as string[])[0] === w0 && (params[0] as string[]).length === 4 && n === 1) {
      const acc = (x as { value: ({ lamports: number; data: [string, string] } | null)[] }).value[1];
      if (acc) {
        const d = base64.decode(acc.data[0]);
        const v = new DataView(d.buffer, d.byteOffset);
        v.setBigUint64(64, v.getBigUint64(64, true) + 1n, true); // the lamports stay: only the data moved
        acc.data[0] = base64.encode(d);
      }
    }
    return x;
  };
  const r = await runSolanaTrade(req, deps(SELL, { edit }));
  assert.match(r.legs[0]?.refused ?? "", /changed while the trade was checked/);
  for (const l of r.legs.slice(1)) assert.equal(l.refused, undefined, l.refused);
});

test("a reference with an E(a_k) of 0 is no reference", async () => {
  const ref = fx.references[BUY]!.answer!;
  const r = await runSolanaTrade(request(BUY), { ...deps(BUY), reference: async () => ({ expectedOut: BigInt(ref.expectedOut), expectedOuts: [0n] }) });
  assert.equal(r.legs[0]?.refused, "no reference pool");
});

test("a dry sell of part of a balance is not torn down; a sell of the whole balance is", async () => {
  // Seller 0's token account read one token higher on both providers, and its simulation ending at 1: the leg sells
  // all but one token, so its account stays open.
  const req = request(SELL);
  const w0 = req.legs[0]!.wallet;
  const bump = (acc: { data: [string, string] } | null, set?: bigint) => {
    if (!acc) return;
    const d = base64.decode(acc.data[0]);
    const v = new DataView(d.buffer, d.byteOffset);
    v.setBigUint64(64, set ?? v.getBigUint64(64, true) + 1n, true);
    acc.data[0] = base64.encode(d);
  };
  const edit: Edit = (_at, method, _n, x, params) => {
    if (method === "getMultipleAccounts" && (params[0] as string[])[0] === w0 && (params[0] as string[]).length >= 4) bump((x as { value: ({ data: [string, string] } | null)[] }).value[1] ?? null);
    const sim = method === "simulateTransaction" ? (params[1] as { accounts?: { addresses?: string[] } })?.accounts?.addresses : null;
    if (sim && sim[0] === w0) bump((x as { value: { accounts: ({ data: [string, string] } | null)[] } }).value.accounts[1] ?? null, 1n);
    return x;
  };
  const r = await runSolanaTrade(req, deps(SELL, { edit }));
  assert.equal(r.legs[0]?.refused, undefined, r.legs[0]?.refused);
  assert.equal(r.legs[0]?.dry?.state, "simulated", JSON.stringify(r.legs[0]?.dry, (_k, v) => (typeof v === "bigint" ? String(v) : v)).slice(0, 600));
  assert.equal(r.legs[0]?.teardown, undefined);
  for (const l of r.legs.slice(1)) assert.equal(l.teardown?.verdict.ok, true, l.teardown?.refused);
});

test("a route that quotes no more than minOut is refused, with no second build", async () => {
  const urls: string[] = [];
  const r = await runSolanaTrade(request(BUY), deps(BUY, { scale: 11_000n, urls }));
  assert.match(r.legs[0]?.refused ?? "", /not above the floor/);
  assert.equal(urls.length, 1);
});

test("an account that moves between the pre-state and the read after the simulation refuses the leg", async () => {
  const w = request(BUY).legs[0]!.wallet;
  const edit: Edit = (at, method, n, x) => {
    if (at === "B" && method === "getMultipleAccounts" && n === 1) {
      const v = (x as { value: ({ lamports: number } | null)[] }).value;
      if (v.length >= 4 && v[0]) v[0].lamports -= 5_000;
    }
    return x;
  };
  const r = await runSolanaTrade(request(BUY), deps(BUY, { edit }));
  assert.match(r.legs[0]?.refused ?? "", /changed while the trade was checked/);
  void w;
});

test("spendable is the lower provider's: B reading less than the amount refuses the leg", async () => {
  const req = request(BUY);
  const edit: Edit = (at, method, _n, x) => {
    if (at === "B" && method === "getMultipleAccounts") {
      const v = (x as { value: ({ lamports: number } | null)[] }).value;
      if (v.length >= 4 && v[0] && v[0].lamports > 0) v[0].lamports = Number(req.legs[0]!.amount) - 1;
    }
    return x;
  };
  const r = await runSolanaTrade(req, deps(BUY, { edit }));
  assert.match(r.legs[0]?.refused ?? "", /S1 amount .* is not within the spendable/);
});

test("a simulation that reads back another account than asked is no simulation", async () => {
  const edit: Edit = (at, method, _n, x) => {
    if (at === "A" && method === "simulateTransaction") (x as { value: { accounts: unknown[] } }).value.accounts.pop();
    return x;
  };
  const r = await runSolanaTrade(request(BUY), deps(BUY, { edit }));
  assert.match(r.legs[0]?.refused ?? "", /S11 no simulation on provider A/);
});

test("E(a_k) above the simulated out refuses at S12, and an E_k above E(a_k) is out of range", async () => {
  const ref = fx.references[BUY]!.answer!;
  const d = deps(BUY);
  const high = await runSolanaTrade(request(BUY), { ...d, reference: async () => ({ expectedOut: BigInt(ref.expectedOut), expectedOuts: [(BigInt(ref.expectedOuts[0]!) * 10_300n) / 10_000n] }) });
  assert.match(high.legs[0]?.refused ?? "", /S12 simulated out/);
  const low = await runSolanaTrade(request(BUY), { ...deps(BUY), reference: async () => ({ expectedOut: BigInt(ref.expectedOut), expectedOuts: [BigInt(ref.expectedOut) - 1n] }) });
  assert.match(low.legs[0]?.refused ?? "", /S12 reference out of range/);
});

test("a reference without one E per leg is no reference", async () => {
  const ref = fx.references[SELL]!.answer!;
  const r = await runSolanaTrade(request(SELL), { ...deps(SELL), reference: async () => ({ expectedOut: BigInt(ref.expectedOut), expectedOuts: [BigInt(ref.expectedOuts[0]!)] }) });
  for (const l of r.legs) assert.match(l.refused ?? "", /no reference pool/);
});
