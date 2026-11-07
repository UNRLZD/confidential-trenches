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
  SOLANA_SIGNING_MARGIN_MS,
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
/** The one wSOL account a recorded sell wallet holds (see replay below), and its lamports in the recording. */
const WSOL_HELD = { wallet: "9UnZnrFJ1CXCmCorgGU9NvYkX5np1h4v4ympx3Nrdw3v", account: "FVee2JCpMd9k17iP1LLCSP28wwLt5N172pULCqUo8qQi", lamports: 28_772_578_629 };
const askOf = (method: string, params: readonly unknown[]): string =>
  JSON.stringify(method === "simulateTransaction" ? [method, (params[1] as { accounts?: unknown })?.accounts] : [method, params]);

type Edit = (at: "A" | "B", method: string, n: number, answer: unknown, params: readonly unknown[]) => unknown;
/** isBlockhashValid, which the recording holds no answer to: the n-th ask on a provider (0 first) answers this. */
type Valid = (at: "A" | "B", hash: string, n: number) => boolean;
/** A provider answering from the recording: the n-th ask of a key gets the n-th recorded answer (the last repeats). */
function replay(at: "A" | "B", edit: Edit = (_a, _m, _n, x) => x, valid: Valid = () => true): SolanaRpc & { asks: string[]; times: number[] } {
  const by = new Map<string, unknown[]>();
  for (const r of fx.rpc) if (r.at === at) by.set(r.ask, [...(by.get(r.ask) ?? []), r.answer]);
  // The recording predates the read of every account a leg's tx writes (card solana-legs-checked). An ask for accounts
  // the recording never asked together answers each from the recording's own reads of it on this provider, and as no
  // account where it holds none. One sell wallet, 9UnZ…dw3v, also holds a wSOL account (FVee…8qQi, 28,771,090,189
  // wrapped, read by its teardown), which its sell writes: the flow reads it back in a second simulation, which the
  // recording predates too, with the wallet itself (card solana-written-accounts-whole: the native sum from one run).
  // That sell's own instructions close the account into the wallet (S13 holds a create closed once, after the route, to
  // the wallet), so a clean run of it leaves the account closed, read back as a real simulation reads a closed account
  // (the system program's, 0 lamports, no data: a dry buy from that wallet, 7 Nov), and the wallet as the recorded
  // simulation left it: the replay answers that.
  const known = new Map<string, unknown>();
  for (const r of fx.rpc) {
    if (r.at !== at || !r.ask.startsWith('["getMultipleAccounts"')) continue;
    const keys = (JSON.parse(r.ask) as [string, [string[]]])[1][0];
    keys.forEach((k, i) => known.set(k, (r.answer as { value: unknown[] }).value[i] ?? null));
  }
  const seen = new Map<string, number>();
  const asks: string[] = [];
  const times: number[] = [];
  const fn = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const k = askOf(method, params);
    asks.push(k);
    times.push(Date.now());
    if (method === "isBlockhashValid") return { context: { slot: 1 }, value: valid(at, params[0] as string, asks.filter((x) => x.startsWith('["isBlockhashValid"')).length - 1) };
    let list = by.get(k);
    // The pre-state read carries the wallet's wSOL account after its four (card solana-quote-under-1s), which the
    // recording predates: it answers as the recorded four-account read (counted and edited as that one) and the wSOL
    // account from the recording's own reads of it.
    const keys = method === "getMultipleAccounts" ? (params[0] as string[]) : [];
    const head = keys.length === 5 ? askOf(method, [keys.slice(0, 4), ...params.slice(1)]) : "";
    const headList = !list && head ? by.get(head) : undefined;
    if (headList) {
      const n = seen.get(head) ?? 0;
      seen.set(head, n + 1);
      const four = edit(at, method, n, clone(headList[Math.min(n, headList.length - 1)]), [keys.slice(0, 4), ...params.slice(1)]) as { context: unknown; value: unknown[] };
      return { ...four, value: [...four.value, clone(known.get(keys[4] as string) ?? null)] };
    }
    if (!list && method === "getMultipleAccounts") return { context: { slot: 1 }, value: (params[0] as string[]).map((x) => clone(known.get(x) ?? null)) };
    const back = method === "simulateTransaction" ? (params[1] as { accounts?: { addresses?: string[] } })?.accounts?.addresses : undefined;
    if (!list && back?.length === 2 && back[0] === WSOL_HELD.wallet && back[1] === WSOL_HELD.account) {
      const main = fx.rpc.find((r) => r.at === at && r.ask.startsWith('["simulateTransaction"') && (JSON.parse(r.ask) as [string, { addresses?: string[] } | null])[1]?.addresses?.[0] === WSOL_HELD.wallet)!;
      list = [{ context: { slot: 1 }, value: { err: null, accounts: [(main.answer as { value: { accounts: unknown[] } }).value.accounts[0], { data: ["", "base64"], executable: false, lamports: 0, owner: "11111111111111111111111111111111", rentEpoch: 0, space: 0 }] } }]; // edited as a recorded answer
    }
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

test("a floor that rounds to 0 is refused: its build, out with the first reads, is dropped unassembled, nothing simulated or signed", async () => {
  const urls: string[] = [];
  const d = deps(BUY, { urls });
  const r = await runSolanaTrade(request(BUY), { ...d, reference: async () => ({ expectedOut: 1n, expectedOuts: [1n] }) });
  assert.equal(r.legs[0]?.minOut, 0n);
  assert.equal(r.legs[0]?.refused, "the floor rounds to 0");
  assert.ok(urls.length <= 1, `${urls.length} builds`);
  for (const p of d.providers) assert.ok(!p.asks.some((a) => a.startsWith('["simulateTransaction"')), "a refused leg was simulated");
  assert.equal(r.legs[0]?.signature, undefined);
});

test("card solana-quote-under-1s: every leg's build goes out with the first reads, before the reference answers", async () => {
  const urls: string[] = [];
  const d = deps(SELL, { urls });
  let builtBeforeReference = false;
  // the reference answers only once a build is out, or after 3 s: a flow that waits for it before building is red
  const reference: SolanaTradeDeps["reference"] = async (q, p) => {
    const t = Date.now();
    while (urls.length < request(SELL).legs.length && Date.now() - t < 3_000) await new Promise((ok) => setTimeout(ok, 5));
    builtBeforeReference = urls.length === request(SELL).legs.length;
    return d.reference(q, p);
  };
  const r = await runSolanaTrade(request(SELL), { ...d, reference });
  assert.equal(builtBeforeReference, true, "the builds waited for the reference");
  for (const l of r.legs) assert.equal(l.refused, undefined, l.refused);
});

test("card solana-quote-under-1s: no reference pool while a build waits out the helper's Retry-After: the trade is refused at once, the wait ended, no build asked again", async () => {
  const urls: string[] = [];
  const d = deps(SELL);
  const fetch = async (url: string) => { urls.push(url); return new Response('{"error":{"code":"rate_limited"}}', { status: 429, headers: { "retry-after": "30" } }); };
  // the room's sleep never ends by itself: a refused trade that kept waiting would never answer
  const run = runSolanaTrade(request(SELL), { ...d, fetch, sleep: () => new Promise<void>(() => {}), reference: async () => null });
  const r = await Promise.race([run, new Promise<null>((ok) => setTimeout(() => ok(null), 2_000))]);
  assert.ok(r, "the refused trade waited for the build's room");
  for (const l of r.legs) assert.equal(l.refused, "no reference pool");
  assert.equal(urls.length, request(SELL).legs.length, "one build a leg, none asked again");
});

test("card solana-quote-under-1s: no reference pool refuses every leg; the builds already out are dropped, nothing simulated or signed", async () => {
  const d = deps(SELL);
  const r = await runSolanaTrade(request(SELL), { ...d, reference: async () => null });
  for (const l of r.legs) { assert.equal(l.refused, "no reference pool"); assert.equal(l.signature, undefined); assert.equal(l.verdict, undefined); }
  for (const p of d.providers) assert.ok(!p.asks.some((a) => a.startsWith('["simulateTransaction"')), "a refused leg was simulated");
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

test("a trade that reaches its signatures within 15 s of its blockhash read (20 s less the 5 s signing margin) reads no blockhash again and asks no isBlockhashValid", async () => {
  assert.equal(SOLANA_BLOCKHASH_REFRESH_MS, 20_000);
  assert.equal(SOLANA_SIGNING_MARGIN_MS, 5_000);
  const clock = slowBuilds(15_000);
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
    // one more a leg, the renewal's, and the renewal's read-back of the one wSOL account a leg writes (WSOL_HELD)
    assert.equal(sims(p.asks), sims(d0.providers[i].asks) + req.legs.length + 1, "one more simulation a leg: the renewal's");
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
      // the sell's own proceeds, scaled: not the wSOL a wallet already held, which its sell's close returns whole
      const held = w === WSOL_HELD.wallet ? WSOL_HELD.lamports : 0;
      if (n === 0) gains.set(`${at}${w}`, acc.lamports - pre - held);
      else acc.lamports = pre + held + Math.floor((gains.get(`${at}${w}`) ?? 0) * k);
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

test("the blockhash takes 25 s to agree and the market moves 50% meanwhile: at the sign point the reference and the blockhash are read once more, and every leg is refused on them", async () => {
  const clock = slowBuilds(25_000);
  const cap = signedOn(renewalPays(1.5));
  // the renewal's first validity read on B takes 25 s of the clock; the sign point's answers at once
  const d = deps(SELL, { edit: cap.edit, valid: (at, _h, n) => { if (at === "B" && n === 0) clock.advance(25_000); return true; } });
  const m = marketAt(d, clock.now, 1_000 + 25_000 + 10_000, 15_000n);
  const r = await runSolanaTrade(request(SELL), { ...d, reference: m.reference, fetch: clock.fetch, now: clock.now });
  assert.equal(m.reads.length, 3, "the first read, the renewal's, and one at the sign point");
  for (const l of r.legs) {
    assert.match(l.refused ?? "", /^checks: S12 minOut /, l.refused);
    assert.equal(l.signature, undefined);
  }
  for (const p of d.providers) assert.equal(p.asks.filter((k) => k.startsWith('["simulateTransaction"') && k.includes('"addresses"') && k.includes(request(SELL).legs[0]!.wallet)).length, 2, "the set's own reads are not run a third time");
});

// Card kit-renewal-read-bounded: the price a leg is signed on is a reference read begun no more than
// SOLANA_BLOCKHASH_REFRESH_MS before the signature, at the sign point's re-read and at each leg's own signature; a leg
// past it is refused as a price check (`checks: `, the signing page's quote_check_failed), never read again in a loop.
const LATE = /^checks: the reference is \d+ ms old at the signature, past the 20000 ms limit$/;
/** The reference read, its n-th call (0 first) taking costs[n] ms of the clock before it answers as recorded. */
function slowReference(d: SolanaTradeDeps, advance: (ms: number) => void, costs: readonly number[]) {
  const reads = { n: 0 };
  const reference: SolanaTradeDeps["reference"] = async (q, p) => {
    advance(costs[reads.n++] ?? 0);
    return d.reference(q, p);
  };
  return { reference, reads };
}

test("every reference read takes 25 s: the sign point reads it once more, that read is late, and every leg is refused, never a loop", async () => {
  const clock = slowBuilds(25_000);
  const cap = signedOn(renewalPays(1));
  const d = deps(SELL, { edit: cap.edit });
  const m = marketAt(d, clock.now, Number.MAX_SAFE_INTEGER, 10_000n, 25_000, clock.advance);
  const r = await runSolanaTrade(request(SELL), { ...d, reference: m.reference, fetch: clock.fetch, now: clock.now });
  assert.equal(m.reads.length, 3);
  for (const l of r.legs) {
    assert.match(l.refused ?? "", LATE, l.refused);
    assert.equal(l.signature, undefined);
    assert.equal(l.dry, undefined);
  }
  assert.equal(legWires(cap.signed, r.legs).length, 0);
});

test("the sign point's reference re-read answers in 40 s: every leg refused with no signature, the reference never read a fourth time", async () => {
  const clock = slowBuilds(25_000);
  const cap = signedOn(renewalPays(1));
  const d = deps(SELL, { edit: cap.edit });
  const m = slowReference(d, clock.advance, [0, 25_000, 40_000]);
  const r = await runSolanaTrade(request(SELL), { ...d, reference: m.reference, fetch: clock.fetch, now: clock.now });
  assert.equal(m.reads.n, 3, "the first read, the renewal's, and one at the sign point");
  assert.equal(r.legs.length, 3);
  for (const l of r.legs) {
    assert.match(l.refused ?? "", LATE, l.refused);
    assert.equal(l.signature, undefined);
    assert.equal(l.dry, undefined);
  }
  assert.equal(legWires(cap.signed, r.legs).length, 0);
});

const FRESH2 = base58.encode(new Uint8Array(32).fill(8));
/** renewalPays(1), with the third blockhash read (and any after) answering FRESH2: the sign point's own. */
function payingWithSignPointHash(): Edit {
  const pays = renewalPays(1);
  return (at, method, n, x, params) => {
    const y = pays(at, method, n, x, params);
    if (method === "getLatestBlockhash" && n >= 2) (y as { value: { blockhash: string } }).value.blockhash = FRESH2;
    return y;
  };
}

test("the sign point's reference re-read answers in 15 s on an unmoved market: it reads a fresh blockhash with it, and every leg is signed on that blockhash", async () => {
  const clock = slowBuilds(25_000);
  const cap = signedOn(payingWithSignPointHash());
  const d = deps(SELL, { edit: cap.edit });
  const m = slowReference(d, clock.advance, [0, 25_000, 15_000]);
  const r = await runSolanaTrade(request(SELL), { ...d, reference: m.reference, fetch: clock.fetch, now: clock.now });
  assert.equal(m.reads.n, 3);
  for (const l of r.legs) assert.equal(l.refused, undefined, l.refused);
  assert.equal(r.blockhash?.blockhash, FRESH2, "the record names the blockhash the legs are signed on");
  assert.ok(r.firstBlockhash && r.firstBlockhash.blockhash !== FRESH && r.firstBlockhash.blockhash !== FRESH2, "firstBlockhash stays the trade's first read");
  assert.equal(legWires(cap.signed, r.legs).length, r.legs.length);
  for (const b of legWires(cap.signed, r.legs)) assert.equal(signedHash(b), FRESH2, "signed on the sign point's blockhash, not the renewal's");
  for (const p of d.providers) assert.equal(p.asks.filter((k) => k.startsWith('["isBlockhashValid"')).length, 2, "the renewal's blockhash and the sign point's, each asked valid once");
});

test("the signing margin: builds of 15 s go straight to the signatures, builds of 15.001 s renew first and sign on the fresh blockhash", async () => {
  for (const [ms, renews] of [[15_000, false], [15_001, true]] as const) {
    const clock = slowBuilds(ms);
    const cap = signedOn(freshAfterFirst);
    const d = deps(SELL, { edit: cap.edit });
    const r = await runSolanaTrade(request(SELL), { ...d, fetch: clock.fetch, now: clock.now });
    for (const l of r.legs) assert.equal(l.refused, undefined, `${ms} ms: ${l.refused}`);
    assert.equal(r.firstBlockhash !== undefined, renews, `${ms} ms`);
    for (const b of legWires(cap.signed, r.legs)) assert.equal(signedHash(b) === FRESH, renews, `${ms} ms`);
  }
});

test("a clock that runs backwards at the signature is late: the leg is refused, never sent", async () => {
  const clock = slowBuilds(10_000);
  // the signer answers with the clock 5 s behind the reference's read
  const sign: SolanaTradeDeps["sign"] = async () => { clock.advance(-15_000); return new Uint8Array(64).fill(1); };
  const paths = [{ name: "never", send: async () => { throw new Error("a late leg was sent"); } }];
  const r = await runSolanaTrade(request(BUY), { ...deps(BUY), dry: false, sign, paths, fetch: clock.fetch, now: clock.now });
  const l = r.legs[0]!;
  assert.match(l.refused ?? "", /^checks: the reference is -\d+ ms old at the signature, past the 20000 ms limit$/, l.refused);
  assert.equal(l.signature, undefined);
});

test("a partial set dropped at its signatures: the clock passes 20 s after the first leg's signature, onSigned names that leg alone and only it is signed", async () => {
  // a dry trade: each leg's age is read right before its signature and again inside signedWire once it is made; the
  // clock jumps 25 s just after the first leg's second read, so the next legs are late
  let t = 1_000;
  let jumped = false;
  const now = () => {
    const at = t;
    if (!jumped && new Error().stack?.includes("signedWire")) { jumped = true; t += 25_000; }
    return at;
  };
  const cap = signedOn();
  const d = deps(SELL, { edit: cap.edit });
  const given: { wallet: string; signature: string }[][] = [];
  const r = await runSolanaTrade(request(SELL), { ...d, now, onSigned: (x) => void given.push([...x]) });
  assert.equal(jumped, true);
  const [first, ...rest] = r.legs;
  assert.equal(first!.refused, undefined, first!.refused);
  for (const l of rest) {
    assert.match(l.refused ?? "", LATE, l.refused);
    assert.equal(l.signature, undefined);
  }
  assert.deepEqual(given, [[{ wallet: first!.wallet, signature: first!.signature! }]], "onSigned names the kept leg alone");
  assert.equal(legWires(cap.signed, r.legs).length, 1);
});

test("the signer's store read takes 15 s after a 10 s old reference: the leg is refused at its signature and nothing is sent; a 5 s one goes on to the signature's check", async () => {
  const run = async (signerMs: number) => {
    const clock = slowBuilds(10_000);
    const asked: string[] = [];
    const sign: SolanaTradeDeps["sign"] = async (wallet) => {
      asked.push(wallet);
      clock.advance(signerMs);
      // the recording's wallets have no key here: a signature that would be checked next, and fail
      return new Uint8Array(64).fill(1);
    };
    const paths = [{ name: "never", send: async () => { throw new Error("a late leg was sent"); } }];
    const r = await runSolanaTrade(request(BUY), { ...deps(BUY), dry: false, sign, paths, fetch: clock.fetch, now: clock.now });
    return { r, asked };
  };
  const late = await run(15_000);
  assert.equal(late.asked.length, 1, "the signer was asked: the reference was 10 s old then");
  const l = late.r.legs[0]!;
  assert.equal(l.firstVerdict, undefined, "no renewal: the trade's own reads, 10 s old");
  assert.equal(l.verdict?.ok, true);
  assert.match(l.refused ?? "", LATE, l.refused);
  assert.equal(l.signature, undefined);
  assert.equal(l.outcome, undefined);
  // the same leg with a signer that answers in 5 s is past the age rule: its signature is checked against the wallet
  await assert.rejects(run(5_000), /does not verify/);
});

test("onSigned is handed exactly the kept legs' signatures, in send order, once, right before signed: a leg refused at its renewal check is not in it", async () => {
  const clock = slowBuilds(25_000);
  const req = request(SELL);
  const w0 = req.legs[0]!.wallet;
  // the renewal's simulation for w0: the wallet gains nothing from the sell, so its check refuses it
  const cap = signedOn((at, method, n, x, params) => {
    const y = freshAfterFirst(at, method, n, x, params);
    const sim = method === "simulateTransaction" ? (params[1] as { accounts?: { addresses?: string[] } })?.accounts?.addresses : null;
    if (sim && sim[0] === w0 && n >= 1) {
      const pre = fx.rpc.find((q) => q.at === at && q.ask.startsWith('["getMultipleAccounts"') && q.ask.includes(w0))!.answer as { value: ({ lamports: number } | null)[] };
      (y as { value: { accounts: ({ lamports: number } | null)[] } }).value.accounts[0]!.lamports = pre.value[0]!.lamports;
    }
    return y;
  });
  const events: string[] = [];
  const given: { wallet: string; signature: string }[][] = [];
  const d = deps(SELL, { edit: cap.edit });
  const r = await runSolanaTrade(req, { ...d, fetch: clock.fetch, now: clock.now, onSigned: (s) => { events.push("onSigned"); given.push([...s]); }, onProgress: (st) => events.push(st) });
  assert.match(r.legs[0]!.refused ?? "", /^checks: /);
  assert.equal(given.length, 1, "called once");
  assert.deepEqual(events.slice(0, 2), ["onSigned", "signed"], "right before signed");
  const kept = r.legs.filter((l) => l.signature).map((l) => ({ wallet: l.wallet, signature: l.signature! }));
  assert.equal(kept.length, req.legs.length - 1);
  assert.deepEqual(given[0], kept, "the kept legs, in send order, and no other");
  // the signatures it names are the ones signed onto the wires
  assert.deepEqual(new Set(legWires(cap.signed, r.legs).map((b) => base58.encode(base64.decode(b).subarray(1, 65)))), new Set(kept.map((k) => k.signature)));
});

test("a set whose every leg is dropped as late never calls onSigned: refused, and nothing named", async () => {
  const clock = slowBuilds(10_000);
  const events: string[] = [];
  const sign: SolanaTradeDeps["sign"] = async () => { clock.advance(15_000); return new Uint8Array(64).fill(1); };
  const r = await runSolanaTrade(request(BUY), { ...deps(BUY), dry: false, sign, paths: [], fetch: clock.fetch, now: clock.now, onSigned: () => events.push("onSigned"), onProgress: (st) => events.push(st) });
  assert.match(r.legs[0]!.refused ?? "", LATE);
  assert.deepEqual(events, ["refused"]);
});

test("card solana-legs-checked: the sell wallet that already holds 28.77 wSOL has that account read on both providers and read back after its sell, and its sell is held to its own proceeds", async () => {
  const d = deps(SELL);
  const r = await runSolanaTrade(request(SELL), d);
  const back = JSON.stringify(["simulateTransaction", { addresses: [WSOL_HELD.wallet, WSOL_HELD.account], encoding: "base64" }]);
  for (const p of d.providers) {
    assert.ok(p.asks.some((k) => k.startsWith('["getMultipleAccounts"') && k.includes(WSOL_HELD.account) && k.includes(WSOL_HELD.wallet)), "read with the accounts its sell writes");
    assert.ok(p.asks.includes(back), "read back after the sell");
  }
  const leg = r.legs.find((l) => l.wallet === WSOL_HELD.wallet)!;
  assert.equal(leg.verdict?.ok, true, leg.refused);
  // its native in, as S12 reads it, is the sell's own: the recorded simulation's lamports less the wSOL the close returned
  const s12 = leg.verdict!.results.find((x) => x.id === "S12")!.detail;
  const out = BigInt(/^simulated out (\d+)/.exec(s12)![1]!);
  assert.ok(out > 0n && out < BigInt(WSOL_HELD.lamports), `${out}`);
});

test("card solana-written-accounts-whole: the wallet's held wSOL account read again after its simulations; a deposit into it meanwhile refuses that leg alone", async () => {
  const d = deps(SELL);
  const wrap = (p: (typeof d.providers)[number]) =>
    Object.assign(async (method: string, params: readonly unknown[]) => {
      const x = await p(method, params);
      const keys = method === "getMultipleAccounts" ? (params[0] as string[]) : [];
      // the read after the simulations: the wallet's four accounts, then its wSOL account the sell writes
      if (keys.length === 5 && keys[0] === WSOL_HELD.wallet && keys[4] === WSOL_HELD.account) {
        const acc = (x as { value: ({ lamports: number } | null)[] }).value[4]!;
        acc.lamports += 1;
      }
      return x;
    }, { asks: p.asks, times: p.times });
  const providers = [wrap(d.providers[0]), wrap(d.providers[1])] as const;
  const r = await runSolanaTrade(request(SELL), { ...d, providers });
  for (const p of providers) assert.ok(p.asks.some((k) => k.startsWith('["getMultipleAccounts"') && JSON.parse(k)[1][0].length === 5 && k.includes(WSOL_HELD.account)), "read again after the simulations");
  for (const l of r.legs) {
    if (l.wallet === WSOL_HELD.wallet) assert.match(l.refused ?? "", /changed while the trade was checked/);
    else assert.equal(l.refused, undefined, l.refused);
  }
});

// The second simulation (the wallet with its written accounts) on a provider whose answer `edit` changes, every other
// call as recorded.
function secondRun(d: ReturnType<typeof deps>, edit: (at: "A" | "B", method: string, params: readonly unknown[], x: unknown) => unknown) {
  const wrap = (p: (typeof d.providers)[number], at: "A" | "B") => Object.assign(async (method: string, params: readonly unknown[]) => edit(at, method, params, await p(method, params)), { asks: p.asks, times: p.times });
  return [wrap(d.providers[0], "A"), wrap(d.providers[1], "B")] as const;
}
test("card solana-quote-under-1s: a wallet whose pre-state read shows its wSOL account has its second simulation sent beside the first, and the leg passes every check", async () => {
  const d = deps(SELL);
  const backOf = (params: readonly unknown[]) => (params[1] as { accounts?: { addresses?: string[] } })?.accounts?.addresses ?? [];
  const beside: boolean[] = [];
  // the wallet's four-account simulation answers only once its [wallet, wSOL] one is out, or after 3 s
  const wrap = (p: (typeof d.providers)[number]) => Object.assign(async (method: string, params: readonly unknown[]) => {
    const back = backOf(params);
    if (method === "simulateTransaction" && back[0] === WSOL_HELD.wallet && back.length === 4) {
      const t = Date.now();
      const out = () => p.asks.some((k) => k.startsWith('["simulateTransaction"') && k.includes(WSOL_HELD.account));
      while (!out() && Date.now() - t < 3_000) await new Promise((ok) => setTimeout(ok, 5));
      beside.push(out());
    }
    return p(method, params);
  }, { asks: p.asks, times: p.times });
  const r = await runSolanaTrade(request(SELL), { ...d, providers: [wrap(d.providers[0]), wrap(d.providers[1])] });
  // both providers' quote simulations (and the dry send's after them)
  assert.ok(beside.length >= 2 && beside.every(Boolean), `the second simulation waited for the first: ${beside}`);
  const leg = r.legs.find((l) => l.wallet === WSOL_HELD.wallet)!;
  assert.equal(leg.refused, undefined, leg.refused);
  const second = askOf("simulateTransaction", ["", { accounts: { addresses: [WSOL_HELD.wallet, WSOL_HELD.account], encoding: "base64" } }]);
  for (const p of d.providers) assert.equal(p.asks.filter((k) => k === second).length, 1, "one second simulation a provider, the one sent beside");
});

test("card solana-quote-under-1s: the wSOL account read otherwise by the written accounts' read than by the pre-state read: the early simulation is dropped and the second runs after the read", async () => {
  const d = deps(SELL);
  let moved = 0;
  // the written accounts' read (more than 5 keys, the wSOL account among them; the pre-state read and the read again are
  // 5) answers the wSOL account one lamport up
  const wrap = (p: (typeof d.providers)[number]) => Object.assign(async (method: string, params: readonly unknown[]) => {
    const x = await p(method, params);
    const keys = method === "getMultipleAccounts" ? (params[0] as string[]) : [];
    const i = keys.indexOf(WSOL_HELD.account);
    if (i >= 0 && keys.length > 5) {
      const v = (x as { value: ({ lamports: number } | null)[] }).value[i];
      if (v) { v.lamports += 1; moved++; }
    }
    return x;
  }, { asks: p.asks, times: p.times });
  const r = await runSolanaTrade(request(SELL), { ...d, providers: [wrap(d.providers[0]), wrap(d.providers[1])] });
  assert.ok(moved >= 2, `the written read was edited ${moved} times`);
  const second = askOf("simulateTransaction", ["", { accounts: { addresses: [WSOL_HELD.wallet, WSOL_HELD.account], encoding: "base64" } }]);
  for (const p of d.providers) assert.equal(p.asks.filter((k) => k === second).length, 2, "the early one and the one after the read");
  const leg = r.legs.find((l) => l.wallet === WSOL_HELD.wallet)!;
  // the read again equals the pre-state, not the written read: the leg is refused as moved, never passed on the early run
  assert.equal(leg.refused, "the wallet's accounts changed while the trade was checked");
});

test("card solana-written-accounts-whole: the native sum comes from one simulation: the wallet's lamports read back with its wSOL account, not from the first run", async () => {
  const base = await runSolanaTrade(request(SELL), deps(SELL));
  const outOf = (r: typeof base) => BigInt(/^simulated out (\d+)/.exec(r.legs.find((l) => l.wallet === WSOL_HELD.wallet)!.verdict!.results.find((x) => x.id === "S12")!.detail)![1]!);
  const d = deps(SELL);
  // the second run lands where the sell pays 1,000 lamports less: the simulated out is that run's
  const providers = secondRun(d, (_at, method, params, x) => {
    const back = method === "simulateTransaction" ? (params[1] as { accounts?: { addresses?: string[] } })?.accounts?.addresses : undefined;
    if (back?.length === 2 && back[1] === WSOL_HELD.account) (x as { value: { accounts: { lamports: number }[] } }).value.accounts[0]!.lamports -= 1_000;
    return x;
  });
  const r = await runSolanaTrade(request(SELL), { ...d, providers });
  assert.equal(outOf(r), outOf(base) - 1_000n);
});
test("card solana-written-accounts-whole: a wSOL account of the wallet's that provider B alone reads is read back on both providers and read again on both, and the leg is refused", async () => {
  const d = deps(SELL);
  // provider A's read of the accounts the sell writes (more than the wallet's four) answers no account at the wSOL one
  const providers = secondRun(d, (at, method, params, x) => {
    const keys = method === "getMultipleAccounts" ? (params[0] as string[]) : [];
    const i = keys.indexOf(WSOL_HELD.account);
    if (at === "A" && keys.length > 5 && i >= 0 && keys.includes(WSOL_HELD.wallet)) (x as { value: unknown[] }).value[i] = null;
    return x;
  });
  const r = await runSolanaTrade(request(SELL), { ...d, providers });
  const back = JSON.stringify(["simulateTransaction", { addresses: [WSOL_HELD.wallet, WSOL_HELD.account], encoding: "base64" }]);
  for (const p of d.providers) assert.ok(p.asks.includes(back), "read back on each provider");
  const leg = r.legs.find((l) => l.wallet === WSOL_HELD.wallet)!;
  // A's read again after the simulations finds the account A first read as none: refused before the checks (which
  // would refuse the providers' disagreement on it)
  assert.match(leg.refused ?? "", /changed while the trade was checked/);
  for (const l of r.legs) if (l !== leg) assert.equal(l.refused, undefined, l.refused);
});

// Card solana-written-accounts-whole, the independent review of 0d2d8dc1 (7 Nov).
const simAddresses = (method: string, params: readonly unknown[]): string[] | undefined =>
  method === "simulateTransaction" ? (params[1] as { accounts?: { addresses?: string[] } })?.accounts?.addresses : undefined;
// A sell whose simulation leaves a stranger as the delegate of the wallet's account of the token: the flow hands S11 the
// account as the simulation reads it back (mutant N13 handed it the read before, and the sell passed).
test("card solana-written-accounts-whole review: a sell whose simulation reads the wallet's account of the token back with a stranger as its delegate is refused", async () => {
  const req = request(SELL);
  const d = deps(SELL);
  const stranger = base58.decode(base58.encode(Uint8Array.from({ length: 32 }, (_, i) => 200 - i)));
  const providers = secondRun(d, (_at, method, params, x) => {
    const back = simAddresses(method, params);
    if (back?.length === 4 && req.legs.some((l) => l.wallet === back[0])) {
      const acc = (x as { value: { accounts: ({ data: [string, string] } | null)[] } }).value.accounts[1];
      if (acc) {
        const b = base64.decode(acc.data[0]);
        new DataView(b.buffer, b.byteOffset).setUint32(72, 1, true);
        b.set(stranger, 76);
        acc.data = [base64.encode(b), "base64"];
      }
    }
    return x;
  });
  const r = await runSolanaTrade(req, { ...d, providers });
  for (const l of r.legs) assert.match(l.refused ?? "", new RegExp(`^checks: .*S11 provider A: the wallet's account of the token \\S+ is left with its delegate`), `${l.wallet}: ${l.refused}`);
});
// More than three of the wallet's token accounts written: they are read back with the wallet, three at a time (a provider
// reads back at most four accounts), and the wallet's lamports must read the same in each of those runs.
function fourHeld(d: ReturnType<typeof deps>, wallet: string, ata: string, shift = 0) {
  const fake = (k: string) => { const b = new Uint8Array(165); b.set(base58.decode(k), 0); b.set(base58.decode(wallet), 32); b[64] = 1; b[108] = 1; return { data: [base64.encode(b), "base64"], executable: false, lamports: 2_039_280, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", rentEpoch: 0, space: 165 }; };
  let picked: string[] | null = null;
  const walletBack: Record<string, unknown> = {};
  const groups: string[][] = [];
  const wrap = (p: (typeof d.providers)[number], at: "A" | "B") => Object.assign(async (method: string, params: readonly unknown[]) => {
    const back = simAddresses(method, params);
    if (back && back[0] === wallet && back.length !== 4 || back && back[0] === wallet && back.length === 4 && picked && back.slice(1).every((k) => picked!.includes(k))) {
      groups.push(back);
      const w = clone(walletBack[at]) as { lamports: number };
      if (shift && back.slice(1).includes(picked![3]!)) w.lamports += shift;
      p.asks.push(JSON.stringify(["simulateTransaction", { addresses: back }]));
      return { context: { slot: 1 }, value: { err: null, accounts: [w, ...back.slice(1).map(fake)] } };
    }
    const x = await p(method, params);
    if (back?.length === 4 && back[0] === wallet) walletBack[at] = (x as { value: { accounts: unknown[] } }).value.accounts[0];
    if (method === "getMultipleAccounts") {
      const keys = params[0] as string[];
      if (!picked && keys.length > 5 && keys.includes(wallet)) picked = keys.filter((k) => k !== wallet && k !== ata && k !== WSOL_HELD.account).slice(0, 4);
      if (picked) keys.forEach((k, i) => { if (picked!.includes(k)) (x as { value: unknown[] }).value[i] = fake(k); });
    }
    return x;
  }, { asks: p.asks, times: p.times });
  return { providers: [wrap(d.providers[0], "A"), wrap(d.providers[1], "B")] as const, groups, picked: () => picked };
}
test("card solana-written-accounts-whole review: four token accounts of the wallet's written are read back three at a time with the wallet, each once on each provider", async () => {
  const req = request(SELL);
  const leg = req.legs.find((l) => l.wallet !== WSOL_HELD.wallet)!;
  const d = deps(SELL);
  const ata = solanaAta(leg.wallet, req.token, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  const f = fourHeld(d, leg.wallet, ata);
  const r = await runSolanaTrade(req, { ...d, providers: f.providers });
  const mine = r.legs.find((l) => l.wallet === leg.wallet)!;
  assert.equal(f.picked()?.length, 4, String(mine.refused));
  assert.equal(mine.simulationErrors, undefined, String(mine.simulationErrors));
  for (const g of f.groups) assert.ok(g.length <= 4 && g[0] === leg.wallet, `read back ${g.length}: a provider reads back at most 4`);
  assert.deepEqual(f.groups.map((g) => g.length).sort(), [2, 2, 4, 4]);
  assert.deepEqual(f.groups.flatMap((g) => g.slice(1)).sort(), [...f.picked()!, ...f.picked()!].sort());
});
test("card solana-written-accounts-whole review: the wallet's lamports read differently in its second read-back run refuse the leg", async () => {
  const req = request(SELL);
  const leg = req.legs.find((l) => l.wallet !== WSOL_HELD.wallet)!;
  const d = deps(SELL);
  const ata = solanaAta(leg.wallet, req.token, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  const f = fourHeld(d, leg.wallet, ata, 1);
  const r = await runSolanaTrade(req, { ...d, providers: f.providers });
  const mine = r.legs.find((l) => l.wallet === leg.wallet)!;
  assert.ok(mine.refused, "refused");
  assert.match(String(mine.simulationErrors), /A: the wallet's lamports differ between its simulations/);
});

// Card solana-written-accounts-whole, the independent review of d1806532 (RVW-3): the flow reads the rent of the wallet's
// account of the token for the size the one rule gives (solanaTokenAccountSize), the size S11 holds the created account
// to: a Pausable mint's (26) 174 bytes with PausableAccount, where flow.ts's own rule read 170 and S11 refused the buy by
// the 4 bytes' rent. A mint that rule refuses (S10 refuses it too) is refused before its build is assembled or any rent
// is read (the build itself goes out with the first reads: card solana-quote-under-1s).
function mintWith(type: number, body: Uint8Array, urls: string[]) {
  const token = request(BUY).token;
  const d = deps(BUY, { urls });
  const asked: number[] = [];
  const wrap = (p: (typeof d.providers)[number]) => Object.assign(async (method: string, params: readonly unknown[]) => {
    if (method === "getMinimumBalanceForRentExemption") {
      asked.push(params[0] as number);
      return ((params[0] as number) + 128) * 5_080; // the recording's rent, 5,080 a byte: 170 bytes -> 1,513,840
    }
    const x = await p(method, params);
    if (method === "getMultipleAccounts") (params[0] as string[]).forEach((k, i) => {
      const a = (x as { value: ({ data: [string, string] } | null)[] }).value[i];
      if (k === token && a) a.data = [base64.encode(Uint8Array.from([...base64.decode(a.data[0]), type & 0xff, type >> 8, body.length & 0xff, body.length >> 8, ...body])), "base64"];
    });
    return x;
  }, { asks: p.asks, times: p.times });
  return { d: { ...d, providers: [wrap(d.providers[0]), wrap(d.providers[1])] as const }, asked };
}
test("card solana-written-accounts-whole review RVW-3: the rent of the account of the token is read for the one rule's size, 174 for a Pausable mint; a mint the rule refuses is refused, its build (out with the first reads, card solana-quote-under-1s) dropped unassembled, no rent read", async () => {
  const urls: string[] = [];
  const p = mintWith(26, new Uint8Array(33), urls);
  await runSolanaTrade(request(BUY), p.d);
  assert.deepEqual([...new Set(p.asked)].sort(), [137, 174], `rent asked for ${p.asked.join(", ")}`);
  assert.ok(urls.length > 0, "built");
  const none: string[] = [];
  const u = mintWith(29, new Uint8Array(4), none);
  const r = await runSolanaTrade(request(BUY), u.d);
  assert.equal(r.legs[0]?.refused, "the mint on provider A: Token-2022 extension 29 not known");
  assert.ok(none.length <= 1, `${none.length} builds`);
  assert.deepEqual(u.asked, [], "no rent read");
});

// Card solana-quote-under-1s, the independent review of fd926d82 (af47a0f7): the early [wallet, wSOL] simulation counts
// only when the written accounts' read finds that one account to read back and reads it on each provider as the
// pre-state read did. M4 (provider B's comparison dropped) and M5 (`mine.length === 1` dropped) each pass the suite
// without these two tests.
test("card solana-quote-under-1s review M4: provider B alone reads a deposit into the wSOL account after the pre-state read, and reads it so again: the early simulation is dropped on both providers and the second runs after the read", async () => {
  const d = deps(SELL);
  let moved = 0;
  let pre = 0;
  // provider B only: the first five-key read of the wallet with its wSOL account is the pre-state read and stays as
  // recorded; the written accounts' read and the read again after the simulations both read the account one lamport up
  const providers = secondRun(d, (at, method, params, x) => {
    const keys = method === "getMultipleAccounts" ? (params[0] as string[]) : [];
    const i = keys.indexOf(WSOL_HELD.account);
    if (at !== "B" || i < 0 || !keys.includes(WSOL_HELD.wallet) || (keys.length === 5 && pre++ === 0)) return x;
    const v = (x as { value: ({ lamports: number } | null)[] }).value[i];
    if (v) { v.lamports += 1; moved++; }
    return x;
  });
  const r = await runSolanaTrade(request(SELL), { ...d, providers });
  assert.ok(moved >= 2, `B's reads after the pre-state edited ${moved} times`);
  const second = askOf("simulateTransaction", ["", { accounts: { addresses: [WSOL_HELD.wallet, WSOL_HELD.account], encoding: "base64" } }]);
  for (const p of d.providers) assert.equal(p.asks.filter((k) => k === second).length, 2, "the early one and the one after the read");
  const leg = r.legs.find((l) => l.wallet === WSOL_HELD.wallet)!;
  assert.notEqual(leg.refused, "the wallet's accounts changed while the trade was checked", "the read again equals the written read");
});

// X, one more account the read finds as the wallet's token account, is planted after the wSOL account (the recorded
// sell writes none before it but the wallet's own): the read finds [wSOL, X], and M5 would read the wallet back with
// wSOL alone and X not at all.
test("card solana-quote-under-1s review M5: the written accounts' read finds the wallet's wSOL account and another of its token accounts after it in the tx: the early simulation is dropped and the wallet is read back with both, once on each provider", async () => {
  const req = request(SELL);
  const d = deps(SELL);
  const w = WSOL_HELD.wallet;
  const not = new Set([w, WSOL_HELD.account, solanaAta(w, req.token, SOLANA_TOKEN_2022_PROGRAM), solanaVolumeAccumulator(w, SOLANA_PUMP_PROGRAM), solanaVolumeAccumulator(w, SOLANA_PUMP_AMM_PROGRAM)]);
  const fake = (k: string) => { const b = new Uint8Array(165); b.set(base58.decode(k), 0); b.set(base58.decode(w), 32); b[64] = 1; b[108] = 1; return { data: [base64.encode(b), "base64"], executable: false, lamports: 2_039_280, owner: SOLANA_TOKEN_PROGRAM, rentEpoch: 0, space: 165 }; };
  let x: string | null = null;
  const groups: Record<"A" | "B", string[][]> = { A: [], B: [] };
  const wrap = (p: (typeof d.providers)[number], at: "A" | "B") => Object.assign(async (method: string, params: readonly unknown[]) => {
    const back = simAddresses(method, params);
    if (back?.[0] === w) groups[at].push(back);
    if (back?.[0] === w && back.length === 3 && x && back.includes(x)) {
      // the recorded [wallet, wSOL] read-back, with X read back as the planted account
      const two = (await p(method, [params[0], { ...(params[1] as object), accounts: { addresses: [w, WSOL_HELD.account], encoding: "base64" } }])) as { value: { accounts: unknown[] } };
      two.value.accounts = back.map((k) => (k === w ? two.value.accounts[0] : k === x ? fake(k) : two.value.accounts[1]));
      return two;
    }
    const out = await p(method, params);
    if (method === "getMultipleAccounts") {
      const keys = params[0] as string[];
      const iw = keys.indexOf(WSOL_HELD.account);
      if (!x && keys.length > 5 && keys.includes(w) && iw >= 0) x = keys.slice(iw + 1).find((k) => !not.has(k)) ?? null;
      if (x) keys.forEach((k, i) => { if (k === x) (out as { value: unknown[] }).value[i] = fake(k); });
    }
    return out;
  }, { asks: p.asks, times: p.times });
  const r = await runSolanaTrade(req, { ...d, providers: [wrap(d.providers[0], "A"), wrap(d.providers[1], "B")] });
  assert.ok(x, "no written account after the wSOL account to plant");
  const leg = r.legs.find((l) => l.wallet === w)!;
  assert.equal(leg.simulationErrors, undefined, String(leg.simulationErrors));
  for (const at of ["A", "B"] as const) {
    const g = groups[at].filter((b) => b.length === 2 || b.length === 3).map((b) => b.join(","));
    assert.equal(g.filter((b) => b === `${w},${WSOL_HELD.account}`).length, 1, `${at}: the early run alone, dropped`);
    assert.equal(g.filter((b) => b.split(",").length === 3 && b.includes(WSOL_HELD.account) && b.includes(x!)).length, 1, `${at}: the wallet read back with both, once: ${g.join(" | ")}`);
  }
});
