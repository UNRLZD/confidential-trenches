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
  SolanaWalletLinks,
  runSolanaTrade,
  SOLANA_BLOCKHASH_REFRESH_MS,
  SOLANA_TRADE_BUILD_WAIT_MS,
  solanaAta,
  solanaDecodeMessage,
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
/** isBlockhashValid, which the recording holds no answer to: the n-th ask on a provider (0 first) answers this. */
type Valid = (at: "A" | "B", hash: string, n: number) => boolean;
/** A provider answering from the recording: the n-th ask of a key gets the n-th recorded answer (the last repeats). */
function replay(at: "A" | "B", edit: Edit = (_a, _m, _n, x) => x, valid: Valid = () => true): SolanaRpc & { asks: string[]; times: number[] } {
  const by = new Map<string, unknown[]>();
  for (const r of fx.rpc) if (r.at === at) by.set(r.ask, [...(by.get(r.ask) ?? []), r.answer]);
  const seen = new Map<string, number>();
  const asks: string[] = [];
  const times: number[] = [];
  const fn = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const k = askOf(method, params);
    asks.push(k);
    times.push(Date.now());
    if (method === "isBlockhashValid") return { context: { slot: 1 }, value: valid(at, params[0] as string, asks.filter((x) => x.startsWith('["isBlockhashValid"')).length - 1) };
    const list = by.get(k);
    if (!list) throw new Error(`not recorded on ${at}: ${k.slice(0, 160)}`);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return edit(at, method, n, clone(list[Math.min(n, list.length - 1)]), params);
  };
  return Object.assign(fn, { asks, times });
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
function deps(i: number, o: { edit?: Edit; scale?: bigint; urls?: string[]; keepSlippage?: boolean; valid?: Valid } = {}): SolanaTradeDeps & { providers: readonly [SolanaRpc & { asks: string[]; times: number[] }, SolanaRpc & { asks: string[]; times: number[] }] } {
  const ref = fx.references[i]!.answer!;
  const k = o.scale ?? 10_000n;
  return {
    helper: "https://api.confidential.unrealized.trade",
    providers: [replay("A", o.edit, o.valid), replay("B", o.edit, o.valid)],
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

test("one queue a provider: every call of a three-wallet sell, its teardowns' included, stays within the provider's rate", async () => {
  const d = { ...deps(SELL), providerRps: [20, 20] as const };
  const r = await runSolanaTrade(request(SELL), d);
  for (const l of r.legs) assert.equal(l.refused, undefined, l.refused);
  assert.ok(r.legs.filter((l) => l.sellsAll).every((l) => l.teardown), "the teardowns were planned and simulated");
  for (const p of d.providers) {
    const ts = p.times;
    const most = Math.max(...ts.map((x) => ts.filter((y) => y >= x && y < x + 1_000).length));
    assert.ok(ts.length > 30, `${ts.length} calls`);
    assert.ok(most <= 20, `${most} calls in one second`);
  }
});

test("the flow hands the signer each tx's own lastValidBlockHeight: the height of the blockhash in the message it signs", async () => {
  const dry = await runSolanaTrade(request(SELL), deps(SELL));
  const h = dry.blockhash?.lastValidBlockHeight;
  assert.ok(Number.isSafeInteger(h) && (h as number) > 0);
  const got: { wallet: string; blockhash: string; h: number }[] = [];
  // No key here: the stand-in records what it is handed and answers no signature, so nothing is sent.
  const sign = async (wallet: string, m: Uint8Array, tx: { lastValidBlockHeight: number }) => {
    got.push({ wallet, blockhash: solanaDecodeMessage(m).blockhash, h: tx.lastValidBlockHeight });
    return new Uint8Array(64);
  };
  await assert.rejects(runSolanaTrade(request(SELL), { ...deps(SELL), dry: false, sign }), /does not verify/);
  assert.equal(got.length, request(SELL).legs.length);
  for (const g of got) assert.deepEqual([g.blockhash, g.h], [dry.blockhash?.blockhash, h], g.wallet);
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

test("one long-lived map across trades: a user with 204 wallets, the next three-wallet sell inside the 2 s budget, nothing derived again", async () => {
  const extra = Array.from({ length: 200 }, (_, i) => base58.encode(Uint8Array.from({ length: 32 }, (_, j) => (i * 31 + j * 7 + 1) & 0xff)));
  const req = { ...request(SELL), wallets: [...request(SELL).wallets, ...extra] };
  const links = new SolanaWalletLinks();
  const first = await runSolanaTrade(req, { ...deps(SELL), links });
  assert.ok(first.legs.every((l) => l.refused === undefined));
  assert.equal(links.holds(req.wallets), true, "the trade grew the caller's map by every wallet");
  const t = performance.now();
  const next = await runSolanaTrade(req, { ...deps(SELL), links });
  const ms = performance.now() - t;
  assert.ok(next.legs.every((l) => l.refused === undefined && l.dry?.state === "simulated"));
  assert.ok(ms < 2_000, `the next trade took ${ms.toFixed(0)} ms`);
  console.log(`204 wallets, long-lived map: the next sell ${ms.toFixed(0)} ms`);
});

// Card solana-uncapped-fits, fold 2: the trade's build is the cap search, judged on the device's own assembly.
/** The recorded builds, answered per cap: `at(cap, body)` returns a Response, or null for the recorded build as is. */
function capWorld(at: (cap: number, body: Record<string, unknown>) => Response | null) {
  const urls: string[] = [];
  const recorded = builds([]);
  const fetch = async (url: string): Promise<Response> => {
    urls.push(url);
    const u = new URL(url);
    const cap = Number(u.searchParams.get("maxAccounts"));
    u.searchParams.set("maxAccounts", "40"); // the recording was asked at 40
    const r = await recorded(u.toString());
    return at(cap, (await r.json()) as Record<string, unknown>) ?? new Response(JSON.stringify(await (await recorded(u.toString())).json()), { status: 200 });
  };
  return { urls, fetch, caps: () => urls.map((x) => Number(new URL(x).searchParams.get("maxAccounts"))) };
}

test("no route at 40: the flow's cap search asks 48, and the trade goes through every check", async () => {
  const w = capWorld((cap) => (cap === 40 ? new Response('{"error":"No routes found"}', { status: 400 }) : null));
  const req = request(BUY);
  const r = await runSolanaTrade(req, { ...deps(BUY), fetch: w.fetch });
  for (const l of r.legs) {
    assert.equal(l.refused, undefined, l.refused);
    assert.equal(l.dry?.state, "simulated");
    assert.deepEqual(l.buildCaps, [{ maxAccounts: 40, outcome: "no_route" }, { maxAccounts: 48, outcome: "fits" }]);
    assert.equal(l.buildCalls, 2);
  }
  assert.deepEqual([...new Set(w.caps())], [40, 48]);
});

test("40's route assembles over 1,232 bytes on the device: the flow asks again at 32 and signs only the build that fits", async () => {
  // at 40 the recorded route with 40 more accounts no lookup table holds, as a route with fresh pools has
  const extra = Array.from({ length: 40 }, (_, i) => ({ pubkey: base58.encode(new Uint8Array(32).fill(100 + i)), isSigner: false, isWritable: false }));
  const w = capWorld((cap, body) => {
    if (cap !== 40) return null;
    const swap = body.swapInstruction as { accounts: unknown[] };
    swap.accounts = [...swap.accounts, ...extra];
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const r = await runSolanaTrade(request(BUY), { ...deps(BUY), fetch: w.fetch });
  for (const l of r.legs) {
    assert.equal(l.refused, undefined, l.refused);
    assert.equal(l.buildCaps?.[0]?.maxAccounts, 40);
    assert.equal(l.buildCaps?.[0]?.outcome, "too_large");
    assert.ok((l.buildCaps?.[0]?.size ?? 0) > 1_232);
    assert.deepEqual(l.buildCaps?.[1], { maxAccounts: 32, outcome: "fits" });
    assert.ok((l.size ?? 9_999) <= 1_232);
  }
  assert.deepEqual([...new Set(w.caps())], [40, 32]);
});

test("no build of the search fits: the leg is refused too_large after at most 3 builds, and nothing is signed", async () => {
  const extra = Array.from({ length: 40 }, (_, i) => ({ pubkey: base58.encode(new Uint8Array(32).fill(100 + i)), isSigner: false, isWritable: false }));
  const w = capWorld((_cap, body) => {
    const swap = body.swapInstruction as { accounts: unknown[] };
    swap.accounts = [...swap.accounts, ...extra];
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const req = request(BUY);
  const r = await runSolanaTrade(req, { ...deps(BUY), fetch: w.fetch });
  for (const l of r.legs) {
    assert.match(l.refused ?? "", /^build too_large: too_large: no build within 1232 bytes \(40 too_large \d+, 32 too_large \d+, 28 too_large \d+\)/);
    assert.equal(l.signature, undefined);
    assert.equal(l.dry, undefined);
  }
  assert.equal(w.urls.length, 3 * req.legs.length);
});

// Card solana-uncapped-fits, folds 3 and 4: every leg runs its own cap search at once, no leg waits on another; the
// floor rebuild asks the cap the search found.
const noRouteBelow = (top: number) => (cap: number) => (cap < top ? new Response('{"error":"No routes found"}', { status: 400 }) : null);
const rebuildsOf = (r: { legs: { buildCalls?: number; buildCaps?: unknown[] }[] }) => r.legs.reduce((n, l) => n + ((l.buildCalls ?? 0) - (l.buildCaps?.length ?? 0)), 0);
/** Holds the first `n` builds asked at `cap` until all `n` are asked; a leg that waited on another's answer would never
 * come, so they fail after 2 s. Counts the builds at `cap` asked before the first one at it is answered. */
function barrierAt(cap: number, n: number, inner: (url: string) => Promise<Response>) {
  const held: (() => void)[] = [];
  const at = { before: 0, answered: false };
  const fetch = async (url: string): Promise<Response> => {
    if (Number(new URL(url).searchParams.get("maxAccounts")) === cap && !at.answered) {
      at.before++;
      if (held.length < n) {
        await new Promise<void>((ok, no) => {
          held.push(ok);
          if (held.length === n) held.forEach((f) => f());
          setTimeout(() => no(new Error(`a leg waited for another's build at ${cap}`)), 2_000);
        });
      }
      at.answered = true;
    }
    return inner(url);
  };
  return { fetch, at };
}

test("a sell over 3 wallets whose routes all fit at 40: all three 40 builds are sent before any is answered", async () => {
  const b = barrierAt(40, 3, builds([]));
  const r = await runSolanaTrade(request(SELL), { ...deps(SELL), fetch: b.fetch });
  assert.equal(b.at.before, 3);
  for (const l of r.legs) {
    assert.equal(l.refused, undefined, l.refused);
    assert.deepEqual(l.buildCaps, [{ maxAccounts: 40, outcome: "fits" }]);
  }
});

test("a sell over 3 wallets, no route at 40: all three 48 builds are sent before any 48 answer (no leg waits for another's search), 6 builds", async () => {
  const w = capWorld(noRouteBelow(48));
  const b = barrierAt(48, 3, w.fetch);
  const req = request(SELL);
  assert.equal(req.legs.length, 3);
  const r = await runSolanaTrade(req, { ...deps(SELL), fetch: b.fetch });
  assert.equal(b.at.before, 3);
  for (const l of r.legs) {
    assert.equal(l.refused, undefined, l.refused);
    assert.equal(l.dry?.state, "simulated");
    assert.deepEqual(l.buildCaps, [{ maxAccounts: 40, outcome: "no_route" }, { maxAccounts: 48, outcome: "fits" }]);
  }
  assert.equal(w.urls.length, 3 * 2 + rebuildsOf(r));
});

test("a sell over 3 wallets, no route at 40 or 48: each leg's own search asks 40, 48 and 60 (9 builds: no leg learns from another, so none waits)", async () => {
  const w = capWorld(noRouteBelow(60));
  const r = await runSolanaTrade(request(SELL), { ...deps(SELL), fetch: w.fetch });
  for (const l of r.legs) {
    assert.equal(l.refused, undefined, l.refused);
    assert.deepEqual(l.buildCaps, [{ maxAccounts: 40, outcome: "no_route" }, { maxAccounts: 48, outcome: "no_route" }, { maxAccounts: 60, outcome: "fits" }]);
  }
  assert.equal(w.urls.length, 9 + rebuildsOf(r));
});

test("no route at any cap: each leg's search ends no_route after its 3 builds", async () => {
  const w = capWorld(() => new Response('{"error":"No routes found"}', { status: 400 }));
  const r = await runSolanaTrade(request(SELL), { ...deps(SELL), fetch: w.fetch });
  for (const l of r.legs) assert.match(l.refused ?? "", /^build no_route: no_route: no route \(40 no_route, 48 no_route, 60 no_route\)/);
  assert.deepEqual([...w.caps()].sort((a, c) => a - c), [40, 40, 40, 48, 48, 48, 60, 60, 60]);
});

test("no route at 40, 48 fits, the floor needs a rebuild: the rebuild asks 48, the cap the search found (3 builds)", async () => {
  const urls: string[] = [];
  const base = builds(urls);
  const fetch = async (url: string) => {
    const u = new URL(url);
    const cap = Number(u.searchParams.get("maxAccounts"));
    if (cap === 40) { urls.push(url); return new Response('{"error":"No routes found"}', { status: 400 }); }
    u.searchParams.set("maxAccounts", "40"); // the recording was asked at 40
    const r = await base(u.toString());
    urls[urls.length - 1] = url;
    return r;
  };
  const r = await runSolanaTrade(request(BUY), { ...deps(BUY, { scale: 10_100n }), fetch });
  const l = r.legs[0]!;
  assert.equal(l.refused, undefined, l.refused);
  assert.deepEqual(urls.map((x) => Number(new URL(x).searchParams.get("maxAccounts"))), [40, 48, 48]);
  assert.equal(l.buildCalls, 3);
  assert.ok(Number(new URL(urls[2]!).searchParams.get("slippageBps")) !== Number(new URL(urls[1]!).searchParams.get("slippageBps")));
});

test("the floor's rebuild finds no route at the search's cap: refused for the floor, never as a token with no route", async () => {
  let n = 0;
  const base = builds();
  const fetch = async (url: string) => (++n === 2 ? new Response('{"error":"No routes found"}', { status: 400 }) : base(url));
  const r = await runSolanaTrade(request(BUY), { ...deps(BUY, { scale: 10_100n }), fetch });
  const l = r.legs[0]!;
  assert.equal(n, 2);
  assert.match(l.refused ?? "", /^the route quotes \d+, under the floor \d+ at its slippage, and its rebuild at \d+ bps found no route at maxAccounts=40$/);
  assert.doesNotMatch(l.refused ?? "", /^build no_route/);
  assert.equal(l.buildCalls, 2);
  assert.equal(l.dry, undefined);
});

// Card solana-legs-share-wait: a leg the helper answers past its share waits the Retry-After inside the trade's bound,
// then asks the cap another leg fitted; a wait past the bound refuses that leg alone; onBuilds shows the wait.
const takerOf = (url: string) => new URL(url).searchParams.get("taker");
function fakeTime(realMs = 0) {
  let t = 1_000;
  // the clock moves by the wait; `realMs` of real time lets the other legs' reads land meanwhile, as in a real wait
  return { now: () => t, sleep: async (ms: number) => { t += ms; if (realMs) await new Promise((ok) => setTimeout(ok, realMs)); }, at: () => t };
}

test("a sell over 3 wallets, no route at 40: the leg answered 429 waits its Retry-After, then asks 48, the cap the others fitted, once", async () => {
  const w = capWorld(noRouteBelow(48));
  const req = request(SELL);
  const late = req.legs[2]!.wallet;
  let refusedOnce = false;
  const fetch = async (url: string): Promise<Response> => {
    if (takerOf(url) === late && !refusedOnce) { refusedOnce = true; return new Response('{"error":{"code":"rate_limited"}}', { status: 429, headers: { "retry-after": "2" } }); }
    return w.fetch(url);
  };
  const time = fakeTime(200);
  const seen: { built: number; waiting: number; total: number }[] = [];
  const r = await runSolanaTrade(req, { ...deps(SELL), fetch, now: time.now, sleep: time.sleep, onBuilds: (p) => seen.push(p) });
  for (const l of r.legs) assert.equal(l.refused, undefined, l.refused);
  const lateRec = r.legs.find((l) => l.wallet === late)!;
  assert.deepEqual(lateRec.buildCaps, [{ maxAccounts: 48, outcome: "fits" }], "after the wait, the cap another leg fitted: 1 build");
  for (const l of r.legs.filter((x) => x.wallet !== late)) assert.deepEqual(l.buildCaps, [{ maxAccounts: 40, outcome: "no_route" }, { maxAccounts: 48, outcome: "fits" }]);
  assert.ok(seen.some((p) => p.waiting === 1), "the wait was shown");
  assert.deepEqual(seen.at(-1), { built: 3, waiting: 0, total: 3 });
});

test("a leg whose waits would end past the trade's 10-minute bound is refused alone; the others go on", async () => {
  assert.equal(SOLANA_TRADE_BUILD_WAIT_MS, 600_000);
  const req = request(SELL);
  const late = req.legs[0]!.wallet;
  const base = builds([]);
  let asks = 0;
  const fetch = async (url: string): Promise<Response> => {
    if (takerOf(url) === late) { asks++; return new Response('{"error":{"code":"upstream"}}', { status: 503, headers: { "retry-after": "61" } }); }
    return base(url);
  };
  const time = fakeTime();
  const t0 = time.at();
  const r = await runSolanaTrade(req, { ...deps(SELL), fetch, now: time.now, sleep: time.sleep });
  const lateRec = r.legs.find((l) => l.wallet === late)!;
  assert.equal(lateRec.refused, "build upstream: upstream: HTTP 503: no room by the trade's bound (Retry-After 61 s)");
  assert.equal(asks, 10, "9 waits of 61 s fit in 600 s, the tenth would not");
  assert.ok(time.at() - t0 <= SOLANA_TRADE_BUILD_WAIT_MS);
  for (const l of r.legs.filter((x) => x.wallet !== late)) assert.equal(l.refused, undefined, l.refused);
});

// Card solana-legs-share-wait, the blockhash: a trade not signed within SOLANA_BLOCKHASH_REFRESH_MS of its blockhash
// read reads each leg's pre-state and simulation again, then a blockhash both providers answer valid, and checks each
// leg's tx on it again, with the trade's own floors, before anything is signed.
const FRESH = base58.encode(new Uint8Array(32).fill(7));
/** The second blockhash read (and any after) answers FRESH, as a newer finalized block would. */
const freshAfterFirst: Edit = (_at, method, n, x) => {
  if (method === "getLatestBlockhash" && n >= 1) (x as { value: { blockhash: string } }).value.blockhash = FRESH;
  return x;
};
/** A clock the builds move: the first build takes `ms`. */
function slowBuilds(ms: number) {
  let t = 1_000;
  let moved = false;
  const base = builds([]);
  return { now: () => t, advance: (by: number) => { t += by; }, fetch: async (url: string) => { if (!moved) { moved = true; t += ms; } return base(url); } };
}
const signedHash = (b64: string): string => solanaDecodeMessage(base64.decode(b64).subarray(65)).blockhash;
/** The captured wires that are the legs' own signed txs (a teardown frame's dry simulation is not one). */
const legWires = (signed: readonly string[], legs: readonly { signature?: string }[]): string[] =>
  signed.filter((b) => legs.some((l) => l.signature === base58.encode(base64.decode(b).subarray(1, 65))));
/** The bytes the dry run sent to each provider's simulation (the signed wires: no `accounts` read-back). */
function signedOn(edit: Edit = (_a, _m, _n, x) => x): { edit: Edit; signed: string[] } {
  const signed: string[] = [];
  return { signed, edit: (at, method, n, x, params) => {
    if (method === "simulateTransaction" && !(params[1] as { accounts?: unknown })?.accounts && at === "A") signed.push(params[0] as string);
    return edit(at, method, n, x, params);
  } };
}

test("a trade signed within 20 s of its blockhash read reads no blockhash again and asks no isBlockhashValid", async () => {
  assert.equal(SOLANA_BLOCKHASH_REFRESH_MS, 20_000);
  const clock = slowBuilds(19_000);
  const d = deps(SELL, { edit: freshAfterFirst });
  const r = await runSolanaTrade(request(SELL), { ...d, fetch: clock.fetch, now: clock.now });
  for (const l of r.legs) assert.equal(l.refused, undefined, l.refused);
  assert.equal(r.firstBlockhash, undefined);
  assert.notEqual(r.blockhash?.blockhash, FRESH);
  for (const p of d.providers) {
    assert.equal(p.asks.filter((k) => k.startsWith('["isBlockhashValid"')).length, 0);
    assert.equal(p.asks.filter((k) => k.startsWith('["getLatestBlockhash"')).length, 1 + r.legs.filter((l) => l.teardown).length, "the trade's one read, and one a teardown");
  }
});

test("builds that took 25 s: every leg's pre-state and simulation read again, a fresh blockhash both providers hold, each leg checked and signed on it", async () => {
  const clock = slowBuilds(25_000);
  const cap = signedOn(freshAfterFirst);
  const d = deps(SELL, { edit: cap.edit });
  const req = request(SELL);
  const r = await runSolanaTrade(req, { ...d, fetch: clock.fetch, now: clock.now });
  for (const l of r.legs) assert.equal(l.refused, undefined, l.refused);
  assert.equal(r.blockhash?.blockhash, FRESH);
  assert.ok(r.firstBlockhash && r.firstBlockhash.blockhash !== FRESH);
  // the signed bytes are on the fresh blockhash, one tx a leg
  assert.equal(legWires(cap.signed, r.legs).length, req.legs.length);
  for (const b of legWires(cap.signed, r.legs)) assert.equal(signedHash(b), FRESH);
  // the same trade signed at once, for its count of simulations read back on accounts (the legs' and the teardowns')
  const fast = slowBuilds(0);
  const d0 = deps(SELL, { edit: freshAfterFirst });
  await runSolanaTrade(request(SELL), { ...d0, fetch: fast.fetch, now: fast.now });
  const sims = (asks: string[]) => asks.filter((k) => k.startsWith('["simulateTransaction"') && k.includes('"addresses"')).length;
  for (const i of [0, 1] as const) {
    const p = d.providers[i];
    assert.equal(p.asks.filter((k) => k.startsWith('["isBlockhashValid"')).length, 1, "the fresh hash asked once on each provider");
    assert.equal(sims(p.asks), sims(d0.providers[i].asks) + req.legs.length, "one more simulation a leg: the renewal's");
  }
  // the floors are the trade's own: S12 still names each leg's reference E, the check on the fresh bytes passed
  const ref = fx.references[SELL]!.answer!;
  r.legs.forEach((l, k) => {
    assert.equal(l.verdict?.ok, true);
    assert.match(l.verdict?.results.find((x) => x.id === "S12")?.detail ?? "", new RegExp(`E ${ref.expectedOuts[k]}$`));
  });
});

test("the fresh blockhash read valid on one provider only: read once more; valid on both then, the trade goes on it", async () => {
  const clock = slowBuilds(25_000);
  const cap = signedOn(freshAfterFirst);
  const d = deps(SELL, { edit: cap.edit, valid: (at, _h, n) => !(at === "B" && n === 0) });
  const r = await runSolanaTrade(request(SELL), { ...d, fetch: clock.fetch, now: clock.now });
  for (const l of r.legs) assert.equal(l.refused, undefined, l.refused);
  assert.equal(legWires(cap.signed, r.legs).length, r.legs.length);
  for (const b of legWires(cap.signed, r.legs)) assert.equal(signedHash(b), FRESH);
  for (const p of d.providers) assert.equal(p.asks.filter((k) => k.startsWith('["isBlockhashValid"')).length, 2);
});

test("the two providers do not both answer the fresh blockhash valid, twice: every leg refused, nothing signed", async () => {
  const clock = slowBuilds(25_000);
  const cap = signedOn(freshAfterFirst);
  const d = deps(SELL, { edit: cap.edit, valid: (at) => at === "A" });
  const r = await runSolanaTrade(request(SELL), { ...d, fetch: clock.fetch, now: clock.now });
  for (const l of r.legs) {
    assert.equal(l.refused, `renewal: no blockhash both providers hold (${FRESH}: valid on A true, on B false)`);
    assert.equal(l.signature, undefined);
    assert.equal(l.dry, undefined);
  }
  assert.equal(cap.signed.length, 0);
});

test("a leg whose fresh simulation now gives it nothing is refused on the renewal check and keeps its money; the others are signed", async () => {
  const clock = slowBuilds(25_000);
  const req = request(SELL);
  const w0 = req.legs[0]!.wallet;
  // the renewal's simulation for w0 (its second): the wallet gains no lamports from the sell
  const cap = signedOn((at, method, n, x, params) => {
    const y = freshAfterFirst(at, method, n, x, params);
    const sim = method === "simulateTransaction" ? (params[1] as { accounts?: { addresses?: string[] } })?.accounts?.addresses : null;
    if (sim && sim[0] === w0 && n >= 1) {
      const pre = fx.rpc.find((q) => q.at === at && q.ask.startsWith('["getMultipleAccounts"') && q.ask.includes(w0))!.answer as { value: ({ lamports: number } | null)[] };
      (y as { value: { accounts: ({ lamports: number } | null)[] } }).value.accounts[0]!.lamports = pre.value[0]!.lamports;
    }
    return y;
  });
  const d = deps(SELL, { edit: cap.edit });
  const r = await runSolanaTrade(req, { ...d, fetch: clock.fetch, now: clock.now });
  const l0 = r.legs[0]!;
  assert.match(l0.refused ?? "", /^checks: /);
  assert.equal(l0.verdict?.ok, false);
  assert.equal(l0.signature, undefined);
  for (const l of r.legs.slice(1)) assert.equal(l.refused, undefined, l.refused);
  assert.equal(legWires(cap.signed, r.legs).length, req.legs.length - 1);
  for (const b of legWires(cap.signed, r.legs)) assert.equal(signedHash(b), FRESH);
});

// The renewal's reference (review M1): the market can move while the helper holds the set, so the renewal reads E
// again for the same set and S12 holds each leg's floor and simulated out to the fresh E; minOut stays the leg's own.
/** The renewal's simulation (each wallet's second) pays `k` x the first's gain in lamports. */
function renewalPays(k: number): Edit {
  const gains = new Map<string, number>();
  return (at, method, n, x, params) => {
    const y = freshAfterFirst(at, method, n, x, params);
    const sim = method === "simulateTransaction" ? (params[1] as { accounts?: { addresses?: string[] } })?.accounts?.addresses : null;
    if (sim) {
      const w = sim[0]!;
      const pre = (fx.rpc.find((q) => q.at === at && q.ask.startsWith('["getMultipleAccounts"') && q.ask.includes(w))!.answer as { value: ({ lamports: number } | null)[] }).value[0]!.lamports;
      const acc = (y as { value: { accounts: ({ lamports: number } | null)[] } }).value.accounts[0]!;
      if (n === 0) gains.set(`${at}${w}`, acc.lamports - pre);
      else acc.lamports = pre + Math.floor((gains.get(`${at}${w}`) ?? 0) * k);
    }
    return y;
  };
}
/** The reference read: the first as recorded, every later one scaled by `k` (null: no reference pool). */
function movedReference(d: SolanaTradeDeps, k: bigint | null) {
  const reads = { n: 0 };
  const reference: SolanaTradeDeps["reference"] = async (q, p) => {
    reads.n++;
    const x = await d.reference(q, p);
    if (reads.n === 1 || !x) return x;
    if (k === null) return null;
    return { expectedOut: (x.expectedOut * k) / 10_000n, ...(x.expectedOuts ? { expectedOuts: x.expectedOuts.map((e) => (e * k) / 10_000n) } : {}) };
  };
  return { reference, reads };
}

test("the market moved 50% for the user while the set waited: the renewal reads E again and refuses every leg whose floor is now under the fresh E_k less s; nothing is signed", async () => {
  const clock = slowBuilds(25_000);
  const req = request(SELL);
  const cap = signedOn(renewalPays(1.5));
  const d = deps(SELL, { edit: cap.edit });
  const m = movedReference(d, 15_000n);
  const r = await runSolanaTrade(req, { ...d, reference: m.reference, fetch: clock.fetch, now: clock.now });
  const ref = fx.references[SELL]!.answer!;
  r.legs.forEach((l, k) => {
    const s12 = l.verdict?.results.find((x) => x.id === "S12");
    assert.equal(s12?.ok, false, s12?.detail);
    assert.match(s12?.detail ?? "", new RegExp(`^minOut ${l.minOut} < E_k \\d+ less ${req.slippageBps} bps \\(\\d+\\)$`));
    assert.match(l.refused ?? "", /^checks: S12 minOut /);
    assert.equal(l.signature, undefined);
    // the leg's own floor and first reference are kept; the fresh E is on the record beside them
    assert.equal(l.legExpectedOut, BigInt(ref.expectedOuts[k]!));
    assert.equal(l.renewedReference?.legExpectedOut, (BigInt(ref.expectedOuts[k]!) * 15_000n) / 10_000n);
  });
  assert.equal(legWires(cap.signed, r.legs).length, 0);
  assert.equal(m.reads.n, 2, "E read before the builds and again at the renewal");
});

test("the market moved 3% against the user while the set waited, inside the slippage: the floors still hold on the fresh E, every leg is signed on the fresh blockhash", async () => {
  const clock = slowBuilds(25_000);
  const cap = signedOn(renewalPays(0.97));
  const d = deps(SELL, { edit: cap.edit });
  const m = movedReference(d, 9_700n);
  const r = await runSolanaTrade(request(SELL), { ...d, reference: m.reference, fetch: clock.fetch, now: clock.now });
  assert.equal(m.reads.n, 2);
  for (const l of r.legs) {
    assert.equal(l.refused, undefined, l.refused);
    assert.equal(l.verdict?.ok, true);
  }
  assert.equal(legWires(cap.signed, r.legs).length, r.legs.length);
  for (const b of legWires(cap.signed, r.legs)) assert.equal(signedHash(b), FRESH);
});

test("the renewal's reference read answers no pool: every leg refused, nothing signed", async () => {
  const clock = slowBuilds(25_000);
  const cap = signedOn(freshAfterFirst);
  const d = deps(SELL, { edit: cap.edit });
  const m = movedReference(d, null);
  const r = await runSolanaTrade(request(SELL), { ...d, reference: m.reference, fetch: clock.fetch, now: clock.now });
  for (const l of r.legs) {
    assert.equal(l.refused, "renewal: no reference pool");
    assert.equal(l.signature, undefined);
  }
  assert.equal(legWires(cap.signed, r.legs).length, 0);
});

test("a leg refused by the renewal keeps no passing verdict: its first check is on firstVerdict, verdict is the renewal's own or none", async () => {
  const clock = slowBuilds(25_000);
  const d = deps(SELL, { edit: freshAfterFirst, valid: (at) => at === "A" });
  const r = await runSolanaTrade(request(SELL), { ...d, fetch: clock.fetch, now: clock.now });
  for (const l of r.legs) {
    assert.match(l.refused ?? "", /^renewal: no blockhash both providers hold/);
    assert.equal(l.verdict, undefined);
    assert.equal(l.firstVerdict?.ok, true);
  }
});

test("a leg whose bytes to sign are not its checked copy is refused in the trade itself, never signed (the guard in runSolanaTrade)", async (t) => {
  // The checked copy is made with Uint8Array.from: here it gets one signature-slot byte the bytes to sign do not have.
  // The checks never read the signature slot, so they pass the copy; only the guard sees the two differ.
  const from = Uint8Array.from as unknown as (this: unknown, ...a: unknown[]) => Uint8Array;
  t.mock.method(Uint8Array, "from", (src: ArrayLike<number>, ...rest: unknown[]) => {
    const out = from.call(Uint8Array, src, ...rest);
    const unsigned = src instanceof Uint8Array && src.length > 65 && src[0] === 1 && src.subarray(1, 65).every((b) => b === 0);
    if (unsigned && new Error().stack?.includes("verdictOn")) out[1] = 7;
    return out;
  });
  const d = deps(SELL);
  const r = await runSolanaTrade(request(SELL), d);
  t.mock.restoreAll();
  for (const l of r.legs) {
    assert.equal(l.verdict?.ok, true, "the checks passed the copy");
    assert.equal(l.refused, "the bytes to sign are not the bytes the checks passed");
    assert.equal(l.signature, undefined);
    assert.equal(l.dry, undefined);
  }
});

// The renewal's reference is read last (review fold 2, M1): after the legs' re-reads, beside the blockhash; and at the
// sign point, a reference older than the limit is read once more, the reference only, so a large set never loops.
/** E as the market gives it at the clock's time: the recorded E before `at`, then `k` x it. */
function marketAt(d: SolanaTradeDeps, now: () => number, at: number, k: bigint, cost = 0, advance: (ms: number) => void = () => {}) {
  const reads: number[] = [];
  const reference: SolanaTradeDeps["reference"] = async (q, p) => {
    reads.push(now());
    const moved = now() >= at;
    advance(cost);
    const x = await d.reference(q, p);
    if (!x || !moved) return x;
    return { expectedOut: (x.expectedOut * k) / 10_000n, ...(x.expectedOuts ? { expectedOuts: x.expectedOuts.map((e) => (e * k) / 10_000n) } : {}) };
  };
  return { reference, reads };
}

test("the legs' re-reads take 30 s and the market moves 50% for the user during them: S12 holds the E read after them, every leg refused", async () => {
  const clock = slowBuilds(25_000);
  const pays = renewalPays(1.5);
  // each leg's renewal simulation on provider A takes 10 s of the clock: 3 legs, 30 s
  const cap = signedOn((at, method, n, x, params) => {
    const sim = method === "simulateTransaction" ? (params[1] as { accounts?: unknown })?.accounts : null;
    if (sim && n >= 1 && at === "A") clock.advance(10_000);
    return pays(at, method, n, x, params);
  });
  const d = deps(SELL, { edit: cap.edit });
  const start = 1_000 + 25_000;
  const m = marketAt(d, clock.now, start + 15_000, 15_000n);
  const r = await runSolanaTrade(request(SELL), { ...d, reference: m.reference, fetch: clock.fetch, now: clock.now });
  for (const l of r.legs) {
    assert.match(l.refused ?? "", /^checks: S12 minOut /, l.refused);
    assert.equal(l.signature, undefined);
  }
  assert.equal(legWires(cap.signed, r.legs).length, 0);
  assert.equal(m.reads.length, 2);
  assert.ok(m.reads[1]! >= start + 30_000, `the renewal's E read after the legs' re-reads (${m.reads[1]! - start} ms into them)`);
});

test("the blockhash takes 25 s to agree and the market moves 50% meanwhile: at the sign point the reference alone is read once more, and every leg is refused on it", async () => {
  const clock = slowBuilds(25_000);
  const cap = signedOn(renewalPays(1.5));
  // the renewal's validity read on B takes 25 s of the clock
  const d = deps(SELL, { edit: cap.edit, valid: (at) => { if (at === "B") clock.advance(25_000); return true; } });
  const m = marketAt(d, clock.now, 1_000 + 25_000 + 10_000, 15_000n);
  const r = await runSolanaTrade(request(SELL), { ...d, reference: m.reference, fetch: clock.fetch, now: clock.now });
  assert.equal(m.reads.length, 3, "the first read, the renewal's, and one at the sign point");
  for (const l of r.legs) {
    assert.match(l.refused ?? "", /^checks: S12 minOut /, l.refused);
    assert.equal(l.signature, undefined);
  }
  for (const p of d.providers) assert.equal(p.asks.filter((k) => k.startsWith('["simulateTransaction"') && k.includes('"addresses"') && k.includes(request(SELL).legs[0]!.wallet)).length, 2, "the set's own reads are not run a third time");
});

test("every reference read takes 25 s: the sign point reads it once more and signs, never a loop", async () => {
  const clock = slowBuilds(25_000);
  const cap = signedOn(renewalPays(1));
  const d = deps(SELL, { edit: cap.edit });
  const m = marketAt(d, clock.now, Number.MAX_SAFE_INTEGER, 10_000n, 25_000, clock.advance);
  const r = await runSolanaTrade(request(SELL), { ...d, reference: m.reference, fetch: clock.fetch, now: clock.now });
  assert.equal(m.reads.length, 3);
  for (const l of r.legs) assert.equal(l.refused, undefined, l.refused);
  assert.equal(legWires(cap.signed, r.legs).length, r.legs.length);
});
