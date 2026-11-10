// One real Base Sepolia or Robinhood testnet deposit through the signing page's own EVM flow (card pool-deposits):
// src/pool-deposit-evm.ts runPoolDepositEvm on the testnet build's own pin of the chain's pool (the wallet's EVM_POOLS,
// card evm-pool-pins), read on the testnet build's two RPCs of the chain (src/pool-testnet.ts TESTNET_RPCS), its tree
// read by the wallet's evmTreeSync as the page reads it.
//   node packages/signpage/scripts/pool-deposit-evm-testnet.mjs <base|robinhood> <out.json> [--settle]
// - A seed made in this run only (16 random bytes), never printed or kept: its note's secrets end with the run, so the
//   0.001 ETH stays in the pool as a test deposit.
// - The ask, one pool.deposit of 0.001 ETH: its first run names U and the wei U is short (`short`), and this run waits
//   until U holds that on both RPCs. Someone else funds U.
// - Then the ask again: it signs and sends U's deposit and answers "sent". The run waits until the send's receipt
//   reads back succeeded on both RPCs with the pool's Deposited naming the note's precommitment. With --settle it then
//   runs, every 60 s, the page load's pass (runPoolDepositEvm with no ask, what settle runs on each load and state read)
//   until it settles the note UNSPENT with its leaf (a Deposited is final only after ~22 min), 40 min at most.
// - It writes U, the deposit's tx, the answers and the note to <out.json>. Nothing here logs a key or the words.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { IDBFactory } from "fake-indexeddb";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, wordsToSeed64 } from "../../wallet/src/derive/index.ts";
import { depositIdEvm } from "../../wallet/src/derive/keys.ts";
import { openWalletStore } from "../../wallet/src/store/index.ts";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import { noteSecrets } from "../../wallet/src/notes/secrets.ts";

// the testnet build: the network is set before the pool modules load (the wallet's network.ts reads it once), so
// they are imported here, after it, never statically
globalThis.__SIGN_NETWORK__ = "testnet";
const { EVM_CHAIN_IDS, EVM_LADDER, EVM_POOL_EVENTS, EVM_POOLS, evmPoolScopeOf, evmTreeSync } = await import("../../wallet/src/pool/evm.ts");
const { TESTNET_RPCS } = await import("../src/pool-testnet.ts");
const { runPoolDepositEvm } = await import("../src/pool-deposit-evm.ts");

const [CHAIN, OUT] = process.argv.slice(2);
const SETTLE = process.argv.includes("--settle");
if ((CHAIN !== "base" && CHAIN !== "robinhood") || !OUT) throw new Error("usage: pool-deposit-evm-testnet.mjs <base|robinhood> <out.json> [--settle]");
const NETWORK = CHAIN === "base" ? "base-sepolia" : "robinhood-testnet";
// the page's own pin and pair
const PIN = EVM_POOLS[NETWORK];
if (!PIN) throw new Error(`the testnet build pins no ${NETWORK} pool`);
const POOL = PIN.pool;
const RPCS = TESTNET_RPCS[CHAIN];
const RUNG = EVM_LADDER.min; // 0.001 ETH, the ladder's smallest rung
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;
/** One JSON-RPC provider; HTTP 429 and transport faults are asked again, up to 8 times per call. */
const rpcOf = (url) => async (method, params) => {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(`RPC error ${j.error.code}: ${j.error.message}`), { rpc: true });
      return j.result;
    } catch (e) {
      if (e.rpc || i >= 7) throw e;
      await sleep(1_000 * 2 ** Math.min(i, 4));
    }
  }
};
// U's estimate and simulation on each RPC, logged (public reads: U's address, the pool, the call)
const traced = (k, rpc) => async (method, params) => {
  try {
    const r = await rpc(method, params);
    if (method === "eth_estimateGas" || method === "eth_sendRawTransaction") log(`rpc ${k} ${method} -> ${r}`);
    return r;
  } catch (e) {
    if (method === "eth_estimateGas" || method === "eth_call" || method === "eth_sendRawTransaction") log(`rpc ${k} ${method} failed: ${e.message}`);
    throw e;
  }
};
const rpcs = [traced(0, rpcOf(RPCS[0])), traced(1, rpcOf(RPCS[1]))];
for (const r of rpcs) if (BigInt(await r("eth_chainId", [])) !== EVM_CHAIN_IDS[NETWORK]) throw new Error(`not ${NETWORK}`);

const w = await openWalletStore({ indexedDB: new IDBFactory() });
const entropy = randomBytes(16);
await w.insertSeed({ v: 1, entropy: Uint8Array.from(entropy), source: "code", code_saved: true, created_ms: Date.now() });
const seed64 = wordsToSeed64(entropyToWords(Uint8Array.from(entropy)));
entropy.fill(0);
const ns = await openNoteStore(w);
const scope = evmPoolScopeOf(POOL, EVM_CHAIN_IDS[NETWORK]);
const sync = evmTreeSync({ rpcs, pin: PIN });
const round = async () => {
  const r = await sync.events();
  return { events: r.events, finalBlock: r.fin.number };
};
const shorts = [];
const host = () => ({ pin: PIN, testnet: true, rpcs, round, notes: async () => ns, seed64: async () => seed64.slice(), short: (u, wei) => (shorts.push([u, wei]), log(`short: U ${u} needs ${wei} wei more`)), progress: (s) => log(`stage ${s}`), wait: sleep });
const ASK = { kind: "pool.deposit", chain: CHAIN, token: null, amount: RUNG, slippageBps: 0, decimals: 18 };

const first = await runPoolDepositEvm(host(), ASK);
log(`first answer ${JSON.stringify(first)}`);
const [U, need] = shorts.at(-1) ?? [];
if (!U) throw new Error("no top-up named");
const planned = (await ns.list()).find((n) => n.scope === scope && n.state === "PLANNED");
if (depositIdEvm(seed64, scope, planned.ref.i).address !== U) throw new Error("the top-up names another U");
log(`fund U ${U} with ${need} wei on ${NETWORK}`);
const balance = async () => {
  const got = await Promise.all(rpcs.map(async (r) => BigInt(await r("eth_getBalance", [U, "latest"]))));
  return got[0] < got[1] ? got[0] : got[1];
};
for (let b = await balance(); b < need; b = await balance()) await sleep(5_000);
const funded = await balance();
log(`U holds ${funded}: depositing ${RUNG} wei`);

const answer = await runPoolDepositEvm(host(), ASK);
log(`answer ${JSON.stringify(answer)}`);
let note = (await ns.list()).find((n) => n.scope === scope && n.ref.kind === "deposit" && n.state !== "PLANNED");
// the send read back: its receipt succeeded on both RPCs, with the pool's Deposited (topic 0, EVM_POOL_EVENTS) naming
// the note's precommitment (the event's last word), 10 min at most
const sendHash = note?.evmSends?.at(-1)?.hash;
const DEPOSITED = "0x" + Buffer.from(keccak_256(new TextEncoder().encode(EVM_POOL_EVENTS.Deposited))).toString("hex");
const pre = note ? "0x" + note.precommitment.toString(16).padStart(64, "0") : null;
const receipts = [];
for (const until = Date.now() + 10 * 60_000; sendHash && Date.now() < until; await sleep(5_000)) {
  const rs = await Promise.all(rpcs.map((r) => r("eth_getTransactionReceipt", [sendHash]).catch(() => null)));
  const good = rs.map((r) => r?.status === "0x1" && r.logs.some((l) => l.address.toLowerCase() === POOL && l.topics[0] === DEPOSITED && l.data.toLowerCase().endsWith(pre.slice(2))));
  if (good.every(Boolean)) {
    receipts.push(...rs.map((r, k) => ({ rpc: RPCS[k], block: BigInt(r.blockNumber).toString(), status: r.status })));
    break;
  }
}
log(`the send ${sendHash} read back on both RPCs: ${receipts.length === 2 ? receipts.map((r) => `block ${r.block}`).join(", ") : "no"}`);
const settles = [];
const until = Date.now() + 40 * 60_000;
while (SETTLE && note?.state === "INCOMING" && Date.now() < until) {
  await sleep(60_000);
  const a = await runPoolDepositEvm(host(), null); // the page load's pass
  settles.push({ at: new Date().toISOString(), answer: a });
  note = await ns.get(note.id);
  log(`load pass ${JSON.stringify(a)}: the note ${note.state}`);
}
const left = await balance();
const out = {
  by: "packages/signpage/scripts/pool-deposit-evm-testnet.mjs",
  network: NETWORK,
  pool: POOL,
  pin: { feeRecipient: PIN.feeRecipient, fromBlock: String(PIN.fromBlock) },
  fromBlock: String(PIN.fromBlock),
  rpcs: RPCS,
  u: U,
  need: String(need),
  funded: String(funded),
  left: String(left),
  first,
  answer,
  send: sendHash ?? null,
  receipts,
  settles,
  note: note && { state: note.state, precommitment: note.precommitment.toString(16).padStart(64, "0"), sends: (note.evmSends ?? []).map((s) => ({ hash: s.hash, nonce: String(s.nonce), value: String(s.value) })), leaf: note.leaf && { value: String(note.leaf.value), label: note.leaf.label.toString(16).padStart(64, "0"), commitment: note.leaf.commitment.toString(16).padStart(64, "0"), leafIndex: String(note.leaf.leafIndex) } },
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
log(`wrote ${OUT}`);
seed64.fill(0);
ns.close();
w.close();
process.exit(receipts.length === 2 && (!SETTLE || note?.state === "UNSPENT") ? 0 : 1);
