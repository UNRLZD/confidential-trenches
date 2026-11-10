// One real devnet run of a sell by share across wallets through the signing page's own testnet flow (card
// pool-sell-share-across-wallets): the page's pool kinds (src/pool-kinds.ts poolKinds over src/pool-testnet.ts
// testnetPool, as main.ts wires them in the testnet build) on the devnet pool it pins: <n> rounds of one pool.deposit of
// 0.01 SOL, the proof queue's pass and one pool.buy of the same devnet coin (each buy in its own fresh wallet W), then
// one pool.sell of a share (share_bps <bps>, 10000 = all of it) that the page sizes from its own reads of every W.
//   node packages/signpage/scripts/pool-sell-share-devnet.mjs <table> <mint> <n> <bps> <out.json>
// - The script is pool-flow-devnet.mjs's way, cut to this: a seed made in this run only (16 random bytes, kept at
//   ~/.ct-devnet-runs/run-<time>.seed, 0600, never printed), the wallet store and notes in memory (fake-indexeddb), the
//   prover snarkjs's fullProve in this process on the pinned setup files, the page's own RPC pair and the deployed helper.
//   Every check, every send and every read-back is the page's own code; the sell's amount is never this script's: it
//   sends only { chain, token, share_bps, slippage_bps }.
// - Each deposit's source U is the address the note store plans. One funder F, a key made here and kept beside the seed
//   (run-<time>.funder, 0600, never printed; FLOW_FUNDER=<that file> uses a kept one), pays each U exactly the lamports
//   its deposit needs (the rung, the mark's rent, two page entries and the fee, from the Rent sysvar both RPCs give).
//   F's address and what it must hold are printed first; someone else funds F, and this waits for it.
// - Each buy spends "max" (the most the ready proof can spend on the coin's own venue, so W keeps exactly its sell's
//   need) and is tapped once; a kind that does not land on its tap is a failed run, recorded as one, never tapped again.
// - The sell's end is the device's record of it (state.ops: its stage, txs and one leg per wallet: wallet, units, tx,
//   stage), read after the run's end; the kind itself answers once, at its first send.
// - The sell's times, from its tap (performance.now()): the kind's answer (sent) and its end stage (progress filled or
//   part_filled: every wallet's sale ended), then the run's end (each full sale's rent back, one W after another).
// - After the run's end, once every transaction the page sent reads finalized on api.devnet.solana.com (90 s at most):
//   each W, its token account and both volume accounts at finalized; every transaction read back on both RPCs.
// - FLOW_SWEEP_F_TO=<address> with FLOW_FUNDER=<F's file>: no run; F pays its whole balance less its fee to <address>.
// - It writes the answers, the stages, the notes, each leg, the times and every tx to <out.json>; exit 0 only when every
//   deposit landed, every buy filled, the sell answered sent and ended filled with a leg per W and its return notes.
import { randomBytes, createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { IDBFactory } from "fake-indexeddb";
import { base58, base64 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";

globalThis.__SIGN_NETWORK__ = "testnet";
const { entropyToWords, wordsToSeed64, depositId } = await import("../../wallet/src/derive/index.ts");
const { openWalletStore } = await import("../../wallet/src/store/index.ts");
const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
const { noteSecrets } = await import("../../wallet/src/notes/secrets.ts");
const { SOL_POOLS, solanaPoolOf } = await import("../../wallet/src/pool/solana.ts");
const { readSolanaRent, solanaRentMin, readSolanaPoolBuyVenue, solanaPoolBuyMaxSpend } = await import("../../kit/src/trade/solana/pool-buy.ts");
const { ZK_SETUP_FILES } = await import("../../kit/src/zk/setup-files.ts");
const { solanaCompileV0 } = await import("../../kit/src/trade/solana/build.ts");
const { solanaDecodeMessage, solanaAta } = await import("../../kit/src/checks/solana/message.ts");
const { solanaVolumeAccumulator, SOLANA_PUMP_PROGRAM, SOLANA_PUMP_AMM_PROGRAM } = await import("../../kit/src/checks/solana/checks.ts");
const { poolKinds } = await import("../src/pool-kinds.ts");
const { TESTNET_RPCS, testnetPool, testnetPoolDeps, testnetRpc } = await import("../src/pool-testnet.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");
const { WALLET_SEED_LOCK } = await import("@blindfill/wallet/store");
if (POOL_TESTNET !== true || SOL_POOLS.devnet === undefined) throw new Error("not the testnet build's pins");

const [TABLE, MINT, NS, BPS, OUT] = process.argv.slice(2);
const N = Number(NS);
const SHARE = Number(BPS);
if (!OUT || !Number.isInteger(N) || N < 1 || !Number.isInteger(SHARE) || SHARE < 1 || SHARE > 10_000) throw new Error("usage: pool-sell-share-devnet.mjs <table> <mint> <n buys> <share bps> <out.json>");
const RUNG = 10_000_000n;
const FEE = 5_000n;
const SYSTEM = "11111111111111111111111111111111";
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RPC_HOSTS = new Set(Object.values(TESTNET_RPCS).flat().map((u) => new URL(u).host));
// every transaction the page sends on a devnet RPC, by its first signature, in order; public bytes only
const sentTxs = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  if (RPC_HOSTS.has(new URL(String(u)).host)) {
    try {
      const b = JSON.parse(String(init?.body ?? ""));
      if (b?.method === "sendTransaction") {
        const sig = base58.encode(Buffer.from(String(b.params?.[0]), "base64").subarray(1, 65));
        if (!sentTxs.includes(sig)) sentTxs.push(sig);
      }
    } catch {}
  }
  const r = await realFetch(u, init);
  if (RPC_HOSTS.has(new URL(String(u)).host) && (r.status === 429 || r.status >= 500)) log(`rpc ${new URL(String(u)).host}: HTTP ${r.status} from the provider`);
  return r;
};
const rpcs = TESTNET_RPCS.solana.slice(0, 2).map((u) => testnetRpc(u));
/** This script's own reads after the run (never the page's): a provider's 429 is read again, 10 tries 3 s apart. */
const again = async (f) => {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= 9) throw e;
      log(`read again (${String(e?.message).slice(0, 80)})`);
      await sleep(3_000);
    }
  }
};

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
    return { proof, publicSignals, proveMs: Math.round(performance.now() - t0) };
  },
};

// the run's seed and F's key, kept before anything can move
const DIR = join(homedir(), ".ct-devnet-runs");
mkdirSync(DIR, { recursive: true, mode: 0o700 });
chmodSync(DIR, 0o700);
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const entropy = randomBytes(16);
writeFileSync(join(DIR, `run-${STAMP}.seed`), entropy.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
log(`the run's seed is kept at ${join(DIR, `run-${STAMP}.seed`)}`);
const keptF = process.env.FLOW_FUNDER;
const fKey = keptF ? Uint8Array.from(Buffer.from(readFileSync(keptF, "utf8").trim(), "hex")) : Uint8Array.from(randomBytes(32));
if (fKey.length !== 32) throw new Error("the funder's file holds no 32-byte key");
if (!keptF) writeFileSync(join(DIR, `run-${STAMP}.funder`), Buffer.from(fKey).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
const F = base58.encode(ed25519.getPublicKey(fKey));

const w = await openWalletStore({ indexedDB: new IDBFactory() });
await w.insertSeed({ v: 1, entropy: Uint8Array.from(entropy), source: "code", code_saved: true, created_ms: Date.now() });
const seed64 = wordsToSeed64(entropyToWords(Uint8Array.from(entropy)));
entropy.fill(0);
const page = { store: async () => w, seed64: async () => seed64.slice() };
let relayFee = null;
const helperFetch = async (url, init) => {
  const r = await fetch(url, init);
  log(`helper ${init?.method ?? "GET"} ${new URL(url).pathname}: HTTP ${r.status}`);
  if (new URL(url).pathname === "/v1/pool/fee" && r.status === 200) relayFee = BigInt(JSON.parse(await r.clone().text()).fee);
  return r;
};
const t = testnetPool(page, { rpcs, prover: { vault, stop: () => {} }, table: TABLE, fetch: helperFetch });
const kinds = poolKinds({ ...testnetPoolDeps(t.flow), rpcs: (c) => (c === "solana" ? rpcs : testnetPoolDeps().rpcs(c)) });
const stages = [];
const ns = await openNoteStore(w);
const noteList = async () => (await ns.list()).map((n) => ({ ref: n.ref.kind, state: n.state, value: n.leaf ? String(n.leaf.value) : null, leafIndex: n.leaf ? String(n.leaf.leafIndex) : null }));
/** One tap of `kind`: its answer at its send, then the run's end (the seed's lock); its times from the tap. */
const once = async (kind, params) => {
  const tap = performance.now();
  const times = {};
  const id = `${kind}-${stages.length}-${Math.round(tap)}`;
  const r = kinds[kind](params, {
    id,
    sha: "00",
    progress: (s) => {
      times[s] ??= Math.round(performance.now() - tap);
      stages.push({ kind, stage: s });
      log(`${kind} progress ${JSON.stringify(s)}`);
    },
  });
  if ("error" in r) return { answer: r, times };
  await r.after;
  const answer = r.answer();
  times.answer = Math.round(performance.now() - tap);
  log(`${kind} answered ${JSON.stringify(answer)}; waiting for its run to end`);
  await navigator.locks.request(WALLET_SEED_LOCK, { mode: "exclusive" }, () => {});
  times.ended = Math.round(performance.now() - tap);
  // the kind answers once, at its first send; the end, every sale's signature and each leg are the device's record
  // (state.ops), which the app reads
  return { answer, record: await w.get("ops", id), times, notes: await noteList() };
};

const rent = await readSolanaRent(rpcs);
const NEED = RUNG + solanaRentMin(rent, 17) + 2n * 72n * rent.lamportsPerByte * rent.factor + FEE;
const F_NEEDS = BigInt(N) * (NEED + FEE) + solanaRentMin(rent, 0);
const VENUE = await readSolanaPoolBuyVenue(rpcs, "pump-curve", MINT);
const { scope } = solanaPoolOf(SOL_POOLS.devnet.program);
log(`F ${F} (its key kept${keptF ? ` at ${keptF}` : ` at ${join(DIR, `run-${STAMP}.funder`)}`}); fund F with at least ${F_NEEDS} lamports on devnet for ${N} deposit(s)`);
const balanceOf = async (a) => {
  for (;;) {
    try {
      const got = await Promise.all(rpcs.map(async (r) => BigInt((await r("getBalance", [a, { commitment: "confirmed" }])).value)));
      return got[0] < got[1] ? got[0] : got[1];
    } catch (e) {
      log(`balance read failed (${String(e?.message).slice(0, 80)}): reading again`);
      await sleep(5_000);
    }
  }
};
const fundTxs = [];
/** F pays `to` exactly `lamports` (System Transfer), sent on both RPCs and read confirmed on both. */
const fund = async (to, lamports) => {
  const { blockhash } = (await rpcs[0]("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
  const data = new Uint8Array(12);
  data[0] = 2;
  new DataView(data.buffer).setBigUint64(4, lamports, true);
  const ix = { program: SYSTEM, accounts: [{ key: F, signer: true, writable: true }, { key: to, signer: false, writable: true }], data };
  const { message } = solanaCompileV0(F, [ix], blockhash, [], [F]);
  const wire = new Uint8Array(1 + 64 + message.length);
  wire[0] = 1;
  wire.set(ed25519.sign(message, fKey), 1);
  wire.set(message, 65);
  const sig = base58.encode(wire.subarray(1, 65));
  fundTxs.push(sig);
  log(`F pays ${to} ${lamports}: ${sig}`);
  await Promise.allSettled(rpcs.map((r) => r("sendTransaction", [base64.encode(wire), { encoding: "base64", preflightCommitment: "confirmed" }])));
  for (let i = 0; i < 60; i++) {
    const st = await Promise.all(rpcs.map(async (r) => (await r("getSignatureStatuses", [[sig]])).value[0]));
    if (st.some((x) => x?.err)) throw new Error(`F's payment failed: ${JSON.stringify(st.map((x) => x?.err ?? null))}`);
    if (st.every((x) => x?.confirmationStatus === "confirmed" || x?.confirmationStatus === "finalized")) return sig;
    await sleep(1_000);
  }
  throw new Error("F's payment not confirmed on both RPCs");
};

// FLOW_SWEEP_F_TO=<address> with FLOW_FUNDER: F's whole balance back to <address> (less its fee), read on both RPCs
if (process.env.FLOW_SWEEP_F_TO) {
  if (!keptF) throw new Error("FLOW_SWEEP_F_TO needs FLOW_FUNDER");
  const left = await balanceOf(F);
  const sig = await fund(process.env.FLOW_SWEEP_F_TO, left - FEE);
  log(`F swept: ${sig}; F holds ${await balanceOf(F)}`);
  fKey.fill(0);
  seed64.fill(0);
  process.exit(0);
}
for (let b = await balanceOf(F); b < F_NEEDS; b = await balanceOf(F)) {
  log(`F holds ${b}: waiting for at least ${F_NEEDS}`);
  await sleep(10_000);
}
log("F funded");
const rounds = [];
let ok = true;
for (let i = 0; i < N && ok; i++) {
  const planned = await ns.planDeposit(scope, (ref) => noteSecrets(seed64, ref).precommitment);
  const id = depositId(seed64, scope, planned.ref.i);
  const U = base58.encode(id.publicKey);
  id.secretKey.fill(0);
  if ((await balanceOf(U)) !== 0n) throw new Error(`U ${U} is not empty`);
  await fund(U, NEED);
  log(`round ${i + 1}: pool.deposit of 0.01 SOL from U ${U}`);
  const deposit = await once("pool.deposit", { chain: "solana", amount: "0.01" });
  const landed = deposit.notes?.some((n) => n.ref === "deposit" && n.state === "UNSPENT");
  if (!landed) {
    rounds.push({ U, deposit });
    ok = false;
    break;
  }
  await t.proofs();
  const max = solanaPoolBuyMaxSpend({ withdrawnValue: RUNG, relayFee }, VENUE, 0n, rent);
  const spend = `0.${String(max).padStart(9, "0")}`;
  log(`round ${i + 1}: pool.buy of ${spend} SOL of ${MINT}`);
  const buy = await once("pool.buy", { chain: "solana", token: MINT, amount: spend, slippage_bps: 300 });
  const sig = buy.answer?.result?.txs?.[0]?.hash;
  let W = null;
  for (let k = 0; k < 60 && sig && !W; k++) {
    const tx = await rpcs[0]("getTransaction", [sig, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
    W = tx?.transaction.message.accountKeys[1] ?? null;
    if (!W) await sleep(2_000);
  }
  rounds.push({ U, deposit, buy, W });
  if (!W) ok = false;
}

let sell = null;
let after = null;
if (ok) {
  log(`pool.sell of ${SHARE} bps of ${MINT} across ${rounds.map((r) => r.W).join(", ")}`);
  sell = await once("pool.sell", { chain: "solana", token: MINT, share_bps: SHARE, slippage_bps: 300 });
  log(`sell ${JSON.stringify(sell)}`);
  for (let i = 0; i < 45; i++) {
    const st = (await again(() => rpcs[0]("getSignatureStatuses", [sentTxs]))).value;
    if (st.every((s) => s?.confirmationStatus === "finalized")) break;
    await sleep(2_000);
  }
  const info = async (a) => (await again(() => rpcs[0]("getAccountInfo", [a, { encoding: "base64", commitment: "finalized" }]))).value;
  const program = (await info(MINT)).owner;
  const left = async (a) => (await info(a))?.lamports ?? null;
  after = [];
  for (const { W } of rounds) after.push({ W, tokenAccount: await left(solanaAta(W, MINT, program)), pumpVolume: await left(solanaVolumeAccumulator(W, SOLANA_PUMP_PROGRAM)), ammVolume: await left(solanaVolumeAccumulator(W, SOLANA_PUMP_AMM_PROGRAM)), w: await left(W) });
  log(`after the run ${JSON.stringify(after)}`);
}
// every transaction, F's payments, the page's own sends and each buy (sent through the helper), read back on both RPCs
const all = [...new Set([...fundTxs, ...sentTxs, ...rounds.map((r) => r.buy?.answer?.result?.txs?.[0]?.hash).filter(Boolean)])];
const readBack = {};
for (const sig of all) {
  readBack[sig] = await Promise.all(rpcs.map(async (r) => {
    const tx = await again(() => r("getTransaction", [sig, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }]));
    return tx ? { slot: tx.slot, err: tx.meta?.err ?? null } : null;
  }));
}
const legTxs = sell?.record?.txs?.map((x) => x.hash) ?? [];
const notes = await noteList();
const filled =
  ok &&
  sell?.answer?.result !== undefined &&
  sell.record?.stage === "filled" &&
  sell.record.legs?.length === rounds.length &&
  sell.record.legs.every((l) => l.stage === "filled" && legTxs.includes(l.tx)) &&
  [...new Set(sell.record.legs.map((l) => l.wallet))].sort().join() === rounds.map((r) => r.W).sort().join() &&
  sell.times.filled !== undefined &&
  legTxs.length === rounds.length &&
  notes.filter((n) => n.ref === "return" && n.state === "UNSPENT" && n.leafIndex !== null).length === rounds.length &&
  !stages.some((x) => x.kind !== "pool.deposit" && x.stage !== "sent" && x.stage !== "filled") &&
  Object.values(readBack).every((r) => r.every((x) => x !== null && x.err === null));
log(`notes ${JSON.stringify(notes)}; sell times ${JSON.stringify(sell?.times ?? null)}; filled ${filled}`);
seed64.fill(0);
fKey.fill(0);
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), cluster: "devnet", program: SOL_POOLS.devnet.program, table: TABLE, mint: MINT, n: N, share_bps: SHARE, F, need: String(NEED), fundTxs, rounds, sell, after, sentTxs, readBack, stages, notes, filled }, null, 2) + "\n");
await t.signedOut();
ns.close();
w.close();
process.exit(filled ? 0 : 1);
