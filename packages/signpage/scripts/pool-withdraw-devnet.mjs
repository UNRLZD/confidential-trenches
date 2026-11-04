// One real devnet run of the pool withdraw through the signing page's own testnet flow (card
// signpage-pool-withdraw-form): pool.withdraw on the page's pool kinds (src/pool-kinds.ts over src/pool-testnet.ts, as
// main.ts wires them), its screen's model on the funds the page reads (src/withdraw/pool-form.ts evaluatePool), then the
// press: the run (src/pool-withdraw.ts) proves each part on demand, sends the release and the transfer from W to To
// through the helper's POST /v1/pool/solana/send, and reads it back on both devnet RPCs.
//   FLOW_RESUME=<seed file> node packages/signpage/scripts/pool-withdraw-devnet.mjs <to> <amount SOL> <out.json>
// - The seed is a kept run's (~/.ct-devnet-runs/run-<time>.seed, pool-flow-devnet.mjs): its notes restored from the seed
//   on both devnet RPCs (the wallet's solanaRestoreNotes), never printed. No new money goes in.
// - WITHDRAW_DRY=1 stops before the press: the notes, the screen's view and the plan, nothing signed or sent.
// - What differs from the page in a browser, and only that: the prover is snarkjs's fullProve in this process on the
//   pinned setup files, and the screen's fields are given here, not typed. Every check, the send and every read-back are
//   the page's own code.
// - Then each part's transaction is read at finalized on both RPCs: succeeded, and To's balance up by exactly its part.
//   It writes the answers, the op record, the notes and every tx to <out.json>; exit 0 only when the op is "sent" and
//   every part reads back so on both RPCs.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { IDBFactory } from "fake-indexeddb";

globalThis.__SIGN_NETWORK__ = "testnet";
const { entropyToWords, wordsToSeed64 } = await import("../../wallet/src/derive/index.ts");
const { openWalletStore } = await import("../../wallet/src/store/index.ts");
const { openNoteStore, refKey } = await import("../../wallet/src/notes/store.ts");
const { SOL_POOLS, solanaPoolOf } = await import("../../wallet/src/pool/solana.ts");
const { solanaRestoreNotes } = await import("../../wallet/src/pool/solana-restore.ts");
const { pageRpc } = await import("../src/page-rpc.ts");
const { ZK_SETUP_FILES } = await import("../../kit/src/zk/setup-files.ts");
const { poolKinds } = await import("../src/pool-kinds.ts");
const { TESTNET_RPCS, testnetPool, testnetPoolDeps } = await import("../src/pool-testnet.ts");
const { evaluatePool } = await import("../src/withdraw/pool-form.ts");
const { planPoolWithdraw } = await import("../src/pool-withdraw.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");
if (POOL_TESTNET !== true || SOL_POOLS.devnet === undefined) throw new Error("not the testnet build's pins");

const [TO, AMOUNT, OUT] = process.argv.slice(2);
const RESUME = process.env.FLOW_RESUME;
const DRY = process.env.WITHDRAW_DRY === "1";
if (!OUT || !RESUME) throw new Error("usage: FLOW_RESUME=<seed file> pool-withdraw-devnet.mjs <to> <amount SOL> <out.json>");
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const big = (_k, v) => (typeof v === "bigint" ? String(v) : v);
const rpcs = [pageRpc(TESTNET_RPCS.solana[0]), pageRpc(TESTNET_RPCS.solana[1])];

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
};
const t = testnetPool(page, { rpcs, prover: { vault, stop: () => {} }, fetch: helperFetch });
const kinds = poolKinds({ ...testnetPoolDeps(t.flow), rpcs: (c) => (c === "solana" ? rpcs : testnetPoolDeps().rpcs(c)) });

const { pool } = solanaPoolOf(SOL_POOLS.devnet.program);
const ns = await openNoteStore(w);
const r = await solanaRestoreNotes({ seed64, program: SOL_POOLS.devnet.program, rpcs });
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
const view = evaluatePool("solana", TO, AMOUNT, deps.keys, funds);
const plan = view.ready ? planPoolWithdraw(funds.notes, view.ready.amount, funds.fee, funds.minPart) : null;
log(`screen ${view.state}: ${JSON.stringify({ view, plan, fee: funds.fee, minPart: funds.minPart }, big)}`);
const record = { at: new Date().toISOString(), cluster: "devnet", program: SOL_POOLS.devnet.program, pool, to: TO, amount: AMOUNT, dry: DRY, answer, opened, view, plan, before };
if (DRY || !view.ready) {
  writeFileSync(OUT, JSON.stringify(record, big, 2) + "\n");
  log(DRY ? "dry: stopped before the press" : "the screen refused it");
  seed64.fill(0);
  process.exit(view.ready ? 0 : 1);
}
log("the press");
await t.withdraw(view.ready, opId);
const op = await w.get("ops", opId);
log(`op ${JSON.stringify(op)}`);
// each part read at finalized on both RPCs: succeeded, To up by exactly its part
const checks = [];
for (const [k, tx] of (op?.txs ?? []).entries()) {
  const reads = [];
  for (const rpc of rpcs) {
    let got = null;
    for (let i = 0; i < 60 && !got; i++) {
      got = await rpc("getTransaction", [tx.hash, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }]).catch(() => null);
      if (!got) await sleep(2_000);
    }
    const keys = got?.transaction?.message?.accountKeys ?? [];
    const at = keys.indexOf(TO);
    reads.push({ ok: got?.meta?.err === null, toDelta: at < 0 ? null : String(BigInt(got.meta.postBalances[at]) - BigInt(got.meta.preBalances[at])) });
  }
  const want = plan?.[k]?.part;
  checks.push({ signature: tx.hash, part: String(want), reads, landed: reads.every((x) => x.ok && x.toDelta === String(want)) });
}
const notes = await noteList();
const sent = op?.stage === "sent" && checks.length === (plan?.length ?? -1) && checks.every((c) => c.landed);
writeFileSync(OUT, JSON.stringify({ ...record, op, checks, notes, sent }, big, 2) + "\n");
log(`checks ${JSON.stringify(checks)}; sent ${sent}`);
seed64.fill(0);
await t.signedOut();
ns.close();
w.close();
process.exit(sent ? 0 : 1);
