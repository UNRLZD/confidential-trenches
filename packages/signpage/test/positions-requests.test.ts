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
import { POOL_TESTNET } from "../../wallet/src/pool/network.ts";
import { solanaAta } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import { POSITION_COSTS_KEY, type Position } from "../src/positions.ts";
import { testnetPool } from "../src/pool-testnet.ts";
import { TRADE_HELPER } from "../src/trade.ts";

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const PIN = { program: "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8", feePayer: "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb" };
const SCOPE = solanaPoolOf(PIN.program).scope;
const key = (b: number) => base58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? b : i === 0 ? 9 : 0)));
const BOUGHT = key(7); // W0's buy, its record naming its decimals
const OLD = key(9); // W1's buy, its record from before decimals were kept
const STRANGER = key(8); // sent to W0 by anyone: no buy record
const HELPER_RPC = `${new URL(TRADE_HELPER).host}/v1/rpc/solana`;
const realFetch = globalThis.fetch;
after(() => void (globalThis.fetch = realFetch));

test("the positions on the mainnet build: no request names a W to any host but the helper's keyed route, none names a W or a mint no buy record names, and a load asks no decimals a buy record or the kept pass names", { timeout: 300_000 }, async () => {
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
    return ok(null);
  }) as typeof fetch;

  const timers: (() => void)[] = [];
  const make = () => testnetPool({ store: async () => w, seed64: async () => SEED64.slice() }, { pin: PIN, positions: { setTimer: (f: () => void) => timers.push(f), clearTimer: () => {} } } as never);
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
});

// The second review's request log (of c5a61ca5), on the same transport: account A's load, a buy that wrote no buy record
// (W's buy mint only, its run told no amount), a sell's read and end, a sign out while a pass reads, then account B on
// the same tab. Every request the page makes in it is logged:
// - none names a W, a W's token account or a mint only this device's buys name to any host but the helper's keyed route;
// - none names a stranger's mint (one sent to a W) anywhere;
// - none names account A's Ws, token accounts or mints once B signed in.
test("the positions across a buy with no record, a sell, a sign out mid-pass and the next account: no W, token account or bought mint named past the helper's keyed route, no stranger's mint anywhere, nothing of A's after B signs in", { timeout: 600_000 }, async () => {
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
  const buy = (host: () => { bought?: { put(a: string, m: { mint: string; program: string }): Promise<void> } }) => (_ask: unknown, ctx: { route(r: unknown): void; progress(s: string): void }) => {
    const ran = (async () => {
      await host().bought!.put(A.Ws[3]!, { mint: NEW, program: SOLANA_TOKEN_PROGRAM });
      ctx.route({ wallet: A.Ws[3]! });
      holds.set(A.Ws[3]!, [[NEW, 2_500_000_000n]]);
      ctx.progress("filled");
    })();
    return { running: true as const, after: ran, answer: () => ({ result: { stage: "filled", txs: [] } }) };
  };
  const sell = (host: () => { wallets(): Promise<unknown> }) => () => {
    sellRead = host().wallets().catch(() => {});
    return { running: true as const, after: new Promise<void>((r) => (sellEnd = r)), answer: () => ({ result: { stage: "filled", txs: [] } }) };
  };
  const tp = testnetPool(
    { store: async () => cur, seed64: async () => (seed === null ? Promise.reject(new Error("no seed is stored")) : seed.slice()) },
    { pin: PIN, table: "6bbfV79efN889c4iRTSTf4htv6EnurCJuz5CjMftjsyZ", tradeKinds: { buy, sell }, positions: { setTimer: () => 0, clearTimer: () => {} } } as never,
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
});
