// The signing page's own EVM pool code on a local fork of Base or Robinhood mainnet (card evm-money-shows-and-spends-at-once),
// the deployed pool (the wallet's EVM_POOLS pin) at the fork block, with nothing signed or sent on any real chain:
//   node contracts/pool-evm/test/fork-rpc.mjs [--record] --book pools -- sh packages/signpage/scripts/pool-fork-evm.sh <base|robinhood> <S> <out.json>
// (pool-fork-evm.sh starts anvil at POOLS_FORK_BLOCKS with --slots-in-an-epoch <S>, then runs
//   node packages/signpage/scripts/pool-fork-evm.mjs <chain> http://127.0.0.1:<port> <out.json> --slots <S> --lag <L>;
// anvil is a heavy job: scripts/heavy.sh).
// - Every request the page makes to the chain's pool pair (src/pool-testnet.ts MAINNET_POOL_RPCS, two operators) is
//   answered by the fork's anvil, the URL kept on each RPC so the pair stays two providers; a request to any other
//   host throws: nothing reaches a real chain or the helper.
// - The seed is the published all-zero test vector (packages/wallet/test/vectors/a8.json): its U is funded on the fork
//   only (anvil_setBalance), never on a chain.
// - Finalized trails the head as on mainnet: anvil answers "finalized" as the head less 2 x --slots-in-an-epoch blocks.
//   The run mines 2 x slots + 1 blocks first, lag / (2 x slots) s apart, the first `lag` s before the wall clock
//   (evm_setNextBlockTimestamp, then anvil_mine at that interval), so the head's time is now and finalized, 2 x slots
//   blocks back, trails it by `lag` s, the lag read on the chain's mainnet pair. The trail matches mainnet in time, not
//   in block count: few blocks, far apart (each block anvil mines reads one slot of the chain's EIP-2935 block-hash
//   contract upstream, so a trail of mainnet's ~5,000 blocks would cost as many recorded reads).
// Steps, each timed from the wall clock and printed:
//   1. device A: the ask (pool.deposit of the ladder's least rung) names U short, U is funded, the ask again sends U's
//      deposit (src/pool-deposit-evm.ts runPoolDepositEvm); the note shows UNSPENT and in the balance once the
//      newest agreed block holds it, its block above finalized;
//   2. device B, a fresh profile: the restore from the seed alone (the wallet's evmRestoreNotes, then writeRestored,
//      as src/pool-restore.ts writes it) shows the note UNSPENT;
//   3. the heal: the fork goes back to before the deposit (evm_revert) and mines another block at its height; each
//      device's settle pass (the wallet's evmSettleReserved, as the page's state read runs it) backs the note out
//      (INCOMING, out of the balance); the same signed deposit is sent again and lands in a later block; each device's
//      load pass (runPoolDepositEvm with no ask, what the page's settleEvm runs on load and on each state read while an
//      INCOMING note is open, src/pool-testnet.ts) lands it again at its new block.
// It writes each step's reads and times to <out.json>. Nothing here logs a key or the words.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { entropyToWords, wordsToSeed64 } from "../../wallet/src/derive/index.ts";
import { depositIdEvm } from "../../wallet/src/derive/keys.ts";
import { openWalletStore, WALLET_LANES } from "../../wallet/src/store/index.ts";
import { openNoteStore, readNotes, refKey } from "../../wallet/src/notes/store.ts";
import { writeRestored } from "../../wallet/src/notes/restore.ts";
import { EVM_CHAIN_IDS, EVM_LADDER, EVM_POOLS, evmPoolScopeOf, evmTreeSync } from "../../wallet/src/pool/evm.ts";
import { evmRestoreNotes } from "../../wallet/src/pool/evm-restore.ts";
import { evmSettleReserved } from "../../wallet/src/pool/evm-settle.ts";
import { MAINNET_POOL_RPCS } from "../src/pool-testnet.ts";
import { POOL_DEPOSIT_EVM_FOLLOW_MS, runPoolDepositEvm } from "../src/pool-deposit-evm.ts";

const [CHAIN, ANVIL, OUT] = process.argv.slice(2);
const SLOTS_AT = process.argv.indexOf("--slots");
const SLOTS = SLOTS_AT > 0 && /^\d+$/.test(process.argv[SLOTS_AT + 1] ?? "") ? BigInt(process.argv[SLOTS_AT + 1]) : 0n;
const LAG_AT = process.argv.indexOf("--lag");
const LAG = LAG_AT > 0 && /^\d+$/.test(process.argv[LAG_AT + 1] ?? "") ? BigInt(process.argv[LAG_AT + 1]) : 0n;
if ((CHAIN !== "base" && CHAIN !== "robinhood") || !/^http:\/\/127\.0\.0\.1:\d+$/.test(ANVIL ?? "") || !OUT || SLOTS <= 0n || LAG < 2n * SLOTS)
  throw new Error("usage: pool-fork-evm.mjs <base|robinhood> http://127.0.0.1:<port> <out.json> --slots <n> --lag <s, at least 2n>");
const SPACING = LAG / (2n * SLOTS);
const PIN = EVM_POOLS[CHAIN];
const URLS = MAINNET_POOL_RPCS[CHAIN];
const HOSTS = new Set(URLS.map((u) => new URL(u).host));
const t0 = Date.now();
const at = () => Date.now() - t0;
const log = (s) => console.log(`${new Date().toISOString()} +${(at() / 1000).toFixed(1)}s ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => `0x${BigInt(n).toString(16)}`;

// the page's pair answered by the fork; any other host refused
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  if (u.origin === ANVIL) return realFetch(input, init);
  if (HOSTS.has(u.host)) return realFetch(ANVIL, init);
  throw new Error(`pool-fork-evm: no request past the fork (${u.host})`);
};
let id = 0;
const anvil = async (method, params) => {
  const j = await (await realFetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })).json();
  if (j.error) throw new Error(`RPC error ${j.error.code}: ${j.error.message}`);
  return j.result;
};
const raws = [];
// each step's calls on the pair: by method, their count, their ms and the errors' messages (methods and messages only,
// never a parameter), printed with the step and cleared
let calls = {};
const took = () => {
  const out = calls;
  calls = {};
  return out;
};
/** One provider of the pair, by its own URL (fetched as the fork). */
const rpcOf = (url) => Object.assign(async (method, params) => {
  const s = performance.now();
  const c = (calls[method] ??= { n: 0, ms: 0, errors: [] });
  c.n++;
  try {
    const j = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })).json();
    if (j.error) throw new Error(`RPC error ${j.error.code}: ${j.error.message}`);
    if (method === "eth_sendRawTransaction") raws.push(params[0]);
    return j.result;
  } catch (e) {
    if (c.errors.length < 3) c.errors.push(String(e?.message ?? e).slice(0, 200));
    throw e;
  } finally {
    c.ms += Math.round(performance.now() - s);
  }
}, { url });
/** A fork transaction's receipt, read only once a block of this fork holds it: anvil sends a hash it does not know to
 *  the forked chain's provider, so a receipt asked before the block is mined would name a fork-only tx upstream. */
const minedReceipt = async (hash) => {
  for (let k = 0; k < 100; k++) {
    const top = BigInt(await anvil("eth_blockNumber", []));
    for (let n = top; n > top - 5n; n--) if ((await anvil("eth_getBlockByNumber", [hex(n), false])).transactions.includes(hash)) return anvil("eth_getTransactionReceipt", [hash]);
    await sleep(100);
  }
  throw new Error(`${hash} not mined on the fork`);
};
const block = async (tag) => {
  const b = await anvil("eth_getBlockByNumber", [tag, false]);
  return { number: BigInt(b.number), hash: b.hash, timestamp: BigInt(b.timestamp) };
};

// what this run sets, apart from what it reads (every other number in the steps is read from the fork's own answers)
const record = {
  by: "packages/signpage/scripts/pool-fork-evm.mjs",
  chain: CHAIN,
  pool: PIN.pool,
  pair: URLS,
  set: {
    slots: String(SLOTS),
    trailBlocks: String(2n * SLOTS),
    lagS: String(LAG),
    trailSpacingS: String(SPACING),
    seed: "the all-zero test vector (packages/wallet/test/vectors/a8.json)",
    funded: "U's balance set to the wei the first ask names short (anvil_setBalance), on the fork only",
    reorg: "evm_revert to before the deposit, then empty blocks to its height",
    why: "lagS is the head-to-finalized lag read on the chain's mainnet pair (live check evm-money-shows-and-spends-at-once); the trail's 2 x slots blocks span it, so finalized trails the head by about that many seconds",
    read: "every number in steps: blocks, hashes, times, notes, balances, the fork's own answers",
  },
  steps: [],
};
const step = (name, o) => ((o = { ...o, rpc: took() }), record.steps.push({ name, atMs: at(), ...o }), log(`${name}: ${JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`));

// the trail: 2 x slots + 1 blocks SPACING s apart ending now, so "finalized" is this fork's first block, LAG s back
const forked = await block("latest");
await anvil("evm_setNextBlockTimestamp", [hex(BigInt(Math.floor(Date.now() / 1000)) - 2n * SLOTS * SPACING)]);
await anvil("anvil_mine", [hex(2n * SLOTS + 1n), hex(SPACING)]);
const head0 = await block("latest");
const fin0 = await block("finalized");
step("trail", { forkBlock: forked.number, head: head0.number, finalized: fin0.number, trailBlocks: head0.number - fin0.number, headTime: head0.timestamp, finalizedTime: fin0.timestamp });
if (fin0.number <= forked.number || head0.number - fin0.number !== 2n * SLOTS) throw new Error("finalized is not 2 x slots blocks back in this fork");
if (Math.abs(Number(head0.timestamp) - Date.now() / 1000) > 30 || head0.timestamp - fin0.timestamp < LAG - SPACING) throw new Error(`the trail is not now less ${LAG} s: head ${head0.timestamp}, finalized ${fin0.timestamp}`);

const scope = evmPoolScopeOf(PIN.pool, EVM_CHAIN_IDS[CHAIN]);
const ENTROPY = new Uint8Array(16); // the all-zero test vector
const seed64 = wordsToSeed64(entropyToWords(ENTROPY));
// the device's lane is drawn at random as on the page (store/index.ts readLane), so its first U is one of eight: each
// one's account is read on the fork first, so the fixture holds all eight at the fork block and any lane replays
for (let d = 0; d < WALLET_LANES; d++) await anvil("eth_getBalance", [depositIdEvm(seed64, scope, d).address, "latest"]);
const device = async () => {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: Date.now() });
  const ns = await openNoteStore(w);
  const rpcs = [rpcOf(URLS[0]), rpcOf(URLS[1])];
  const sync = evmTreeSync({ rpcs, pin: PIN });
  const shorts = [];
  // the page's deposit host (src/pool-testnet.ts evmKind) on this device's store, pair and sync
  const host = () => ({ pin: PIN, testnet: false, rpcs, round: async (s) => { const r = await sync.events(s); return { events: r.events, finalBlock: r.fin.number }; }, notes: async () => ns, records: async () => readNotes(w), seed64: async () => seed64.slice(), short: (u, wei) => shorts.push([u, wei]), progress: (s) => log(`stage ${s}`), wait: sleep });
  return { w, ns, rpcs, sync, shorts, host };
};
const mine = async (ns) => (await ns.list()).filter((n) => n.scope === scope);
const balanceOf = async (ns) => (await mine(ns)).filter((n) => n.state === "UNSPENT" || n.state === "HELD" || n.state === "RESERVED").reduce((s, n) => s + n.leaf.value, 0n);
const states = async (ns) => (await mine(ns)).map((n) => `${refKey(n.ref)} ${n.state}${n.leaf ? ` leaf ${n.leaf.leafIndex}` : ""}`);

// 1. device A deposits
const A = await device();
const host = A.host;
const shorts = A.shorts;
const RUNG = EVM_LADDER.min;
const ASK = { kind: "pool.deposit", chain: CHAIN, token: null, amount: RUNG, slippageBps: 0, decimals: 18 };
const first = await runPoolDepositEvm(host(), ASK);
const [U, need] = shorts.at(-1) ?? [];
if (!U) throw new Error(`no top-up named: ${JSON.stringify(first)}`);
const planned = (await mine(A.ns)).find((n) => n.state === "PLANNED");
if (depositIdEvm(seed64, scope, planned.ref.i).address !== U) throw new Error("the top-up names another U");
await anvil("anvil_setBalance", [U, hex(need)]);
step("funded", { first, u: U, wei: need });
const snap = await anvil("evm_snapshot", []);
const sendAt = at();
const answer = await runPoolDepositEvm(host(), ASK);
const answeredMs = at() - sendAt;
const tx = answer.txs?.[0]?.hash;
const rc = tx ? await minedReceipt(tx) : null;
if (rc?.status !== "0x1") throw new Error(`the deposit did not land: ${JSON.stringify(answer)}`);
const landedIn = BigInt(rc.blockNumber);
// the note in the balance: at the answer when the run's own read landed it, else on the page's load pass, read as the
// kind reads on (POOL_DEPOSIT_EVM_FOLLOW_MS), at most 60 s
let shownMs = (await balanceOf(A.ns)) >= RUNG ? at() - sendAt : null;
const shownBy = shownMs === null ? "load pass" : "the deposit's own run";
for (let k = 0; k < 6 && shownMs === null; k++) {
  await sleep(POOL_DEPOSIT_EVM_FOLLOW_MS);
  await runPoolDepositEvm(host(), null);
  if ((await balanceOf(A.ns)) >= RUNG) shownMs = at() - sendAt;
}
const finAtShow = await block("finalized");
step("deposit", { answer, answeredMs, shownBy, tx, block: landedIn, finalizedThen: finAtShow.number, aboveFinalizedBy: landedIn - finAtShow.number, shownMs, balance: await balanceOf(A.ns), notes: await states(A.ns), kept: [...(await A.ns.landings())] });
if (shownMs === null) throw new Error("the note never showed in the balance");

// 2. device B: a fresh profile restores from the seed alone
const B = await device();
// where a restore's seconds go: the pool's whole event list read on a fresh sync (the same reads the restore starts
// with), timed alone first
const syncAt = at();
const fresh = await evmTreeSync({ rpcs: B.rpcs, pin: PIN }).events();
step("events read", { ms: at() - syncAt, events: fresh.events.length, anchor: fresh.anchor.number, finalized: fresh.fin.number });
const restoreAt = at();
const restored = await evmRestoreNotes({ seed64: seed64.slice(), pin: PIN, rpcs: B.rpcs, wallets: false });
await writeRestored(B.ns, restored);
const restoredMs = at() - restoreAt;
step("restore", { restoredMs, sinceSendMs: at() - sendAt, atBlock: restored.block, notes: await states(B.ns), balance: await balanceOf(B.ns), landed: restored.notes.map((n) => n.landed ?? null) });
if ((await balanceOf(B.ns)) < RUNG) throw new Error("the restore does not show the note");

// 3. the heal: back before the deposit, another block at its height
const dropped = await block(hex(landedIn));
if (!(await anvil("evm_revert", [snap]))) throw new Error("evm_revert refused");
await anvil("anvil_mine", ["0x1", "0x0"]);
for (let b = await block("latest"); b.number < landedIn; b = await block("latest")) await anvil("anvil_mine", ["0x1", "0x0"]);
const other = await block(hex(landedIn));
if (other.hash === dropped.hash) throw new Error("the same block at the deposit's height");
const settle = (d) => evmSettleReserved({ seed64: seed64.slice(), notes: d.ns, scope, round: (s) => d.sync.events(s) });
const healA = await settle(A);
const healB = await settle(B);
step("reorg", { height: landedIn, dropped: dropped.hash, now: other.hash, a: { pass: healA, notes: await states(A.ns), balance: await balanceOf(A.ns) }, b: { pass: healB, notes: await states(B.ns), balance: await balanceOf(B.ns) } });
if ((await balanceOf(A.ns)) !== 0n || (await balanceOf(B.ns)) !== 0n) throw new Error("a dropped deposit still in a balance");
// the same signed deposit again, in a later block
const resentAt = at();
const again = await anvil("eth_sendRawTransaction", [raws.at(-1)]);
const rc2 = await minedReceipt(again);
const loadA = await runPoolDepositEvm(A.host(), null);
const loadB = await runPoolDepositEvm(B.host(), null);
step("landed again", { tx: again, block: BigInt(rc2.blockNumber), ms: at() - resentAt, a: { load: loadA, notes: await states(A.ns), balance: await balanceOf(A.ns) }, b: { load: loadB, notes: await states(B.ns), balance: await balanceOf(B.ns) } });
if ((await balanceOf(A.ns)) < RUNG || (await balanceOf(B.ns)) < RUNG) throw new Error("the deposit landed again is not shown");

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(record, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
log(`wrote ${OUT}`);
for (const d of [A, B]) (d.ns.close(), d.w.close());
process.exit(0);
