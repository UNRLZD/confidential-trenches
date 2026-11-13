// One real devnet run of the pool withdraw through the signing page's own testnet flow (card
// signpage-pool-withdraw-form): pool.withdraw on the page's pool kinds (src/pool-kinds.ts over src/pool-testnet.ts, as
// main.ts wires them), its screen's model on the funds the page reads (src/withdraw/pool-form.ts evaluatePool), then the
// press: the run (src/pool-withdraw.ts) proves each part on demand, sends its release alone to W through the helper's
// POST /v1/pool/solana/send, then W's own transfer to To through the page's RPC pair, each read back on both devnet RPCs.
//   FLOW_RESUME=<seed file> node packages/signpage/scripts/pool-withdraw-devnet.mjs <to> <amount SOL> <out.json>
// - The seed is a kept run's (~/.ct-devnet-runs/run-<time>.seed, pool-flow-devnet.mjs): its notes restored from the seed
//   on both devnet RPCs (the wallet's solanaRestoreNotes), never printed. No new money goes in.
// - WITHDRAW_DEST=<chain> (card pool-withdraws-to-any-chain, FLOW_COPY with COPY_ONECLICK=1 only): <to> is an address on
//   that chain and the pool pays a live 1Click quote's deposit address on Solana, the quote asked and checked by the
//   page's own exit (src/pool-exit.ts) at WITHDRAW_PRICE (the SOL PoolStatePrice, read by the parent on public mainnet
//   RPCs); every onward send must pay that one deposit address, never <to>. The copy's money stays on the copy: 1Click
//   never sees it, so nothing is swapped.
// - WITHDRAW_DRY=1 stops before the press: the notes, the screen's view and the plan, nothing signed or sent.
// - What differs from the page in a browser, and only that: the prover is snarkjs's fullProve in this process on the
//   pinned setup files, and the screen's fields are given here, not typed. Every check, the send and every read-back are
//   the page's own code.
// - Then each part's two transactions are read at finalized on both RPCs: both succeeded; the onward send moves To's
//   balance up by exactly its part and leaves W at 0.
//   It writes the answers, the op record, the notes and every tx to <out.json>; exit 0 only when the op is "sent" and
//   every part reads back so on both RPCs.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { IDBFactory } from "fake-indexeddb";
import { COPY, copyNet } from "./copy-net.mjs";

// FLOW_COPY (./copy-net.mjs): the mainnet build, on a local copy of mainnet
globalThis.__SIGN_NETWORK__ = COPY ? "mainnet" : "testnet";
const { entropyToWords, wordsToSeed64 } = await import("../../wallet/src/derive/index.ts");
const { openWalletStore } = await import("../../wallet/src/store/index.ts");
const { openNoteStore, refKey } = await import("../../wallet/src/notes/store.ts");
const { SOL_POOLS, solanaPoolOf } = await import("../../wallet/src/pool/solana.ts");
const { solanaRestoreNotes } = await import("../../wallet/src/pool/solana-restore.ts");
const { ZK_SETUP_FILES } = await import("../../kit/src/zk/setup-files.ts");
const { poolKinds } = await import("../src/pool-kinds.ts");
const { TESTNET_RPCS, testnetPool, testnetPoolDeps, testnetRpc } = await import("../src/pool-testnet.ts");
const { evaluatePool } = await import("../src/withdraw/pool-form.ts");
const { planPoolWithdraw } = await import("../src/pool-withdraw.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");
if (!COPY && (POOL_TESTNET !== true || SOL_POOLS.devnet === undefined)) throw new Error("not the testnet build's pins");

const [TO, AMOUNT, OUT] = process.argv.slice(2);
const RESUME = process.env.FLOW_RESUME;
const DRY = process.env.WITHDRAW_DRY === "1";
const DEST = process.env.WITHDRAW_DEST;
const PRICE = DEST ? JSON.parse(process.env.WITHDRAW_PRICE ?? "null") : null;
if (DEST && (!COPY || process.env.COPY_ONECLICK !== "1" || typeof PRICE?.price !== "string")) throw new Error("WITHDRAW_DEST: FLOW_COPY, COPY_ONECLICK=1 and WITHDRAW_PRICE");
if (!OUT || !RESUME) throw new Error("usage: FLOW_RESUME=<seed file> pool-withdraw-devnet.mjs <to> <amount SOL> <out.json>");
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const big = (_k, v) => (typeof v === "bigint" ? String(v) : v);
let phase = "start";
const copy = COPY ? await copyNet({ log, phase: () => phase }) : null;
const rpcs = COPY ? copy.rpcs : [testnetRpc(TESTNET_RPCS.solana[0]), testnetRpc(TESTNET_RPCS.solana[1])];
const PIN = COPY ? copy.pin : SOL_POOLS.devnet;

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

const w = await openWalletStore({ indexedDB: new IDBFactory() });
const entropy = Buffer.from(readFileSync(RESUME, "utf8").trim(), "hex");
if (entropy.length !== 16) throw new Error("the seed file holds no 16-byte seed");
await w.insertSeed({ v: 1, entropy: Uint8Array.from(entropy), source: "code", code_saved: true, created_ms: Date.now() });
const seed64 = wordsToSeed64(entropyToWords(Uint8Array.from(entropy)));
entropy.fill(0);
const helperFetch = async (url, init) => {
  const r = await fetch(url, init);
  log(`helper ${init?.method ?? "GET"} ${new URL(url).pathname}: HTTP ${r.status}`);
  return r;
};
let opened = null;
const page = {
  store: async () => w,
  seed64: async () => seed64.slice(),
  // the page's screen, as main.ts opens it: the chain the app named and the request's id
  openWithdraw: (chain, ctx) => ((opened = { chain, opId: ctx.id }), { result: { pending: true } }),
  ...(PRICE ? { price: () => PRICE } : {}),
};
const t = testnetPool(page, { rpcs, prover: { vault, stop: () => {} }, fetch: helperFetch, ...(COPY ? { pin: copy.pin, holdings: copy.holdings } : {}) });
const kinds = poolKinds({ ...testnetPoolDeps(t.flow), rpcs: (c) => (c === "solana" ? rpcs : testnetPoolDeps().rpcs(c)) });

const { pool } = solanaPoolOf(PIN.program);
const ns = await openNoteStore(w);
const r = await solanaRestoreNotes({ seed64, program: PIN.program, rpcs });
const ids = new Map();
for (const n of r.notes) {
  const rec = await ns.add({ ref: n.ref, scope: n.scope, precommitment: n.precommitment, state: "UNSPENT", leaf: n.leaf, ...(n.parent === undefined ? {} : { parent: ids.get(n.parent) }) });
  ids.set(refKey(n.ref), rec.id);
}
const noteList = async () => (await ns.list()).map((n) => ({ ref: n.ref.kind, state: n.state, value: n.leaf ? String(n.leaf.value) : null, leafIndex: n.leaf ? String(n.leaf.leafIndex) : null }));
const before = await noteList();
log(`restored from the seed file: ${JSON.stringify(before)}`);

const opId = "pool-withdraw-devnet";
const answer = kinds["pool.withdraw"]({ chain: "solana" }, { id: opId, sha: "00", progress: (s) => log(`progress ${s}`) });
log(`pool.withdraw answered ${JSON.stringify(answer)}; screen opened ${JSON.stringify(opened)}`);
if (!opened) throw new Error("pool.withdraw did not open the screen");
const deps = t.withdrawDeps("solana", opId);
const funds = await deps.funds();
// "max" (FLOW_COPY's run): the most the screen takes from these notes
const { poolWithdrawable } = await import("../src/pool-withdraw.ts");
const { formatUnits } = await import("../src/withdraw/pool-form.ts");
const amount = AMOUNT === "max" ? formatUnits(poolWithdrawable(funds.notes, funds), 9) : AMOUNT;
const view = evaluatePool("solana", TO, amount, deps.keys, funds, DEST ?? "solana");
if (DEST && !deps.exits?.includes(DEST)) throw new Error(`the page offers no exit to ${DEST}`);
const plan = view.ready ? planPoolWithdraw(funds.notes, view.ready.amount, funds) : null;
log(`screen ${view.state}: ${JSON.stringify({ view, plan, fee: funds.fee, wFee: funds.wFee, minPart: funds.minPart }, big)}`);
const record = { at: new Date().toISOString(), cluster: COPY ? "mainnet copy" : "devnet", program: PIN.program, pool, to: TO, amount, dry: DRY, answer, opened, view, plan, before };
if (DRY || !view.ready) {
  writeFileSync(OUT, JSON.stringify(record, big, 2) + "\n");
  log(DRY ? "dry: stopped before the press" : "the screen refused it");
  seed64.fill(0);
  process.exit(view.ready ? 0 : 1);
}
log("the press");
phase = "withdraw";
await t.withdraw(view.ready, opId);
const op = await w.get("ops", opId);
log(`op ${JSON.stringify(op)}`);
// each part's two transactions (txs: release, onward, release, onward, ...) read at finalized on both RPCs: both
// succeeded; the onward send moves To up by exactly its part and leaves W (its fee payer, key 0) at 0
const finalized = async (rpc, hash) => {
  let got = null;
  for (let i = 0; i < 60 && !got; i++) {
    got = await rpc("getTransaction", [hash, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }]).catch(() => null);
    if (!got) await sleep(2_000);
  }
  return got;
};
const checks = [];
const txs = op?.txs ?? [];
// To on Solana: the typed address, or on an exit the quote's deposit address (the first onward's own payee, which every
// onward must name and which is never the typed address)
const onwardTo = async (hash) => (await finalized(rpcs[0], hash))?.transaction?.message?.accountKeys?.[1] ?? null;
const PAYEE = DEST && txs[1]?.hash ? await onwardTo(txs[1].hash) : TO;
for (let k = 0; k * 2 < txs.length; k++) {
  const [release, onward] = [txs[2 * k]?.hash, txs[2 * k + 1]?.hash];
  const reads = [];
  for (const rpc of rpcs) {
    const rel = release ? await finalized(rpc, release) : null;
    const on = onward ? await finalized(rpc, onward) : null;
    const keys = on?.transaction?.message?.accountKeys ?? [];
    const at = keys.indexOf(PAYEE);
    reads.push({
      release: rel?.meta?.err === null,
      onward: on?.meta?.err === null,
      toDelta: at < 0 ? null : String(BigInt(on.meta.postBalances[at]) - BigInt(on.meta.preBalances[at])),
      wAfter: on ? String(on.meta.postBalances[0]) : null,
    });
  }
  const want = plan?.[k]?.part;
  checks.push({ release, onward, part: String(want), reads, landed: reads.every((x) => x.release && x.onward && x.toDelta === String(want) && x.wAfter === "0") });
}
const notes = await noteList();
const sent = op?.stage === "sent" && checks.length === (plan?.length ?? -1) && checks.every((c) => c.landed) && (!DEST || (PAYEE !== null && PAYEE !== TO && copy.quotes.length === 1 && copy.quotes[0].status >= 200 && copy.quotes[0].status < 300));
// FLOW_COPY: each send by its step, To and the fee payer watched
const steps = COPY ? copy.sent.map((x, i) => ({ step: txs.findIndex((y) => y.hash === x.signature) % 2 === 1 ? "withdraw: onward to To" : "withdraw: release", signature: x.signature, watch: { to: PAYEE, feePayer: PIN.feePayer } })) : undefined;
writeFileSync(OUT, JSON.stringify({ ...record, dest: DEST ?? "solana", payee: PAYEE, quotes: copy?.quotes, op, checks, notes, sent, steps, simFails: copy?.simFails, sendLines: copy?.sendLines }, big, 2) + "\n");
log(`checks ${JSON.stringify(checks)}; sent ${sent}`);
seed64.fill(0);
await t.signedOut();
ns.close();
w.close();
process.exit(sent ? 0 : 1);
