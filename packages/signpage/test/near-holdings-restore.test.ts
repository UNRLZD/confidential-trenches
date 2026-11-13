// The NEAR buy records rebuilt after a sign out, a new device or a restore from the 12 words (card near-holdings-restore,
// src/near-buy.ts nearHoldingsPass): the token from W's own signed calls (the helper's record, each call's delegate
// checked as W's), W's balances on the helper's keyed seat alone, never a request naming W to anyone but the helper;
// nothing a stranger writes to chain changes what is shown or signed. A fake store (fake-indexeddb), the vault's spends
// rows, the helper's records and the seat faked; W's calls signed with W's own key from the public test seed.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64 } from "@scure/base";
import { IDBFactory } from "fake-indexeddb";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import type { VaultSpendRow } from "../../kit/src/vault/sync.ts";
import type { NearRpc } from "../../kit/src/near/networks.ts";
import { NEAR_NETWORKS } from "../../kit/src/near/networks.ts";
import { NEAR_RHEA } from "../../kit/src/near/rhea.ts";
import { encodeDelegateAction, NEP366_PREFIX } from "../../wallet/src/deposit/delegate.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteRecord, type NoteStore } from "../../wallet/src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../../wallet/src/store/index.ts";
import { nearSwapWallet } from "../../wallet/src/near/swap-delegate.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import {
  depsOf,
  NEAR_BUY_KEY,
  NEAR_BUY_RESUMES,
  NEAR_DELEGATE_LIFE_BLOCKS,
  NEAR_PENDING_SETTLED_BLOCKS,
  NEAR_HOLDINGS_EMPTY_KEY,
  NEAR_HOLDINGS_W_KEY,
  NEAR_RECORD_MAX_BYTES,
  nearBuyRecordOf,
  nearHoldingsPass,
  nearPositions,
  nearSellKind,
  nearWRecords,
  resumeNearBuys,
  resumeNearSells,
  type NearBuyPage,
  type NearBuyRecord,
  type NearHoldingsReads,
  type NearWRecord,
} from "../src/near-buy.ts";
import { nearWCallOf } from "../src/near-w-calls.ts";
import { vaultScope } from "../src/withdraw/checks.ts";

const SEED = new Uint8Array(64).fill(0x42); // the public test seed
const NETWORK = "mainnet" as const;
const SCOPE = vaultScope(NETWORK)!;
const USDC = NEAR_NETWORKS.mainnet.usdc;
const EX = NEAR_RHEA.mainnet.exchange;
const TOKEN = "token.rhealab.near";
const STRANGER = "airdrop.near";
const PAID = 3_000_000n;
const FEE = 20_000n;
const H = 1_000; // the seat's final in these tests
const HELPER = "ct-api.unrealized.trade";

const worlds: { w: WalletStore; ns: NoteStore }[] = [];
after(() => {
  for (const v of worlds.splice(0)) (v.ns.close(), v.w.close());
});

/** A store as a restore leaves it: the notes, each SPENT when `spent` says so, and no buy record. */
async function world(values: bigint[], spent: boolean[]) {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  worlds.push({ w, ns });
  for (const [k, value] of values.entries()) {
    let n = await ns.planDeposit(SCOPE, (ref) => noteSecrets(SEED, ref).precommitment);
    const label = vaultLabelOf(keccak_256, SCOPE, BigInt(k + 1));
    const commitment = noteCommitment(value, label, n.precommitment);
    n = await ns.move(n.id, "PLANNED", "INCOMING");
    n = await ns.move(n.id, "INCOMING", "UNSPENT", { leaf: { value, label, commitment, leafIndex: BigInt(k) } });
    if (spent[k]) n = await ns.move(n.id, "UNSPENT", "SPENT");
  }
  const notes = (await ns.list()).filter((n) => n.state === "SPENT");
  const ws = notes.map((n) => ({ note: n, w: nearSwapWallet(SEED, n.leaf!.label, jOf(n.ref)).id, nh: noteSecrets(SEED, n.ref).nullifierHash }));
  return { w, ns, ws };
}

/** The vault's spends row of a note: paid to `recipient`. */
const row = (nh: bigint, recipient: string, o: Partial<VaultSpendRow> = {}): VaultSpendRow => ({
  index: 0, nullifierHash: nh, withdrawn: PAID, newLeafIndex: 0n, refundPrecommitment: 0n, refundValue: 0n, refundLabel: 0n, refundLeafIndex: 0n, status: "paid", payer: "r.near", reserve: 0n, recipient, fee: FEE, context: 0n, ...o,
});
const spendsOf = (rows: VaultSpendRow[], height = H) => async () => ({ rows, height });

// ---- W's calls, signed by W's own key and wrapped in the relayer's transaction as the helper stores it ----
const le = (v: bigint, n: number) => Array.from({ length: n }, (_, k) => Number((v >> BigInt(8 * k)) & 0xffn));
const bstr = (s: string) => {
  const b = new TextEncoder().encode(s);
  return [...le(BigInt(b.length), 4), ...b];
};
type Call = { receiver: string; method: string; args: Record<string, unknown>; mbh?: bigint };
/** One of W's calls as the relayer sent it: base64(Transaction V0 of one Delegate, then the relayer's signature). */
function relayed(note: NoteRecord, c: Call, o: { key?: Uint8Array; sender?: string; pub?: Uint8Array } = {}): string {
  const fw = freshWallet(SEED, "near", note.leaf!.label, jOf(note.ref));
  const sk = o.key ?? fw.secretKey;
  const pub = ed25519.getPublicKey(sk);
  const d = encodeDelegateAction({ sender_id: o.sender ?? fw.address, receiver_id: c.receiver, method_name: c.method, args: new TextEncoder().encode(JSON.stringify(c.args)), gas: 150_000_000_000_000n, deposit: 1n, nonce: 41n, max_block_height: c.mbh ?? BigInt(H - 10), public_key: o.pub ?? pub });
  const signable = new Uint8Array(4 + d.length);
  new DataView(signable.buffer).setUint32(0, NEP366_PREFIX, true);
  signable.set(d, 4);
  const sig = ed25519.sign(sha256(signable), sk);
  const tx = [...bstr("relayer.near"), 0, ...new Uint8Array(32).fill(7), ...le(9n, 8), ...bstr(fw.address), ...new Uint8Array(32).fill(3), ...le(1n, 4), 8, ...d, 0, ...sig, 0, ...new Uint8Array(64).fill(1)];
  return base64.encode(Uint8Array.from(tx));
}
const register = (token = TOKEN): Call => ({ receiver: token, method: "storage_deposit", args: { account_id: "w", registration_only: true } });
const buySwap = (token = TOKEN, mbh?: bigint): Call => ({ receiver: USDC, method: "ft_transfer_call", args: { receiver_id: EX, amount: PAID.toString(), msg: JSON.stringify({ force: 0, actions: [{ pool_id: 9, token_in: USDC, token_out: token, min_amount_out: "1" }], skip_degen_price_sync: true, skip_unwrap_near: true }) }, ...(mbh === undefined ? {} : { mbh }) });
const sellSwap = (token = TOKEN): Call => ({ receiver: token, method: "ft_transfer_call", args: { receiver_id: EX, amount: "7", msg: JSON.stringify({ force: 0, actions: [{ pool_id: 9, token_in: token, token_out: USDC, min_amount_out: "1" }], skip_degen_price_sync: true, skip_unwrap_near: true }) } });
/** The helper's record of W: its token and each call with its state. */
/** As the helper answers it: a landed or failed call with its signed bytes, a pending or dropped one with its last block
 *  alone (`mbh`, absent when the helper could not read it). */
function recordOf(w: string, token: string | null, calls: { tx: string; state?: NearWRecord["calls"][number]["state"]; side?: "buy" | "sell"; mbh?: bigint }[], created: NearWRecord["created"] = { tx_hash: "c", state: "landed", height: String(H - 900) }): NearWRecord {
  return {
    wallet: w,
    token,
    calls: calls.map((c, k) => {
      const state = c.state ?? "landed";
      const bytes = state === "landed" || state === "failed" ? { signed_tx: c.tx } : c.mbh === undefined ? {} : { max_block_height: c.mbh.toString() };
      return { tx_hash: `t${k}`, ...bytes, method: "m", side: c.side ?? "buy", state };
    }),
    created,
  };
}
const none = (w: string): NearWRecord => ({ wallet: w, token: null, calls: [], created: null });
const recordsFrom = (m: Record<string, NearWRecord>, asked: string[][] = []) => async (ws: readonly string[]) => (asked.push([...ws]), ws.map((w) => m[w] ?? none(w)));

/** The helper's keyed seat: W's balances (token -> account -> units) at one block; each read logged. */
function seatOf(held: Record<string, Record<string, bigint>>, o: { height?: number; lost?: bigint; log?: string[] } = {}): NearRpc {
  return {
    name: NEAR_NETWORKS.mainnet.seat!,
    async query(p) {
      const args = JSON.parse(atob(String(p.args_base64)));
      const at = "block_id" in p ? Number(p.block_id) : (o.height ?? H);
      o.log?.push(`${String(p.account_id)} ${String(p.method_name)} ${"block_id" in p ? "@" + at : "final"}`);
      const v = p.method_name === "ft_balance_of" ? String(held[String(p.account_id)]?.[args.account_id] ?? 0n) : p.method_name === "get_lostfound_token" ? String(o.lost ?? 0n) : null;
      return { result: { block_height: at, block_hash: `H${at}`, result: [...new TextEncoder().encode(JSON.stringify(v))] } };
    },
  };
}
const refusingPair = (): readonly [NearRpc, NearRpc] => [
  { name: NEAR_NETWORKS.mainnet.fastnear[0], query: async () => Promise.reject(new Error("no public read in the pass")) },
  { name: NEAR_NETWORKS.mainnet.drpc, query: async () => Promise.reject(new Error("no public read in the pass")) },
];

function pageOf(v: { w: WalletStore; ns: NoteStore }, log: string[] = [], o: Partial<NearBuyPage> = {}): NearBuyPage {
  return {
    network: NETWORK,
    store: async () => v.w,
    notes: async () => v.ns,
    seed64: async () => Uint8Array.from(SEED),
    seedLock: (fn) => fn(),
    fee: async () => FEE,
    handoff: null,
    settle: async () => ({ outcomes: {} }),
    rpcs: refusingPair,
    pools: async () => [],
    wait: async () => {},
    decimals: async () => 18,
    // no request leaves a test unless it names its fetch
    fetchFn: async (u) => Promise.reject(new Error(`no request in this test: ${String(u)}`)),
    log: (line) => void log.push(line),
    ...o,
  };
}
const records = async (w: WalletStore): Promise<NearBuyRecord[]> =>
  (await Promise.all((await w.keys("quotes")).filter((k) => k.startsWith(NEAR_BUY_KEY)).map(async (k) => nearBuyRecordOf(await w.get("quotes", k))))).filter((r): r is NearBuyRecord => r !== undefined);
const keptEmpty = async (w: WalletStore) => ((await w.get("quotes", `${NEAR_HOLDINGS_EMPTY_KEY}mainnet`)) as { final: string[] } | undefined)?.final ?? [];
/** The Ws one seat answer read empty: read again on a restore or a Sync, never on a plain load. */
const softEmpty = async (w: WalletStore) => Object.keys(((await w.get("quotes", `${NEAR_HOLDINGS_EMPTY_KEY}mainnet`)) as { soft?: Record<string, number> } | undefined)?.soft ?? {});

/** One W bought TOKEN (its registration and swap carried, landed), as the pass's reads see it. */
async function bought(held: Record<string, Record<string, bigint>>, calls?: (n: NoteRecord) => { tx: string; state?: string }[]) {
  const v = await world([5_000_000n], [true]);
  const { w: W, note, nh } = v.ws[0]!;
  const recs = { [W]: recordOf(W, TOKEN, (calls ?? ((n) => [{ tx: relayed(n, register()) }, { tx: relayed(n, buySwap()) }]))(note)) };
  const reads: NearHoldingsReads = { spends: spendsOf([row(nh, W)]), records: recordsFrom(recs), seat: seatOf(held) };
  return { v, W, note, nh, reads, recs };
}

test("a: a W holding the token its own signed calls name comes back as a position, at the payout W received, and the sell takes it", async () => {
  const { v, W, reads } = await bought({ [TOKEN]: { ["W"]: 0n } });
  reads.seat = seatOf({ [TOKEN]: { [W]: 7n * 10n ** 18n } });
  const log: string[] = [];
  const page = pageOf(v, log);
  assert.deepEqual(await nearPositions(page), [], "the store holds no record: nothing shows (the strand)");
  assert.deepEqual(await nearHoldingsPass(page, reads), { written: [W], empty: [], unread: [] });
  const [r] = await records(v.w);
  assert.equal(r!.token, TOKEN);
  assert.equal(r!.stage, "filled");
  assert.equal(r!.amount, (PAID - FEE).toString(), "probe 6: the cost is what W received, the payout less the relay fee");
  assert.deepEqual(r!.fill, { out: (7n * 10n ** 18n).toString(), decimals: 18 });
  const pos = await nearPositions(page);
  assert.equal(pos.length, 1);
  assert.equal(pos[0]!.amount, "7");
  const sp = { ...page, readWallet: async () => Promise.reject(new Error("no reads past the pick here")) };
  const k = nearSellKind(sp)({ token: TOKEN, slippageBps: 100 }, { id: "sell-1", sha: "00", progress: () => {} });
  assert.ok("running" in k);
  await k.after;
  assert.equal((await records(v.w))[0]!.sell?.id, "sell-1");
});

test("probe 1: a stranger's token with more units on W is never read or shown; the record is the bought coin", async () => {
  const log: string[] = [];
  const { v, W, reads } = await bought({});
  reads.seat = seatOf({ [TOKEN]: { [W]: 5n }, [STRANGER]: { [W]: 10n ** 30n } }, { log });
  assert.deepEqual((await nearHoldingsPass(pageOf(v), reads)).written, [W]);
  assert.equal((await records(v.w))[0]!.token, TOKEN);
  assert.ok(!log.some((l) => l.startsWith(STRANGER)), "the stranger's token is never asked");
});

test("a W whose sell's swap the helper read landed, holding its coin, is a position: the coin on W decides, never the helper's word; holding none, it is closed", async () => {
  const sold = (n: NoteRecord) => [{ tx: relayed(n, register()) }, { tx: relayed(n, buySwap()) }, { tx: relayed(n, sellSwap()), state: "landed" as const, side: "sell" as const }];
  const { v, W, reads } = await bought({}, sold);
  reads.seat = seatOf({ [TOKEN]: { [W]: 9n * 10n ** 18n } });
  assert.deepEqual(await nearHoldingsPass(pageOf(v), reads), { written: [W], empty: [], unread: [] });
  assert.equal((await nearPositions(pageOf(v)))[0]?.amount, "9");
  const b = await bought({}, sold);
  assert.deepEqual(await nearHoldingsPass(pageOf(b.v), b.reads), { written: [], empty: [b.W], unread: [] });
  assert.deepEqual(await nearPositions(pageOf(b.v)), []);
});

test("probe 2: decimals that do not read leave W unread (never a silent 18), shown on a later load once they read", async () => {
  const { v, W, reads } = await bought({});
  reads.seat = seatOf({ [TOKEN]: { [W]: 5n } });
  const log: string[] = [];
  const failing = pageOf(v, log, { decimals: async () => Promise.reject(new Error("no ft_metadata")) });
  assert.deepEqual(await nearHoldingsPass(failing, reads), { written: [], empty: [], unread: [W] });
  assert.ok(log.some((l) => l.startsWith("near holdings: decimals not read")));
  assert.deepEqual(await keptEmpty(v.w), [], "never kept empty for a read that failed");
  assert.deepEqual((await nearHoldingsPass(pageOf(v), reads)).written, [W]);
});

test("probe 3 and 8: what W holds beyond its proven token is never listed; empty is decided on that token's balance alone, and a W holding it is never kept empty", async () => {
  const log: string[] = [];
  const { v, W, reads } = await bought({});
  const many = Object.fromEntries(Array.from({ length: 65 }, (_, k) => [`dust${k}.near`, { [W]: 1n }]));
  reads.seat = seatOf({ ...many }, { log });
  // the coin not yet on W (its swap's output on its way): empty and settled? its swap landed, nothing in flight: closed
  // only once the token reads 0 at a block past every call; here it reads 0, so the W is closed
  assert.deepEqual((await nearHoldingsPass(pageOf(v), reads)).empty, [W]);
  assert.deepEqual(log.map((l) => l.split(" ")[0]).sort(), [TOKEN, USDC, EX].sort(), "USDC, the proven token and its lost-found: nothing else");
  // a W holding its coin is shown, whatever else lands on it
  const b = await bought({});
  b.reads.seat = seatOf({ ...many, [TOKEN]: { [b.W]: 3n } });
  assert.deepEqual((await nearHoldingsPass(pageOf(b.v), b.reads)).written, [b.W]);
});

test("probe 4: the sign out's signal stops the pass between reads; nothing is asked after it", async () => {
  const v = await world([5_000_000n, 6_000_000n, 7_000_000n], [true, true, true]);
  const recs = Object.fromEntries(v.ws.map((x) => [x.w, recordOf(x.w, TOKEN, [{ tx: relayed(x.note, buySwap()) }])]));
  const log: string[] = [];
  const out = new AbortController();
  const seat = seatOf(Object.fromEntries([[TOKEN, Object.fromEntries(v.ws.map((x) => [x.w, 5n]))]]), { log });
  const stopping: NearRpc = { name: seat.name, query: async (p, s) => (log.length === 2 && out.abort(), seat.query(p, s)) };
  const p = await nearHoldingsPass(pageOf(v, [], { signal: () => out.signal }), { spends: spendsOf(v.ws.map((x) => row(x.nh, x.w))), records: recordsFrom(recs), seat: stopping });
  const asked = log.length;
  assert.ok(asked <= 3, `${asked} reads`);
  assert.ok(p.written.length <= 1);
  assert.equal((await nearHoldingsPass(pageOf(v, [], { signal: () => out.signal }), { spends: spendsOf([]), records: async () => assert.fail("asked after the sign out"), seat })).written.length, 0);
});

test("probe 5: no request of the pass names W to anyone but the helper: its records and the seat are the helper's, and a seat that fails (5xx, 429, a timeout, stale) stops the pass with no other host asked", async () => {
  for (const fault of ["none", "503", "429", "timeout", "stale"] as const) {
    const v = await world([5_000_000n, 6_000_000n], [true, true]);
    const recs = Object.fromEntries(v.ws.map((x) => [x.w, recordOf(x.w, TOKEN, [{ tx: relayed(x.note, buySwap()) }])]));
    const asked: string[] = [];
    const fetchFn: typeof fetch = async (u, init) => {
      const url = new URL(String(u));
      asked.push(url.host);
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url.pathname === "/v1/bind/record") return new Response(JSON.stringify({ records: body.wallets.map((w: string) => recs[w]) }), { status: 200 });
      if (`${url.origin}${url.pathname}${url.search}` === NEAR_NETWORKS.mainnet.seat) {
        if (fault === "503") return new Response("{}", { status: 503 });
        if (fault === "429") return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
        if (fault === "timeout") throw new DOMException("timed out", "TimeoutError");
        const p = body.params;
        const height = fault === "stale" ? H - 100 : "block_id" in p ? p.block_id : H;
        const args = JSON.parse(atob(p.args_base64));
        const v2 = p.method_name === "ft_balance_of" ? (p.account_id === TOKEN && v.ws.some((x) => x.w === args.account_id) ? "5" : "0") : "0";
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: { block_height: height, block_hash: `H${height}`, result: [...new TextEncoder().encode(JSON.stringify(v2))] } }), { status: 200 });
      }
      throw new Error(`a request to ${url.host}`);
    };
    const p = await nearHoldingsPass(pageOf(v, [], { fetchFn }), { spends: spendsOf(v.ws.map((x) => row(x.nh, x.w))) });
    assert.ok(asked.length > 0);
    assert.deepEqual([...new Set(asked)], [HELPER], `${fault}: every request to the helper`);
    if (fault === "none") assert.equal(p.written.length, 2, fault);
    else {
      assert.deepEqual(p.written, [], fault);
      assert.deepEqual(p.unread.sort(), v.ws.map((x) => x.w).sort(), `${fault}: read again on a later load`);
      assert.deepEqual(await keptEmpty(v.w), [], fault);
    }
  }
});

test("probe 7: each spent note's W is derived once and kept; a later pass opens no seed", async () => {
  const { v, reads } = await bought({});
  let opened = 0;
  const page = pageOf(v, [], { seed64: async () => (opened++, Uint8Array.from(SEED)) });
  await nearHoldingsPass(page, reads);
  assert.equal(opened, 1);
  assert.ok(await v.w.get("quotes", `${NEAR_HOLDINGS_W_KEY}mainnet`));
  await nearHoldingsPass(page, reads);
  assert.equal(opened, 1, "no seed opened again");
});

test("the token is proven by W's own signature: a call signed by another key, from another sender, or bytes out of shape prove nothing; a helper token the calls do not prove rebuilds nothing", async () => {
  const v = await world([5_000_000n], [true]);
  const { w: W, note, nh } = v.ws[0]!;
  const other = new Uint8Array(32).fill(9);
  assert.equal(nearWCallOf(W, relayed(note, buySwap(), { key: other })), null, "another key");
  assert.equal(nearWCallOf(W, relayed(note, buySwap(), { sender: "f".repeat(64) })), null, "another sender");
  const good = relayed(note, buySwap());
  assert.ok(nearWCallOf(W, good));
  const bytes = base64.decode(good);
  assert.equal(nearWCallOf(W, base64.encode(Uint8Array.from([...bytes, 0]))), null, "a byte after the signature");
  const flip = Uint8Array.from(bytes);
  flip[flip.length - 100]! ^= 1;
  assert.equal(nearWCallOf(W, base64.encode(flip)), null, "a signed byte changed");
  assert.equal(nearWCallOf(W, "not base64!"), null);
  assert.equal(nearWCallOf(W, relayed(note, buySwap(), { pub: new Uint8Array(32).fill(5) })), null, "W's signature over a delegate naming another key: the chain would refuse it");
  // the helper names a token the calls do not: nothing rebuilt, logged, read again later (never kept empty)
  const log: string[] = [];
  const seat = seatOf({ [TOKEN]: { [W]: 5n }, [STRANGER]: { [W]: 5n } });
  const lying = { [W]: recordOf(W, STRANGER, [{ tx: relayed(note, buySwap()) }]) };
  assert.deepEqual(await nearHoldingsPass(pageOf(v, log), { spends: spendsOf([row(nh, W)]), records: recordsFrom(lying), seat }), { written: [], empty: [], unread: [W] });
  // only forged calls: no proven token, a W holding a token shows nothing and is not kept empty
  const forged = { [W]: recordOf(W, STRANGER, [{ tx: relayed(note, buySwap(STRANGER), { key: other }) }]) };
  assert.deepEqual(await nearHoldingsPass(pageOf(v), { spends: spendsOf([row(nh, W)]), records: recordsFrom(forged), seat }), { written: [], empty: [], unread: [W] });
  assert.deepEqual(await keptEmpty(v.w), []);
});

test("rule 6: USDC on W goes home only once nothing of W is in flight and no call W signed can still land", async () => {
  const usdcOnly = async (calls: (n: NoteRecord) => Parameters<typeof recordOf>[2], created?: NearWRecord["created"], height = H) => {
    const v = await world([5_000_000n], [true]);
    const { w: W, note, nh } = v.ws[0]!;
    const rec = recordOf(W, TOKEN, calls(note), created);
    const p = await nearHoldingsPass(pageOf(v), { spends: spendsOf([row(nh, W)], height), records: recordsFrom({ [W]: rec }), seat: seatOf({ [USDC]: { [W]: 2_500_000n } }, { height }) });
    return { p, v, W };
  };
  // the swap failed, its window passed: home
  const a = await usdcOnly((n) => [{ tx: relayed(n, register()) }, { tx: relayed(n, buySwap(TOKEN, BigInt(H - 1))), state: "failed" }]);
  assert.deepEqual(a.p.written, [a.W]);
  const r = (await records(a.v.w))[0]!;
  assert.equal(r.stage, "sent");
  assert.equal(r.resumes, NEAR_BUY_RESUMES, "no buy is ever run from it");
  // a call of W's that can still land (its max_block_height at or past the seat's final): not yet
  assert.deepEqual((await usdcOnly((n) => [{ tx: relayed(n, register(TOKEN)), state: "landed" }, { tx: relayed(n, buySwap(TOKEN, BigInt(H))), state: "failed" }])).p.written, []);
  // a call still pending at the helper: not yet while the seat's final is within NEAR_PENDING_SETTLED_BLOCKS of its
  // last block, or its last block is not known; past that, settled whatever the helper last read
  const pending = (mbh?: bigint) => usdcOnly((n) => [{ tx: relayed(n, register()) }, { tx: relayed(n, buySwap(TOKEN, mbh)), state: "pending", ...(mbh === undefined ? {} : { mbh }) }]);
  assert.deepEqual((await pending(BigInt(H) - NEAR_PENDING_SETTLED_BLOCKS)).p.written, []);
  assert.deepEqual((await pending()).p.written, []);
  const past = await pending(BigInt(H - 500));
  assert.deepEqual(past.p.written, [past.W]);
  assert.equal((await records(past.v.w))[0]!.token, TOKEN, "the proven token, never Rhea's wrapped NEAR");
  // no call yet: W's life must pass first, timed from the creation's height or this device's first read of W, the later
  const young: NearWRecord["created"] = { tx_hash: "c", state: "landed", height: String(H - Number(NEAR_DELEGATE_LIFE_BLOCKS)) };
  assert.deepEqual((await usdcOnly(() => [], young)).p.unread.length, 1);
  // with no creation and no call, the life past the block this device first read W so
  assert.equal((await usdcOnly(() => [], null)).p.unread.length, 1);
  // a creation the helper names at height 1 (long past) never skips the wait: the first read starts it
  const v1 = await world([5_000_000n], [true]);
  const x1 = v1.ws[0]!;
  const ancient = (h: number) => nearHoldingsPass(pageOf(v1), { spends: spendsOf([row(x1.nh, x1.w)], h), records: recordsFrom({ [x1.w]: { wallet: x1.w, token: null, calls: [], created: { tx_hash: "c", state: "landed", height: "1" } } }), seat: seatOf({ [USDC]: { [x1.w]: 2_500_000n } }, { height: h }) });
  assert.deepEqual((await ancient(H)).written, []);
  assert.deepEqual((await ancient(H + Number(NEAR_DELEGATE_LIFE_BLOCKS))).written, []);
  assert.deepEqual((await ancient(H + Number(NEAR_DELEGATE_LIFE_BLOCKS) + 1)).written, [x1.w]);
  // a creation still pending: not yet
  assert.deepEqual((await usdcOnly(() => [], { tx_hash: "c", state: "pending", height: "1" })).p.written, []);
});

test("a creation the helper calls pending holds W's USDC only until the seat's final is NEAR_PENDING_SETTLED_BLOCKS past the block this device first read it so; a Sync never restarts the wait", async () => {
  const v = await world([5_000_000n], [true]);
  const { w: W, nh } = v.ws[0]!;
  const creating = recordsFrom({ [W]: { wallet: W, token: null, calls: [], created: { tx_hash: "c", state: "pending", height: "1" } } });
  const at = (h: number, fresh = false) => nearHoldingsPass(pageOf(v), { spends: spendsOf([row(nh, W)], h), records: creating, seat: seatOf({ [USDC]: { [W]: 2_500_000n } }, { height: h }), fresh });
  // no first read yet: this read is it, not yet
  assert.deepEqual(await at(H), { written: [], empty: [], unread: [W] });
  // inside the wait, a Sync too: not yet
  assert.deepEqual((await at(H + Number(NEAR_PENDING_SETTLED_BLOCKS), true)).written, []);
  // past it, but W has no call: its life from the first read still holds it; past that, home
  assert.deepEqual((await at(H + Number(NEAR_PENDING_SETTLED_BLOCKS) + 1)).written, []);
  assert.deepEqual((await at(H + Number(NEAR_DELEGATE_LIFE_BLOCKS) + 1)).written, [W]);
  assert.equal((await records(v.w))[0]!.stage, "sent");
  // with a call of W's landed past its last block, the pending creation alone holds it until the margin past the first read
  const u = await world([5_000_000n], [true]);
  const y = u.ws[0]!;
  const withCall = recordsFrom({ [y.w]: recordOf(y.w, TOKEN, [{ tx: relayed(y.note, register()) }], { tx_hash: "c", state: "pending", height: "1" }) });
  const at2 = (h: number) => nearHoldingsPass(pageOf(u), { spends: spendsOf([row(y.nh, y.w)], h), records: withCall, seat: seatOf({ [USDC]: { [y.w]: 2_500_000n } }, { height: h }) });
  assert.deepEqual((await at2(H)).written, []);
  assert.deepEqual((await at2(H + Number(NEAR_PENDING_SETTLED_BLOCKS))).written, []);
  assert.deepEqual((await at2(H + Number(NEAR_PENDING_SETTLED_BLOCKS) + 1)).written, [y.w]);
});

test("finding 7: the coin in the exchange's lost-found leaves W unread, never kept empty", async () => {
  const { v, W, reads } = await bought({});
  reads.seat = seatOf({}, { lost: 4n });
  assert.deepEqual(await nearHoldingsPass(pageOf(v), reads), { written: [], empty: [], unread: [W] });
  assert.deepEqual(await keptEmpty(v.w), []);
});

test("a stranger's dust in the exchange's lost-found for W (under W's own floor) holds nothing back: W's USDC is on its way home", async () => {
  const v = await world([5_000_000n], [true]);
  const { w: W, note, nh } = v.ws[0]!;
  const swap = { ...buySwap(TOKEN, BigInt(H - 1)), args: { ...buySwap().args, msg: JSON.stringify({ force: 0, actions: [{ pool_id: 9, token_in: USDC, token_out: TOKEN, min_amount_out: "1000" }], skip_degen_price_sync: true, skip_unwrap_near: true }) } };
  const recs = recordsFrom({ [W]: recordOf(W, TOKEN, [{ tx: relayed(note, register()) }, { tx: relayed(note, swap), state: "failed" }]) });
  const seat = (lost: bigint) => seatOf({ [USDC]: { [W]: 2_500_000n } }, { lost });
  assert.deepEqual(await nearHoldingsPass(pageOf(v), { spends: spendsOf([row(nh, W)]), records: recs, seat: seat(999n) }), { written: [W], empty: [], unread: [] });
  // W's own output at its floor in the lost-found: read again later, as finding 7
  const v2 = await world([5_000_000n], [true]);
  const x = v2.ws[0]!;
  const recs2 = recordsFrom({ [x.w]: recordOf(x.w, TOKEN, [{ tx: relayed(x.note, register()) }, { tx: relayed(x.note, swap), state: "failed" }]) });
  assert.deepEqual(await nearHoldingsPass(pageOf(v2), { spends: spendsOf([row(x.nh, x.w)]), records: recs2, seat: seatOf({ [USDC]: { [x.w]: 2_500_000n } }, { lost: 1000n }) }), { written: [], empty: [], unread: [x.w] });
});

test("a W the helper has no record of rebuilds nothing and is not kept empty for good; under the least deposit it is read again", async () => {
  const v = await world([5_000_000n], [true]);
  const { w: W, nh } = v.ws[0]!;
  const p = await nearHoldingsPass(pageOf(v), { spends: spendsOf([row(nh, W)]), records: recordsFrom({}), seat: seatOf({ [USDC]: { [W]: 10n } }) });
  assert.deepEqual(p, { written: [], empty: [], unread: [W] });
  assert.deepEqual(await keptEmpty(v.w), []);
});

test("many Ws: 64 a call to the helper, one seat block for all", async () => {
  const n = 70;
  const v = await world(Array.from({ length: n }, (_, k) => BigInt(5_000_000 + k)), Array.from({ length: n }, () => true));
  const recs = Object.fromEntries(v.ws.map((x) => [x.w, recordOf(x.w, TOKEN, [{ tx: relayed(x.note, buySwap()) }])]));
  const asked: string[][] = [];
  const log: string[] = [];
  const seat = seatOf({ [TOKEN]: Object.fromEntries(v.ws.map((x) => [x.w, 1n])) }, { log });
  const p = await nearHoldingsPass(pageOf(v), { spends: spendsOf(v.ws.map((x) => row(x.nh, x.w))), records: recordsFrom(recs, asked), seat });
  assert.deepEqual(asked.map((a) => a.length), [64, 6]);
  assert.equal(p.written.length, n);
  assert.equal(log.filter((l) => l.endsWith("final")).length, 1, "one final read, every other at its block");
});

test("d: twice, or beside the store's own record of W: one record, the store's own never rewritten", async () => {
  const v = await world([5_000_000n, 6_000_000n], [true, true]);
  const [A, B] = v.ws.map((x) => x.w);
  const mine = { v: 1, id: "req-9", network: NETWORK, token: TOKEN, amount: "1", slippage_bps: 100, w: B, l: "1", j: 0, note: v.ws[1]!.note.id, fee: "0", created_ms: 1, resumes: 0, stage: "sent", step: "swap", txs: [], payout: "landed" };
  await v.w.put("quotes", `${NEAR_BUY_KEY}req-9`, mine);
  const recs = Object.fromEntries(v.ws.map((x) => [x.w, recordOf(x.w, TOKEN, [{ tx: relayed(x.note, buySwap()) }])]));
  const reads = { spends: spendsOf(v.ws.map((x) => row(x.nh, x.w))), records: recordsFrom(recs), seat: seatOf({ [TOKEN]: { [A!]: 5n, [B!]: 5n } }) };
  const [p1, p2] = await Promise.all([nearHoldingsPass(pageOf(v), reads), nearHoldingsPass(pageOf(v), reads)]);
  assert.deepEqual([...p1.written, ...p2.written], [A], "A once, B never");
  assert.equal((await records(v.w)).length, 2);
  assert.deepEqual(await v.w.get("quotes", `${NEAR_BUY_KEY}req-9`), mine);
  assert.deepEqual((await nearHoldingsPass(pageOf(v), reads)).written, []);
});

test("d: a live buy's record of W written while the pass reads: the pass writes nothing, the live one stands", async () => {
  const { v, W, reads } = await bought({});
  const live = { v: 1, id: "req-live", network: NETWORK, token: TOKEN, amount: "1", slippage_bps: 100, w: W, l: "1", j: 0, note: v.ws[0]!.note.id, fee: "0", created_ms: 2, resumes: 0, stage: "sent", step: "swap", txs: [], payout: "landed" };
  const seat = seatOf({ [TOKEN]: { [W]: 5n } });
  reads.seat = { name: seat.name, query: async (p, s) => (await v.w.put("quotes", `${NEAR_BUY_KEY}req-live`, live), seat.query(p, s)) };
  assert.deepEqual((await nearHoldingsPass(pageOf(v), reads)).written, []);
  assert.deepEqual(await v.w.get("quotes", `${NEAR_BUY_KEY}req-live`), live);
  assert.equal(await v.w.get("quotes", `${NEAR_BUY_KEY}restored:${W}`), undefined);
});

test("d: a value under the rebuilt record's key that reads as no record is never overwritten", async () => {
  const { v, W, reads } = await bought({});
  reads.seat = seatOf({ [TOKEN]: { [W]: 5n } });
  await v.w.put("quotes", `${NEAR_BUY_KEY}restored:${W}`, { kept: "as is" });
  assert.deepEqual((await nearHoldingsPass(pageOf(v), reads)).written, []);
  assert.deepEqual(await v.w.get("quotes", `${NEAR_BUY_KEY}restored:${W}`), { kept: "as is" });
});

test("e: a spends read or a helper read that fails, a payout not yet delivered, a payout of 0 or no more than its fee: nothing invented, nothing kept, the pass never throws", async () => {
  const v = await world([5_000_000n], [true]);
  const { w: W, note, nh } = v.ws[0]!;
  const recs = recordsFrom({ [W]: recordOf(W, TOKEN, [{ tx: relayed(note, buySwap()) }]) });
  const seat = seatOf({ [TOKEN]: { [W]: 5n } });
  const page = pageOf(v);
  assert.deepEqual(await nearHoldingsPass(page, { spends: async () => Promise.reject(new Error("503")), records: recs, seat }), { written: [], empty: [], unread: ["spends"] });
  assert.deepEqual(await nearHoldingsPass(page, { spends: spendsOf([row(nh, W)]), records: async () => Promise.reject(new Error("503")), seat }), { written: [], empty: [], unread: [W] });
  for (const rows of [[], [row(nh, W, { status: "refund_pending" })], [row(nh, W, { status: "in_flight" })], [row(nh, W, { withdrawn: 0n })], [row(nh, W, { withdrawn: FEE })]]) {
    assert.deepEqual(await nearHoldingsPass(page, { spends: spendsOf(rows), records: async () => assert.fail("no record asked"), seat }), { written: [], empty: [], unread: [] });
  }
  assert.deepEqual(await records(v.w), []);
  assert.deepEqual(await keptEmpty(v.w), []);
});

test("e: a note's final spend that paid someone else, or was refunded, is no buy: no record, never read again", async () => {
  for (const r of [(nh: bigint) => row(nh, "someone.near"), (nh: bigint, w: string) => row(nh, w, { status: "settled", refundValue: 5n })]) {
    const v = await world([5_000_000n], [true]);
    const W = v.ws[0]!.w;
    let asked = 0;
    const reads = { spends: async () => (asked++, { rows: [r(v.ws[0]!.nh, W)], height: H }), records: async () => assert.fail("no record asked"), seat: seatOf({}) };
    assert.deepEqual(await nearHoldingsPass(pageOf(v), reads), { written: [], empty: [], unread: [] });
    assert.deepEqual(await keptEmpty(v.w), [W]);
    await nearHoldingsPass(pageOf(v), reads);
    assert.equal(asked, 1, "the spends list is not read again for it");
  }
});

test("the helper's answer is hostile until shaped: one per wallet in order, each field's shape, a size cap, no credentials, POST to the helper only", async () => {
  const W = "a".repeat(64);
  const seen: { url: string; init: RequestInit }[] = [];
  const answer = (body: unknown, status = 200) => async (u: string | URL | Request, init?: RequestInit) => (seen.push({ url: String(u), init: init! }), new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
  const ok = { records: [{ wallet: W, token: TOKEN, calls: [], created: null }] };
  assert.equal((await nearWRecords(NETWORK, [W], answer(ok) as typeof fetch))[0]!.token, TOKEN);
  const open = { records: [{ ...ok.records[0], calls: [{ tx_hash: "t", max_block_height: "5", method: "m", side: "buy", state: "pending" }, { tx_hash: "u", method: "m", side: "sell", state: "dropped" }] }] };
  assert.equal((await nearWRecords(NETWORK, [W], answer(open) as typeof fetch))[0]!.calls.length, 2);
  assert.equal(seen[0]!.url, "https://ct-api.unrealized.trade/v1/bind/record");
  assert.equal(seen[0]!.init.credentials, "omit");
  assert.equal(seen[0]!.init.method, "POST");
  assert.equal(seen[0]!.init.redirect, "error");
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { network: NETWORK, wallets: [W] });
  for (const bad of [
    { records: [] },
    { records: [{ ...ok.records[0], wallet: "b".repeat(64) }] },
    { records: [{ ...ok.records[0], token: "NOT AN ID" }] },
    { records: [{ ...ok.records[0], calls: [{ tx_hash: "t", signed_tx: 5, method: "m", side: "buy", state: "landed" }] }] },
    { records: [{ ...ok.records[0], calls: [{ tx_hash: "t", signed_tx: "x", method: "m", side: "buy", state: "maybe" }] }] },
    // a final call carries its bytes and no last block; a call not on chain its last block alone, never bytes
    { records: [{ ...ok.records[0], calls: [{ tx_hash: "t", method: "m", side: "buy", state: "landed" }] }] },
    { records: [{ ...ok.records[0], calls: [{ tx_hash: "t", signed_tx: "x", max_block_height: "5", method: "m", side: "buy", state: "failed" }] }] },
    { records: [{ ...ok.records[0], calls: [{ tx_hash: "t", signed_tx: "x", method: "m", side: "buy", state: "pending" }] }] },
    { records: [{ ...ok.records[0], calls: [{ tx_hash: "t", max_block_height: "-1", method: "m", side: "buy", state: "dropped" }] }] },
    { records: [{ ...ok.records[0], calls: [{ tx_hash: "t", max_block_height: 5, method: "m", side: "buy", state: "pending" }] }] },
    { records: [{ ...ok.records[0], created: { tx_hash: "c", state: "landed", height: "-1" } }] },
    "not json",
    `{"records":[${" ".repeat(NEAR_RECORD_MAX_BYTES)}]}`,
  ])
    await assert.rejects(nearWRecords(NETWORK, [W], answer(bad) as typeof fetch));
  await assert.rejects(nearWRecords(NETWORK, [W], answer(ok, 503) as typeof fetch));
  await assert.rejects(nearWRecords(NETWORK, [], answer(ok) as typeof fetch), /1 to 64/);
  await assert.rejects(nearWRecords(NETWORK, Array.from({ length: 65 }, (_, k) => k.toString(16).padStart(64, "0")), answer(ok) as typeof fetch), /1 to 64/);
});

test("the sign out, end to end in the page's own code: a buy's record, the store signed out, the same words in a new store, the load's pass: the position is back and its sell takes W", async () => {
  const a = await world([5_000_000n], [false]);
  const pa = pageOf(a, [], { fee: async () => 0n, readWallet: async () => Promise.reject(new Error("unused")) });
  const note = (await a.ns.list())[0]!;
  const W = nearSwapWallet(SEED, note.leaf!.label, jOf(note.ref)).id;
  const live = { ...pa, handoff: async () => (await a.ns.move(note.id, "UNSPENT", "SPENT"), { kind: "arrived", tx: "4".repeat(44) }) as never };
  const d = depsOf(live, null, "req-1");
  assert.ok(await d.begin({ token: TOKEN, amount: PAID, slippageBps: 100 }));
  assert.equal((await d.payout()).kind, "landed");
  await d.progress({ step: "receive", stage: "filled", txs: [], fill: { out: "7000000000000000000", decimals: 18 } });
  d.release();
  assert.equal((await nearPositions(pa)).length, 1);
  a.ns.close();
  await a.w.signOut();
  const b = await world([5_000_000n], [true]);
  assert.equal(b.ws[0]!.w, W, "the same W from the same words");
  const log: string[] = [];
  const pb = pageOf(b, log);
  assert.deepEqual(await nearPositions(pb), []);
  await nearHoldingsPass(pb, { spends: spendsOf([row(b.ws[0]!.nh, W)]), records: recordsFrom({ [W]: recordOf(W, TOKEN, [{ tx: relayed(b.ws[0]!.note, register()) }, { tx: relayed(b.ws[0]!.note, buySwap()) }]) }), seat: seatOf({ [TOKEN]: { [W]: 7n * 10n ** 18n } }) });
  const pos = await nearPositions(pb);
  assert.equal(pos.length, 1);
  assert.equal(pos[0]!.amount, "7");
  const sp = { ...pb, readWallet: async () => Promise.reject(new Error("no reads past the pick here")) };
  const r = nearSellKind(sp)({ token: TOKEN, slippageBps: 100 }, { id: "sell-1", sha: "00", progress: () => {} });
  assert.ok("running" in r);
  await r.after;
  assert.equal((await records(b.w))[0]!.sell?.id, "sell-1", "the sell took the rebuilt W");
  assert.ok(log.includes("near sell recorded"));
});

test("b: the load after the pass sends a USDC-only W's money home (resumeNearSells takes the rebuilt record); no buy runs from it", async () => {
  const v = await world([5_000_000n], [true]);
  const { w: W, note, nh } = v.ws[0]!;
  const log: string[] = [];
  const page = pageOf(v, log, {
    readWallet: async (x: { wallet: string; side: string }) => ({ account: x.wallet, height: 1, blockHash: "h", nonce: 1n, held: x.side === "sell" ? 0n : 2_500_000n, registered: true, storageMin: 0n, lostfound: 0n, exists: true }) as never,
    bindRpcs: () => [{ name: "x", query: async () => Promise.reject(new Error("no")) }, { name: "y", query: async () => Promise.reject(new Error("no")) }] as never,
  });
  await nearHoldingsPass(page, { spends: spendsOf([row(nh, W)]), records: recordsFrom({ [W]: recordOf(W, TOKEN, [{ tx: relayed(note, buySwap(TOKEN, BigInt(H - 1))), state: "failed" }]) }), seat: seatOf({ [USDC]: { [W]: 2_500_000n } }) });
  await resumeNearBuys(page);
  assert.ok(!log.some((l) => l.startsWith("near buy resumed")), "never taken up as a buy");
  await resumeNearSells(page).catch(() => {});
  assert.ok(log.includes("near sell recorded"), "the sell pass took it up on the load");
});

test("calls that name two tokens rebuild nothing; a seat answer of another block is refused; a sell whose swap failed leaves the coin a position", async () => {
  const v = await world([5_000_000n], [true]);
  const { w: W, note, nh } = v.ws[0]!;
  const two = { [W]: recordOf(W, null, [{ tx: relayed(note, buySwap()) }, { tx: relayed(note, register(STRANGER)) }]) };
  assert.deepEqual(await nearHoldingsPass(pageOf(v), { spends: spendsOf([row(nh, W)]), records: recordsFrom(two), seat: seatOf({ [TOKEN]: { [W]: 5n } }) }), { written: [], empty: [], unread: [W] });
  // with USDC on W too: still nothing believed (no "sent" record from calls that disagree)
  assert.deepEqual(await nearHoldingsPass(pageOf(v), { spends: spendsOf([row(nh, W)]), records: recordsFrom(two), seat: seatOf({ [USDC]: { [W]: 2_500_000n } }) }), { written: [], empty: [], unread: [W] });
  // a seat whose answer at block_id names another block (or hash): nothing believed, read again later
  const seat = seatOf({ [TOKEN]: { [W]: 5n } });
  const drifting: NearRpc = { name: seat.name, query: async (p, sg) => {
    const a = (await seat.query(p, sg)) as { result: { block_height: number; block_hash: string } };
    if ("block_id" in p) a.result.block_height += 1;
    return a;
  } };
  const one = { [W]: recordOf(W, TOKEN, [{ tx: relayed(note, buySwap()) }]) };
  assert.deepEqual(await nearHoldingsPass(pageOf(v), { spends: spendsOf([row(nh, W)]), records: recordsFrom(one), seat: drifting }), { written: [], empty: [], unread: [W] });
  // a sell's swap that failed on chain: the coin is still W's (all it signed to sell, 7), a position
  const failedSell = { [W]: recordOf(W, TOKEN, [{ tx: relayed(note, buySwap()) }, { tx: relayed(note, sellSwap()), state: "failed" }]) };
  assert.deepEqual((await nearHoldingsPass(pageOf(v), { spends: spendsOf([row(nh, W)]), records: recordsFrom(failedSell), seat: seatOf({ [TOKEN]: { [W]: 7n } }) })).written, [W]);
});

// ---- one seat answer never decides for good ----

const HELD = 5n * 10n ** 18n;
/** W read on the two providers as they truly stand: `coin` of the token, `usdc` of USDC; every read named. */
const twoProviders = (coin: bigint, usdc: bigint, named: string[] = []) => async (x: { wallet: string; side: string }) =>
  (named.push(x.wallet), { account: x.wallet, height: 1, blockHash: "h", nonce: 1n, held: x.side === "sell" ? coin : usdc, registered: true, storageMin: 0n, lostfound: 0n, exists: true }) as never;

test("a seat answer of 0 for a W holding its coin closes it only until the next restore or Sync: a plain load asks nothing of it, the Sync reads it again and the coin shows", async () => {
  const { v, W, reads } = await bought({});
  assert.deepEqual((await nearHoldingsPass(pageOf(v), { ...reads, seat: seatOf({}) })).empty, [W]);
  assert.deepEqual(await softEmpty(v.w), [W]);
  assert.deepEqual(await keptEmpty(v.w), [], "never closed for good on a seat answer");
  const log: string[] = [];
  let asked = 0;
  const honest = { ...reads, seat: seatOf({ [TOKEN]: { [W]: HELD } }, { log }), records: async (ws: readonly string[]) => (asked++, reads.records!(ws)) };
  assert.deepEqual(await nearHoldingsPass(pageOf(v), honest), { written: [], empty: [], unread: [] }, "a plain load leaves it");
  assert.equal(asked + log.length, 0);
  assert.deepEqual(await nearHoldingsPass(pageOf(v), { ...honest, fresh: true }), { written: [W], empty: [], unread: [] });
  assert.equal((await nearPositions(pageOf(v)))[0]?.amount, "5");
  assert.deepEqual(await softEmpty(v.w), []);
});

test("a seat answer of USDC and no coin writes a record of the proven token; the two providers' read on the way home finds the coin and makes it a position, nothing sent", async () => {
  const { v, W, reads } = await bought({});
  assert.deepEqual((await nearHoldingsPass(pageOf(v), { ...reads, seat: seatOf({ [USDC]: { [W]: 2_000_000n } }) })).written, [W]);
  const r = (await records(v.w))[0]!;
  assert.equal(r.token, TOKEN, "the proven token, never Rhea's wrapped NEAR");
  assert.equal(r.stage, "sent");
  const log: string[] = [];
  const page = pageOf(v, log, { readWallet: twoProviders(HELD, 0n) });
  await resumeNearSells(page);
  const after = (await records(v.w))[0]!;
  assert.equal(after.stage, "filled");
  assert.deepEqual(after.fill, { out: HELD.toString(), decimals: 18 });
  assert.equal(after.sell, undefined, "nothing sold or sent");
  assert.equal((await nearPositions(page))[0]?.amount, "5");
  assert.ok(!log.includes("near sell recorded"));
});

test("a paid W with no creation and no call at the helper (another device between its payout and W's creation) is never sent home at once: the next Sync, once that device bought, shows the coin; with no call ever, home once a delegate's life passed", async () => {
  const v = await world([5_000_000n], [true]);
  const { w: W, note, nh } = v.ws[0]!;
  const usdcOnW = seatOf({ [USDC]: { [W]: PAID - FEE } });
  const mid = { spends: spendsOf([row(nh, W)]), records: recordsFrom({ [W]: none(W) }), seat: usdcOnW };
  assert.deepEqual(await nearHoldingsPass(pageOf(v), mid), { written: [], empty: [], unread: [W] });
  assert.deepEqual(await records(v.w), []);
  // the other device created W and bought: its calls at the helper, the coin on W
  const bought2 = { spends: spendsOf([row(nh, W)]), records: recordsFrom({ [W]: recordOf(W, TOKEN, [{ tx: relayed(note, register()) }, { tx: relayed(note, buySwap()) }]) }), seat: seatOf({ [TOKEN]: { [W]: HELD } }), fresh: true };
  assert.deepEqual((await nearHoldingsPass(pageOf(v), bought2)).written, [W]);
  assert.equal((await nearPositions(pageOf(v)))[0]?.amount, "5");
  // no call ever: within a delegate's life of the first read, not yet; past it, home
  const u = await world([5_000_000n], [true]);
  const x = u.ws[0]!;
  const at = (h: number) => ({ spends: spendsOf([row(x.nh, x.w)], h), records: recordsFrom({}), seat: seatOf({ [USDC]: { [x.w]: PAID - FEE } }, { height: h }) });
  assert.deepEqual((await nearHoldingsPass(pageOf(u), at(H))).written, []);
  assert.deepEqual((await nearHoldingsPass(pageOf(u), { ...at(H + Number(NEAR_DELEGATE_LIFE_BLOCKS)), fresh: true })).written, [], "a Sync never restarts or skips the wait");
  assert.deepEqual((await nearHoldingsPass(pageOf(u), at(H + Number(NEAR_DELEGATE_LIFE_BLOCKS) + 1))).written, [x.w]);
});

test("the way home after a rebuild reads one rebuilt W a page load on the two providers: two USDC-only Ws, one named this load, the other on the next", async () => {
  const v = await world([5_000_000n, 6_000_000n], [true, true]);
  const recs = Object.fromEntries(v.ws.map((x) => [x.w, recordOf(x.w, TOKEN, [{ tx: relayed(x.note, buySwap(TOKEN, BigInt(H - 1))), state: "failed" }])]));
  await nearHoldingsPass(pageOf(v), { spends: spendsOf(v.ws.map((x) => row(x.nh, x.w))), records: recordsFrom(recs), seat: seatOf({ [USDC]: Object.fromEntries(v.ws.map((x) => [x.w, 2_500_000n])) }) });
  assert.equal((await records(v.w)).length, 2);
  const named: string[] = [];
  // W reads only, no sell run (its reads refused past the pick): what each load names to the providers
  const load = () => pageOf(v, [], { readWallet: twoProviders(0n, 0n, named) });
  const first = load();
  await resumeNearSells(first);
  await resumeNearSells(first);
  assert.equal(new Set(named).size, 1, "one W this load, however often the pass runs");
  await resumeNearSells(load());
  assert.equal(new Set(named).size, 2, "the other on the next load");
});

test("a sold W's own USDC registration and its claim of USDC from the exchange's lost-found name no token, nor does a claim off the exchange: the bought coin alone is proven", async () => {
  const { v, W, reads } = await bought({}, (n) => [
    { tx: relayed(n, register()) },
    { tx: relayed(n, buySwap()) },
    { tx: relayed(n, register(USDC)) },
    { tx: relayed(n, sellSwap()) },
    { tx: relayed(n, { receiver: EX, method: "claim_lostfound", args: { token_id: USDC } }) },
    { tx: relayed(n, { receiver: STRANGER, method: "claim_lostfound", args: { token_id: STRANGER } }) },
  ]);
  assert.deepEqual((await nearHoldingsPass(pageOf(v), { ...reads, seat: seatOf({ [USDC]: { [W]: 2_500_000n } }) })).written, [W]);
  assert.equal((await records(v.w))[0]!.token, TOKEN);
});

// ---- a stranger's dust: a coin counts only at the floor W itself signed ----

/** W on the two providers as the way home sees it: `coin` of the token and the USDC, which the move takes into the vault
 *  (each amount moved kept), so a run that reaches the move ends with W's USDC in the vault. */
const homeOf = (coin: bigint, usdc: bigint) => {
  const st = { usdc, moved: [] as bigint[] };
  const readWallet = async (x: { wallet: string; side: string }) =>
    ({ account: x.wallet, height: 1, blockHash: "h", nonce: 1n, held: x.side === "sell" ? coin : st.usdc, registered: true, storageMin: 0n, lostfound: 0n, exists: true }) as never;
  const move = async (_w: unknown, _note: string, amount: bigint) => {
    st.moved.push(amount);
    st.usdc -= amount;
    return { kind: "deposited" as const, txs: ["11111111111111111111111111111111"], height: 1 };
  };
  return { st, readWallet, move };
};

const sold = (n: NoteRecord) => [{ tx: relayed(n, register()) }, { tx: relayed(n, buySwap()) }, { tx: relayed(n, sellSwap()), state: "landed" as const, side: "sell" as const }];

test("a sold W a stranger sends 1 unit of its coin shows nothing: under what W's own sell sent in, the coin is not W's position", async () => {
  const { v, W, reads } = await bought({}, sold);
  assert.deepEqual(await nearHoldingsPass(pageOf(v), { ...reads, seat: seatOf({ [TOKEN]: { [W]: 1n } }) }), { written: [], empty: [W], unread: [] });
  assert.deepEqual(await nearPositions(pageOf(v)), []);
});

test("a W whose buy swap failed, holding its USDC and a stranger's 1 unit of the coin: the coin under W's own floor is ignored, the record is on its way home and the way home takes the USDC", async () => {
  const v = await world([5_000_000n], [true]);
  const { w: W, note, nh } = v.ws[0]!;
  // W's own swap let the exchange send no less than 1000 units
  const swap = { ...buySwap(TOKEN, BigInt(H - 1)), args: { ...buySwap().args, msg: JSON.stringify({ force: 0, actions: [{ pool_id: 9, token_in: USDC, token_out: TOKEN, min_amount_out: "1000" }], skip_degen_price_sync: true, skip_unwrap_near: true }) } };
  const recs = recordsFrom({ [W]: recordOf(W, TOKEN, [{ tx: relayed(note, register()) }, { tx: relayed(note, swap), state: "failed" }]) });
  assert.deepEqual((await nearHoldingsPass(pageOf(v), { spends: spendsOf([row(nh, W)]), records: recs, seat: seatOf({ [TOKEN]: { [W]: 1n }, [USDC]: { [W]: 2_500_000n } }) })).written, [W]);
  const r = (await records(v.w))[0]!;
  assert.equal(r.stage, "sent");
  assert.deepEqual(r.swap, { floor: "1000", before: "0" });
  const log: string[] = [];
  const home = homeOf(1n, 2_500_000n);
  await resumeNearSells(pageOf(v, log, { readWallet: home.readWallet, move: home.move }));
  assert.equal((await records(v.w))[0]!.fill, undefined, "never made a position by dust");
  assert.ok(log.includes("near sell move: in the vault"), `the move reached: ${log.join(" | ")}`);
  assert.deepEqual(home.st.moved, [2_500_000n], "W's USDC in the vault");
  assert.equal((await records(v.w))[0]!.sell?.stage, "filled", "dust under the floor leaves W empty");
});

test("a W no call of names a token keeps Rhea's wrapped NEAR as a stand-in that never becomes a position: a stranger's 1 yocto of it leaves the USDC on its way home", async () => {
  const v = await world([5_000_000n], [true]);
  const { w: W, nh } = v.ws[0]!;
  const noCall = (h: number) => ({ spends: spendsOf([row(nh, W)], h), records: recordsFrom({ [W]: none(W) }), seat: seatOf({ [USDC]: { [W]: 2_500_000n } }, { height: h }) });
  await nearHoldingsPass(pageOf(v), noCall(H));
  assert.deepEqual((await nearHoldingsPass(pageOf(v), noCall(H + Number(NEAR_DELEGATE_LIFE_BLOCKS) + 1))).written, [W]);
  const r = (await records(v.w))[0]!;
  assert.equal(r.token, NEAR_RHEA.mainnet.wrap);
  assert.equal(r.swap, undefined, "no floor: no coin of it ever counts");
  const log: string[] = [];
  const home = homeOf(1n, 2_500_000n);
  await resumeNearSells(pageOf(v, log, { readWallet: home.readWallet, move: home.move }));
  assert.equal((await records(v.w))[0]!.stage, "sent");
  assert.ok(log.includes("near sell move: in the vault"), `the move reached: ${log.join(" | ")}`);
  assert.deepEqual(home.st.moved, [2_500_000n], "W's USDC in the vault");
});

test("a live buy's record (not rebuilt) whose swap was sent: W's USDC goes home whatever W holds; dust under the floor is nothing, the coin at its floor is kept a position", async () => {
  const v = await world([5_000_000n], [true]);
  const { w: W, note } = v.ws[0]!;
  const live = { v: 1, id: "req-7", network: NETWORK, token: TOKEN, amount: "2980000", slippage_bps: 100, w: W, l: note.leaf!.label.toString(), j: jOf(note.ref), note: note.id, fee: "20000", created_ms: 1, resumes: NEAR_BUY_RESUMES, stage: "sent", step: "swap", code: "carry_failed", txs: [], payout: "landed", swap: { floor: "1000", before: "0" } };
  await v.w.put("quotes", `${NEAR_BUY_KEY}req-7`, live);
  const log: string[] = [];
  const home = homeOf(1n, 2_500_000n);
  await resumeNearSells(pageOf(v, log, { readWallet: home.readWallet, move: home.move }));
  assert.ok(log.includes("near sell move: in the vault"), `dust: the move reached: ${log.join(" | ")}`);
  assert.deepEqual(home.st.moved, [2_500_000n], "dust: W's USDC in the vault");
  const v2 = await world([5_000_000n], [true]);
  const n2 = v2.ws[0]!.note;
  await v2.w.put("quotes", `${NEAR_BUY_KEY}req-7`, { ...live, w: v2.ws[0]!.w, note: n2.id, l: n2.leaf!.label.toString(), j: jOf(n2.ref) });
  const home2 = homeOf(1000n, 2_500_000n);
  await resumeNearSells(pageOf(v2, [], { readWallet: home2.readWallet, move: home2.move }));
  assert.deepEqual(home2.st.moved, [2_500_000n], "the coin at its floor: W's USDC still home, nothing sold");
  assert.deepEqual((await records(v2.w))[0]!.fill?.out, "1000", "the coin kept, a position");
});

test("one rebuilt W a load reaches the two providers whatever it waits for: two rebuilt Ws with a sell open each, one taken up this load", async () => {
  const v = await world([5_000_000n, 6_000_000n], [true, true]);
  const recs = Object.fromEntries(v.ws.map((x) => [x.w, recordOf(x.w, TOKEN, [{ tx: relayed(x.note, register()) }, { tx: relayed(x.note, buySwap()) }])]));
  await nearHoldingsPass(pageOf(v), { spends: spendsOf(v.ws.map((x) => row(x.nh, x.w))), records: recordsFrom(recs), seat: seatOf({ [TOKEN]: Object.fromEntries(v.ws.map((x) => [x.w, 5n])) }) });
  for (const k of (await v.w.keys("quotes")).filter((x) => x.startsWith(NEAR_BUY_KEY))) {
    const r = (await v.w.get("quotes", k)) as NearBuyRecord;
    await v.w.put("quotes", k, { ...r, sell: { id: `s-${r.w}`, slippage_bps: 100, created_ms: 1, resumes: 0, stage: "pending", step: "swap", txs: [] } });
  }
  const named: string[] = [];
  await resumeNearSells(pageOf(v, [], { readWallet: twoProviders(5n, 0n, named) })).catch(() => {});
  assert.equal(new Set(named).size, 1, `one W this load: ${named.length} reads`);
});

test("a pending call with no last block holds W's USDC only until W's life and the margin passed", async () => {
  const v = await world([5_000_000n], [true]);
  const { w: W, note, nh } = v.ws[0]!;
  const recs = recordsFrom({ [W]: recordOf(W, TOKEN, [{ tx: relayed(note, register()) }, { tx: relayed(note, buySwap()), state: "pending" }], { tx_hash: "c", state: "landed", height: String(H) }) });
  const at = (h: number) => nearHoldingsPass(pageOf(v), { spends: spendsOf([row(nh, W)], h), records: recs, seat: seatOf({ [USDC]: { [W]: 2_500_000n } }, { height: h }) });
  const end = H + Number(NEAR_DELEGATE_LIFE_BLOCKS + NEAR_PENDING_SETTLED_BLOCKS);
  assert.deepEqual((await at(H)).written, []);
  assert.deepEqual((await at(end)).written, []);
  assert.deepEqual((await at(end + 1)).written, [W]);
});

test("a W one seat answer closed is read once on the two providers on the way home: the coin they find there is a position, and a W they read empty stays closed", async () => {
  const { v, W, reads } = await bought({});
  assert.deepEqual((await nearHoldingsPass(pageOf(v), { ...reads, seat: seatOf({}) })).empty, [W]);
  const named: string[] = [];
  await resumeNearSells(pageOf(v, [], { readWallet: twoProviders(HELD, 0n, named) }));
  assert.ok(named.includes(W));
  assert.equal((await nearPositions(pageOf(v)))[0]?.amount, "5");
  // read empty there too: closed, and never read on the two providers again
  const b = await bought({});
  await nearHoldingsPass(pageOf(b.v), { ...b.reads, seat: seatOf({}) });
  const n2: string[] = [];
  await resumeNearSells(pageOf(b.v, [], { readWallet: twoProviders(0n, 0n, n2) }));
  await resumeNearSells(pageOf(b.v, [], { readWallet: twoProviders(0n, 0n, n2) }));
  assert.deepEqual(await records(b.v.w), []);
  assert.equal(n2.filter((x) => x === b.W).length, 2, "one load's read (its two sides), then never again");
});

test("two buy swaps W signed (a round that failed and the one re-signed on a fresh quote): the coin counts from the lower floor of the two", async () => {
  const at = (min: string, mbh: bigint) => ({ ...buySwap(TOKEN, mbh), args: { ...buySwap().args, msg: JSON.stringify({ force: 0, actions: [{ pool_id: 9, token_in: USDC, token_out: TOKEN, min_amount_out: min }], skip_degen_price_sync: true, skip_unwrap_near: true }) } });
  const { v, W, reads } = await bought({}, (n) => [{ tx: relayed(n, register()) }, { tx: relayed(n, at("2000", BigInt(H - 20))), state: "failed" }, { tx: relayed(n, at("1000", BigInt(H - 10))) }]);
  assert.deepEqual((await nearHoldingsPass(pageOf(v), { ...reads, seat: seatOf({ [TOKEN]: { [W]: 1500n } }) })).written, [W]);
  assert.deepEqual((await records(v.w))[0]!.swap, { floor: "1000", before: "0" });
});

test("a token that takes a fee on what the exchange sends: the floor is what reaches W, so the honest coin under the signed minimum still counts", async () => {
  const at = { ...buySwap(), args: { ...buySwap().args, msg: JSON.stringify({ force: 0, actions: [{ pool_id: 9, token_in: USDC, token_out: TOKEN, min_amount_out: "1000" }], skip_degen_price_sync: true, skip_unwrap_near: true }) } };
  const { v, W, reads } = await bought({}, (n) => [{ tx: relayed(n, register()) }, { tx: relayed(n, at) }]);
  const asked: string[] = [];
  const page = pageOf(v, [], { tokenFee: async (t) => (asked.push(t), { buyBps: 500, sellBps: 500, senderPays: false, scope: "all", exempt: [], unknown: false }) });
  assert.deepEqual((await nearHoldingsPass(page, { ...reads, seat: seatOf({ [TOKEN]: { [W]: 960n } }) })).written, [W]);
  assert.deepEqual(asked, [TOKEN]);
  assert.deepEqual((await records(v.w))[0]!.swap, { floor: "950", before: "0" });
});

test("a token fee read as not known (code not pinned) is taken at the widest fee the device reads: W is never left unread for good; its USDC comes home and its coin shows", async () => {
  const unknown = async () => ({ buyBps: 0, sellBps: 0, senderPays: false, scope: [] as string[], exempt: [] as string[], unknown: true });
  // W's buy swap failed: 2.5 USDC on W and none of the coin, three passes
  const v = await world([5_000_000n], [true]);
  const { w: W, note, nh } = v.ws[0]!;
  const failed = { ...buySwap(TOKEN, BigInt(H - 1)), args: { ...buySwap().args, msg: JSON.stringify({ force: 0, actions: [{ pool_id: 9, token_in: USDC, token_out: TOKEN, min_amount_out: "1000" }], skip_degen_price_sync: true, skip_unwrap_near: true }) } };
  const recs = recordsFrom({ [W]: recordOf(W, TOKEN, [{ tx: relayed(note, register()) }, { tx: relayed(note, failed), state: "failed" }]) });
  const page = pageOf(v, [], { tokenFee: unknown });
  const pass = () => nearHoldingsPass(page, { spends: spendsOf([row(nh, W)]), records: recs, seat: seatOf({ [USDC]: { [W]: 2_500_000n } }) });
  assert.deepEqual(await pass(), { written: [W], empty: [], unread: [] });
  const r = (await records(v.w))[0]!;
  assert.deepEqual([r.stage, r.swap], ["sent", { floor: "1", before: "0" }], "1000 at 9,999 bps is under 1: the floor is 1");
  const home = homeOf(0n, 2_500_000n);
  await resumeNearSells(pageOf(v, [], { readWallet: home.readWallet, move: home.move }));
  assert.deepEqual(home.st.moved, [2_500_000n], "W's USDC in the vault");
  // a W holding 5000 of its coin under an unknown fee: a position
  const at = { ...buySwap(), args: { ...buySwap().args, msg: JSON.stringify({ force: 0, actions: [{ pool_id: 9, token_in: USDC, token_out: TOKEN, min_amount_out: "1000" }], skip_degen_price_sync: true, skip_unwrap_near: true }) } };
  const b = await bought({}, (n) => [{ tx: relayed(n, register()) }, { tx: relayed(n, at) }]);
  assert.deepEqual(await nearHoldingsPass(pageOf(b.v, [], { tokenFee: unknown }), { ...b.reads, seat: seatOf({ [TOKEN]: { [b.W]: 5000n } }) }), { written: [b.W], empty: [], unread: [] });
  assert.deepEqual((await records(b.v.w))[0]!.fill?.out, "5000");
});

// ---- round 7's grid: the USDC decision and the coin decision apart, at every site ----

/** W's buy swap signed at min_amount_out 1,000,000 of the coin. Restored: the token's fee not known, so the plain floor is
 *  1,000,000 at the widest fee (9,999 bps) = 100. Live: the device's own record, its floor 1,000,000 (no fee). */
const SIGNED_MIN = "1000000";
const signedSwap = { ...buySwap(), args: { ...buySwap().args, msg: JSON.stringify({ force: 0, actions: [{ pool_id: 9, token_in: USDC, token_out: TOKEN, min_amount_out: SIGNED_MIN }], skip_degen_price_sync: true, skip_unwrap_near: true }) } };
const feeUnknown = async () => ({ buyBps: 0, sellBps: 0, senderPays: false, scope: [] as string[], exempt: [] as string[], unknown: true });
type When = "before" | "after" | "mid";
/** What a cell ends with: the position shown (whole units of 18 decimals as nearPositions gives them, or null), the USDC
 *  moved into the vault, and the record (stage, fill, the sell's stage; "none" for no record). */
type End = { pos: string | null; home: bigint; rec: string };

/**
 * One cell: W holds `coin` of the token throughout and `usdc` of USDC that arrives `when` (before the rebuild, after it,
 * or mid way home: after the way home's first USDC read). The run: the restore's pass (restored) or the live record, then
 * a load, a load, a Sync (the pass fresh, then a load), a load; its end; then a load and a Sync again, which change nothing.
 */
async function cell(device: "restored" | "live" | "live-filled", coin: bigint, usdc: bigint, when: When): Promise<{ end: End; again: End; tap: string[]; tapHome: bigint }> {
  const v = await world([5_000_000n], [true]);
  const { w: W, note, nh } = v.ws[0]!;
  const st = { coin, usdc: when === "before" ? usdc : 0n, moved: 0n, armed: when === "mid" };
  const readWallet = async (x: { wallet: string; side: string }) => {
    const held = x.side === "sell" ? st.coin : st.usdc;
    // mid way home: the USDC lands just after the way home's first read of it (that read saw none)
    if (x.side === "buy" && st.armed) (st.armed = false, (st.usdc = usdc));
    return { account: x.wallet, height: 1, blockHash: "h", nonce: 1n, held, registered: true, storageMin: 0n, lostfound: 0n, exists: true } as never;
  };
  const move = async (_w: unknown, _n: string, amount: bigint) => ((st.moved += amount), (st.usdc -= amount), { kind: "deposited" as const, txs: ["11111111111111111111111111111111"], height: 1 });
  const seat: NearRpc = {
    name: NEAR_NETWORKS.mainnet.seat!,
    async query(p) {
      const args = JSON.parse(atob(String(p.args_base64)));
      const at = "block_id" in p ? Number(p.block_id) : H;
      const of = String(p.account_id) === TOKEN ? st.coin : String(p.account_id) === USDC ? st.usdc : 0n;
      const val = p.method_name === "ft_balance_of" ? String(args.account_id === W ? of : 0n) : p.method_name === "get_lostfound_token" ? "0" : null;
      return { result: { block_height: at, block_hash: `H${at}`, result: [...new TextEncoder().encode(JSON.stringify(val))] } };
    },
  };
  const reads: NearHoldingsReads = { spends: spendsOf([row(nh, W)]), records: recordsFrom({ [W]: recordOf(W, TOKEN, [{ tx: relayed(note, register()) }, { tx: relayed(note, signedSwap) }]) }), seat };
  const log: string[] = [];
  const page = () => pageOf(v, log, { readWallet, move, tokenFee: feeUnknown });
  const load = () => resumeNearSells(page()).catch(() => {});
  const sync = async () => (await nearHoldingsPass(page(), { ...reads, fresh: true }), await load());
  if (device === "restored") await nearHoldingsPass(page(), reads);
  else {
    const live = { v: 1, id: "req-7", network: NETWORK, token: TOKEN, amount: "2980000", slippage_bps: 100, w: W, l: note.leaf!.label.toString(), j: jOf(note.ref), note: note.id, fee: "20000", created_ms: 1, resumes: NEAR_BUY_RESUMES, stage: "sent", step: "swap", code: "carry_failed", txs: [], payout: "landed", swap: { floor: SIGNED_MIN, before: "0" } };
    // live-filled: the live buy read its fill, 950,000 of a token whose fee took 5% under the signed 1,000,000
    await v.w.put("quotes", `${NEAR_BUY_KEY}req-7`, device === "live" ? live : { ...Object.fromEntries(Object.entries(live).filter(([k]) => k !== "code")), stage: "filled", step: "receive", fill: { out: "950000", decimals: 18 } });
  }
  // after the rebuild (restored) or after the first load (live)
  if (when === "after" && device === "restored") st.usdc = usdc;
  const endOf = async (): Promise<End> => {
    const rs = await records(v.w);
    const r = rs[0];
    const pos = (await nearPositions(page()))[0]?.amount ?? null;
    return { pos, home: st.moved, rec: r === undefined ? "none" : `${r.stage}${r.fill ? ` ${r.fill.out}` : ""}${r.sell ? ` sell ${r.sell.stage}` : ""}` };
  };
  await load();
  if (when === "after" && device !== "restored") st.usdc = usdc;
  await load();
  await sync();
  await load();
  const end = await endOf();
  await load();
  await sync();
  const again = await endOf();
  // the tap: a sale the user asks reads W's coin as held wherever a position is shown
  const tap: string[] = [];
  if (end.pos !== null) {
    const r = nearSellKind(pageOf(v, tap, { readWallet, move, tokenFee: feeUnknown }))({ token: TOKEN, slippageBps: 100 }, { id: "tap-1", sha: "00", progress: () => {} });
    if ("running" in r) await r.after.catch(() => {});
  }
  return { end, again, tap, tapHome: st.moved - again.home };
}


/**
 * Each cell's end, as literal data: [device, the coin on W, the USDC on W, its end ("position home record", one for all
 * three arrivals, or [before, after, mid])]. The position is whole units at 18 decimals; home is the USDC moved into the
 * vault; the record is its stage, its fill and its sell's stage. Read against round 7's rule:
 * - W's USDC of the least deposit (1,000,000) goes home whatever W holds; under it nothing moves (the vault takes no less).
 * - The coin counts at its floor alone: restored 100 (the plain floor, the fee not known), live 1,000,000. Under it the
 *   coin is a stranger's dust: never shown, never holding the USDC back.
 * - The read budget: a position's W (its record "filled") is not read on a load, so USDC that lands on it after the
 *   record is filled (after the rebuild, or mid way home after a read that saw none) stays on W until the user's own
 *   sale moves it (near-sell's move takes W's whole USDC). A load and a Sync later change nothing.
 * - A live record stopped at its swap whose W holds nothing over the least deposit and none of its coin stays "sent"
 *   (read again each load), as before round 7.
 * - live-filled: the live buy's fill (950,000, under the signed 1,000,000 by the token's fee) stands; W is never read on
 *   a load, so no USDC moves whatever lands there.
 */
const GRID: readonly (readonly [device: "restored" | "live" | "live-filled", coin: bigint, usdc: bigint, end: string | readonly [string, string, string]])[] = [
  ["restored", 0n, 0n, "null 0 none"],
  ["restored", 0n, 999_999n, "null 0 none"],
  ["restored", 0n, 1_000_000n, "null 1000000 sent sell filled"],
  ["restored", 0n, 2_500_000n, "null 2500000 sent sell filled"],
  ["restored", 1n, 0n, "null 0 none"],
  ["restored", 1n, 999_999n, "null 0 none"],
  ["restored", 1n, 1_000_000n, "null 1000000 sent sell filled"],
  ["restored", 1n, 2_500_000n, "null 2500000 sent sell filled"],
  ["restored", 99n, 0n, "null 0 none"],
  ["restored", 99n, 999_999n, "null 0 none"],
  ["restored", 99n, 1_000_000n, "null 1000000 sent sell filled"],
  ["restored", 99n, 2_500_000n, "null 2500000 sent sell filled"],
  ["restored", 100n, 0n, "0.0000000000000001 0 filled 100"],
  ["restored", 100n, 999_999n, "0.0000000000000001 0 filled 100"],
  ["restored", 100n, 1_000_000n, ["0.0000000000000001 1000000 filled 100 sell refused", "0.0000000000000001 0 filled 100", "0.0000000000000001 0 filled 100"]],
  ["restored", 100n, 2_500_000n, ["0.0000000000000001 2500000 filled 100 sell refused", "0.0000000000000001 0 filled 100", "0.0000000000000001 0 filled 100"]],
  ["restored", 10_000n, 0n, "0.00000000000001 0 filled 10000"],
  ["restored", 10_000n, 999_999n, "0.00000000000001 0 filled 10000"],
  ["restored", 10_000n, 1_000_000n, ["0.00000000000001 1000000 filled 10000 sell refused", "0.00000000000001 0 filled 10000", "0.00000000000001 0 filled 10000"]],
  ["restored", 10_000n, 2_500_000n, ["0.00000000000001 2500000 filled 10000 sell refused", "0.00000000000001 0 filled 10000", "0.00000000000001 0 filled 10000"]],
  ["restored", 950_000n, 0n, "0.00000000000095 0 filled 950000"],
  ["restored", 950_000n, 999_999n, "0.00000000000095 0 filled 950000"],
  ["restored", 950_000n, 1_000_000n, ["0.00000000000095 1000000 filled 950000 sell refused", "0.00000000000095 0 filled 950000", "0.00000000000095 0 filled 950000"]],
  ["restored", 950_000n, 2_500_000n, ["0.00000000000095 2500000 filled 950000 sell refused", "0.00000000000095 0 filled 950000", "0.00000000000095 0 filled 950000"]],
  ["restored", 1_000_000n, 0n, "0.000000000001 0 filled 1000000"],
  ["restored", 1_000_000n, 999_999n, "0.000000000001 0 filled 1000000"],
  ["restored", 1_000_000n, 1_000_000n, ["0.000000000001 1000000 filled 1000000 sell refused", "0.000000000001 0 filled 1000000", "0.000000000001 0 filled 1000000"]],
  ["restored", 1_000_000n, 2_500_000n, ["0.000000000001 2500000 filled 1000000 sell refused", "0.000000000001 0 filled 1000000", "0.000000000001 0 filled 1000000"]],
  ["live", 0n, 0n, "null 0 sent"],
  ["live", 0n, 999_999n, "null 0 sent"],
  ["live", 0n, 1_000_000n, "null 1000000 sent sell filled"],
  ["live", 0n, 2_500_000n, "null 2500000 sent sell filled"],
  ["live", 1n, 0n, "null 0 sent"],
  ["live", 1n, 999_999n, "null 0 sent"],
  ["live", 1n, 1_000_000n, "null 1000000 sent sell filled"],
  ["live", 1n, 2_500_000n, "null 2500000 sent sell filled"],
  ["live", 99n, 0n, "null 0 sent"],
  ["live", 99n, 999_999n, "null 0 sent"],
  ["live", 99n, 1_000_000n, "null 1000000 sent sell filled"],
  ["live", 99n, 2_500_000n, "null 2500000 sent sell filled"],
  ["live", 100n, 0n, "null 0 sent"],
  ["live", 100n, 999_999n, "null 0 sent"],
  ["live", 100n, 1_000_000n, "null 1000000 sent sell filled"],
  ["live", 100n, 2_500_000n, "null 2500000 sent sell filled"],
  ["live", 10_000n, 0n, "null 0 sent"],
  ["live", 10_000n, 999_999n, "null 0 sent"],
  ["live", 10_000n, 1_000_000n, "null 1000000 sent sell filled"],
  ["live", 10_000n, 2_500_000n, "null 2500000 sent sell filled"],
  ["live", 950_000n, 0n, "null 0 sent"],
  ["live", 950_000n, 999_999n, "null 0 sent"],
  ["live", 950_000n, 1_000_000n, "null 1000000 sent sell filled"],
  ["live", 950_000n, 2_500_000n, "null 2500000 sent sell filled"],
  ["live", 1_000_000n, 0n, "0.000000000001 0 filled 1000000"],
  ["live", 1_000_000n, 999_999n, "0.000000000001 0 filled 1000000"],
  ["live", 1_000_000n, 1_000_000n, ["0.000000000001 1000000 filled 1000000 sell refused", "0.000000000001 0 filled 1000000", "0.000000000001 0 filled 1000000"]],
  ["live", 1_000_000n, 2_500_000n, ["0.000000000001 2500000 filled 1000000 sell refused", "0.000000000001 0 filled 1000000", "0.000000000001 0 filled 1000000"]],
  ["live-filled", 950_000n, 0n, "0.00000000000095 0 filled 950000"],
  ["live-filled", 950_000n, 999_999n, "0.00000000000095 0 filled 950000"],
  ["live-filled", 950_000n, 1_000_000n, "0.00000000000095 0 filled 950000"],
  ["live-filled", 950_000n, 2_500_000n, "0.00000000000095 0 filled 950000"],
];

test("round 7's grid: every cell of the coin on W, the USDC on W, the device and when the USDC lands ends as its row says, a later load and Sync change nothing, and a tap reads the coin wherever a position shows", async () => {
  assert.equal(GRID.length, 60);
  const failed: string[] = [];
  for (const [device, coin, usdc, end] of GRID)
    for (const [k, when] of (["before", "after", "mid"] as const).entries()) {
      const want = typeof end === "string" ? end : end[k]!;
      const c = await cell(device, coin, usdc, when);
      const got = `${c.end.pos} ${c.end.home} ${c.end.rec}`;
      const again = `${c.again.pos} ${c.again.home} ${c.again.rec}`;
      const tapped = c.tap.includes("near sell read: token held");
      if (got !== want || again !== got || tapped !== (c.end.pos !== null)) failed.push(`${device} coin ${coin} usdc ${usdc} ${when}: ${got} (again ${again}, tap ${tapped}), want ${want}`);
    }
  assert.deepEqual(failed, []);
});

test("a stored record whose swap carries a funded floor (7059859c3 wrote one) still reads, and the funded floor is never used: dust at it is no coin and the USDC goes home", async () => {
  const v = await world([5_000_000n], [true]);
  const { w: W, note } = v.ws[0]!;
  const live = { v: 1, id: "req-7", network: NETWORK, token: TOKEN, amount: "2980000", slippage_bps: 100, w: W, l: note.leaf!.label.toString(), j: jOf(note.ref), note: note.id, fee: "20000", created_ms: 1, resumes: NEAR_BUY_RESUMES, stage: "sent", step: "swap", code: "carry_failed", txs: [], payout: "landed", swap: { floor: "1000000", before: "0", funded: "100" } };
  await v.w.put("quotes", `${NEAR_BUY_KEY}req-7`, live);
  assert.ok(nearBuyRecordOf(await v.w.get("quotes", `${NEAR_BUY_KEY}req-7`)), "the record reads");
  const log: string[] = [];
  const home = homeOf(100n, 2_500_000n);
  await resumeNearSells(pageOf(v, log, { readWallet: home.readWallet, move: home.move }));
  assert.deepEqual(home.st.moved, [2_500_000n], "W's USDC in the vault");
  assert.deepEqual(await nearPositions(pageOf(v)), [], "100 under the floor of 1,000,000: no position, whatever funded says");
});

test("a W one seat answer closed that the two providers read holding its coin and 2.5 USDC: a record on its way home, never a position that holds the USDC; the next load moves the USDC and keeps the coin", async () => {
  const { v, W, reads } = await bought({});
  assert.deepEqual((await nearHoldingsPass(pageOf(v), { ...reads, seat: seatOf({}) })).empty, [W]);
  const home = homeOf(HELD, 2_500_000n);
  await resumeNearSells(pageOf(v, [], { readWallet: home.readWallet, move: home.move }));
  const r = (await records(v.w))[0]!;
  assert.deepEqual([r.stage, r.fill], ["sent", undefined], "the USDC decides first: on its way home");
  await resumeNearSells(pageOf(v, [], { readWallet: home.readWallet, move: home.move }));
  assert.deepEqual(home.st.moved, [2_500_000n], "W's USDC in the vault");
  assert.equal((await nearPositions(pageOf(v)))[0]?.amount, "5", "the coin kept, a position");
});

test("a record whose W held 500 of the coin before its swap (its baseline) and holds 1700 after: the position is what the swap brought, 1200", async () => {
  const v = await world([5_000_000n], [true]);
  const { w: W, note } = v.ws[0]!;
  const live = { v: 1, id: "req-7", network: NETWORK, token: TOKEN, amount: "2980000", slippage_bps: 100, w: W, l: note.leaf!.label.toString(), j: jOf(note.ref), note: note.id, fee: "20000", created_ms: 1, resumes: NEAR_BUY_RESUMES, stage: "sent", step: "swap", code: "carry_failed", txs: [], payout: "landed", swap: { floor: "1000", before: "500" } };
  await v.w.put("quotes", `${NEAR_BUY_KEY}req-7`, live);
  const home = homeOf(1700n, 0n);
  await resumeNearSells(pageOf(v, [], { readWallet: home.readWallet, move: home.move }));
  assert.deepEqual((await records(v.w))[0]!.fill?.out, "1200");
  assert.deepEqual(home.st.moved, []);
});

// ---- round 8: whether a run is the way home or a sale is stored on its sell mark, never inferred ----

/** A live record stopped at its swap (floor 1000), W read as `st` holds it; the move given, counted. */
async function liveAtSwap(coin: bigint, usdc: bigint, o: { sell?: Record<string, unknown>; code?: string; step?: string; fill?: boolean } = {}) {
  const v = await world([5_000_000n], [true]);
  const { w: W, note } = v.ws[0]!;
  const rec = { v: 1, id: "req-8", network: NETWORK, token: TOKEN, amount: "2980000", slippage_bps: 100, w: W, l: note.leaf!.label.toString(), j: jOf(note.ref), note: note.id, fee: "20000", created_ms: 1, resumes: NEAR_BUY_RESUMES, stage: "sent", step: o.step ?? "swap", code: o.code ?? "carry_failed", txs: [], payout: "landed", swap: { floor: "1000", before: "0" }, ...(o.sell ? { sell: o.sell } : {}) };
  await v.w.put("quotes", `${NEAR_BUY_KEY}req-8`, rec);
  const st = { coin, usdc, moved: [] as bigint[], pools: 0 };
  const readWallet = async (x: { wallet: string; side: string }) => ({ account: x.wallet, height: 1, blockHash: "h", nonce: 1n, held: x.side === "sell" ? st.coin : st.usdc, registered: true, storageMin: 0n, lostfound: 0n, exists: true }) as never;
  const move = async (_w: unknown, _n: string, amount: bigint) => (st.moved.push(amount), (st.usdc -= amount), { kind: "deposited" as const, txs: ["11111111111111111111111111111111"], height: 1 });
  const page = (log: string[], m: NearBuyPage["move"] = move) => pageOf(v, log, { readWallet, move: m, pools: async () => (st.pools++, []) });
  const rec8 = async () => (await records(v.w))[0]!;
  return { v, W, st, page, move, rec8 };
}
/** A sale's lines: a quote read, a swap signed or sent. */
const saleLines = (log: string[]) => log.filter((l) => /^near sell (quote|swap|stopped at (quote|swap))/.test(l));

test("P2-L a way home whose move throws once is taken up on the next load as the way home: no quote, no swap, nothing of a sale signed; the coin kept, the USDC home, the sell refused", async () => {
  const x = await liveAtSwap(5000n, 2_500_000n);
  let once = true;
  const throwsOnce: NearBuyPage["move"] = async (w, n, a) => {
    if (once) throw ((once = false), new Error("timed out"));
    return x.move(w, n, a);
  };
  const first: string[] = [];
  await resumeNearSells(x.page(first, throwsOnce)).catch(() => {});
  const stored = (await x.rec8()).sell?.home;
  const next: string[] = [];
  await resumeNearSells(x.page(next, throwsOnce)).catch(() => {});
  assert.deepEqual(saleLines([...first, ...next]), [], `no sale: ${next.join(" | ")}`);
  assert.equal(stored, true, `the way home stored on its mark: ${first.join(" | ")}`);
  assert.equal(x.st.pools, 0, "no pool read for a quote");
  assert.deepEqual(x.st.moved, [2_500_000n], "W's USDC in the vault");
  const r = await x.rec8();
  assert.deepEqual([r.stage, r.fill?.out, r.sell?.stage, r.sell?.code], ["filled", "5000", "refused", "coin_kept"]);
  // a later load: nothing more
  const later: string[] = [];
  await resumeNearSells(x.page(later)).catch(() => {});
  // (the mock move leaves W's return note PLANNED, so a later load takes the note up again: never as a sale)
  assert.deepEqual([saleLines(later), x.st.pools], [[], 0]);
});

test("P2-L a way home whose page closes during the move's wait is taken up on the next load as the way home: no quote, no swap, nothing of a sale signed", async () => {
  const x = await liveAtSwap(5000n, 2_500_000n);
  const first: string[] = [];
  // the first page closes while its move waits: its run never returns, and its locks go with it (a closed page holds
  // none), so that page takes its locks from a manager of its own
  const own = { request: (_n: string, _o: unknown, fn: () => unknown) => Promise.resolve(fn()) } as unknown as LockManager;
  void resumeNearSells({ ...x.page(first, () => new Promise(() => {})), locks: own });
  for (let k = 0; k < 50 && !first.some((l) => l.startsWith("near sell move")) && (await x.rec8()).sell?.step !== "move"; k++) await new Promise((r) => setTimeout(r, 5));
  const next: string[] = [];
  await resumeNearSells(x.page(next)).catch(() => {});
  assert.deepEqual(saleLines([...first, ...next]), [], `no sale: ${next.join(" | ")}`);
  assert.equal(x.st.pools, 0);
  assert.deepEqual(x.st.moved, [2_500_000n]);
  assert.deepEqual((await x.rec8()).fill?.out, "5000");
});

test("P2-L the other side: a tap's sale that stopped partway resumes on the next load as a sale (its quote read); a tap on a way home that stopped makes it a sale", async () => {
  const sale = { id: "tap-1", slippage_bps: 100, created_ms: 1, resumes: 0, stage: "sent", step: "quote", txs: [] };
  const a = await liveAtSwap(5000n, 0n, { sell: sale });
  const la: string[] = [];
  await resumeNearSells(a.page(la)).catch(() => {});
  assert.ok(la.some((l) => l.startsWith("near sell quote")), `the sale goes on: ${la.join(" | ")}`);
  // the same mark stored as the way home: no quote on a load
  const b = await liveAtSwap(5000n, 0n, { sell: { ...sale, id: "home-1", home: true } });
  const lb: string[] = [];
  await resumeNearSells(b.page(lb)).catch(() => {});
  assert.deepEqual(saleLines(lb), [], `the way home goes on: ${lb.join(" | ")}`);
  // a tap on a W whose way home stopped: the user's sale, its quote read
  const c = await liveAtSwap(5000n, 0n, { sell: { ...sale, id: "home-2", home: true } });
  const lc: string[] = [];
  const r = nearSellKind(c.page(lc))({ token: TOKEN, slippageBps: 100 }, { id: "tap-2", sha: "00", progress: () => {} });
  if ("running" in r) await r.after.catch(() => {});
  assert.ok(lc.some((l) => l.startsWith("near sell quote")), `the tap sells: ${lc.join(" | ")}`);
  assert.equal((await c.rec8()).sell?.home, undefined);
});

test("P3-K a buy that ended below its floor with no fill (its USDC read failed): the way home writes the fill once W's USDC is under the least deposit and W holds more than its baseline", async () => {
  const x = await liveAtSwap(900n, 0n, { code: "received_below_floor", step: "receive" });
  await resumeNearSells(x.page([])).catch(() => {});
  assert.deepEqual((await x.rec8()).fill?.out, "900");
  assert.deepEqual(x.st.moved, []);
  // nothing over its baseline: no fill
  const y = await liveAtSwap(0n, 0n, { code: "received_below_floor", step: "receive" });
  await resumeNearSells(y.page([])).catch(() => {});
  assert.equal((await y.rec8()).fill, undefined);
  // another code (a swap that never left): a coin under the floor is dust, no fill
  const z = await liveAtSwap(900n, 0n);
  await resumeNearSells(z.page([])).catch(() => {});
  assert.equal((await z.rec8()).fill, undefined);
});

test("a record whose tap sale was refused with nothing sent (its quote not read), W holding its coin and under 1 USDC: the load shows the coin, a position", async () => {
  const x = await liveAtSwap(5000n, 0n, { sell: { id: "tap-1", slippage_bps: 100, created_ms: 1, resumes: 0, stage: "refused", step: "quote", code: "quote_check_failed", txs: [] } });
  await resumeNearSells(x.page([])).catch(() => {});
  assert.deepEqual((await x.rec8()).fill?.out, "5000");
});
