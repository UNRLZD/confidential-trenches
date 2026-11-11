// One real Base Sepolia or Robinhood testnet pool sell through the signing page's own code path (card
// signpage-evm-pool-sell), from a wiped browser: a store that holds only the seed. The page's restore steps for an EVM
// pool (src/pool-restore.ts: the wallet's evmRestoreNotes, notes only, then restoreEvmHoldings, which reads each buy's
// route back from its own transaction on the pool's two RPCs) write the notes and W's buy record; then the page's pool
// kinds (src/pool-kinds.ts over src/pool-testnet.ts testnetPool, as main.ts wires them) sell W's whole holding:
// pool.sell quotes on the route the buy took, builds, checks and signs (W's Sell and its EIP-7702 authorization),
// writes the open record and the note INCOMING, sends through the helper's POST /v1/pool/evm/sell and reads its end on
// the pool's Deposited logs on the chain's two pool RPCs (src/pool-sell-evm.ts).
//   FLOW_RESUME=<seed file> [SELL_PARTS=2] [SETTLE_S=600] node packages/signpage/scripts/pool-sell-evm-testnet.mjs <base|robinhood> <out.json>
// - SELL_PARTS=2: half the holding, then the rest at once, while the first sale's deposit is not final yet (W's next
//   return note and Sell nonce); SETTLE_S: how long the run reads on for the return notes to land (final blocks).
// - The seed: a buy run's own 16 random bytes, kept 0600 in ~/.ct-devnet-runs by pool-buy-evm-testnet.mjs's run; read
//   here, never printed.
// - What differs from the page in a browser, and only that: the wallet store is fake-indexeddb in memory, and W's
//   balance is read once before the tap to size the ask (the box's own number on the page).
// - It writes the answer, the end, the notes, W's records, each RPC's read of the transaction and the sell's request
//   log (every request from the tap to the end: its host, its method, and whether it names W or the transaction) to
//   <out.json>. Nothing here logs a key or the words.
import { readFileSync, writeFileSync } from "node:fs";
import { IDBFactory } from "fake-indexeddb";

globalThis.__SIGN_NETWORK__ = "testnet";
const requests = [];
let tapped = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (tapped) {
    const u = new URL(String(url instanceof Request ? url.url : url));
    let method = null;
    try {
      method = [JSON.parse(String(init?.body ?? "null"))].flat().map((x) => x?.method).filter(Boolean).join(",") || null;
    } catch {}
    requests.push({ at: Date.now(), host: u.host, path: u.pathname, verb: init?.method ?? "GET", method, body: String(init?.body ?? "").toLowerCase() });
  }
  return realFetch(url, init);
};
const { entropyToWords, wordsToSeed64 } = await import("../../wallet/src/derive/index.ts");
const { openWalletStore, WALLET_SEED_LOCK } = await import("../../wallet/src/store/index.ts");
const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
const { EVM_POOLS, EVM_CHAIN_IDS, evmPair, evmPoolScopeOf } = await import("../../wallet/src/pool/evm.ts");
const { evmRestoreNotes } = await import("../../wallet/src/pool/evm-restore.ts");
const { writeRestored } = await import("../../wallet/src/notes/restore.ts");
const { poolKinds } = await import("../src/pool-kinds.ts");
const { TESTNET_RPCS, testnetPool, testnetPoolDeps, testnetRpc } = await import("../src/pool-testnet.ts");
const { EVM_POSITION_COSTS_KEY } = await import("../src/pool-buy-evm.ts");
const { EVM_OPEN_SELLS_KEY, restoreEvmHoldings } = await import("../src/pool-sell-evm.ts");

const [CHAIN, OUT] = process.argv.slice(2);
if ((CHAIN !== "base" && CHAIN !== "robinhood") || !OUT || !process.env.FLOW_RESUME) throw new Error("usage: FLOW_RESUME=<seed file> pool-sell-evm-testnet.mjs <base|robinhood> <out.json>");
const NETWORK = CHAIN === "base" ? "base-sepolia" : "robinhood-testnet";
const PIN = EVM_POOLS[NETWORK];
if (!PIN) throw new Error(`the testnet build pins no ${NETWORK} pool`);
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const big = (_k, v) => (typeof v === "bigint" ? v.toString() : v);

const entropy = Buffer.from(readFileSync(process.env.FLOW_RESUME, "utf8").trim(), "hex");
if (entropy.length !== 16) throw new Error("the seed file holds no 16-byte seed");
const seed64 = wordsToSeed64(entropyToWords(Uint8Array.from(entropy)));
const w = await openWalletStore({ indexedDB: new IDBFactory() });
await w.insertSeed({ v: 1, entropy: Uint8Array.from(entropy), source: "code", code_saved: true, created_ms: Date.now() });
entropy.fill(0);
const ns = await openNoteStore(w);
const RPCS = TESTNET_RPCS[CHAIN];
const rpcs = RPCS.map((u) => testnetRpc(u));

// the wiped browser's restore, as the page's runs it for an EVM pool: the notes, then each buy's record from its own
// transaction
const restored = await evmRestoreNotes({ seed64: seed64.slice(), pin: PIN, rpcs, wallets: false });
// written as the page's restore writes them (writeRestored: SPENT notes and their parents included)
await writeRestored(ns, { notes: restored.notes });
const buys = restored.spends.flatMap((x) => (x.token === null ? [] : [{ w: x.w, token: x.token, block: x.block, blockHash: x.blockHash, logIndex: x.logIndex }]));
log(`restored ${restored.notes.length} note(s), ${buys.length} buy(s) at block ${restored.block}`);
const written = await restoreEvmHoldings({ chain: CHAIN, testnet: true, pin: PIN, rpcs: evmPair(rpcs), store: w, spends: buys });
const restoredHoldings = await w.get("meta", EVM_POSITION_COSTS_KEY);
log(`buy records written: ${written.length}; ${JSON.stringify(restoredHoldings, big)}`);
if (written.length === 0) throw new Error("no buy record restored");

// W's whole holding of the first restored buy: the box's number (or its parts, SELL_PARTS)
const W = written[0];
const rec = restoredHoldings[W];
const bal = BigInt(await rpcs[0]("eth_call", [{ to: rec.mint, data: "0x70a08231" + W.slice(2).toLowerCase().padStart(64, "0") }, "latest"]));
if (bal === 0n) throw new Error("W holds none of its buy's token");
// the exact decimal string of the units (the kind converts it back with the token's decimals)
const D = 10n ** BigInt(rec.decimals);
const decimal = (u) => {
  const frac = (u % D).toString().padStart(rec.decimals, "0").replace(/0+$/, "");
  return `${u / D}${frac ? "." + frac : ""}`;
};
const PARTS = process.env.SELL_PARTS === "2" ? [bal / 2n, bal - bal / 2n] : [bal];
const amount = decimal(bal);
log(`selling ${amount} of ${rec.mint} (${bal} units, ${rec.decimals} decimals) on route ${rec.route.venue} in ${PARTS.length} part(s)`);

const helperLog = [];
const helperFetch = async (url, init) => {
  const r = await fetch(url, init);
  const body = r.status === 200 ? null : (await r.clone().text()).slice(0, 300);
  helperLog.push({ method: init?.method ?? "GET", path: new URL(url).pathname, status: r.status, ...(body === null ? {} : { body, retryAfter: r.headers.get("retry-after") }) });
  log(`helper ${init?.method ?? "GET"} ${new URL(url).pathname}: HTTP ${r.status}${body === null ? "" : ` ${body} (Retry-After ${r.headers.get("retry-after")})`}`);
  return r;
};
const page = { store: async () => w, held: async () => w, seed64: async () => seed64.slice() };
const t = testnetPool(page, { prover: { vault: { load: async () => {}, prove: async () => Promise.reject(new Error("no proof in a sell")) }, stop: () => {} }, fetch: helperFetch });
const kinds = poolKinds(testnetPoolDeps(t.flow));

const stages = [];
const ENDS = ["filled", "part_filled", "refused", "not_landed"];
tapped = true;
const tapAt = Date.now();
const taps = [];
for (const [k, units] of PARTS.entries()) {
  const at = Date.now();
  const mine = [];
  const r = kinds["pool.sell"]({ chain: CHAIN, token: rec.mint, amount: decimal(units), slippage_bps: 300 }, { id: `sell${k}`, sha: "00", progress: (s) => (stages.push(s), mine.push(s), log(`sale ${k} progress ${JSON.stringify(s)}`)) });
  if ("error" in r) throw new Error(`refused: ${JSON.stringify(r)}`);
  await r.after;
  const first = r.answer();
  log(`sale ${k} of ${units} units answered ${JSON.stringify(first)} in ${Date.now() - at} ms`);
  // the latest stage: a progress after the answer, else the answer's own
  const endOf = () => (mine.length > 0 ? (mine.at(-1)?.stage ?? mine.at(-1)) : first?.result?.stage);
  for (let i = 0; i < 360 && !ENDS.includes(endOf()); i++) await sleep(2_000);
  taps.push({ units, first, end: ENDS.includes(endOf()) ? endOf() : null, endMs: Date.now() - at, notes: (await ns.list()).filter((n) => n.ref.kind !== "deposit").map((n) => `${n.ref.kind}${n.ref.kind === "second" ? "/" + n.ref.n : ""} ${n.state}`) });
  log(`sale ${k} end ${taps.at(-1).end} in ${taps.at(-1).endMs} ms; notes ${JSON.stringify(taps.at(-1).notes)}`);
}
const first = taps[0].first;
const end = taps.every((x) => x.end === "filled") ? "filled" : taps.map((x) => x.end).join(",");
const endMs = Date.now() - tapAt;
await navigator.locks.request(WALLET_SEED_LOCK, { mode: "exclusive" }, () => {});
// the sales' open records, then their end: each return note leaves INCOMING once the pool's round holds its deposit at
// a final block (the record is dropped then), read on as the page's own background read does
const sales = Object.values((await w.get("meta", EVM_OPEN_SELLS_KEY)) ?? {});
const sale = sales[0] ?? null;
const SETTLE_S = Number(process.env.SETTLE_S ?? 600);
for (let i = 0; i < SETTLE_S / 10 && Object.keys((await w.get("meta", EVM_OPEN_SELLS_KEY)) ?? {}).length > 0; i++) {
  if (i % 30 === 0) log(`open sales: ${Object.keys((await w.get("meta", EVM_OPEN_SELLS_KEY)) ?? {}).length}`);
  await sleep(10_000);
}
const settledMs = Date.now() - tapAt;
tapped = false;
// each sale's transaction: the pool's Deposited log for its note's precommitment, from the record's first block, in a
// bounded range (a public RPC refuses an unbounded one)
const T = "0x" + Buffer.from((await import("@noble/hashes/sha3.js")).keccak_256(new TextEncoder().encode("Deposited(address,uint256,uint256,uint256,uint256)"))).toString("hex");
const headNow = BigInt(await rpcs[0]("eth_blockNumber", []));
const hashes = [];
for (const o of sales) {
  const from = BigInt(o.from);
  const to = from + 9_000n < headNow ? from + 9_000n : headNow;
  const logs = await rpcs[0]("eth_getLogs", [{ address: PIN.pool, topics: [T], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
  hashes.push(logs.find((l) => BigInt("0x" + l.data.slice(2 + 64 * 3, 2 + 64 * 4)) === BigInt(o.precommitment))?.transactionHash ?? null);
}
const hash = hashes[0] ?? null;
const said = { w: W.slice(2).toLowerCase(), tx: hash?.slice(2) ?? "-" };
const requestLog = requests.map(({ body, ...q }) => ({ ...q, at: q.at - tapAt, names: Object.entries(said).filter(([, v]) => body.includes(v)).map(([k]) => k) }));
const reads = [];
for (const h of hashes.filter(Boolean))
  for (const [k, rpc] of rpcs.entries()) {
    const rc = await rpc("eth_getTransactionReceipt", [h]).catch((e) => ({ error: String(e?.message).slice(0, 120) }));
    reads.push({ hash: h, rpc: RPCS[k], block: rc?.blockNumber ? BigInt(rc.blockNumber).toString() : null, status: rc?.status ?? null });
  }
const notes = (await ns.list()).map((n) => ({ id: n.id, ref: n.ref.kind, state: n.state, value: n.leaf ? String(n.leaf.value) : null }));
const open = await w.get("meta", EVM_OPEN_SELLS_KEY);
log(`end ${end} in ${endMs} ms, settled in ${settledMs} ms; txs ${JSON.stringify(hashes)}; reads ${JSON.stringify(reads)}; notes ${JSON.stringify(notes)}; open ${JSON.stringify(open ?? null, big)}`);
for (const q of requestLog) log(`request +${q.at} ms ${q.verb} ${q.host}${q.path} ${q.method ?? ""} names: ${q.names.join(",") || "none"}`);
writeFileSync(OUT, JSON.stringify({ by: "packages/signpage/scripts/pool-sell-evm-testnet.mjs", network: NETWORK, pool: PIN.pool, scope: evmPoolScopeOf(PIN.pool, EVM_CHAIN_IDS[NETWORK]), rpcs: RPCS, w: W, token: rec.mint, amount, units: bal, route: rec.route, first, stages, taps, end, endMs, settledMs, sale, sales, hash, hashes, reads, notes, open: open ?? null, helper: helperLog, requests: requestLog }, big, 2) + "\n");
log(`wrote ${OUT}`);
await t.signedOut();
seed64.fill(0);
ns.close();
w.close();
process.exit(end === "filled" && reads.length === 2 && reads.every((x) => x.status === "0x1") && notes.some((n) => n.ref === "return" && n.state === "UNSPENT") && open !== undefined && Object.keys(open).length === 0 ? 0 : 1);
