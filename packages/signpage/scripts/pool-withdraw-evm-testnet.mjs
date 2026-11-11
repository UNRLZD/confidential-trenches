// One real Base Sepolia or Robinhood testnet pool withdraw through the signing page's own code path: the page's
// pool.withdraw screen deps and run (src/pool-testnet.ts withdrawDeps and withdraw over src/pool-withdraw-evm.ts) on the
// testnet build's own pins, pool RPCs and helper. The screen's funds are read for To, the Amount is checked by the
// screen's own checkPoolAmount (its Max fee the one drawn), and the run proves, checks, signs as W, sends the release
// through the helper, reads it back on both pool RPCs, then W's own send of exactly the amount to To.
//   FLOW_RESUME=<seed file> node packages/signpage/scripts/pool-withdraw-evm-testnet.mjs <base|robinhood> <amount ETH> <out.json>
// - The seed: a run's own 16 random bytes in a file the operator keeps (0600), whose deposit run put a note in the
//   pool (pool-deposit-evm-testnet.mjs with FLOW_RESUME of that file); never printed. The note comes back from the seed
//   alone (the wallet's evmRestoreNotes, as the page's restore reads it).
// - To: an address made for the run from the seed (keccak of the seed and "withdraw-to"), a key no one uses again.
// - What differs from the page in a browser, and only that: the prover is snarkjs's fullProve in this process on the
//   pinned withdraw files, and the wallet store is fake-indexeddb in memory.
// - FLOW_LOSE_SEND=1: W's onward send is lost (this process's every eth_sendRawTransaction is dropped before it leaves)
//   until the run ends with the part owed on W. Then a restore from the words alone finds W and the part on it, and two
//   page loads on the same store (a reload, and another tab beside it) each run the state reads' finish: W's one send
//   leaves once, and the op ends sent.
// - It reads To's and W's balances before and after on both RPCs, and every transaction's receipt on both, and writes
//   them with the op record and the owed record to <out.json>. Nothing here logs a key or the words.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { IDBFactory } from "fake-indexeddb";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

globalThis.__SIGN_NETWORK__ = "testnet";
// FLOW_LOSE_SEND: this process's raw sends dropped while `losing` (the page's only raw send is W's: the release goes
// through the helper)
const LOSE = process.env.FLOW_LOSE_SEND === "1";
let losing = LOSE;
let lost = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (losing && typeof init?.body === "string" && init.body.includes("eth_sendRawTransaction")) {
    lost++;
    throw new TypeError("fetch failed");
  }
  return realFetch(url, init);
};
const { entropyToWords, wordsToSeed64 } = await import("../../wallet/src/derive/index.ts");
const { evmAddress, freshWallet } = await import("../../wallet/src/derive/keys.ts");
const { openWalletStore } = await import("../../wallet/src/store/index.ts");
const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
const { EVM_POOLS } = await import("../../wallet/src/pool/evm.ts");
const { evmRestoreNotes } = await import("../../wallet/src/pool/evm-restore.ts");
const { jOf } = await import("../../wallet/src/pool/queue.ts");
const { ZK_SETUP_FILES } = await import("../../kit/src/zk/setup-files.ts");
const { TESTNET_RPCS, testnetPool, testnetRpc } = await import("../src/pool-testnet.ts");
const { checkPoolAmount, checkPoolTo } = await import("../src/withdraw/pool-form.ts");

const [CHAIN, AMOUNT, OUT] = process.argv.slice(2);
if ((CHAIN !== "base" && CHAIN !== "robinhood") || !/^\d+(\.\d+)?$/.test(AMOUNT ?? "") || !OUT || !process.env.FLOW_RESUME)
  throw new Error("usage: FLOW_RESUME=<seed file> pool-withdraw-evm-testnet.mjs <base|robinhood> <amount ETH> <out.json>");
const NETWORK = CHAIN === "base" ? "base-sepolia" : "robinhood-testnet";
const PIN = EVM_POOLS[NETWORK];
if (!PIN) throw new Error(`the testnet build pins no ${NETWORK} pool`);
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const big = (_k, v) => (typeof v === "bigint" ? v.toString() : v);

const KIT_ZK = new URL("../../kit/zk/", import.meta.url);
const file = (name) => {
  const b = readFileSync(new URL(name, KIT_ZK));
  if (createHash("sha256").update(b).digest("hex") !== ZK_SETUP_FILES[name].sha256) throw new Error(`${name}: not the pinned setup file`);
  return new Uint8Array(b);
};
const WASM = file("withdraw.wasm");
const ZKEY = file("withdraw.zkey");
const snarkjs = createRequire(new URL("../../kit/package.json", import.meta.url))("snarkjs");
const vault = {
  load: async () => {},
  prove: async (circuit, input) => {
    if (circuit !== "withdraw") throw new Error(`no ${circuit} prover here`);
    const t0 = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY, undefined, undefined, { singleThread: true });
    log(`proved in ${Math.round(performance.now() - t0)} ms`);
    return { proof, publicSignals, proveMs: Math.round(performance.now() - t0) };
  },
};

const entropy = Buffer.from(readFileSync(process.env.FLOW_RESUME, "utf8").trim(), "hex");
if (entropy.length !== 16) throw new Error("the seed file holds no 16-byte seed");
const seed64 = wordsToSeed64(entropyToWords(Uint8Array.from(entropy)));
const w = await openWalletStore({ indexedDB: new IDBFactory() });
await w.insertSeed({ v: 1, entropy: Uint8Array.from(entropy), source: "code", code_saved: true, created_ms: Date.now() });
entropy.fill(0);
const ns = await openNoteStore(w);
const RPCS = TESTNET_RPCS[CHAIN];
const rpcs = RPCS.map((u) => testnetRpc(u));

const restored = await evmRestoreNotes({ seed64: seed64.slice(), pin: PIN, rpcs, wallets: false });
for (const n of restored.notes) await ns.add({ ref: n.ref, scope: n.scope, precommitment: n.precommitment, state: n.state, leaf: n.leaf });
log(`restored ${restored.notes.length} note(s) at block ${restored.block}: ${restored.notes.map((n) => `${n.ref.kind} ${n.state} ${n.leaf.value}`).join(", ")}`);
if (!restored.notes.some((n) => n.state === "UNSPENT")) throw new Error("no UNSPENT note to withdraw from");

// To: the run's own fresh address (its key from the seed, never used to sign)
const toKey = keccak_256(Uint8Array.from([...seed64, ...new TextEncoder().encode("withdraw-to")]));
const TO = evmAddress(secp256k1.getPublicKey(toKey, false));
toKey.fill(0);
const each = async (method, params) => Promise.all(rpcs.map((rpc) => rpc(method, params)));
const balances = async (a) => (await each("eth_getBalance", [a, "latest"])).map((x) => BigInt(x));

const helperLog = [];
const helperFetch = async (url, init) => {
  const r = await fetch(url, init);
  const body = r.status === 200 ? null : (await r.clone().text()).slice(0, 300);
  helperLog.push({ method: init?.method ?? "GET", path: new URL(url).pathname, status: r.status, ...(body === null ? {} : { body }) });
  log(`helper ${init?.method ?? "GET"} ${new URL(url).pathname}: HTTP ${r.status}${body === null ? "" : ` ${body}`}`);
  return r;
};
const page = { store: async () => w, held: async () => w, seed64: async () => seed64.slice(), openWithdraw: () => ({ result: { pending: true }, then: () => {} }) };
const t = testnetPool(page, { prover: { vault, stop: () => {} }, fetch: helperFetch });

const OP = "withdraw-run";
// the screen: pool.withdraw opens it; its funds read for To, its two fields checked as the screen checks them
const opened = t.flow({ kind: "pool.withdraw", chain: CHAIN, token: null, amount: 0n, slippageBps: 0, decimals: 18 }, { id: OP, sha: "00", progress: () => {} });
log(`pool.withdraw: ${JSON.stringify(opened?.result ?? opened)}`);
const deps = t.withdrawDeps(CHAIN, OP);
const to = checkPoolTo(CHAIN, TO, deps.keys);
if (!to.ok) throw new Error("To refused by the screen");
const funds = await deps.funds(to.to);
log(`funds: ${funds.notes.length} note(s), fee ${funds.fee}, W's fee ${funds.wFee}, min part ${funds.minPart}`);
const m = checkPoolAmount(CHAIN, AMOUNT, funds);
if (!m.ok) throw new Error(`the amount is refused: ${JSON.stringify(m, big)}`);
const ready = { chain: CHAIN, to: to.to, amount: m.amount, maxFee: m.maxFee };
log(`ready: To ${ready.to}, amount ${ready.amount} wei, ${m.parts} part(s), Max fee ${ready.maxFee} wei`);

const toBefore = await balances(TO);
const t0 = Date.now();
const loseLog = {};
// the screen's handoff is `void withdraw(ready, op id)`; the same call here, awaited, so the run's end is read after it
if (typeof deps.handoff !== "function") throw new Error("the screen has no run for this chain");
await t.withdraw(ready, OP);
if (LOSE) {
  const first = await w.get("ops", OP);
  loseLog.first = { op: first, owed: (await w.get("meta", `owed/${OP}`)) ?? null, lost };
  log(`lost send: the run ended ${JSON.stringify(first, big)}; ${lost} raw sends dropped; owed ${JSON.stringify(loseLog.first.owed)}`);
  // a restore from the words alone (a fresh device): the spent note's W, and what it holds
  const back = await evmRestoreNotes({ seed64: seed64.slice(), pin: PIN, rpcs, wallets: false });
  loseLog.restore = await Promise.all(back.spends.map(async (sp) => ({ w: sp.w, balance: (await balances(sp.w)).map(String) })));
  log(`restore from the words: ${back.notes.length} note(s), spends ${JSON.stringify(loseLog.restore)}`);
  losing = false;
  // a reload and another tab: two page loads on the same store, each one's state read runs the owed send's finish
  const reload = testnetPool(page, { prover: { vault, stop: () => {} }, fetch: helperFetch });
  const tab = testnetPool(page, { prover: { vault, stop: () => {} }, fetch: helperFetch });
  for (let i = 0; i < 60 && (await w.get("ops", OP))?.stage !== "sent"; i++) {
    await Promise.all([reload.stateRead(), tab.stateRead()]);
    await new Promise((r) => setTimeout(r, 3_000));
  }
  await reload.signedOut();
  await tab.signedOut();
}
const ms = Date.now() - t0;
const op = await w.get("ops", OP);
const owed = await w.get("meta", `owed/${OP}`);
log(`op ${JSON.stringify(op, big)} in ${ms} ms; owed ${JSON.stringify(owed ?? null)}`);
const toAfter = await balances(TO);
// W of the spent note: its leftover
const spent = (await ns.list()).find((n) => n.state === "RESERVED" || n.state === "SPENT");
let wAddr = null;
let wLeft = null;
if (spent) {
  const fw = freshWallet(seed64, "evm", spent.leaf.label, jOf(spent.ref));
  fw.secretKey.fill(0);
  wAddr = fw.address;
  wLeft = await balances(wAddr);
}
const reads = [];
for (const tx of op?.txs ?? []) {
  const rs = await Promise.all(rpcs.map((rpc, k) => rpc("eth_getTransactionReceipt", [tx.hash]).then((r) => ({ rpc: RPCS[k], block: r?.blockNumber ? BigInt(r.blockNumber).toString() : null, status: r?.status ?? null, gasUsed: r?.gasUsed ? BigInt(r.gasUsed).toString() : null, effectiveGasPrice: r?.effectiveGasPrice ? BigInt(r.effectiveGasPrice).toString() : null, l1Fee: r?.l1Fee ? BigInt(r.l1Fee).toString() : null }))));
  const value = await Promise.all(rpcs.map((rpc) => rpc("eth_getTransactionByHash", [tx.hash]).then((x) => BigInt(x.value).toString())));
  reads.push({ hash: tx.hash, value, receipts: rs });
  log(`tx ${tx.hash}: value ${value.join("/")}; ${rs.map((r) => `${r.rpc} block ${r.block} status ${r.status}`).join("; ")}`);
}
const arrived = toAfter.map((a, k) => (a - toBefore[k]).toString());
log(`To ${TO}: before ${toBefore.join("/")}, after ${toAfter.join("/")}, arrived ${arrived.join("/")} (asked ${ready.amount}); W ${wAddr} left ${wLeft?.join("/")}`);
const notes = (await ns.list()).map((n) => ({ id: n.id, ref: n.ref.kind, state: n.state, value: n.leaf ? String(n.leaf.value) : null }));
writeFileSync(OUT, JSON.stringify({ by: "packages/signpage/scripts/pool-withdraw-evm-testnet.mjs", network: NETWORK, pool: PIN.pool, rpcs: RPCS, to: TO, amount: ready.amount, maxFee: ready.maxFee, funds: { fee: funds.fee, wFee: funds.wFee, minPart: funds.minPart }, op, owed: owed ?? null, ms, lose: LOSE ? loseLog : null, toBefore, toAfter, arrived, w: wAddr, wLeft, reads, notes, helper: helperLog }, big, 2) + "\n");
log(`wrote ${OUT}`);
await t.signedOut();
seed64.fill(0);
ns.close();
w.close();
const ok = op?.stage === "sent" && arrived.every((a) => a === ready.amount.toString()) && reads.length >= 2 && reads.every((r) => r.receipts.every((x) => x.status === "0x1"));
process.exit(ok ? 0 : 1);
