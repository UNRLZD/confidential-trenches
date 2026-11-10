// Every request the positions make on the mainnet build (card signpage-state-holdings, review P1-1): the page's own
// transport, the finder on the helper's keyed route and the page's two Solana RPCs (PublicNode and the helper), each
// request logged as it leaves. Across a load, a W whose read fails and its retry, the helper down, the public RPC down
// and a reload, with a token a stranger sent to a W on it:
// - no request to any host but the helper's keyed route names a W or a W's token account;
// - no request names a W with no buy record on this device, nor a mint no buy record names;
// - a mint whose buy record names its decimals is never asked for, and one from before decimals were kept is asked
//   once on each of the page's RPCs, then never again (the kept pass names them).
//   node --test test/positions-requests.test.ts
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { base58, base64 } from "@scure/base";
import { IDBFactory } from "fake-indexeddb";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore } from "@blindfill/wallet/store";
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
  assert.deepEqual(old.sort(), [`1 a load | ${HELPER_RPC} | getAccountInfo`, "1 a load | solana-rpc.publicnode.com/ | getAccountInfo"], "a record from before decimals were kept: its mint once on each RPC, then the kept pass names them");
  assert.ok(log.some((l) => l.to === HELPER_RPC && l.names.includes("W0")), "the finder read the Ws (a sanity check of the log)");
});
