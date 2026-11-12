// Every request the positions make on the mainnet build (card signpage-state-holdings, review P1-1): the page's own
// transport, the finder on the helper's keyed route and the page's two Solana RPCs (PublicNode and the helper), each
// request logged as it leaves. Across a load, a W whose read fails and its retry, the helper down, the public RPC down
// and a reload, with a token a stranger sent to a W on it:
// - no request to any host but the helper's keyed route names a W or a W's token account;
// - no request names a W with no buy record on this device, nor a mint no buy record names;
// - a mint whose buy record names its decimals is never asked for, and one from before decimals were kept is asked
//   once, on the helper's keyed route only (never PublicNode), then never again (the kept pass names them).
//   node --test test/positions-requests.test.ts
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { base58, base64 } from "@scure/base";
import { IDBFactory } from "fake-indexeddb";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import { solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import { HOLDINGS_THROTTLE_MAX_MS } from "../../wallet/src/pool/buy-wallets.ts";
import { POOL_TESTNET } from "../../wallet/src/pool/network.ts";
import { solanaAta } from "../../kit/src/checks/solana/message.ts";
import { onTestClock } from "../../kit/test/test-clock.ts";
import { SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import { POSITION_COSTS_KEY, type Position } from "../src/positions.ts";
import { testnetPool } from "../src/pool-testnet.ts";
import { poolSellKind } from "../src/pool-sell.ts";
import { BUY_NONE_KEY, solBuyRecords } from "../src/sol-buy-records.ts";
import { TRADE_HELPER } from "../src/trade.ts";

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const PIN = { program: "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8", feePayer: "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb" };
// the Solana pool's page alone: no EVM pool is pinned here (SIGN_HOST's build pins Base's and Robinhood's since card
// evm-pools-on-mainnet, whose passes would add their own timers and state reads to the ones this file counts)
const NO_EVM = (): undefined => undefined;
const SCOPE = solanaPoolOf(PIN.program).scope;
const key = (b: number) => base58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? b : i === 0 ? 9 : 0)));
const BOUGHT = key(7); // W0's buy, its record naming its decimals
const OLD = key(9); // W1's buy, its record from before decimals were kept
const STRANGER = key(8); // sent to W0 by anyone: no buy record
const HELPER_RPC = `${new URL(TRADE_HELPER).host}/v1/rpc/solana`;
const realFetch = globalThis.fetch;
after(() => void (globalThis.fetch = realFetch));

test("the positions on the mainnet build: no request names a W to any host but the helper's keyed route, none names a W or a mint no buy record names, and a load asks no decimals a buy record or the kept pass names", { timeout: 300_000 }, () => onTestClock(async () => {
  assert.equal(POOL_TESTNET, false, "the mainnet build");
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  after(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  const Ws: string[] = [];
  for (let i = 0; i < 3; i++) {
    const ref = { kind: "deposit" as const, s: SCOPE, i };
    const pre = noteSecrets(SEED64, ref).precommitment;
    const label = BigInt(77 + i);
    const r = await ns.add({ ref, scope: SCOPE, precommitment: pre, state: "UNSPENT", leaf: { value: 10_000_000n, label, commitment: noteCommitment(10_000_000n, label, pre), leafIndex: BigInt(i) } });
    await ns.move(r.id, "UNSPENT", "SPENT");
    const fw = freshWallet(SEED64, "sol", label, jOf(ref));
    fw.secretKey.fill(0);
    Ws.push(fw.address);
  }
  ns.close();
  // W0 and W1 bought; W2 (a spent note's W) has no buy record on this device
  await w.put("meta", POSITION_COSTS_KEY, { [Ws[0]!]: { mint: BOUGHT, received: "5", decimals: 6 }, [Ws[1]!]: { mint: OLD, received: "3" } });
  const names = new Map<string, string>([[BOUGHT, "BOUGHT"], [OLD, "OLD"], [STRANGER, "STRANGER"]]);
  Ws.forEach((a, i) => {
    names.set(a, `W${i}`);
    for (const m of [BOUGHT, OLD, STRANGER]) for (const p of [SOLANA_TOKEN_PROGRAM, SOLANA_TOKEN_2022_PROGRAM]) names.set(solanaAta(a, m, p), `ATA(W${i})`);
  });
  const tokenAccount = (mint: string, owner: string, amount: bigint): string => {
    const d = new Uint8Array(165);
    d.set(base58.decode(mint), 0);
    d.set(base58.decode(owner), 32);
    new DataView(d.buffer).setBigUint64(64, amount, true);
    d[108] = 1;
    return base64.encode(d);
  };
  const mintData = new Uint8Array(82);
  mintData[44] = 6;
  mintData[45] = 1;
  const mode = { failW: "", helperDown: false, publicDown: false };
  let phase = "";
  const log: { phase: string; to: string; method: string; names: string[] }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const b = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown[] };
    const to = `${u.host}${u.pathname}`;
    // every name the request carries, anywhere in its body
    const said = [...names].filter(([k]) => String(init?.body).includes(k)).map(([, v]) => v);
    log.push({ phase, to, method: b.method, names: said });
    const isHelper = u.host === new URL(TRADE_HELPER).host;
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    if ((isHelper && mode.helperDown) || (!isHelper && mode.publicDown)) return new Response("down", { status: 500 });
    if (b.params[0] === mode.failW) return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, error: { code: -32000, message: "no" } }), { status: 200 });
    if (b.method === "getBalance") return ok({ context: { slot: 100 }, value: 5000 });
    if (b.method === "getTokenAccountsByOwner") {
      const owner = b.params[0] as string;
      const prog = (b.params[1] as { programId: string }).programId;
      const held = owner === Ws[0] ? [BOUGHT, STRANGER] : owner === Ws[1] ? [OLD] : [];
      const value = prog === SOLANA_TOKEN_PROGRAM ? held.map((m) => ({ pubkey: solanaAta(owner, m, SOLANA_TOKEN_PROGRAM), account: { owner: prog, lamports: 1, data: [tokenAccount(m, owner, 4_000_000n), "base64"] } })) : [];
      return ok({ context: { slot: 100 }, value });
    }
    if (b.method === "getAccountInfo") return ok({ context: { slot: 100 }, value: { owner: SOLANA_TOKEN_PROGRAM, lamports: 1, data: [base64.encode(mintData), "base64"] } });
    // each W's asset_held read (card portfolio-counts-money-an-open-buy-holds): W and its bought token account
    if (b.method === "getMultipleAccounts") {
      const keys = b.params[0] as string[];
      return ok({ context: { slot: 100 }, value: keys.map((k) => (Ws.includes(k) ? { lamports: 5000, owner: "11111111111111111111111111111111", data: ["", "base64"] } : keys.indexOf(k) % 5 === 1 && names.get(k)?.startsWith("ATA") ? { lamports: 2_039_280, owner: SOLANA_TOKEN_PROGRAM, data: ["", "base64"] } : null)) });
    }
    return ok(null);
  }) as typeof fetch;

  const timers: (() => void)[] = [];
  const make = () => testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { pin: PIN, evmPin: NO_EVM, positions: { setTimer: (f: () => void) => (timers.push(f), f), clearTimer: (t: unknown) => void timers.splice(timers.indexOf(t as () => void) >>> 0, timers.includes(t as () => void) ? 1 : 0) } } as never);
  type Tp = ReturnType<typeof make>;
  const show = (p: readonly Position[] | null) => p?.map((x) => [names.get(x.token), x.amount, x.wallets.map((a) => names.get(a))]);
  const until = async (f: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 1_200 && !(await f()); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(await f(), phase);
  };
  const settled = async (tp: Tp, want: unknown) => until(async () => JSON.stringify(show(await tp.positions())) === JSON.stringify(want));
  const both = [["BOUGHT", "4", ["W0"]], ["OLD", "4", ["W1"]]];

  phase = "1 a load";
  let tp = make();
  await tp.positions();
  await settled(tp, both);
  // each W's SOL beside its token, read on the helper's keyed route (the log's checks below): W's 5,000 and its token
  // account's 2,039,280
  assert.deepEqual((await tp.positions())?.map((p) => p.asset_held), ["0.00204428", "0.00204428"]);
  phase = "2 W1's read fails, and its retry";
  mode.failW = Ws[1]!;
  timers.length = 0;
  tp = make();
  assert.deepEqual(show(await tp.positions()), both, "the kept pass at once");
  await until(() => timers.length > 0);
  timers.shift()!();
  await until(() => timers.length > 0);
  assert.deepEqual(show(await tp.positions()), both, "W1 keeps its last");
  mode.failW = "";
  phase = "3 the helper down";
  mode.helperDown = true;
  timers.length = 0;
  tp = make();
  assert.deepEqual(show(await tp.positions()), both);
  await until(() => timers.length > 0);
  assert.deepEqual(show(await tp.positions()), both, "every W keeps its last");
  mode.helperDown = false;
  phase = "4 the public RPC down";
  mode.publicDown = true;
  timers.length = 0;
  tp = make();
  await tp.positions();
  await until(() => log.filter((l) => l.phase === phase && l.method === "getTokenAccountsByOwner").length >= 4);
  await tp.positions();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(show(await tp.positions()), both, "no decimals to read: the positions stand");
  mode.publicDown = false;

  const at = (l: (typeof log)[number]) => `${l.phase} | ${l.to} | ${l.method} | ${l.names.join(",")}`;
  const wallet = log.filter((l) => l.to !== HELPER_RPC && l.names.some((n) => n.startsWith("W") || n.startsWith("ATA")));
  assert.deepEqual(wallet.map(at), [], "no W or W's token account named to a host but the helper's keyed route");
  assert.deepEqual(log.filter((l) => l.names.includes("W2") || l.names.includes("ATA(W2)")).map(at), [], "the W with no buy record is never read");
  assert.deepEqual(log.filter((l) => l.names.includes("STRANGER")).map(at), [], "the stranger's mint is named nowhere");
  assert.deepEqual(log.filter((l) => l.names.includes("BOUGHT")).map(at), [], "a mint whose record names its decimals is never asked for");
  const old = log.filter((l) => l.names.includes("OLD")).map((l) => `${l.phase} | ${l.to} | ${l.method}`);
  assert.deepEqual(old, [`1 a load | ${HELPER_RPC} | getAccountInfo`], "a record from before decimals were kept: its mint once, on the helper's keyed route only, then the kept pass names them");
  assert.ok(log.some((l) => l.to === HELPER_RPC && l.names.includes("W0")), "the finder read the Ws (a sanity check of the log)");
}));

// The second review's request log (of c5a61ca5), on the same transport: account A's load, a buy that wrote no buy record
// (W's buy mint only, its run told no amount), a sell's read and end, a sign out while a pass reads, then account B on
// the same tab. Every request the page makes in it is logged:
// - none names a W, a W's token account or a mint only this device's buys name to any host but the helper's keyed route;
// - none names a stranger's mint (one sent to a W) anywhere;
// - none names account A's Ws, token accounts or mints once B signed in.
test("the positions across a buy with no record, a sell, a sign out mid-pass and the next account: no W, token account or bought mint named past the helper's keyed route, no stranger's mint anywhere, nothing of A's after B signs in", { timeout: 600_000 }, () => onTestClock(async () => {
  assert.equal(POOL_TESTNET, false, "the mainnet build");
  const NEW = key(11); // bought into A's W3 during the test, its run telling no amount
  const BMINT = key(12); // account B's buy
  const S2 = key(10); // a stranger's token on A's W2 (no buy of this device's)
  const SB = key(13); // a stranger's token on B's X0
  const ENT_B = new Uint8Array(16).fill(1);
  const SEED_B = wordsToSeed64(entropyToWords(ENT_B));
  const account = async (entropy: Uint8Array, seed: Uint8Array, n: number) => {
    const w = await openWalletStore({ indexedDB: new IDBFactory() });
    await w.insertSeed({ v: 1, entropy: entropy.slice(), source: "code", code_saved: true, created_ms: 1 });
    const ns = await openNoteStore(w);
    const Ws: string[] = [];
    for (let i = 0; i < n; i++) {
      const ref = { kind: "deposit" as const, s: SCOPE, i };
      const pre = noteSecrets(seed, ref).precommitment;
      const label = BigInt(77 + i);
      const r = await ns.add({ ref, scope: SCOPE, precommitment: pre, state: "UNSPENT", leaf: { value: 10_000_000n, label, commitment: noteCommitment(10_000_000n, label, pre), leafIndex: BigInt(i) } });
      await ns.move(r.id, "UNSPENT", "SPENT");
      const fw = freshWallet(seed, "sol", label, jOf(ref));
      fw.secretKey.fill(0);
      Ws.push(fw.address);
    }
    ns.close();
    return { w, Ws };
  };
  const A = await account(new Uint8Array(16), SEED64, 4);
  // B's store opens after A signs out, as on a page: a sign out tells every open store of the wallet's database to close
  let B: Awaited<ReturnType<typeof account>> | null = null;
  let between: WalletStore | null = null;
  after(() => (A.w.close(), between?.close(), B?.w.close()));
  // A: W0 bought BOUGHT (its record names the decimals), W1 bought OLD (a record from before decimals), W2 holds a
  // stranger's token only, W3 buys NEW below; B: X0 bought BMINT and holds a stranger's token, X1 nothing
  await A.w.put("meta", POSITION_COSTS_KEY, { [A.Ws[0]!]: { mint: BOUGHT, received: "5", decimals: 6 }, [A.Ws[1]!]: { mint: OLD, received: "3" } });
  await A.w.put("meta", "owed/buy-sol", { [A.Ws[0]!]: { mint: BOUGHT, program: SOLANA_TOKEN_PROGRAM }, [A.Ws[1]!]: { mint: OLD, program: SOLANA_TOKEN_PROGRAM } });
  const names = new Map<string, string>([[BOUGHT, "BOUGHT"], [OLD, "OLD"], [NEW, "NEW"], [BMINT, "BMINT"], [STRANGER, "S0"], [S2, "S2"], [SB, "SB"]]);
  const mints = [...names.keys()];
  const nameWs = (Ws: string[], who: string) =>
    Ws.forEach((a, i) => {
      names.set(a, `${who}${i}`);
      for (const m of mints) for (const p of [SOLANA_TOKEN_PROGRAM, SOLANA_TOKEN_2022_PROGRAM]) names.set(solanaAta(a, m, p), `ATA(${who}${i})`);
    });
  nameWs(A.Ws, "A.W");
  const holds = new Map<string, [string, bigint][]>([
    [A.Ws[0]!, [[BOUGHT, 4_000_000n], [STRANGER, 1n]]],
    [A.Ws[1]!, [[OLD, 4_000_000n]]],
    [A.Ws[2]!, [[S2, 9n]]],
    [A.Ws[3]!, []],
  ]);
  const tokenAccount = (mint: string, owner: string, amount: bigint): string => {
    const d = new Uint8Array(165);
    d.set(base58.decode(mint), 0);
    d.set(base58.decode(owner), 32);
    new DataView(d.buffer).setBigUint64(64, amount, true);
    d[108] = 1;
    return base64.encode(d);
  };
  const mintData = (dec: number) => {
    const m = new Uint8Array(82);
    m[44] = dec;
    m[45] = 1;
    return base64.encode(m);
  };
  let phase = "";
  let signedInB = false;
  const log: { phase: string; b: boolean; to: string; method: string; names: string[] }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const body = String(init?.body ?? "");
    const b = JSON.parse(body) as { id: string; method: string; params: unknown[] };
    const said = [...names].filter(([k]) => `${String(url)} ${body}`.includes(k)).map(([, v]) => v);
    log.push({ phase, b: signedInB, to: `${u.host}${u.pathname}`, method: b.method, names: said });
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    if (b.method === "getBalance") return ok({ context: { slot: 100 }, value: 5000 });
    if (b.method === "getTokenAccountsByOwner") {
      const owner = b.params[0] as string;
      const prog = (b.params[1] as { programId: string }).programId;
      const value = prog === SOLANA_TOKEN_PROGRAM ? (holds.get(owner) ?? []).map(([m, a]) => ({ pubkey: solanaAta(owner, m, SOLANA_TOKEN_PROGRAM), account: { owner: prog, lamports: 1, data: [tokenAccount(m, owner, a), "base64"] } })) : [];
      return ok({ context: { slot: 100 }, value });
    }
    if (b.method === "getAccountInfo") return ok({ context: { slot: 100 }, value: { owner: SOLANA_TOKEN_PROGRAM, lamports: 1, data: [mintData(b.params[0] === NEW ? 9 : 6), "base64"] } });
    return ok(null);
  }) as typeof fetch;

  let cur: WalletStore = A.w;
  let seed: Uint8Array | null = SEED64;
  let sellEnd: (() => void) | null = null;
  let sellRead: Promise<unknown> = Promise.resolve();
  // the buy as runPoolBuy runs it: W's buy mint written before its send; then a fill whose amount it could not tell
  // the host ended at the run's end, as poolBuyKind and poolSellKind end theirs (card signpage-passes-yield-to-a-trade:
  // a host holds the page's hosts for the trade until then)
  const buy = (host: () => { bought?: { put(a: string, m: { mint: string; program: string }): Promise<void> }; end?(): void }) => (_ask: unknown, ctx: { route(r: unknown): void; progress(s: string): void }) => {
    const ran = (async () => {
      const h = host();
      try {
        await h.bought!.put(A.Ws[3]!, { mint: NEW, program: SOLANA_TOKEN_PROGRAM });
        ctx.route({ wallet: A.Ws[3]! });
        holds.set(A.Ws[3]!, [[NEW, 2_500_000_000n]]);
      } finally {
        h.end?.();
      }
      ctx.progress("filled");
    })();
    return { running: true as const, after: ran, answer: () => ({ result: { stage: "filled", txs: [] } }) };
  };
  const sell = (host: () => { wallets(): Promise<unknown>; end?(): void }) => () => {
    const h = host();
    sellRead = h.wallets().catch(() => {});
    return { running: true as const, after: new Promise<void>((r) => (sellEnd = () => (h.end?.(), r()))), answer: () => ({ result: { stage: "filled", txs: [] } }) };
  };
  const tp = testnetPool(
    { store: async () => cur, seed64: async () => (seed === null ? Promise.reject(new Error("no seed is stored")) : seed.slice()) },
    { pin: PIN, evmPin: NO_EVM, table: "6bbfV79efN889c4iRTSTf4htv6EnurCJuz5CjMftjsyZ", tradeKinds: { buy, sell }, positions: { setTimer: () => 0, clearTimer: () => {} } } as never,
  );
  const show = (p: readonly Position[] | null) => p?.map((x) => `${names.get(x.token)}=${x.amount}@${x.wallets.map((a) => names.get(a)).join("+")}`).sort();
  const until = async (f: () => boolean | Promise<boolean>, what: () => Promise<string> = async () => "") => {
    for (let i = 0; i < 1_200 && !(await f()); i++) await new Promise((r) => setTimeout(r, 50));
    if (!(await f())) assert.fail(`${phase}: ${await what()}`);
  };
  const settled = (want: string[]) => until(async () => JSON.stringify(show(await tp.positions())) === JSON.stringify([...want].sort()), async () => `${want} (shown ${JSON.stringify(show(await tp.positions()))}; requests since B: ${JSON.stringify(log.filter((l) => l.b).map((l) => `${l.method} ${l.names}`))})`);

  phase = "1 a load";
  await tp.positions();
  await settled(["BOUGHT=4@A.W0", "OLD=4@A.W1"]);
  phase = "2 a buy that wrote no buy record";
  tp.flow({ kind: "pool.buy", chain: "solana", token: NEW, amount: 1n, slippageBps: 100, decimals: 9 } as never, { id: "b1", sha: "00", progress: () => {}, route: () => {} } as never);
  await settled(["BOUGHT=4@A.W0", "OLD=4@A.W1", "NEW=2.5@A.W3"]);
  phase = "3 a sell's read and end";
  tp.flow({ kind: "pool.sell", chain: "solana", token: BOUGHT, amount: 1n, slippageBps: 100, decimals: 6 } as never, { id: "s1", sha: "00", progress: () => {} } as never);
  await sellRead;
  holds.set(A.Ws[0]!, [[BOUGHT, 1_000_000n], [STRANGER, 1n]]);
  sellEnd!();
  await settled(["BOUGHT=1@A.W0", "OLD=4@A.W1", "NEW=2.5@A.W3"]);
  phase = "4 a sign out while a pass reads";
  tp.flow({ kind: "pool.sell", chain: "solana", token: BOUGHT, amount: 1n, slippageBps: 100, decimals: 6 } as never, { id: "s2", sha: "00", progress: () => {} } as never);
  await sellRead;
  const at = log.length;
  sellEnd!();
  await until(() => log.slice(at).some((l) => l.method === "getBalance"));
  await A.w.signOut();
  seed = null;
  cur = between = await openWalletStore({ indexedDB: new IDBFactory() });
  await tp.signedOut();
  phase = "5 account B signs in on the same tab";
  B = await account(ENT_B, SEED_B, 2);
  await B.w.put("meta", "owed/buy-sol", { [B.Ws[0]!]: { mint: BMINT, program: SOLANA_TOKEN_PROGRAM } });
  nameWs(B.Ws, "B.X");
  holds.set(B.Ws[0]!, [[BMINT, 1_000_000n], [SB, 2n]]);
  holds.set(B.Ws[1]!, []);
  cur = B.w;
  seed = SEED_B;
  signedInB = true;
  await tp.positions();
  await settled(["BMINT=1@B.X0"]);
  await new Promise((r) => setTimeout(r, 4_000));

  const row = (l: (typeof log)[number]) => `${l.phase} | ${l.to} | ${l.method} | ${l.names.join(",")}`;
  const isW = (n: string) => /^(A\.W|B\.X|ATA)/.test(n);
  assert.deepEqual(log.filter((l) => l.to !== HELPER_RPC && l.names.some((n) => isW(n) || ["BOUGHT", "OLD", "NEW", "BMINT"].includes(n))).map(row), [], "no W, token account or bought mint past the helper's keyed route");
  assert.deepEqual(log.filter((l) => l.names.some((n) => ["S0", "S2", "SB"].includes(n))).map(row), [], "no stranger's mint anywhere");
  assert.deepEqual(log.filter((l) => l.b && l.names.some((n) => n.startsWith("A.") || n.includes("(A.") || ["BOUGHT", "OLD", "NEW"].includes(n))).map(row), [], "nothing of A's after B signed in");
  assert.ok(log.some((l) => l.phase.startsWith("2") && l.names.includes("NEW") && l.method === "getAccountInfo"), "the buy with no record: its mint's decimals read once, on the helper's keyed route (a sanity check of the log)");
  assert.ok(log.some((l) => l.b && l.names.includes("B.X0")), "B's Ws read (a sanity check of the log)");
}));

// The review of 8522bdf8, F3: the positions pass reads its Ws under one bound from the list's start, as a sell's read
// does (pool-testnet.ts recordedWallets passes the list's `by` on): five Ws on a helper that answers 429 for good end
// within HOLDINGS_THROTTLE_MAX_MS of the pass's start, never one bound a W (5 x 30 s).
test("the positions pass on a helper that throttles for good ends within the list's bound from its start, however many Ws it reads", { timeout: 300_000 }, () => onTestClock(async () => {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  after(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  const costs: Record<string, { mint: string; received: string; decimals: number }> = {};
  for (let i = 0; i < 5; i++) {
    const ref = { kind: "deposit" as const, s: SCOPE, i };
    const pre = noteSecrets(SEED64, ref).precommitment;
    const label = BigInt(177 + i);
    const r = await ns.add({ ref, scope: SCOPE, precommitment: pre, state: "UNSPENT", leaf: { value: 10_000_000n, label, commitment: noteCommitment(10_000_000n, label, pre), leafIndex: BigInt(i) } });
    await ns.move(r.id, "UNSPENT", "SPENT");
    const fw = freshWallet(SEED64, "sol", label, jOf(ref));
    fw.secretKey.fill(0);
    costs[fw.address] = { mint: BOUGHT, received: "5", decimals: 6 };
  }
  ns.close();
  await w.put("meta", POSITION_COSTS_KEY, costs);
  const named = new Set(Object.keys(costs));
  // a timer at the bound from the list's first read (its start: readDerived takes its bound just before it), on the
  // test clock: a read after it fires is one past the list's bound
  let past = false, asked = 0, late = 0;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown[] };
    if (named.has(b.params[0] as string)) {
      if (asked++ === 0) setTimeout(() => (past = true), HOLDINGS_THROTTLE_MAX_MS);
      if (past) late++;
    }
    return new Response("slow down", { status: 429 });
  }) as typeof fetch;
  const timers: (() => void)[] = [];
  const tp = testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { pin: PIN, evmPin: NO_EVM, positions: { setTimer: (f: () => void) => (timers.push(f), f), clearTimer: () => {} } } as never);
  await tp.positions();
  // the pass ends when it sets its retry; a W's read past the list's bound would keep it going for minutes
  for (let i = 0; i < 4_000 && timers.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(timers.length > 0, "the pass ended");
  assert.ok(asked > 0, "the pass asked");
  assert.equal(late, 0, `${late} of ${asked} reads past the list's bound of ${HOLDINGS_THROTTLE_MAX_MS} ms from its first read`);
}));

// Card restore-rebuilds-buy-records: a device restored from the 12 words holds the notes (so the Ws) and no buy record.
// Each W's buy record comes back from its own buy, read on the helper's keyed route, one W a request: W0 bought BOUGHT
// and holds it with a stranger's token beside it, W1 bought OLD and sold it whole, W2 holds only a stranger's token
// (its history: that send alone). Every request is logged.
test("a restored device: each W's buy record back from its own buy on the helper's keyed route, one W a request, so the positions show what it bought and holds; a stranger's token, a sold W and a W with no buy show nothing; a run cut short resumes and never replaces a record", { timeout: 600_000 }, () => onTestClock(async () => {
  assert.equal(POOL_TESTNET, false, "the mainnet build");
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  after(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  const Ws: string[] = [];
  for (let i = 0; i < 4; i++) {
    const ref = { kind: "deposit" as const, s: SCOPE, i };
    const pre = noteSecrets(SEED64, ref).precommitment;
    const label = BigInt(277 + i);
    const r = await ns.add({ ref, scope: SCOPE, precommitment: pre, state: "UNSPENT", leaf: { value: 10_000_000n, label, commitment: noteCommitment(10_000_000n, label, pre), leafIndex: BigInt(i) } });
    await ns.move(r.id, "UNSPENT", "SPENT");
    const fw = freshWallet(SEED64, "sol", label, jOf(ref));
    fw.secretKey.fill(0);
    Ws.push(fw.address);
  }
  ns.close();
  const names = new Map<string, string>([[BOUGHT, "BOUGHT"], [OLD, "OLD"], [STRANGER, "STRANGER"]]);
  Ws.forEach((a, i) => {
    names.set(a, `W${i}`);
    for (const m of [BOUGHT, OLD, STRANGER]) for (const p of [SOLANA_TOKEN_PROGRAM, SOLANA_TOKEN_2022_PROGRAM]) names.set(solanaAta(a, m, p), `ATA(W${i})`);
  });
  const tokenAccount = (mint: string, owner: string, amount: bigint): string => {
    const d = new Uint8Array(165);
    d.set(base58.decode(mint), 0);
    d.set(base58.decode(owner), 32);
    new DataView(d.buffer).setBigUint64(64, amount, true);
    d[108] = 1;
    return base64.encode(d);
  };
  const mintData = new Uint8Array(82);
  mintData[44] = 6;
  mintData[45] = 1;
  // W's transactions as getTransaction answers them (json): W's buy signed by W and the fee payer, the pinned pool's tag 3
  // naming W; a stranger's send signed by the stranger
  const FEE = PIN.feePayer, SENDER = key(20);
  const bal = (accountIndex: number, mint: string, owner: string, amount: string) => ({ accountIndex, mint, owner, programId: SOLANA_TOKEN_PROGRAM, uiTokenAmount: { amount, decimals: 6 } });
  const buyOf = (W: string, mint: string) => ({ slot: 5, meta: { err: null, preTokenBalances: [], postTokenBalances: [bal(3, mint, W, "4000000")] }, transaction: { message: { header: { numRequiredSignatures: 2 }, accountKeys: [FEE, W, PIN.program, solanaAta(W, mint, SOLANA_TOKEN_PROGRAM)], instructions: [{ programIdIndex: 2, accounts: [2, 1, 0], data: base58.encode(Uint8Array.of(3, 9, 9)) }] } } });
  // the pool's plain release naming W (tag 2): W's note spent with no buy
  const releaseOf = (W: string) => ({ slot: 4, meta: { err: null, preTokenBalances: [], postTokenBalances: [] }, transaction: { message: { header: { numRequiredSignatures: 2 }, accountKeys: [FEE, W, PIN.program], instructions: [{ programIdIndex: 2, accounts: [2, 1, 0], data: base58.encode(Uint8Array.of(2, 9, 9)) }] } } });
  const sendOf = (W: string, mint: string) => ({ slot: 6, meta: { err: null, preTokenBalances: [], postTokenBalances: [bal(2, mint, W, "7")] }, transaction: { message: { header: { numRequiredSignatures: 1 }, accountKeys: [SENDER, W, solanaAta(W, mint, SOLANA_TOKEN_PROGRAM)], instructions: [] } } });
  // newest first, as getSignaturesForAddress answers; a signature names no W
  const history = new Map<string, { signature: string; err: null; tx: unknown }[]>([
    [Ws[0]!, [{ signature: "s0drop", err: null, tx: sendOf(Ws[0]!, STRANGER) }, { signature: "s0buy", err: null, tx: buyOf(Ws[0]!, BOUGHT) }]],
    [Ws[1]!, [{ signature: "s1sell", err: null, tx: null }, { signature: "s1buy", err: null, tx: buyOf(Ws[1]!, OLD) }]],
    [Ws[2]!, [{ signature: "s2drop", err: null, tx: sendOf(Ws[2]!, STRANGER) }]],
    // W3's note went out in the pool's plain release, then a stranger's send: read for good, no buy (review of 42a99f81,
    // a; of ae2cfe28, P2: "none" only on the pool's own release)
    [Ws[3]!, [{ signature: "s3drop", err: null, tx: sendOf(Ws[3]!, STRANGER) }, { signature: "s3rel", err: null, tx: releaseOf(Ws[3]!) }]],
  ]);
  const txs = new Map([...history.values()].flat().map((x) => [x.signature, x.tx] as const));
  const mode = { failTx: "", holdTx: "" };
  let release = (): void => {};
  const sentSigs: string[] = [];
  let phase = "";
  const log: { phase: string; to: string; method: string; names: string[] }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const b = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown[] };
    const to = `${u.host}${u.pathname}`;
    const said = [...names].filter(([k]) => String(init?.body).includes(k)).map(([, v]) => v);
    log.push({ phase, to, method: b.method, names: said });
    if (b.method === "getTransaction") sentSigs.push(`${phase} ${String(b.params[0])}`);
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    if (b.method === "getSignaturesForAddress") return ok((history.get(b.params[0] as string) ?? []).map(({ signature, err }) => ({ signature, err, slot: 5 })));
    if (b.method === "getTransaction") {
      if (b.params[0] === mode.holdTx) await new Promise<void>((r) => (release = r));
      if (b.params[0] === mode.failTx) return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, error: { code: -32000, message: "no" } }), { status: 200 });
      // as a route answers it: the signature its first, with a block time
      const t = txs.get(b.params[0] as string) as { transaction: object } | null | undefined;
      return ok(t ? { blockTime: 1_794_000_000, ...t, transaction: { signatures: [b.params[0]], ...t.transaction } } : null);
    }
    if (b.method === "getBalance") return ok({ context: { slot: 100 }, value: 5000 });
    if (b.method === "getTokenAccountsByOwner") {
      const owner = b.params[0] as string;
      const prog = (b.params[1] as { programId: string }).programId;
      const held = owner === Ws[0] ? [BOUGHT, STRANGER] : owner === Ws[2] ? [STRANGER] : [];
      const value = prog === SOLANA_TOKEN_PROGRAM ? held.map((m) => ({ pubkey: solanaAta(owner, m, SOLANA_TOKEN_PROGRAM), account: { owner: prog, lamports: 1, data: [tokenAccount(m, owner, 4_000_000n), "base64"] } })) : [];
      return ok({ context: { slot: 100 }, value });
    }
    if (b.method === "getAccountInfo") return ok({ context: { slot: 100 }, value: { owner: SOLANA_TOKEN_PROGRAM, lamports: 1, data: [base64.encode(mintData), "base64"] } });
    return ok(null);
  }) as typeof fetch;
  // the store while open (page.held); `closed`: another tab's sign out closed it
  let closed = false;
  let sellHost: Parameters<typeof poolSellKind>[0] | undefined;
  const make = () =>
    testnetPool(
      { store: async () => w, held: async () => (closed ? Promise.reject(new Error("no wallet store is open")) : w), seed64: async () => SEED64.slice() },
      { pin: PIN, positions: { setTimer: () => 0, clearTimer: () => {} }, tradeKinds: { sell: (mk: typeof sellHost) => ((sellHost = mk), poolSellKind(mk!)) } } as never,
    );
  const show = (p: readonly Position[] | null) => p?.map((x) => [names.get(x.token), x.amount, x.wallets.map((a) => names.get(a))]);
  const until = async (f: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 1_200 && !(await f()); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(await f(), phase);
  };
  // a transaction this phase asked for, by its signature
  const asked = (sig: string) => sentSigs.includes(`${phase} ${sig}`);
  const records = async () => (await w.get("meta", "owed/buy-sol")) as Record<string, { mint: string; program: string; rebuilt?: true }> | undefined;
  const asks = (sig: string) => sentSigs.filter((x) => x === `${phase} ${sig}`).length;

  // the test before this one leaves the helper route's finder throttled and in doubt (a provider throttling for good),
  // so its next read is refused without asking while the pause runs; the pause (10 s at most) waited out on the clock,
  // this test's first round goes and clears the doubt
  await new Promise((r) => setTimeout(r, 11_000));
  phase = "1 the load after the restore, W1's buy unread (the route down for it)";
  mode.failTx = "s1buy";
  let tp = make();
  await tp.positions();
  await tp.settle();
  await until(async () => JSON.stringify(show(await tp.positions())) === JSON.stringify([["BOUGHT", "4", ["W0"]]]));
  // every W of the run read: its end (W1's read failed, so it keeps none)
  await until(() => asked("s0buy") && asked("s1buy") && asked("s2drop") && asked("s3rel"));
  await until(async () => (await w.get("meta", BUY_NONE_KEY)) !== undefined);
  assert.deepEqual(await records(), { [Ws[0]!]: { mint: BOUGHT, program: SOLANA_TOKEN_PROGRAM, rebuilt: true } }, "W0's record back, marked rebuilt; W1's read failed and W2 has no buy: none");
  assert.deepEqual(await w.get("meta", BUY_NONE_KEY), { [Ws[3]!]: true }, "W3 read for good with no buy; W2's one send and W1's failed read get no mark");
  // W2 no answer: read once this page load, a later state read's run included; W1's failed read is read again
  await tp.settle();
  await until(() => sentSigs.filter((x) => x === `${phase} s1buy`).length === 2);
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(log.filter((l) => l.phase === phase && l.method === "getSignaturesForAddress").map((l) => l.names.join()).sort(), ["W0", "W1", "W1", "W2", "W3"], "W2 once a load; W1 again after its failure");
  phase = "1b a sign out while W1's buy is read: nothing written after it";
  mode.failTx = "";
  mode.holdTx = "s1buy";
  tp = make();
  await tp.settle();
  await until(() => asked("s1buy"));
  await tp.signedOut();
  release();
  mode.holdTx = "";
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal((await records())?.[Ws[1]!], undefined, "W1's buy read after the sign out wrote nothing");
  phase = "1c this tab's sign out at its tap (signingOut) while W1's buy is read: nothing written after it";
  mode.holdTx = "s1buy";
  tp = make();
  await tp.settle();
  await until(() => asked("s1buy"));
  tp.signingOut();
  release();
  mode.holdTx = "";
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal((await records())?.[Ws[1]!], undefined, "W1's buy read after this tab's sign out wrote nothing");
  phase = "1d another tab's sign out closed the store while W1's buy is read: the write never reaches a store made afresh";
  mode.holdTx = "s1buy";
  tp = make();
  await tp.settle();
  await until(() => asked("s1buy"));
  closed = true;
  release();
  mode.holdTx = "";
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal((await records())?.[Ws[1]!], undefined, "no write through a closed store");
  await tp.signedOut();
  closed = false;
  phase = "2 the next load reads W1 (and W2, still with none) again, and never W0";
  mode.failTx = "";
  await w.update("meta", "owed/buy-sol", (v) => ({ ...(v as object), [Ws[0]!]: { mint: BOUGHT, program: "kept as this device wrote it" } }));
  tp = make();
  await tp.positions();
  await tp.settle();
  await until(async () => (await records())?.[Ws[1]!] !== undefined);
  assert.deepEqual(await records(), { [Ws[0]!]: { mint: BOUGHT, program: "kept as this device wrote it" }, [Ws[1]!]: { mint: OLD, program: SOLANA_TOKEN_PROGRAM, rebuilt: true } }, "W1's record back as sold whole (its buy's); W0's never replaced");
  await until(async () => JSON.stringify(show(await tp.positions())) === JSON.stringify([["BOUGHT", "4", ["W0"]]]));
  // the Ws are read in a random order: W2's read may come after W1's record
  await until(() => log.some((l) => l.phase === phase && l.method === "getSignaturesForAddress" && l.names.includes("W2")));
  assert.deepEqual(log.filter((l) => l.phase === phase && l.method === "getSignaturesForAddress").map((l) => l.names).sort(), [["W1"], ["W2"]], "W3's mark: never read again");
  phase = "3 a buy on this device writes W1's record while the run reads W1: the run never replaces it";
  await w.update("meta", "owed/buy-sol", (v) => {
    const all = { ...(v as Record<string, unknown>) };
    delete all[Ws[1]!];
    return all;
  });
  mode.holdTx = "s1buy";
  tp = make();
  await tp.settle();
  await until(() => asked("s1buy"));
  await w.update("meta", "owed/buy-sol", (v) => ({ ...(v as object), [Ws[1]!]: { mint: OLD, program: "this device's buy" } }));
  release();
  mode.holdTx = "";
  await until(() => asked("s2drop"));
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual((await records())?.[Ws[1]!], { mint: OLD, program: "this device's buy" }, "the record written meanwhile is kept");
  phase = "4 a sale's wallet read while the run reads W1: the run stops, writes nothing, and runs again after the sale";
  await w.update("meta", "owed/buy-sol", (v) => {
    const all = { ...(v as Record<string, unknown>) };
    delete all[Ws[1]!];
    return all;
  });
  // and W1's trades cursor (phase 2 read W1 to its sale's missing answer), so the run reads W1 from its buy again
  await w.update("meta", "owed/trades-sol-read", (v) => {
    const all = { ...(v as Record<string, unknown>) };
    delete all[Ws[1]!];
    return all;
  });
  mode.holdTx = "s1buy";
  tp = make();
  await tp.settle();
  await until(() => asked("s1buy"));
  const sale = sellHost!();
  const list = sale.wallets();
  // W1's answer comes while the sale reads: the stopped run's, never written
  release();
  mode.holdTx = "";
  await list;
  (sale as { end?: () => void }).end?.();
  await until(() => asks("s1buy") === 2);
  await until(async () => (await records())?.[Ws[1]!] !== undefined);
  assert.deepEqual((await records())?.[Ws[1]!], { mint: OLD, program: SOLANA_TOKEN_PROGRAM, rebuilt: true }, "W1 read again after the sale");
  phase = "5 a restore's notes written (the proofs call it makes) starts the rebuild, with no state read";
  await w.update("meta", "owed/buy-sol", (v) => {
    const all = { ...(v as Record<string, unknown>) };
    delete all[Ws[1]!];
    return all;
  });
  await w.update("meta", "owed/trades-sol-read", (v) => {
    const all = { ...(v as Record<string, unknown>) };
    delete all[Ws[1]!];
    return all;
  });
  tp = make();
  void tp.proofs().catch(() => {});
  await until(async () => (await records())?.[Ws[1]!] !== undefined);
  assert.ok(asked("s1buy"));

  const at = (l: (typeof log)[number]) => `${l.phase} | ${l.to} | ${l.method} | ${l.names.join(",")}`;
  assert.deepEqual(log.filter((l) => l.to !== HELPER_RPC && l.names.some((n) => n.startsWith("W") || n.startsWith("ATA"))).map(at), [], "no W or W's token account named to a host but the helper's keyed route");
  assert.deepEqual(log.filter((l) => new Set(l.names.filter((n) => /^W\d$/.test(n))).size > 1).map(at), [], "no request names two Ws");
  assert.deepEqual(log.filter((l) => l.names.includes("STRANGER")).map(at), [], "the stranger's mint is named nowhere");
  assert.ok(log.some((l) => l.method === "getSignaturesForAddress" && l.to === HELPER_RPC), "the history read on the helper's keyed route (a sanity check of the log)");
}));

// Review of 42a99f81 (b), P2: the rebuild alone, its deps faked. The Ws are read in a shuffled order; a sale's hold
// stops the run and it starts again once the last hold ends (each call's pass turn is the reader's: buy-wallets.test.ts).
// On the test clock: each read takes 1 s.
test("the buy records' rebuild: the Ws in a shuffled order, a sale's hold stops the run and it runs again after", () => onTestClock(async () => {
  const reads: string[] = [];
  const written = new Map<string, unknown>();
  const r = solBuyRecords({
    wallets: async () => ["a", "b", "c"],
    done: async () => new Set(written.keys()),
    write: async (a, buy) => (written.set(a, buy), buy !== "none"),
    reader: {
      read: async (a, signal) => {
        reads.push(a);
        await new Promise((x) => setTimeout(x, 1_000));
        signal?.throwIfAborted();
        return { mint: `M-${a}`, program: "P" };
      },
    },
    wrote: () => {},
    // always the first index: [a, b, c] becomes [b, c, a]
    pick: () => 0,
  });
  r.run();
  await r.idle();
  assert.deepEqual(reads, ["b", "c", "a"], "the shuffled order");
  // a sale's hold while a read is on: that read writes nothing; asked meanwhile, nothing runs; the hold's end runs again
  written.clear();
  reads.length = 0;
  r.run();
  await new Promise((x) => setTimeout(x, 10));
  assert.deepEqual(reads, ["b"]);
  const end = r.hold();
  r.run();
  await new Promise((x) => setTimeout(x, 5_000));
  assert.deepEqual(reads, ["b"], "nothing read while the sale holds the run");
  assert.equal(written.size, 0, "the stopped read wrote nothing");
  end();
  end();
  await new Promise((x) => setTimeout(x, 10));
  await r.idle();
  assert.deepEqual(reads, ["b", "b", "c", "a"], "the run again after the sale");
  assert.deepEqual([...written.keys()].sort(), ["a", "b", "c"]);
  // two sales: the run waits for the last
  written.clear();
  reads.length = 0;
  const e1 = r.hold(), e2 = r.hold();
  r.run();
  e1();
  await new Promise((x) => setTimeout(x, 10));
  assert.deepEqual(reads, [], "one sale still reads");
  e2();
  await r.idle();
  assert.equal(reads.length, 3);
  // review of ae2cfe28, P2: a W the reader cannot tell (null) is read once a page load, never again at a later run or a
  // run after a sale; a failed read is read again at the next run; a sign-in after a sign out reads it again
  const asks: string[] = [];
  const once = solBuyRecords({
    wallets: async () => ["n", "f"],
    done: async () => new Set(),
    write: async () => true,
    reader: { read: async (a) => (asks.push(a), a === "f" ? Promise.reject(new Error("down")) : null) },
    wrote: () => {},
  });
  for (let i = 0; i < 3; i++) {
    once.run();
    await once.idle();
  }
  const e4 = once.hold();
  once.run();
  e4();
  await once.idle();
  assert.deepEqual([asks.filter((a) => a === "n").length, asks.filter((a) => a === "f").length], [1, 4], "n once; f at each of the four runs (three, then the one after the hold)");
  once.stop();
  once.run();
  await once.idle();
  assert.equal(asks.filter((a) => a === "n").length, 2, "read again after a sign out");
  // review of 0430db23, P3: a sale's hold keeps the load's no-answer Ws (a sale changes what W holds, never W's oldest
  // transactions): a hold that stops a run on reads only the rest again once it ends
  const asked2: string[] = [];
  const turns = async (f: () => boolean) => {
    for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setImmediate(r));
    assert.ok(f());
  };
  let unblock = (): void => {};
  const held2 = solBuyRecords({
    wallets: async () => ["n", "s"],
    done: async () => new Set(),
    write: async () => true,
    reader: { read: async (a, signal) => (asked2.push(a), a === "n" ? null : new Promise<never>((_, no) => ((unblock = () => no(new Error("x"))), signal?.addEventListener("abort", () => no(signal.reason))))) },
    wrote: () => {},
    pick: (n) => n - 1,
  });
  held2.run();
  await turns(() => asked2.length === 2);
  const e5 = held2.hold();
  e5();
  await turns(() => asked2.length >= 3);
  unblock();
  await held2.idle();
  assert.deepEqual(asked2, ["n", "s", "s"], "n not read again after the hold");
  // a sign out during a hold: the hold's end runs nothing
  written.clear();
  reads.length = 0;
  const e3 = r.hold();
  r.run();
  r.stop();
  e3();
  await new Promise((x) => setTimeout(x, 10));
  assert.deepEqual(reads, [], "signed out: no run after the sale");
}));
