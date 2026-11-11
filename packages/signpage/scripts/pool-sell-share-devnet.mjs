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
// - The sell's timeline, from its tap: each sale's send (its signature on a devnet RPC) and the device's record as the app
//   reads it (state.ops: the stage, and each leg's), read every 200 ms; each provider's JSON-RPC calls while the sell
//   runs, against the page's limit (the kit's SOLANA_KEYLESS_RPC_LIMIT per provider, which these RPCs are paced by, as
//   the page's are: pageSolanaRpcs); and any sale refused for its quote (quote_check_failed).
// - Before the tap the page's positions pass runs, as the app's does at sign in, until the whole pass it keeps lists
//   every W holding the coin: the sale lists its Ws from it (card pool-sell-legs-side-by-side). FLOW_FINDER=1: no pass
//   kept, the sale's finder reads them (a restored device before its first whole pass). The path the sale took is read
//   from its own calls (the finder's getBalance and getTokenAccountsByOwner after the tap) and printed; a run whose
//   sale took the other path fails. Every provider refusal from the tap is kept by host and time, and each leg's time
//   from the send before it.
// - It writes the answers, the stages, the notes, each leg, the times and every tx to <out.json>; exit 0 only when every
//   deposit landed, every buy filled, the sell answered sent and ended filled with a leg per W and its return notes.
// - FLOW_RESUME=<run.seed> with <n> 0 and FLOW_FINDER=1: no deposit or buy; the kept words of an earlier run are signed in
//   to a fresh store, the page's restore rebuilds its notes, and the sale sells every W of theirs that still holds the
//   coin (a W an earlier run left unsold). Each refused leg's cause (its record's, card pool-sell-legs-side-by-side) is
//   in the report.
// - FLOW_ONE_FIRST=1 (kept listing path, <n> at least 2): before the share, one pool.sell of the whole holding of the W
//   holding least, which sells from that W alone (the plan sells the smallest first), its own report beside the share's;
//   then, once a whole positions pass lists that W at 0, the share across the other Ws. Each report holds every JSON-RPC
//   call from its tap (ms, host, method) and every provider refusal by host and time.
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
const { solanaPacedRpc, SOLANA_KEYLESS_RPC_LIMIT } = await import("../../kit/src/trade/solana/send.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");
const { WALLET_SEED_LOCK } = await import("@blindfill/wallet/store");
const { POSITIONS_KEPT_KEY, keptListed } = await import("../src/positions.ts");
if (POOL_TESTNET !== true || SOL_POOLS.devnet === undefined) throw new Error("not the testnet build's pins");

const [TABLE, MINT, NS, BPS, OUT] = process.argv.slice(2);
const N = Number(NS);
const SHARE = Number(BPS);
const RESUME = process.env.FLOW_RESUME;
if (!OUT || !Number.isInteger(N) || N < (RESUME ? 0 : 1) || (RESUME && N !== 0) || !Number.isInteger(SHARE) || SHARE < 1 || SHARE > 10_000) throw new Error("usage: pool-sell-share-devnet.mjs <table> <mint> <n buys> <share bps> <out.json>");
const RUNG = 10_000_000n;
const FEE = 5_000n;
const SYSTEM = "11111111111111111111111111111111";
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RPC_HOSTS = new Set(Object.values(TESTNET_RPCS).flat().map((u) => new URL(u).host));
// every transaction the page sends on a devnet RPC, by its first signature, in order; public bytes only
const sentTxs = [];
// each JSON-RPC call on a devnet RPC: its host, method and time (performance.now()); each send's first time, by signature
const calls = [];
const sentAt = new Map();
// each provider refusal (429 or 5xx) on a devnet RPC: its host, status and time (performance.now())
const refusedAt = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  if (RPC_HOSTS.has(new URL(String(u)).host)) {
    try {
      const body = JSON.parse(String(init?.body ?? ""));
      for (const b of Array.isArray(body) ? body : [body]) {
        calls.push({ host: new URL(String(u)).host, method: String(b?.method), t: performance.now() });
        if (b?.method === "sendTransaction") {
          const sig = base58.encode(Buffer.from(String(b.params?.[0]), "base64").subarray(1, 65));
          if (!sentTxs.includes(sig)) sentTxs.push(sig);
          if (!sentAt.has(sig)) sentAt.set(sig, performance.now());
        }
      }
    } catch {}
  }
  const r = await realFetch(u, init);
  if (RPC_HOSTS.has(new URL(String(u)).host) && (r.status === 429 || r.status >= 500)) {
    refusedAt.push({ host: new URL(String(u)).host, status: r.status, t: performance.now() });
    log(`rpc ${new URL(String(u)).host}: HTTP ${r.status} from the provider`);
  }
  return r;
};
// paced as the page's pair is (pool-testnet.ts pageSolanaRpcs)
const rpcs = TESTNET_RPCS.solana.slice(0, 2).map((u) => solanaPacedRpc(testnetRpc(u)));
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
const entropy = RESUME ? Buffer.from(readFileSync(RESUME, "utf8").trim(), "hex") : randomBytes(16);
if (entropy.length !== 16) throw new Error("the seed file holds no 16-byte seed");
if (!RESUME) writeFileSync(join(DIR, `run-${STAMP}.seed`), entropy.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
log(RESUME ? `the words of ${RESUME}, signed in to a fresh store` : `the run's seed is kept at ${join(DIR, `run-${STAMP}.seed`)}`);
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
  // the device's record as the app reads it, every 200 ms from the tap: each change of its stage or a leg's, with its time
  const timeline = [];
  let last = "";
  const look = async () => {
    const rec = await w.get("ops", id);
    const now = JSON.stringify({ stage: rec?.stage ?? null, legs: (rec?.legs ?? []).map((l) => [l.wallet, l.stage, l.code ?? null]) });
    if (now !== last) {
      last = now;
      timeline.push({ ms: Math.round(performance.now() - tap), ...JSON.parse(now) });
    }
  };
  const poll = setInterval(() => void look().catch(() => {}), 200);
  await r.after;
  const answer = r.answer();
  times.answer = Math.round(performance.now() - tap);
  log(`${kind} answered ${JSON.stringify(answer)}; waiting for its run to end`);
  await navigator.locks.request(WALLET_SEED_LOCK, { mode: "exclusive" }, () => {});
  times.ended = Math.round(performance.now() - tap);
  clearInterval(poll);
  await look();
  times.tap = tap;
  times.timeline = timeline;
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

// FLOW_RESUME: the page's restore rebuilds the words' notes; each spent note's W that still holds the coin is a round
if (RESUME && ok) {
  const { poolRestore } = await import("../src/pool-restore.ts");
  const { freshWallet } = await import("../../wallet/src/derive/keys.ts");
  const { jOf } = await import("../../wallet/src/pool/queue.ts");
  const restore = poolRestore({ store: async () => w, seed64: async () => seed64.slice(), signedIn: async () => true, ended: () => {} });
  log(`the restore ended ${await restore.auto()}`);
  const owner = (await again(() => rpcs[0]("getAccountInfo", [MINT, { encoding: "base64", commitment: "finalized" }]))).value.owner;
  for (const n of (await ns.list()).filter((x) => x.state === "SPENT" && x.leaf)) {
    const fw = freshWallet(seed64, "sol", n.leaf.label, jOf(n.ref));
    fw.secretKey.fill(0);
    const ata = (await again(() => rpcs[0]("getAccountInfo", [solanaAta(fw.address, MINT, owner), { encoding: "base64", commitment: "finalized" }]))).value;
    const units = ata ? Buffer.from(ata.data[0], "base64").readBigUInt64LE(64) : 0n;
    log(`W ${fw.address} holds ${units} units of the coin`);
    if (units > 0n) rounds.push({ W: fw.address, resumed: true });
  }
  if (rounds.length === 0) ok = false;
}
// the return notes the store held before the tap (a resumed run's restore rebuilds the earlier run's)
const returnsOf = (ns_) => ns_.filter((n) => n.ref === "return" && n.state === "UNSPENT" && n.leafIndex !== null).length;
let returnsBefore = returnsOf(await noteList());
const ONE_FIRST = process.env.FLOW_ONE_FIRST === "1";
// FLOW_ONE_FIRST: the W sold alone first, and the share's Ws (every other round)
let one = null;
let oneW = null;
let shareRounds = rounds;
let sell = null;
let after = null;
// the sale's path, as the app's: the page's positions pass runs at sign in (positions(), its first pass), so the sale
// lists its Ws from the whole pass it kept; FLOW_FINDER=1: no pass kept, the sale finds its Ws (a restored device
// before its first whole pass). Which path the sale took is read from its own calls after it (`path`)
const FINDER = process.env.FLOW_FINDER === "1";
let path = null;
if (ok) {
  if (FINDER) {
    await w.delete("meta", POSITIONS_KEPT_KEY);
    log("path before the tap: finder (FLOW_FINDER=1, no pass kept)");
  } else {
    await t.positions();
    let listed = null;
    for (let i = 0; i < 90; i++) {
      listed = keptListed(await w.get("meta", POSITIONS_KEPT_KEY));
      if (listed !== null && rounds.every((r) => (listed.get(r.W)?.get(MINT) ?? 0n) > 0n)) break;
      listed = null;
      await sleep(2_000);
    }
    if (listed === null) {
      log("path before the tap: BAD no whole positions pass listing every W in 180 s");
      ok = false;
    } else log(`path before the tap: kept listing (a whole pass lists ${rounds.length} W(s) holding the coin)`);
  }
}
// a whole positions pass that lists each W in `holding` with the coin and each in `sold` with none (180 s at most)
const passLists = async (holding, sold) => {
  await t.positions();
  for (let i = 0; i < 90; i++) {
    const l = keptListed(await w.get("meta", POSITIONS_KEPT_KEY));
    if (l !== null && holding.every((x) => (l.get(x)?.get(MINT) ?? 0n) > 0n) && sold.every((x) => (l.get(x)?.get(MINT) ?? 0n) === 0n)) return l;
    await sleep(2_000);
  }
  return null;
};
// every buy Final (its record's stage filled) before any sale's tap: a buy's reads after its early "sent" share the
// host's budget, so a sale tapped while they run is throttled by them, not by its own reads
const buysFinal = rounds.filter((r) => r.buy).map((r) => r.buy.record?.stage ?? null);
if (ok && !buysFinal.every((x) => x === "filled")) {
  log(`BAD a buy not Final before the first sale: ${JSON.stringify(buysFinal)}`);
  ok = false;
} else if (ok) log(`every buy Final before the first sale (${buysFinal.length} records at stage filled)`);
if (ok && ONE_FIRST) {
  if (FINDER || rounds.length < 2) throw new Error("FLOW_ONE_FIRST takes the kept listing path and two buys at least");
  const listed = keptListed(await w.get("meta", POSITIONS_KEPT_KEY));
  const held = rounds.map((r) => ({ W: r.W, units: listed.get(r.W).get(MINT) })).sort((a, b) => (a.units < b.units ? -1 : a.units > b.units ? 1 : 0));
  oneW = held[0].W;
  const dec = 6;
  const s_ = held[0].units.toString().padStart(dec + 1, "0");
  const amount = `${s_.slice(0, -dec)}.${s_.slice(-dec)}`;
  log(`pool.sell of ${amount} of ${MINT}: the whole holding of ${oneW}, the W holding least, alone`);
  one = await once("pool.sell", { chain: "solana", token: MINT, amount, slippage_bps: 300 });
  log(`one ${JSON.stringify(one)}`);
  const legs = one.record?.legs ?? [];
  if (one.record?.stage !== "filled" || legs.length !== 1 || legs[0].wallet !== oneW) {
    log("BAD the one-wallet sale did not fill from that W alone");
    ok = false;
  }
  shareRounds = rounds.filter((r) => r.W !== oneW);
  if (ok && (await passLists(shareRounds.map((r) => r.W), [oneW])) === null) {
    log("BAD no whole positions pass listing the sold W at 0 and the others holding in 180 s");
    ok = false;
  }
  returnsBefore = returnsOf(await noteList());
}
if (ok) {
  log(`pool.sell of ${SHARE} bps of ${MINT} across ${shareRounds.map((r) => r.W).join(", ")}`);
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
// the sell's numbers: each sale's send and end from the tap, each provider's calls against the page's limit
// a sell's numbers: each sale's send and end from its tap, each provider's calls against the page's limit, every call
// and refusal from the tap
const reportOf = (sell, want) => {
  const tap = sell.times.tap;
  const end = tap + sell.times.ended;
  const legs = (sell.record?.legs ?? []).map((l, i) => {
    const endAt = sell.times.timeline.find((x) => x.legs[i] && x.legs[i][1] !== "pending" && x.legs[i][1] !== "signed" && x.legs[i][1] !== "sent");
    return { leg: i + 1, wallet: l.wallet, units: l.units, tx: l.tx, stage: l.stage, code: l.code ?? null, cause: l.cause ?? null, sentMs: l.tx && sentAt.has(l.tx) ? Math.round(sentAt.get(l.tx) - tap) : null, endedMs: endAt?.ms ?? null };
  });
  const during = calls.filter((c) => c.t >= tap && c.t <= end);
  const perHost = {};
  for (const host of new Set(during.map((c) => c.host))) {
    const mine = during.filter((c) => c.host === host);
    let maxTotal = 0;
    let maxMethod = 0;
    for (const c of mine) {
      const win = mine.filter((d) => d.t >= c.t && d.t < c.t + SOLANA_KEYLESS_RPC_LIMIT.windowMs);
      maxTotal = Math.max(maxTotal, win.length);
      const by = {};
      for (const d of win) by[d.method] = (by[d.method] ?? 0) + 1;
      maxMethod = Math.max(maxMethod, ...Object.values(by));
    }
    const methods = {};
    for (const c of mine) methods[c.method] = (methods[c.method] ?? 0) + 1;
    perHost[host] = { calls: mine.length, maxIn10s: maxTotal, maxOneMethodIn10s: maxMethod, limit: SOLANA_KEYLESS_RPC_LIMIT, methods };
  }
  const quoteAge = legs.filter((l) => l.code === "quote_check_failed").map((l) => l.leg);
  // the path the sale took, from its calls: the finder reads W's holdings (getBalance, getTokenAccountsByOwner); the
  // kept listing reads none
  const finderCalls = during.filter((c) => c.method === "getBalance" || c.method === "getTokenAccountsByOwner").length;
  path = finderCalls > 0 ? "finder" : "kept listing";
  log(`path the sale took: ${path} (${finderCalls} finder call(s) after the tap)`);
  if (path !== want) log(`BAD the sale took the ${path} path, not the ${want} this run asked for`);
  // each refusal from the tap, by host
  const refused = refusedAt.filter((x) => x.t >= tap && x.t <= end).map((x) => ({ host: x.host, status: x.status, ms: Math.round(x.t - tap) }));
  // each leg's time waiting its turn: from the send before it to its own
  for (let i = 1; i < legs.length; i++) if (legs[i].sentMs !== null && legs[i - 1].sentMs !== null) legs[i].afterPriorSentMs = legs[i].sentMs - legs[i - 1].sentMs;
  const report = { path, legs, timeline: sell.times.timeline, perHost, refused, quoteAgeRefused: quoteAge, calls: during.map((c) => [Math.round(c.t - tap), c.host, c.method]) };
  log(`sell report ${JSON.stringify({ ...report, calls: report.calls.length })}`);
  return report;
};
let report = null;
let oneReport = null;
if (sell?.times?.tap !== undefined) {
  report = reportOf(sell, FINDER ? "finder" : "kept listing");
  path = report.path;
}
if (one?.times?.tap !== undefined) oneReport = reportOf(one, "kept listing");
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
  sell.record.legs?.length === shareRounds.length &&
  sell.record.legs.every((l) => l.stage === "filled" && legTxs.includes(l.tx)) &&
  [...new Set(sell.record.legs.map((l) => l.wallet))].sort().join() === shareRounds.map((r) => r.W).sort().join() &&
  sell.times.filled !== undefined &&
  legTxs.length === shareRounds.length &&
  returnsOf(notes) - returnsBefore === shareRounds.length &&
  !stages.some((x) => x.kind !== "pool.deposit" && x.stage !== "sent" && x.stage !== "filled") &&
  Object.values(readBack).every((r) => r.every((x) => x !== null && x.err === null)) &&
  path === (FINDER ? "finder" : "kept listing") &&
  (!ONE_FIRST || (oneReport?.path === "kept listing" && one?.record?.stage === "filled"));
log(`notes ${JSON.stringify(notes)}; sell times ${JSON.stringify(sell?.times ?? null)}; filled ${filled}`);
seed64.fill(0);
fKey.fill(0);
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), cluster: "devnet", program: SOL_POOLS.devnet.program, table: TABLE, mint: MINT, n: N, share_bps: SHARE, F, need: String(NEED), fundTxs, rounds, buysFinal, one: one && { W: oneW, ...one }, oneReport, sell, report, after, sentTxs, readBack, stages, notes, filled }, null, 2) + "\n");
await t.signedOut();
ns.close();
w.close();
process.exit(filled ? 0 : 1);
